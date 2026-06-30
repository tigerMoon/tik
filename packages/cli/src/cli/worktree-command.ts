import * as path from 'node:path';
import type { Command } from 'commander';
import chalk from 'chalk';
import type {
  WorkspaceProjectWorktreeState,
  WorkspaceResolution,
  WorkspaceSettings,
  WorkspaceWorktreePolicyConfig,
} from '@tik/shared';
import type {
  WorkspaceExecutionTarget,
  WorkspaceExecutionTargetInput,
  WorkspaceManagedWorktreeEntry,
  WorkspaceRemoveManagedWorktreeInput,
} from '@tik/kernel';

export type WorktreeWorkspaceStatusSnapshot = {
  settings: Pick<WorkspaceSettings, 'workspaceName' | 'worktreePolicy'> | null;
  state: {
    projects?: WorktreeWorkspaceProjectSnapshot[];
  } | null;
};

export interface WorktreeWorkspaceProjectSnapshot {
  projectName: string;
  projectPath: string;
  sourceProjectPath?: string;
  effectiveProjectPath?: string;
  worktree?: WorkspaceProjectWorktreeState;
  worktreeLanes?: WorkspaceProjectWorktreeState[];
  status: string;
}

export type ManagedWorktreeEntry = WorkspaceManagedWorktreeEntry;

export interface WorktreeCommandServices {
  resolveProjectPath(opts: { project?: string; target?: string }): Promise<WorkspaceResolution>;
  workspaceOrchestrator: {
    getStatus(rootPath: string): Promise<WorktreeWorkspaceStatusSnapshot>;
    markProjectWorktreeReady(rootPath: string, projectName: string, input: { effectiveProjectPath: string; worktree: WorkspaceProjectWorktreeState }): Promise<unknown>;
    markProjectWorktreeRemoved(rootPath: string, projectName: string, input: { sourceProjectPath: string; worktree: WorkspaceProjectWorktreeState }): Promise<unknown>;
    activateProjectWorktreeLane(rootPath: string, projectName: string, input: { effectiveProjectPath: string; worktree: WorkspaceProjectWorktreeState }): Promise<unknown>;
  };
  workspaceWorktreeManager: {
    listManagedWorktrees(input: {
      workspaceName: string;
      workspaceRoot: string;
      projects: Array<{
        projectName: string;
        sourceProjectPath: string;
        effectiveProjectPath?: string;
        worktree?: WorkspaceProjectWorktreeState;
        worktreeLanes?: WorkspaceProjectWorktreeState[];
      }>;
      policy?: WorkspaceWorktreePolicyConfig;
    }): Promise<ManagedWorktreeEntry[]>;
    getExecutionTarget(input: WorkspaceExecutionTargetInput): Promise<WorkspaceExecutionTarget>;
    removeManagedWorktree(input: WorkspaceRemoveManagedWorktreeInput): Promise<WorkspaceExecutionTarget>;
  };
  selectWorkspaceProjectSnapshot(
    projects: WorktreeWorkspaceProjectSnapshot[],
    activeProjectPath: string,
    target?: string,
  ): WorktreeWorkspaceProjectSnapshot | undefined;
  selectManagedWorktreeEntry(
    entries: ManagedWorktreeEntry[],
    projectName: string,
    sourceProjectPath?: string,
    laneId?: string,
  ): ManagedWorktreeEntry | undefined;
}

export function registerWorktreeCommands(program: Command, services: WorktreeCommandServices): void {
  program
    .command('worktree')
    .description('Manage workspace-managed project worktrees')
    .argument('[subcommand]', 'Subcommand: list, status, path, create, use, remove')
    .option('-p, --project <path>', 'Explicit project or workspace path')
    .option('-t, --target <name>', 'Target project in workspace')
    .option('--lane <id>', 'Managed worktree lane id (default: primary)')
    .option('--force', 'Force worktree removal when supported')
    .action(async (subcommand: string | undefined, opts: { project?: string; target?: string; lane?: string; force?: boolean }) => {
      const command = subcommand || 'list';
      const resolution = await services.resolveProjectPath(opts);
      if (!resolution.workspace) {
        console.log(chalk.red('\n  Worktree management requires a .code-workspace root.\n'));
        return;
      }

      const snapshot = await services.workspaceOrchestrator.getStatus(resolution.workspace.rootPath);
      if (!snapshot.state || !snapshot.settings) {
        console.log(chalk.yellow('\n  Workspace state not initialized yet. Run `tik workspace run --demand \"...\"` first.\n'));
        return;
      }

      const projects = snapshot.state.projects || [];
      if (projects.length === 0) {
        console.log(chalk.yellow('\n  No active workspace projects found.\n'));
        return;
      }

      const selectedProject = services.selectWorkspaceProjectSnapshot(projects, resolution.projectPath, opts.target);
      const entries = await services.workspaceWorktreeManager.listManagedWorktrees({
        workspaceName: snapshot.settings.workspaceName,
        workspaceRoot: resolution.workspace.rootPath,
        projects: projects.map((project) => ({
          projectName: project.projectName,
          sourceProjectPath: project.sourceProjectPath || project.projectPath,
          effectiveProjectPath: project.effectiveProjectPath,
          worktree: project.worktree,
          worktreeLanes: project.worktreeLanes,
        })),
        policy: snapshot.settings.worktreePolicy,
      });

      if (command === 'list' || command === 'status') {
        console.log(chalk.bold(`\n🪵 Workspace Worktrees${command === 'status' ? ' Status' : ''}\n`));
        console.log(chalk.dim(`  Workspace: ${resolution.workspace.rootPath}`));
        console.log(chalk.dim(`  Mode: ${snapshot.settings.worktreePolicy?.mode || 'managed'}`));
        console.log(chalk.dim(`  Root: ${snapshot.settings.worktreePolicy?.worktreeRoot || path.join(resolution.workspace.rootPath, '.workspace', 'worktrees')}`));
        console.log(chalk.dim(`  Non-git: ${snapshot.settings.worktreePolicy?.nonGitStrategy || 'source'}`));
        console.log('');
        for (const entry of entries) {
          const laneLabel = entry.laneId ? ` [${entry.laneId}]` : '';
          const activeLabel = entry.active ? ' *' : '';
          console.log(`  ${chalk.cyan(entry.projectName)}${chalk.dim(laneLabel)}${chalk.dim(activeLabel)}  ${chalk.dim(`${entry.kind} / ${entry.worktree?.status || 'disabled'}`)}`);
          console.log(`    ${chalk.dim(`source: ${entry.sourceProjectPath}`)}`);
          console.log(`    ${chalk.dim(`exec:   ${entry.effectiveProjectPath}`)}`);
          if (entry.worktree?.sourceBranch) console.log(`    ${chalk.dim(`source-branch: ${entry.worktree.sourceBranch}`)}`);
          if (entry.worktree?.worktreeBranch) console.log(`    ${chalk.dim(`worktree-branch: ${entry.worktree.worktreeBranch}`)}`);
          if (typeof entry.dirtyFileCount === 'number') console.log(`    ${chalk.dim(`dirty-files: ${entry.dirtyFileCount}`)}`);
          for (const warning of entry.warnings || []) {
            console.log(`    ${chalk.yellow(warning)}`);
          }
          if (entry.worktree?.lastError) console.log(`    ${chalk.red(entry.worktree.lastError)}`);
        }
        console.log('');
        return;
      }

      if (!selectedProject) {
        console.log(chalk.red('\n  Unable to resolve target project for worktree command.\n'));
        return;
      }

      const selectedEntry = services.selectManagedWorktreeEntry(
        entries,
        selectedProject.projectName,
        selectedProject.sourceProjectPath || selectedProject.projectPath,
        opts.lane,
      );
      if (opts.lane && !selectedEntry && (command === 'path' || command === 'use' || command === 'remove')) {
        console.log(chalk.red(`\n  No managed worktree lane found: ${opts.lane}\n`));
        return;
      }

      if (command === 'path') {
        console.log(chalk.bold('\n🪵 Worktree Path\n'));
        console.log(chalk.dim(`  Project: ${selectedProject.projectName}`));
        if (selectedEntry?.laneId) console.log(chalk.dim(`  Lane: ${selectedEntry.laneId}`));
        console.log(chalk.dim(`  Path: ${selectedEntry?.effectiveProjectPath || selectedProject.effectiveProjectPath || selectedProject.projectPath}\n`));
        return;
      }

      if (command === 'create') {
        const target = await services.workspaceWorktreeManager.getExecutionTarget({
          workspaceName: snapshot.settings.workspaceName,
          workspaceRoot: resolution.workspace.rootPath,
          projectName: selectedProject.projectName,
          sourceProjectPath: selectedProject.sourceProjectPath || selectedProject.projectPath,
          laneId: opts.lane,
          existingEffectiveProjectPath: selectedProject.effectiveProjectPath,
          existingWorktree: selectedProject.worktree,
          existingWorktreeLanes: selectedProject.worktreeLanes,
          policy: snapshot.settings.worktreePolicy,
        });
        if (target.worktree) {
          await services.workspaceOrchestrator.markProjectWorktreeReady(resolution.workspace.rootPath, selectedProject.projectName, {
            effectiveProjectPath: target.effectiveProjectPath,
            worktree: target.worktree,
          });
        }
        console.log(chalk.bold('\n🪵 Worktree Ready\n'));
        console.log(chalk.dim(`  Project: ${selectedProject.projectName}`));
        if (target.worktree?.laneId) console.log(chalk.dim(`  Lane:   ${target.worktree.laneId}`));
        console.log(chalk.dim(`  Source: ${target.sourceProjectPath}`));
        console.log(chalk.dim(`  Exec:   ${target.effectiveProjectPath}`));
        if (target.worktree?.worktreeBranch) console.log(chalk.dim(`  Branch: ${target.worktree.worktreeBranch}`));
        console.log('');
        return;
      }

      if (command === 'use') {
        if (!selectedEntry?.worktree) {
          console.log(chalk.red('\n  No managed worktree lane found for this project.\n'));
          console.log(chalk.dim('  Create one first with `tik worktree create --lane <id>`.\n'));
          return;
        }
        const currentActiveEntry = entries.find((entry) => (
          entry.projectName === selectedProject.projectName
          && entry.sourceProjectPath === (selectedProject.sourceProjectPath || selectedProject.projectPath)
          && entry.active
        ));
        if (selectedEntry.worktree.status !== 'ready' && selectedEntry.worktree.status !== 'source') {
          console.log(chalk.red('\n  The selected worktree lane is not ready for activation.\n'));
          console.log(chalk.dim(`  Current status: ${selectedEntry.worktree.status}\n`));
          return;
        }
        if (!selectedEntry.active && selectedProject.status === 'in_progress' && !opts.force) {
          console.log(chalk.red('\n  Refusing to switch lanes while the project is in progress.\n'));
          console.log(chalk.dim('  Re-run with `--force` to override.\n'));
          return;
        }
        if (!selectedEntry.active && (currentActiveEntry?.dirtyFileCount || 0) > 0 && !opts.force) {
          console.log(chalk.red('\n  Refusing to switch away from the current active lane because it has uncommitted changes.\n'));
          console.log(chalk.dim('  Review or clean the active lane first, or re-run with `--force`.\n'));
          return;
        }
        await services.workspaceOrchestrator.activateProjectWorktreeLane(
          resolution.workspace.rootPath,
          selectedProject.projectName,
          {
            effectiveProjectPath: selectedEntry.effectiveProjectPath,
            worktree: selectedEntry.worktree,
          },
        );
        console.log(chalk.bold('\n🪵 Worktree Lane Activated\n'));
        console.log(chalk.dim(`  Project: ${selectedProject.projectName}`));
        if (selectedEntry.worktree.laneId) console.log(chalk.dim(`  Lane:   ${selectedEntry.worktree.laneId}`));
        console.log(chalk.dim(`  Exec:   ${selectedEntry.effectiveProjectPath}`));
        console.log('');
        return;
      }

      if (command === 'remove') {
        if (selectedProject.status === 'in_progress' && !opts.force) {
          console.log(chalk.red('\n  Refusing to remove a managed worktree while the project is in progress. Re-run with --force if you really need to.\n'));
          return;
        }
        if (selectedEntry && !selectedEntry.safeToRemove && !opts.force) {
          console.log(chalk.red('\n  Refusing to remove this managed lane because it is not safe to discard.\n'));
          if (selectedEntry.warnings.length > 0) {
            console.log(chalk.dim(`  ${selectedEntry.warnings.join(' | ')}\n`));
          }
          console.log(chalk.dim('  Re-run with `--force` if you want to discard the isolated lane anyway.\n'));
          return;
        }
        const removed = await services.workspaceWorktreeManager.removeManagedWorktree({
          workspaceName: snapshot.settings.workspaceName,
          workspaceRoot: resolution.workspace.rootPath,
          projectName: selectedProject.projectName,
          sourceProjectPath: selectedProject.sourceProjectPath || selectedProject.projectPath,
          laneId: opts.lane,
          existingWorktree: selectedEntry?.worktree || selectedProject.worktree,
          existingWorktreeLanes: selectedProject.worktreeLanes,
          policy: snapshot.settings.worktreePolicy,
          force: Boolean(opts.force),
        });
        if (removed.worktree) {
          await services.workspaceOrchestrator.markProjectWorktreeRemoved(resolution.workspace.rootPath, selectedProject.projectName, {
            sourceProjectPath: removed.sourceProjectPath,
            worktree: removed.worktree,
          });
        }
        console.log(chalk.bold('\n🪵 Worktree Removed\n'));
        console.log(chalk.dim(`  Project: ${selectedProject.projectName}`));
        if (removed.worktree?.laneId) console.log(chalk.dim(`  Lane: ${removed.worktree.laneId}`));
        console.log(chalk.dim(`  Source: ${removed.sourceProjectPath}`));
        if (removed.worktree?.worktreePath) console.log(chalk.dim(`  Removed path: ${removed.worktree.worktreePath}`));
        if (removed.worktree?.worktreeBranch) console.log(chalk.dim(`  Branch retained: ${removed.worktree.worktreeBranch}`));
        console.log('');
        return;
      }

      console.log(chalk.red(`\n  Unknown worktree subcommand: ${command}`));
      console.log(chalk.dim('  Available: list, status, path, create, use, remove\n'));
    });
}
