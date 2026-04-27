/**
 * Tik CLI
 *
 * Task-first CLI for Tik.
 * Commands: run, plan, status, logs, eval, stop, list, serve, workspace
 */

import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import * as path from 'node:path';
import * as TikKernel from '@tik/kernel';
import {
  buildWorkspaceEventProjection,
  createWorkspaceSkillExecutorRegistry,
  isWorkspacePlanValid,
  LocalWorkflowSkillRuntimeAdapter,
  materializeWorkflowSkillDelegatedSpec,
  WorkspaceContextAssembler,
  type WorkspaceEventProjection,
  type WorkspacePhaseReporter,
  type WorkspaceSkillCompletionAdapter,
  WorkspaceMemoryStore,
  WorkspaceEventStore,
  WorkspacePolicyEngine,
  WorkspaceWorktreeManager,
  WorkspaceWorkflowEngine,
  WorkflowSubtaskRuntime,
} from '@tik/kernel';
import { SIGHTRuntime, ContextRenderer, ToolResultStore } from '@tik/sight';
import { ACEEngine } from '@tik/ace';
import type {
  AgentEvent,
  ConvergenceStrategy,
  WorkspaceProjectWorktreeState,
  WorkspaceResolution,
  WorkspaceSettings,
  WorkspaceState,
  WorkspaceSplitDemands,
  WorkspaceWorkflowPolicyProfile,
  WorkflowSkillName,
  WorkflowSubtaskContract,
  WorkflowSubtaskSpec,
} from '@tik/shared';
import { generateTaskId } from '@tik/shared';
import {
  displayTask,
  displayTaskResult,
  displayEvent,
} from './display/display.js';
import { runShell } from './shell.js';
import { listCliSessions } from './session-store.js';
import type { ProviderOption } from './types.js';
import {
  buildWorkspaceFeatureDir,
  buildWorkspacePlanTargetPath,
  buildWorkspaceSpecTargetPath,
  resolveWorkspacePlanArtifact,
  resolveWorkspaceSpecArtifact,
  workspaceFeatureDirForArtifact,
} from './workspace-artifacts.js';
import { MockLLMProvider } from './commands/mock-llm.js';
import { ClaudeLLMProvider, hasClaudeCredentials } from './commands/claude-llm.js';
import { OpenAILLMProvider, hasOpenAICredentials } from './commands/openai-llm.js';
import { CodexCliProvider, hasCodexCli, hasCodexLogin } from './commands/codex-cli.js';
import { captureWorkspaceGitChangedFiles } from './workspace-git.js';

const interactiveProviderHelp = 'LLM provider (default: codex): auto, claude, openai, codex (governed implementation), codex-delegate (delegated subtask execution), mock';
const planningProviderHelp = 'LLM provider (default: codex): auto, claude, openai, codex, mock';
const serverProviderHelp = 'LLM provider (default: codex): auto, claude, openai, codex, mock';

// ─── Workspace Resolution ────────────────────────────────────

const {
  ExecutionKernel,
  builtinTools,
  frontendTools,
  gitTools,
  searchEditTools,
  WorkspaceResolver,
} = TikKernel;

const workspaceResolver = new WorkspaceResolver();
const workspaceWorktreeManager = new WorkspaceWorktreeManager();
const workspaceOrchestrator = new (TikKernel as any).WorkspaceOrchestrator() as {
  bootstrap(input: { resolution: WorkspaceResolution; demand: string; workflowPolicy?: WorkspaceSettings['workflowPolicy'] }): Promise<WorkspaceStatusSnapshot>;
  getStatus(rootPath: string): Promise<WorkspaceStatusSnapshot>;
  markSpecifyResult(rootPath: string, projectName: string, specPath: string, summary: string, specTaskId?: string, executionMode?: 'native' | 'fallback'): Promise<WorkspaceStatusSnapshot>;
  markPlanResult(rootPath: string, projectName: string, planPath: string, summary: string, planTaskId?: string, executionMode?: 'native' | 'fallback'): Promise<WorkspaceStatusSnapshot>;
  markAceResult(rootPath: string, projectName: string, taskId: string, status: 'pending' | 'in_progress' | 'completed' | 'blocked' | 'failed', summary: string, executionMode?: 'native' | 'fallback'): Promise<WorkspaceStatusSnapshot>;
  markClarifyResult(rootPath: string, projectName: string, clarificationPath: string, summary: string, clarifyTaskId?: string, clarificationStatus?: 'skipped' | 'generated' | 'awaiting_decision' | 'resolved'): Promise<WorkspaceStatusSnapshot>;
  markClarifyBlocked(rootPath: string, projectName: string, clarificationPath: string, summary: string, clarifyTaskId?: string, clarificationStatus?: 'skipped' | 'generated' | 'awaiting_decision' | 'resolved'): Promise<WorkspaceStatusSnapshot>;
  markProjectInProgress(rootPath: string, projectName: string, phase: string, summary?: string, taskId?: string, executionMode?: 'native' | 'fallback'): Promise<WorkspaceStatusSnapshot>;
  markProjectBlocked(rootPath: string, projectName: string, phase: string, summary: string, taskId?: string): Promise<WorkspaceStatusSnapshot>;
  recordFeedback(rootPath: string, reason: string, affectedProjects: string[], nextPhase?: 'PARALLEL_CLARIFY' | 'PARALLEL_SPECIFY' | 'PARALLEL_PLAN' | 'PARALLEL_ACE'): Promise<WorkspaceStatusSnapshot>;
  clearFeedback(rootPath: string, nextPhase: 'PARALLEL_CLARIFY' | 'PARALLEL_SPECIFY' | 'PARALLEL_PLAN' | 'PARALLEL_ACE'): Promise<WorkspaceStatusSnapshot>;
  updateWorkflowPolicy(rootPath: string, workflowPolicy: WorkspaceSettings['workflowPolicy']): Promise<WorkspaceStatusSnapshot>;
  updateWorktreePolicy(rootPath: string, worktreePolicy: WorkspaceSettings['worktreePolicy']): Promise<WorkspaceStatusSnapshot>;
  resolveDecision(rootPath: string, input: { decisionId: string; optionId?: string; message?: string }): Promise<WorkspaceStatusSnapshot>;
  markProjectWorktreeReady(rootPath: string, projectName: string, input: { effectiveProjectPath: string; worktree: WorkspaceProjectWorktreeState }): Promise<WorkspaceStatusSnapshot>;
  markProjectWorktreeFailed(rootPath: string, projectName: string, input: { effectiveProjectPath?: string; worktree: WorkspaceProjectWorktreeState; summary: string }): Promise<WorkspaceStatusSnapshot>;
  markProjectWorktreeRemoved(rootPath: string, projectName: string, input: { sourceProjectPath: string; worktree: WorkspaceProjectWorktreeState }): Promise<WorkspaceStatusSnapshot>;
  activateProjectWorktreeLane(rootPath: string, projectName: string, input: { effectiveProjectPath: string; worktree: WorkspaceProjectWorktreeState }): Promise<WorkspaceStatusSnapshot>;
};

interface WorkspaceStatusSnapshot {
  settings: WorkspaceSettings | null;
  state: (WorkspaceState & {
    projects?: Array<{
      projectName: string;
      projectPath: string;
      sourceProjectPath?: string;
      effectiveProjectPath?: string;
      worktree?: WorkspaceProjectWorktreeState;
      worktreeLanes?: WorkspaceProjectWorktreeState[];
      phase: string;
      status: string;
      workflowContract?: WorkflowSubtaskContract;
      workflowRole?: import('@tik/shared').WorkflowAgentRole;
      workflowSkillName?: WorkflowSkillName;
      workflowSkillPath?: string;
      blockerKind?: string;
      executionMode?: 'native' | 'fallback';
      clarificationPath?: string;
      clarificationStatus?: 'skipped' | 'generated' | 'awaiting_decision' | 'resolved';
      specPath?: string;
      planPath?: string;
      taskId?: string;
      clarifyTaskId?: string;
      specTaskId?: string;
      planTaskId?: string;
      aceTaskId?: string;
      recommendedCommand?: string;
      summary?: string;
      updatedAt: string;
    }>;
    workspaceFeedback?: {
      required: boolean;
      reason?: string;
      affectedProjects?: string[];
      nextPhase?: 'PARALLEL_CLARIFY' | 'PARALLEL_SPECIFY' | 'PARALLEL_PLAN' | 'PARALLEL_ACE';
      updatedAt: string;
    };
    decisions?: Array<{
      id: string;
      status: 'pending' | 'resolved' | 'dismissed';
      kind: 'clarification' | 'approach_choice' | 'phase_reroute' | 'approval';
      phase: 'PARALLEL_CLARIFY' | 'PARALLEL_SPECIFY' | 'PARALLEL_PLAN' | 'PARALLEL_ACE';
      projectName?: string;
      title: string;
      prompt: string;
      options?: Array<{
        id: string;
        label: string;
        description?: string;
        recommended?: boolean;
        nextPhase?: 'PARALLEL_CLARIFY' | 'PARALLEL_SPECIFY' | 'PARALLEL_PLAN' | 'PARALLEL_ACE';
        artifactPath?: string;
        artifactField?: 'specPath' | 'planPath';
      }>;
      recommendedOptionId?: string;
      allowFreeform?: boolean;
      confidence?: 'low' | 'medium' | 'high';
      rationale?: string;
      signals?: string[];
      sourceSummary?: string;
      createdAt: string;
      updatedAt: string;
      resolution?: {
        status: 'resolved' | 'dismissed';
        optionId?: string;
        message?: string;
        nextPhase?: 'PARALLEL_CLARIFY' | 'PARALLEL_SPECIFY' | 'PARALLEL_PLAN' | 'PARALLEL_ACE';
        resolvedAt: string;
      };
    }>;
    summary?: {
      totalProjects: number;
      completedProjects: number;
      blockedProjects: number;
      failedProjects: number;
      clarifiedProjects?: number;
      pendingClarificationProjects?: number;
      needsHumanProjects: number;
      replanProjects: number;
      updatedAt: string;
    };
  }) | null;
  splitDemands: WorkspaceSplitDemands | null;
}

type WorkspaceProjectSnapshot = NonNullable<NonNullable<WorkspaceStatusSnapshot['state']>['projects']>[number];
interface WorkspaceSubtaskEventContext {
  taskId: string;
  projectName: string;
  projectPath: string;
  phase: WorkflowSubtaskSpec['phase'];
  contract: WorkflowSubtaskSpec['contract'];
  role: WorkflowSubtaskSpec['role'];
  skillName: WorkflowSubtaskSpec['skillName'];
}

interface WorkspaceSubtaskEventMonitor {
  onEvent(event: AgentEvent, context: WorkspaceSubtaskEventContext): void;
  onSubtaskRunning(record: {
    projectName: string;
    taskId: string;
  }): void;
  onSubtaskFinished(record: {
    taskId: string;
  }): void;
}

async function resolveProjectPath(opts: { project?: string; target?: string }): Promise<WorkspaceResolution> {
  if (opts.project) {
    const resolved = await workspaceResolver.resolve(opts.project, opts.target);
    if (resolved.workspace) {
      return resolved;
    }
    return { workspace: null, projectPath: opts.project, isWorkspace: false };
  }
  return workspaceResolver.resolve(process.cwd(), opts.target);
}

// ─── Create Kernel ───────────────────────────────────────────

function resolveProvider(provider: ProviderOption = 'codex'): ProviderOption {
  const envProvider = (process.env.TIK_LLM_PROVIDER as ProviderOption | undefined) || 'codex';
  const requested = provider === 'auto' ? envProvider : provider;

  if (requested === 'mock') return 'mock';
  if (requested === 'claude') {
    if (!hasClaudeCredentials()) throw new Error('Claude credentials not found. Set ANTHROPIC_API_KEY.');
    return 'claude';
  }
  if (requested === 'openai') {
    if (!hasOpenAICredentials()) throw new Error('OpenAI credentials not found. Set OPENAI_API_KEY.');
    return 'openai';
  }
  if (requested === 'codex') {
    if (!hasCodexCli()) throw new Error('Codex CLI not found. Install `codex` first.');
    if (!hasCodexLogin()) throw new Error('Codex CLI is not logged in. Run `codex login` first.');
    return 'codex';
  }
  if (requested === 'codex-delegate') {
    if (!hasCodexCli()) throw new Error('Codex CLI not found. Install `codex` first.');
    if (!hasCodexLogin()) throw new Error('Codex CLI is not logged in. Run `codex login` first.');
    return 'codex-delegate';
  }

  if (hasCodexCli() && hasCodexLogin()) return 'codex';
  if (hasClaudeCredentials()) return 'claude';
  if (hasOpenAICredentials()) return 'openai';
  return 'mock';
}

function createKernel(projectPath: string, options?: { provider?: ProviderOption; model?: string; stream?: boolean }) {
  const sight = new SIGHTRuntime({ projectPath });
  const renderer = new ContextRenderer();
  const toolStore = new ToolResultStore(projectPath);
  const provider = resolveProvider(options?.provider);
  const llm = provider === 'claude'
    ? new ClaudeLLMProvider(options?.model)
    : provider === 'openai'
      ? new OpenAILLMProvider(options?.model)
      : provider === 'codex'
        ? new CodexCliProvider(projectPath, options?.model, 'governed')
        : provider === 'codex-delegate'
          ? new CodexCliProvider(projectPath, options?.model, 'delegate')
      : new MockLLMProvider();

  // Streaming handler: write LLM text chunks directly to stdout
  const onStreamChunk = options?.stream
    ? (chunk: string, _meta: { taskId: string; agent: string }) => {
        process.stdout.write(chunk);
      }
    : undefined;

  // Create kernel first (it owns the EventBus)
  const kernel = new ExecutionKernel({
    llm,
    contextBuilder: sight.contextEngine,
    sight,
    projectPath,
    contextRenderer: renderer,
    toolResultStore: toolStore,
    onStreamChunk,
    // Placeholder ACE — replaced below after we have eventBus
    ace: new ACEEngine('incremental'),
  });

  // Now create ACE with the kernel's eventBus for real metrics collection
  const ace = new ACEEngine('incremental', kernel.eventBus);
  // Replace the placeholder
  (kernel as any).ace = ace;

  for (const tool of [...builtinTools, ...frontendTools, ...gitTools, ...searchEditTools]) {
    kernel.toolRegistry.register(tool);
  }

  return { kernel, sight, ace, llmName: llm.name, provider, llm };
}
// ─── CLI Program ─────────────────────────────────────────────

const program = new Command();

program
  .name('tik')
  .description('Tik - Observable, Controllable, Convergent Agent')
  .version('0.1.0')
  .addHelpText('after', `

Provider guidance:
  codex            Governed implementation mode for real coding tasks
  codex-delegate   Delegated subtask execution for review, analysis, and complete handoff runs

Examples:
  tik
  tik run "实现用户认证" --provider codex
  tik run "审查当前改动并总结风险" --provider codex-delegate
`);

// ── tik shell ────────────────────────────────────────────────

program
  .command('shell')
  .description('Start an interactive Tik shell')
  .option('-p, --project <path>', 'Explicit project or workspace path')
  .option('-t, --target <name>', 'Target project in workspace')
  .option('--resume <session>', 'Resume a saved shell session by id or path')
  .option('-s, --strategy <strategy>', 'Convergence strategy', 'incremental')
  .option('-m, --max-iterations <n>', 'Max iterations per turn', '5')
  .option('--mode <mode>', 'Execution mode: single or multi', 'single')
  .option('--provider <provider>', interactiveProviderHelp, 'codex')
  .option('--model <model>', 'Override model name')
  .option('--mock', 'Force mock LLM')
  .addHelpText('after', `

Examples:
  tik shell
  tik shell --provider codex
  tik shell --provider codex-delegate
`)
  .action(async (opts: { project?: string; target?: string; resume?: string; strategy: string; maxIterations: string; mode: string; provider: ProviderOption; model?: string; mock?: boolean }) => {
    const resolution = await resolveProjectPath(opts);
    const provider = opts.mock ? 'mock' : opts.provider;
    await runShell({
      config: {
        projectPath: resolution.projectPath,
        provider,
        model: opts.model,
        mode: opts.mode as 'single' | 'multi',
        strategy: opts.strategy as ConvergenceStrategy,
        maxIterations: parseInt(opts.maxIterations),
        resolution,
        resume: opts.resume,
      },
      createRuntime: ({ projectPath, provider: shellProvider, model }) => {
        const { kernel, llmName, provider: resolvedProvider } = createKernel(projectPath, { provider: shellProvider, model });
        return { kernel, llmName, provider: resolvedProvider };
      },
    });
  });

program
  .command('sessions')
  .description('List saved Tik shell sessions')
  .option('-p, --project <path>', 'Explicit project or workspace path')
  .option('-t, --target <name>', 'Target project in workspace')
  .action(async (opts: { project?: string; target?: string }) => {
    const resolution = await resolveProjectPath(opts);
    const sessions = await listCliSessions(resolution.projectPath);

    console.log(chalk.bold('\n💾 Saved Sessions\n'));
    console.log(chalk.dim(`  Project: ${resolution.projectPath}\n`));

    if (sessions.length === 0) {
      console.log(chalk.yellow('  No saved shell sessions.\n'));
      return;
    }

    for (const session of sessions.slice().reverse()) {
      const lastTask = session.lastTaskId ? ` | last task: ${session.lastTaskId} (${session.lastTaskStatus || 'unknown'})` : '';
      console.log(`  ${chalk.cyan(session.sessionId)}  ${session.provider}  ${session.mode}  turns=${session.turns}  updated=${session.updatedAt}${lastTask}`);
    }
    console.log('');
  });

program
  .command('init')
  .description('Scaffold CLAUDE.md and AGENTS.md in the target project')
  .option('-p, --project <path>', 'Explicit project or workspace path')
  .option('-t, --target <name>', 'Target project in workspace')
  .option('--force', 'Overwrite existing instruction files')
  .action(async (opts: { project?: string; target?: string; force?: boolean }) => {
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const resolution = await resolveProjectPath(opts);

    const targets = [
      {
        path: path.join(resolution.projectPath, 'CLAUDE.md'),
        content: [
          '# Project Instructions',
          '',
          '- Describe the project goal and constraints here.',
          '- Capture preferred workflows, validation rules, and review expectations.',
          '- Keep this file concise and actionable for coding agents.',
          '',
        ].join('\n'),
      },
      {
        path: path.join(resolution.projectPath, 'AGENTS.md'),
        content: [
          '# Agent Instructions',
          '',
          '- List important roles, ownership boundaries, and handoff expectations.',
          '- Document repository conventions that planner/coder/reviewer should follow.',
          '- Add task-specific coordination notes as they stabilize.',
          '',
        ].join('\n'),
      },
    ];

    const created: string[] = [];

    for (const target of targets) {
      let exists = false;
      try {
        await fs.access(target.path);
        exists = true;
      } catch {
        exists = false;
      }

      if (exists && !opts.force) continue;
      await fs.mkdir(path.dirname(target.path), { recursive: true });
      await fs.writeFile(target.path, target.content, 'utf-8');
      created.push(target.path);
    }

    console.log(chalk.bold('\n🧭 Tik Init\n'));
    if (created.length === 0) {
      console.log(chalk.yellow('  Instruction files already exist. Use --force to rewrite them.\n'));
      return;
    }

    for (const file of created) {
      console.log(chalk.green(`  Created ${file}`));
    }
    console.log('');
  });

// ── tik run ──────────────────────────────────────────────────

program
  .command('run')
  .description('Submit and run a task')
  .argument('<description>', 'Task description')
  .option('-p, --project <path>', 'Explicit project or workspace path')
  .option('-t, --target <name>', 'Target project in workspace')
  .option('-s, --strategy <strategy>', 'Convergence strategy', 'incremental')
  .option('-m, --max-iterations <n>', 'Max iterations', '5')
  .option('--mode <mode>', 'Execution mode: single or multi', 'single')
  .option('--provider <provider>', interactiveProviderHelp, 'codex')
  .option('--model <model>', 'Override model name')
  .option('--mock', 'Force mock LLM (skip Claude API)')
  .addHelpText('after', `

Examples:
  tik run "实现用户认证" --provider claude
  tik run "给票务查询接口做缓存" --provider codex
  tik run "审查当前改动并总结风险" --provider codex-delegate
`)
  .action(async (description: string, opts: { project?: string; target?: string; strategy: string; maxIterations: string; mode: string; provider: ProviderOption; model?: string; mock?: boolean }) => {
    const resolution = await resolveProjectPath(opts);
    const provider = opts.mock ? 'mock' : opts.provider;
    const { kernel, llmName } = createKernel(resolution.projectPath, { provider, model: opts.model, stream: true });

    console.log(chalk.bold('\n🚀 Tik - Starting Task\n'));
    if (resolution.isWorkspace) {
      console.log(chalk.dim(`  Workspace: ${resolution.workspace!.name}`));
    }
    console.log(chalk.dim(`  Project: ${resolution.projectPath}`));
    console.log(chalk.dim(`  LLM: ${llmName} | Mode: ${opts.mode} | Strategy: ${opts.strategy} | Max: ${opts.maxIterations} iterations\n`));

    const unsub = kernel.eventBus.onAny((event: AgentEvent) => {
      displayEvent(event);
    });

    const spinner = ora('Executing task...').start();

    try {
      const result = await kernel.submitTask({
        description,
        projectPath: resolution.projectPath,
        strategy: opts.strategy as ConvergenceStrategy,
        maxIterations: parseInt(opts.maxIterations),
        mode: opts.mode as 'single' | 'multi',
      });

      spinner.stop();
      displayTaskResult(result);
    } catch (err) {
      spinner.fail(`Task failed: ${(err as Error).message}`);
    } finally {
      unsub();
      kernel.dispose();
    }
  });

// ── tik plan ─────────────────────────────────────────────────

program
  .command('plan')
  .description('Generate a plan without executing')
  .argument('<description>', 'Task description')
  .option('-p, --project <path>', 'Explicit project path')
  .option('-t, --target <name>', 'Target project in workspace')
  .option('--provider <provider>', planningProviderHelp, 'codex')
  .option('--model <model>', 'Override model name')
  .option('--mock', 'Force mock LLM')
  .addHelpText('after', `

Examples:
  tik plan "设计缓存方案" --provider claude
  tik plan "review this refactor" --provider codex
`)
  .action(async (description: string, opts: { project?: string; target?: string; provider: ProviderOption; model?: string; mock?: boolean }) => {
    const resolution = await resolveProjectPath(opts);
    const provider = opts.mock ? 'mock' : opts.provider;
    const { kernel } = createKernel(resolution.projectPath, { provider, model: opts.model });
    console.log(chalk.bold('\n📋 Generating Plan\n'));
    if (resolution.isWorkspace) {
      console.log(chalk.dim(`  Workspace: ${resolution.workspace!.name} | Project: ${resolution.projectPath}\n`));
    }
    const task = await kernel.planTask({ description, projectPath: resolution.projectPath });
    displayTask(task);
    kernel.dispose();
  });

// ── tik agent ────────────────────────────────────────────────

program
  .command('agent')
  .description('Manage agents')
  .argument('[subcommand]', 'Subcommand: list')
  .action(async (subcommand?: string) => {
    if (!subcommand || subcommand === 'list') {
      // List registered agents
      const resolution = await workspaceResolver.resolve(process.cwd());
      const { kernel } = createKernel(resolution.projectPath, { provider: 'mock' });

      console.log(chalk.bold('\n🤖 Registered Agents\n'));

      const agents = kernel.agentRegistry.list();
      if (agents.length === 0) {
        console.log(chalk.gray('  No agents registered.'));
      } else {
        for (const agent of agents) {
          console.log(`  ${chalk.cyan(agent.id.padEnd(12))} ${chalk.dim(agent.role.padEnd(10))} ${agent.metadata?.description || ''}`);
          if (agent.metadata?.version) {
            console.log(`  ${' '.repeat(12)} ${chalk.gray(`v${agent.metadata.version}`)}`);
          }
        }
      }
      console.log('');
      kernel.dispose();
    } else {
      console.log(chalk.red(`\n  Unknown subcommand: ${subcommand}`));
      console.log(chalk.dim('  Available: list\n'));
    }
  });

// ── tik workspace ────────────────────────────────────────────

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
    const resolution = await resolveProjectPath(opts);
    if (!resolution.workspace) {
      console.log(chalk.red('\n  Worktree management requires a .code-workspace root.\n'));
      return;
    }

    const snapshot = await workspaceOrchestrator.getStatus(resolution.workspace.rootPath);
    if (!snapshot.state || !snapshot.settings) {
      console.log(chalk.yellow('\n  Workspace state not initialized yet. Run `tik workspace run --demand \"...\"` first.\n'));
      return;
    }

    const projects = ((snapshot.state.projects || []) as WorkspaceProjectSnapshot[]);
    if (projects.length === 0) {
      console.log(chalk.yellow('\n  No active workspace projects found.\n'));
      return;
    }

    const selectedProject = selectWorkspaceProjectSnapshot(projects, resolution.projectPath, opts.target);
    const entries = await workspaceWorktreeManager.listManagedWorktrees({
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

    const selectedEntry = selectManagedWorktreeEntry(
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
      const target = await workspaceWorktreeManager.getExecutionTarget({
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
        await workspaceOrchestrator.markProjectWorktreeReady(resolution.workspace.rootPath, selectedProject.projectName, {
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
      await workspaceOrchestrator.activateProjectWorktreeLane(
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
      const removed = await workspaceWorktreeManager.removeManagedWorktree({
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
        await workspaceOrchestrator.markProjectWorktreeRemoved(resolution.workspace.rootPath, selectedProject.projectName, {
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

program
  .command('workspace')
  .alias('ws')
  .description('Show workspace info or run Workspace SDD Phase 0 split')
  .argument('[subcommand]', 'Subcommand: info, run, status, board, next, clarify, specify, plan-phase, ace, feedback, report, retry, policy, decisions, decide')
  .option('--demand <text>', 'Workspace-level demand to split into project tasks')
  .option('-p, --project <path>', 'Explicit project or workspace path')
  .option('-t, --target <name>', 'Target project in workspace')
  .option('--workflow-profile <profile>', 'Workflow policy profile: balanced, fast-feedback, deep-verify')
  .option('--non-git <strategy>', 'Worktree policy for non-git projects: block, source, copy')
  .option('--message <text>', 'Workspace feedback message')
  .option('--projects <names>', 'Comma-separated project names for workspace feedback')
  .option('--next-phase <phase>', 'Next phase after feedback: PARALLEL_CLARIFY, PARALLEL_SPECIFY, PARALLEL_PLAN, or PARALLEL_ACE', 'PARALLEL_PLAN')
  .option('--id <decisionId>', 'Workspace decision id')
  .option('--option <optionId>', 'Workspace decision option id')
  .option('--provider <provider>', interactiveProviderHelp, 'codex')
  .option('--model <model>', 'Override model name')
  .option('--mock', 'Force mock LLM')
  .action(async (subcommand: string | undefined, opts: { demand?: string; project?: string; target?: string; workflowProfile?: string; nonGit?: string; message?: string; projects?: string; nextPhase?: 'PARALLEL_CLARIFY' | 'PARALLEL_SPECIFY' | 'PARALLEL_PLAN' | 'PARALLEL_ACE'; id?: string; option?: string; provider: ProviderOption; model?: string; mock?: boolean }) => {
    let command = subcommand || 'info';
    const autoAdvance = command === 'next';
    let implicitProjects = opts.projects;
    const resolution = await resolveProjectPath(opts);
    try {
    const workflowPolicy = resolveWorkspacePolicyOption(opts.workflowProfile);
    const worktreePolicy = resolveWorkspaceWorktreePolicyOption(opts.nonGit);
    while (true) {

    if (command === 'run') {
      if (!resolution.workspace) {
        console.log(chalk.red('\n  Workspace run requires a .code-workspace root.\n'));
        return;
      }
      if (!opts.demand) {
        console.log(chalk.red('\n  Missing --demand for workspace run.\n'));
        return;
      }

      const snapshot = await workspaceOrchestrator.bootstrap({
        resolution,
        demand: opts.demand,
        workflowPolicy,
      });

      console.log(chalk.bold('\n🧩 Workspace Split Initialized\n'));
      console.log(chalk.dim(`  Workspace: ${resolution.workspace.name}`));
      console.log(chalk.dim(`  Root: ${resolution.workspace.rootPath}`));
      console.log(chalk.dim(`  File: ${resolution.workspace.workspaceFile}`));
      console.log(chalk.dim(`  Active Project: ${resolution.projectPath}`));
      console.log(chalk.dim(`  Phase: ${snapshot.state?.currentPhase || 'WORKSPACE_SPLIT'}\n`));
      if (snapshot.settings?.workflowPolicy?.profile) {
        console.log(chalk.dim(`  Workflow Profile: ${snapshot.settings.workflowPolicy.profile}\n`));
      }
      console.log(chalk.bold('  Project Demand Mapping:'));
      for (const item of snapshot.splitDemands?.items || []) {
        console.log(`    ${chalk.cyan(item.projectName)}  ${chalk.dim(item.reason)}`);
      }
      console.log('');
      console.log(chalk.dim(`  Wrote ${resolution.workspace.rootPath}/.workspace/settings.json`));
      console.log(chalk.dim(`  Wrote ${resolution.workspace.rootPath}/.workspace/state.json`));
      console.log(chalk.dim(`  Wrote ${resolution.workspace.rootPath}/.workspace/split-demands.json\n`));
      console.log(chalk.bold('  Next step:'));
      console.log(chalk.dim(`    tik workspace next --provider ${((opts as any).mock ? 'mock' : (opts as any).provider)}\n`));
      return;
    }

    if (command === 'status') {
      if (!resolution.workspace) {
        console.log(chalk.red('\n  Workspace status requires a .code-workspace root.\n'));
        return;
      }

      const snapshot = await workspaceOrchestrator.getStatus(resolution.workspace.rootPath);
      printWorkspaceStatus(snapshot, resolution.workspace.rootPath, opts.projects);
      return;
    }

    if (command === 'board') {
      if (!resolution.workspace) {
        console.log(chalk.red('\n  Workspace board requires a .code-workspace root.\n'));
        return;
      }
      const snapshot = await workspaceOrchestrator.getStatus(resolution.workspace.rootPath);
      printWorkspaceBoard(snapshot, resolution.workspace.rootPath, opts.projects);
      return;
    }

    if (command === 'next') {
      if (!resolution.workspace) {
        console.log(chalk.red('\n  Workspace next requires a .code-workspace root.\n'));
        return;
      }
      const snapshot = await workspaceOrchestrator.getStatus(resolution.workspace.rootPath);
      const nextPhase = snapshot.state?.currentPhase;
      if (!nextPhase) {
        console.log(chalk.yellow('\n  No workspace phase found. Run `tik workspace run --demand "..."` first.\n'));
        return;
      }
      if (nextPhase === 'PARALLEL_CLARIFY' || nextPhase === 'PARALLEL_SPECIFY' || nextPhase === 'PARALLEL_PLAN' || nextPhase === 'PARALLEL_ACE') {
        command = workspacePhaseToCommand(nextPhase);
      }
      else if (nextPhase === 'FEEDBACK_ITERATION') {
        const feedbackNext = snapshot.state?.workspaceFeedback?.nextPhase;
        const pendingDecisions = getPendingWorkspaceDecisions(snapshot.state);
        if (pendingDecisions.length > 0) {
          console.log(chalk.yellow('\n  Workspace is waiting on human decisions.\n'));
          console.log(chalk.dim('  Review `tik workspace decisions` and use `tik workspace decide --id ... --option ... [--message ...]`.\n'));
          return;
        }
        if (!feedbackNext) {
          console.log(chalk.yellow('\n  Workspace is in FEEDBACK_ITERATION.\n'));
          console.log(chalk.dim('  Review `tik workspace status` and use `tik workspace feedback --message ... --projects ... --next-phase PARALLEL_CLARIFY|PARALLEL_SPECIFY|PARALLEL_PLAN|PARALLEL_ACE`.\n'));
          return;
        }
        if (!implicitProjects && snapshot.state?.workspaceFeedback?.affectedProjects?.length) {
          implicitProjects = snapshot.state.workspaceFeedback.affectedProjects.join(',');
        }
        await workspaceOrchestrator.clearFeedback(resolution.workspace.rootPath, feedbackNext);
        command = workspacePhaseToCommand(feedbackNext);
      }
      else if (nextPhase === 'COMPLETED') {
        console.log(chalk.green('\n  Workspace flow is already completed.\n'));
        return;
      }
    }

    if (command === 'retry') {
      if (!resolution.workspace) {
        console.log(chalk.red('\n  Workspace retry requires a .code-workspace root.\n'));
        return;
      }
      const snapshot = await workspaceOrchestrator.getStatus(resolution.workspace.rootPath);
      const retryPhase = snapshot.state?.workspaceFeedback?.nextPhase || snapshot.state?.currentPhase;
      if (getPendingWorkspaceDecisions(snapshot.state).length > 0) {
        console.log(chalk.yellow('\n  Workspace retry is blocked by pending human decisions.\n'));
        console.log(chalk.dim('  Resolve them first with `tik workspace decisions` and `tik workspace decide --id ...`.\n'));
        return;
      }
      if (!retryPhase || retryPhase === 'FEEDBACK_ITERATION' || retryPhase === 'COMPLETED' || retryPhase === 'WORKSPACE_SPLIT') {
        console.log(chalk.yellow('\n  No retryable workspace phase found.\n'));
        console.log(chalk.dim('  Use `tik workspace status` to inspect the current phase and feedback.\n'));
        return;
      }
      if (snapshot.state?.workspaceFeedback?.required && (retryPhase === 'PARALLEL_CLARIFY' || retryPhase === 'PARALLEL_SPECIFY' || retryPhase === 'PARALLEL_PLAN' || retryPhase === 'PARALLEL_ACE')) {
        if (!implicitProjects && snapshot.state.workspaceFeedback.affectedProjects?.length) {
          implicitProjects = snapshot.state.workspaceFeedback.affectedProjects.join(',');
        }
        await workspaceOrchestrator.clearFeedback(resolution.workspace.rootPath, retryPhase);
      }
      command = workspacePhaseToCommand(retryPhase as 'PARALLEL_CLARIFY' | 'PARALLEL_SPECIFY' | 'PARALLEL_PLAN' | 'PARALLEL_ACE');
    }

    if (command === 'report') {
      if (!resolution.workspace) {
        console.log(chalk.red('\n  Workspace report requires a .code-workspace root.\n'));
        return;
      }
      const snapshot = await workspaceOrchestrator.getStatus(resolution.workspace.rootPath);
      printWorkspaceReport(snapshot, resolution.workspace.rootPath, opts.projects);
      return;
    }

    if (command === 'policy') {
      if (!resolution.workspace) {
        console.log(chalk.red('\n  Workspace policy requires a .code-workspace root.\n'));
        return;
      }
      if (workflowPolicy || worktreePolicy) {
        let snapshot = await workspaceOrchestrator.getStatus(resolution.workspace.rootPath);
        if (workflowPolicy) {
          snapshot = await workspaceOrchestrator.updateWorkflowPolicy(
            resolution.workspace.rootPath,
            workflowPolicy,
          );
        }
        if (worktreePolicy) {
          snapshot = await workspaceOrchestrator.updateWorktreePolicy(
            resolution.workspace.rootPath,
            worktreePolicy,
          );
        }
        const policy = snapshot.settings?.workflowPolicy;
        const worktree = snapshot.settings?.worktreePolicy;
        console.log(chalk.bold('\n🧪 Workspace Policy Updated\n'));
        if (policy?.profile) {
          console.log(chalk.dim(`  Workflow Profile: ${policy.profile}`));
        }
        if (policy?.phaseBudgetsMs) {
          console.log(chalk.dim(`  Phase Budgets: clarify=${policy.phaseBudgetsMs.PARALLEL_CLARIFY}ms, specify=${policy.phaseBudgetsMs.PARALLEL_SPECIFY}ms, plan=${policy.phaseBudgetsMs.PARALLEL_PLAN}ms, ace=${policy.phaseBudgetsMs.PARALLEL_ACE}ms`));
        }
        if (worktree) {
          console.log(chalk.dim(`  Worktree Mode: ${worktree.mode || 'managed'}`));
          console.log(chalk.dim(`  Non-git Strategy: ${worktree.nonGitStrategy || 'source'}`));
        }
        console.log('');
        return;
      }
      const snapshot = await workspaceOrchestrator.getStatus(resolution.workspace.rootPath);
      const policy = snapshot.settings?.workflowPolicy;
      const worktree = snapshot.settings?.worktreePolicy;
      console.log(chalk.bold('\n🧪 Workspace Policy\n'));
      if (policy?.profile) {
        console.log(chalk.dim(`  Workflow Profile: ${policy.profile}`));
      }
      if (policy?.phaseBudgetsMs) {
        console.log(chalk.dim(`  Phase Budgets: clarify=${policy.phaseBudgetsMs.PARALLEL_CLARIFY}ms, specify=${policy.phaseBudgetsMs.PARALLEL_SPECIFY}ms, plan=${policy.phaseBudgetsMs.PARALLEL_PLAN}ms, ace=${policy.phaseBudgetsMs.PARALLEL_ACE}ms`));
      }
      if (policy?.maxFeedbackRetriesPerPhase) {
        console.log(chalk.dim(`  Feedback Retries: clarify=${policy.maxFeedbackRetriesPerPhase.PARALLEL_CLARIFY}, specify=${policy.maxFeedbackRetriesPerPhase.PARALLEL_SPECIFY}, plan=${policy.maxFeedbackRetriesPerPhase.PARALLEL_PLAN}, ace=${policy.maxFeedbackRetriesPerPhase.PARALLEL_ACE}`));
      }
      if (worktree) {
        console.log(chalk.dim(`  Worktree Mode: ${worktree.mode || 'managed'}`));
        console.log(chalk.dim(`  Worktree Root: ${worktree.worktreeRoot || path.join(resolution.workspace.rootPath, '.workspace', 'worktrees')}`));
        console.log(chalk.dim(`  Non-git Strategy: ${worktree.nonGitStrategy || 'source'}`));
      }
      console.log('');
      return;
    }

    if (command === 'decisions') {
      if (!resolution.workspace) {
        console.log(chalk.red('\n  Workspace decisions requires a .code-workspace root.\n'));
        return;
      }
      const snapshot = await workspaceOrchestrator.getStatus(resolution.workspace.rootPath);
      printWorkspaceDecisions(snapshot);
      return;
    }

    if (command === 'decide') {
      if (!resolution.workspace) {
        console.log(chalk.red('\n  Workspace decide requires a .code-workspace root.\n'));
        return;
      }
      if (!opts.id) {
        console.log(chalk.red('\n  Missing --id for workspace decide.\n'));
        return;
      }
      const snapshot = await workspaceOrchestrator.resolveDecision(
        resolution.workspace.rootPath,
        {
          decisionId: opts.id,
          optionId: opts.option,
          message: opts.message,
        },
      );
      const resolved = snapshot.state?.decisions?.find((decision) => decision.id === opts.id);
      console.log(chalk.bold('\n🪄 Workspace Decision Recorded\n'));
      if (resolved?.title) console.log(chalk.dim(`  Decision: ${resolved.title}`));
      if (resolved?.resolution?.optionId) console.log(chalk.dim(`  Option: ${resolved.resolution.optionId}`));
      if (resolved?.resolution?.nextPhase) console.log(chalk.dim(`  Next phase: ${resolved.resolution.nextPhase}`));
      if (resolved?.resolution?.message) console.log(chalk.dim(`  Message: ${resolved.resolution.message}`));
      console.log(chalk.dim('\n  Continue with: tik workspace next\n'));
      return;
    }

    if (command === 'clarify') {
      if (!resolution.workspace) {
        console.log(chalk.red('\n  Workspace clarify requires a .code-workspace root.\n'));
        return;
      }
      const provider = (opts as any).mock ? 'mock' : (opts as any).provider;
      const snapshot = await workspaceOrchestrator.getStatus(resolution.workspace.rootPath);
      const selectedProjectNames = parseProjectNames(implicitProjects);
      if (snapshot.state?.workspaceFeedback?.required && selectedProjectNames.length === 0) {
        await workspaceOrchestrator.clearFeedback(resolution.workspace.rootPath, 'PARALLEL_CLARIFY');
      }
      const items = selectWorkspaceItems(
        snapshot,
        selectedProjectNames.length > 0
          ? implicitProjects
          : snapshot.state?.workspaceFeedback?.affectedProjects?.join(','),
      );
      if (items.length === 0) {
        console.log(chalk.red('\n  No matching workspace projects found for clarify.\n'));
        return;
      }
      console.log(chalk.bold('\n🧭 Parallel Clarify\n'));
      printWorkspacePhaseKickoff('Parallel Clarify', resolution.workspace.rootPath, provider, items, provider);
      const engine = createWorkspaceWorkflowEngineInstance(resolution.workspace.rootPath, snapshot.settings?.workflowPolicy);
      const outcome = await engine.runPhase({
        phase: 'PARALLEL_CLARIFY',
        resolution: { workspace: resolution.workspace },
        snapshot: snapshot as any,
        items,
        provider,
        model: (opts as any).model,
        autoAdvance,
        reporter: createWorkspacePhaseReporter(),
      });
      for (const result of outcome.projectResults) {
        if (result.status === 'completed') {
          console.log(`  ${chalk.cyan(result.projectName)} -> ${chalk.dim(result.outputPath || '')} ${chalk.gray('(mode=native)')}`);
        } else {
          console.log(`  ${chalk.yellow(result.projectName)} -> ${chalk.dim(result.outputPath || '')} ${chalk.red(result.reasonLabel || '(clarification required)')}`);
        }
      }
      console.log('');
      if (!autoAdvance) return;
      if (outcome.completed) {
        console.log(chalk.green('  Workspace flow completed.\n'));
        return;
      }
      if (outcome.requiresFeedback) {
        console.log(chalk.yellow('  Workspace flow requires clarification decisions before continuing.\n'));
        return;
      }
      if (outcome.nextPhase) {
        command = workspacePhaseToCommand(outcome.nextPhase);
        console.log(chalk.dim(`  Auto-advancing to ${outcome.nextPhase}...\n`));
        continue;
      }
      return;
    }

    if (command === 'specify') {
      if (!resolution.workspace) {
        console.log(chalk.red('\n  Workspace specify requires a .code-workspace root.\n'));
        return;
      }
      const provider = (opts as any).mock ? 'mock' : (opts as any).provider;
      const phaseProvider = resolveWorkspacePhaseProvider(provider, 'PARALLEL_SPECIFY');
      const snapshot = await workspaceOrchestrator.getStatus(resolution.workspace.rootPath);
      const items = selectWorkspaceItems(snapshot, implicitProjects);
      if (items.length === 0) {
        console.log(chalk.red('\n  No matching workspace projects found for specify.\n'));
        return;
      }

      console.log(chalk.bold('\n📝 Parallel Specify\n'));
      printWorkspacePhaseKickoff('Parallel Specify', resolution.workspace.rootPath, provider, items, phaseProvider);
      const engine = createWorkspaceWorkflowEngineInstance(resolution.workspace.rootPath, snapshot.settings?.workflowPolicy);
      const outcome = await engine.runPhase({
        phase: 'PARALLEL_SPECIFY',
        resolution: { workspace: resolution.workspace },
        snapshot: snapshot as any,
        items,
        provider,
        model: (opts as any).model,
        autoAdvance,
        reporter: createWorkspacePhaseReporter(),
      });
      for (const result of outcome.projectResults) {
        if (result.status === 'completed') {
          const modeLabel = result.reused ? 'reused' : 'mode=native';
          console.log(`  ${chalk.cyan(result.projectName)} -> ${chalk.dim(result.outputPath || '')} ${chalk.gray(`(${modeLabel})`)}`);
        } else {
          console.log(`  ${chalk.yellow(result.projectName)} -> ${chalk.dim(result.outputPath || '')} ${chalk.red(result.reasonLabel || '(blocked)')}`);
        }
      }
      console.log('');
      if (!autoAdvance) return;
      if (outcome.completed) {
        console.log(chalk.green('  Workspace flow completed.\n'));
        return;
      }
      if (outcome.requiresFeedback) {
        console.log(chalk.yellow('  Workspace flow requires feedback before continuing.\n'));
        return;
      }
      if (outcome.nextPhase) {
        command = workspacePhaseToCommand(outcome.nextPhase);
        console.log(chalk.dim(`  Auto-advancing to ${outcome.nextPhase}...\n`));
        continue;
      }
      return;
    }

    if (command === 'plan-phase') {
      if (!resolution.workspace) {
        console.log(chalk.red('\n  Workspace plan-phase requires a .code-workspace root.\n'));
        return;
      }
      const provider = (opts as any).mock ? 'mock' : (opts as any).provider;
      const phaseProvider = resolveWorkspacePhaseProvider(provider, 'PARALLEL_PLAN');
      const snapshot = await workspaceOrchestrator.getStatus(resolution.workspace.rootPath);
      const selectedProjectNames = parseProjectNames(implicitProjects);
      if (snapshot.state?.workspaceFeedback?.required) {
        await workspaceOrchestrator.clearFeedback(resolution.workspace.rootPath, 'PARALLEL_PLAN');
      }
      const items = selectWorkspaceItems(
        snapshot,
        selectedProjectNames.length > 0
          ? implicitProjects
          : snapshot.state?.workspaceFeedback?.affectedProjects?.join(','),
      );
      const projectStateByName = new Map((snapshot.state?.projects || []).map((project) => [project.projectName, project]));
      if (items.length === 0) {
        console.log(chalk.red('\n  No matching workspace projects found for plan-phase.\n'));
        return;
      }

      console.log(chalk.bold('\n🗺 Parallel Plan\n'));
      printWorkspacePhaseKickoff('Parallel Plan', resolution.workspace.rootPath, provider, items, phaseProvider);
      const engine = createWorkspaceWorkflowEngineInstance(resolution.workspace.rootPath, snapshot.settings?.workflowPolicy);
      const outcome = await engine.runPhase({
        phase: 'PARALLEL_PLAN',
        resolution: { workspace: resolution.workspace },
        snapshot: snapshot as any,
        items,
        provider,
        model: (opts as any).model,
        autoAdvance,
        reporter: createWorkspacePhaseReporter(),
      });
      for (const result of outcome.projectResults) {
        if (result.status === 'completed') {
          const modeLabel = result.reused ? 'reused' : 'mode=native';
          console.log(`  ${chalk.cyan(result.projectName)} -> ${chalk.dim(result.outputPath || '')} ${chalk.gray(`(${modeLabel})`)}`);
        } else {
          console.log(`  ${chalk.yellow(result.projectName)} -> ${chalk.dim(result.outputPath || '')} ${chalk.red(result.reasonLabel || '(blocked)')}`);
        }
      }
      console.log('');
      if (!autoAdvance) return;
      if (outcome.completed) {
        console.log(chalk.green('  Workspace flow completed.\n'));
        return;
      }
      if (outcome.requiresFeedback) {
        console.log(chalk.yellow('  Workspace flow requires feedback before continuing.\n'));
        return;
      }
      if (outcome.nextPhase) {
        command = workspacePhaseToCommand(outcome.nextPhase);
        console.log(chalk.dim(`  Auto-advancing to ${outcome.nextPhase}...\n`));
        continue;
      }
      return;
    }

    if (command === 'ace') {
      if (!resolution.workspace) {
        console.log(chalk.red('\n  Workspace ace requires a .code-workspace root.\n'));
        return;
      }
      const provider = (opts as any).mock ? 'mock' : (opts as any).provider;
      const phaseProvider = resolveWorkspacePhaseProvider(provider, 'PARALLEL_ACE');
      const snapshot = await workspaceOrchestrator.getStatus(resolution.workspace.rootPath);
      const selectedProjectNames = parseProjectNames(implicitProjects);
      if (snapshot.state?.workspaceFeedback?.required && snapshot.state.workspaceFeedback.affectedProjects?.length === 0) {
        await workspaceOrchestrator.clearFeedback(resolution.workspace.rootPath, 'PARALLEL_ACE');
      }
      const items = selectWorkspaceItems(
        snapshot,
        selectedProjectNames.length > 0
          ? implicitProjects
          : snapshot.state?.workspaceFeedback?.affectedProjects?.join(','),
      );
      if (items.length === 0) {
        console.log(chalk.red('\n  No matching workspace projects found for ACE.\n'));
        return;
      }
      console.log(chalk.bold('\n⚙ Parallel ACE\n'));
      printWorkspacePhaseKickoff('Parallel ACE', resolution.workspace.rootPath, provider, items, phaseProvider);
      const engine = createWorkspaceWorkflowEngineInstance(resolution.workspace.rootPath, snapshot.settings?.workflowPolicy);
      const outcome = await engine.runPhase({
        phase: 'PARALLEL_ACE',
        resolution: { workspace: resolution.workspace },
        snapshot: snapshot as any,
        items,
        provider,
        model: (opts as any).model,
        autoAdvance,
        reporter: createWorkspacePhaseReporter(),
      });
      for (const result of outcome.projectResults) {
        if (result.status === 'completed') {
          console.log(`  ${chalk.cyan(result.projectName)} -> completed ${chalk.dim(result.taskId || '')} ${chalk.gray('(mode=native)')}`);
        } else {
          console.log(`  ${chalk.yellow(result.projectName)} -> ${chalk.dim(result.taskId || '')} ${chalk.red(result.reasonLabel || '(blocked)')}`);
        }
      }
      console.log('');
      if (!autoAdvance) return;
      if (outcome.completed) {
        console.log(chalk.green('  Workspace flow completed.\n'));
        return;
      }
      if (outcome.requiresFeedback) {
        console.log(chalk.yellow('  Workspace flow requires feedback before continuing.\n'));
        return;
      }
      if (outcome.nextPhase) {
        command = workspacePhaseToCommand(outcome.nextPhase);
        console.log(chalk.dim(`  Auto-advancing to ${outcome.nextPhase}...\n`));
        continue;
      }
      return;
    }

    if (command === 'feedback') {
      if (!resolution.workspace) {
        console.log(chalk.red('\n  Workspace feedback requires a .code-workspace root.\n'));
        return;
      }
      if (!opts.message) {
        console.log(chalk.red('\n  Missing --message for workspace feedback.\n'));
        return;
      }
      const affectedProjects = (opts.projects || '')
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean);
      const nextPhase = opts.nextPhase === 'PARALLEL_ACE'
        ? 'PARALLEL_ACE'
        : opts.nextPhase === 'PARALLEL_CLARIFY'
          ? 'PARALLEL_CLARIFY'
        : opts.nextPhase === 'PARALLEL_SPECIFY'
          ? 'PARALLEL_SPECIFY'
          : 'PARALLEL_PLAN';
      await workspaceOrchestrator.recordFeedback(
        resolution.workspace.rootPath,
        opts.message,
        affectedProjects,
        nextPhase,
      );
      console.log(chalk.bold('\n🪄 Workspace Feedback Recorded\n'));
      console.log(chalk.dim(`  Next phase: ${nextPhase}`));
      console.log(chalk.dim(`  Affected projects: ${affectedProjects.join(', ') || '(none)'}`));
      console.log(chalk.dim(`  Message: ${opts.message}\n`));
      return;
    }

    if (command !== 'info') {
      console.log(chalk.red(`\n  Unknown workspace subcommand: ${command}`));
      console.log(chalk.dim('  Available: info, run, status, board, next, clarify, specify, plan-phase, ace, feedback, report, retry, policy, decisions, decide\n'));
      return;
    }

    if (!resolution.workspace) {
      console.log(chalk.bold('\n📁 No Workspace\n'));
      console.log(chalk.dim('  No .code-workspace file found.'));
      console.log(chalk.dim(`  Current directory: ${process.cwd()}\n`));
      console.log(chalk.dim('  Create a .code-workspace file to enable multi-project mode.\n'));
      return;
    }

    const ws = resolution.workspace;
    console.log(chalk.bold(`\n📁 Workspace: ${ws.name}\n`));
    console.log(`  Root:  ${ws.rootPath}`);
    console.log(`  File:  ${ws.workspaceFile}`);
    console.log('');
    console.log(chalk.bold('  Projects:'));
    for (const p of ws.projects) {
      const isCurrent = resolution.projectPath === p.path;
      const marker = isCurrent ? chalk.green(' ← active') : '';
      console.log(`    ${chalk.cyan(p.name.padEnd(20))} ${chalk.dim(p.path)}${marker}`);
    }
    console.log('');
    if (ws.config.strategy || ws.config.maxIterations) {
      console.log(chalk.bold('  Config:'));
      if (ws.config.strategy) console.log(`    Strategy: ${ws.config.strategy}`);
      if (ws.config.maxIterations) console.log(`    Max iterations: ${ws.config.maxIterations}`);
      console.log('');
    }
    return;
    }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.log(chalk.red(`\n  Workspace command failed: ${message}\n`));
      return;
    }
  });

// ── tik status ───────────────────────────────────────────────

program
  .command('status')
  .description('Check task status')
  .argument('[taskId]', 'Task ID')
  .option('--api <url>', 'API server URL', 'http://localhost:3000')
  .action(async (taskId: string | undefined, opts: { api: string }) => {
    console.log(chalk.bold('\n📌 Task Status\n'));
    try {
      if (taskId) {
        const res = await fetch(`${opts.api}/api/tasks/${taskId}`);
        if (!res.ok) { console.log(chalk.red(`  Task ${taskId} not found`)); return; }
        displayTask(await res.json() as any);
      } else {
        const res = await fetch(`${opts.api}/api/tasks`);
        const tasks = await res.json() as any[];
        if (tasks.length === 0) {
          console.log(chalk.gray('  No tasks. Submit one with: tik run "<description>"'));
        } else {
          for (const task of tasks) displayTask(task);
        }
      }
    } catch {
      console.log(chalk.yellow('  Cannot connect to API server. Start with: tik serve'));
    }
  });

// ── tik logs ─────────────────────────────────────────────────

program
  .command('logs')
  .description('Stream execution events')
  .argument('<taskId>', 'Task ID')
  .option('--api <url>', 'API server URL', 'http://localhost:3000')
  .action(async (taskId: string, opts: { api: string }) => {
    console.log(chalk.bold(`\n📜 Event Stream: ${taskId}\n`));
    try {
      const response = await fetch(`${opts.api}/api/tasks/${taskId}/events`);
      if (!response.body) { console.log(chalk.red('  No stream')); return; }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        for (const line of decoder.decode(value).split('\n')) {
          if (line.startsWith('data: ')) {
            try { displayEvent(JSON.parse(line.slice(6))); } catch {}
          }
        }
      }
    } catch {
      console.log(chalk.red('  Connection failed. Start server with: tik serve'));
    }
  });

// ── tik eval ─────────────────────────────────────────────────

program
  .command('eval')
  .description('View evaluation metrics')
  .argument('<taskId>', 'Task ID')
  .option('--api <url>', 'API server URL', 'http://localhost:3000')
  .action(async (taskId: string, opts: { api: string }) => {
    console.log(chalk.bold(`\n📊 Evaluation: ${taskId}\n`));
    try {
      const res = await fetch(`${opts.api}/api/tasks/${taskId}`);
      if (!res.ok) { console.log(chalk.red('  Task not found')); return; }
      const task = await res.json() as any;
      for (const iter of (task.iterations || [])) {
        const e = iter.evaluation;
        console.log(`  Iteration ${iter.number}: fitness=${chalk.green(e.fitness.toFixed(3))} drift=${e.drift.toFixed(2)} entropy=${e.entropy.toFixed(3)}`);
      }
    } catch {
      console.log(chalk.yellow('  Cannot connect to API server. Start with: tik serve'));
    }
  });

// ── tik stop ─────────────────────────────────────────────────

program
  .command('stop')
  .description('Stop a running task')
  .argument('<taskId>', 'Task ID')
  .option('--api <url>', 'API server URL', 'http://localhost:3000')
  .action(async (taskId: string, opts: { api: string }) => {
    try {
      const res = await fetch(`${opts.api}/api/tasks/${taskId}/control`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'stop' }),
      });
      console.log(res.ok ? chalk.green('\n  Task stopped') : chalk.red(`\n  Failed: ${(await res.json() as any).error}`));
    } catch {
      console.log(chalk.yellow('\n  Cannot connect to API server.'));
    }
  });

// ── tik list ─────────────────────────────────────────────────

program
  .command('list')
  .description('List all tasks')
  .option('--api <url>', 'API server URL', 'http://localhost:3000')
  .action(async (opts: { api: string }) => {
    console.log(chalk.bold('\n📋 Tasks\n'));
    try {
      const tasks = await (await fetch(`${opts.api}/api/tasks`)).json() as any[];
      if (tasks.length === 0) { console.log(chalk.gray('  No tasks.')); }
      else {
        for (const t of tasks) {
          const c = (t.status === 'converged' || t.status === 'completed')
            ? chalk.green
            : t.status === 'failed'
              ? chalk.red
              : chalk.cyan;
          console.log(`  ${c(t.status.padEnd(12))} ${t.id}  ${chalk.dim(t.description)}`);
        }
      }
    } catch {
      console.log(chalk.gray('  No tasks. Submit one with: tik run "<description>"'));
    }
  });

// ── tik update ───────────────────────────────────────────────

program
  .command('update')
  .description('Rebuild tik from source')
  .action(async () => {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const { fileURLToPath } = await import('node:url');
    const path = await import('node:path');
    const execFileAsync = promisify(execFile);

    // Resolve tik project root (cli/dist/index.js → cli → packages → tik root)
    const cliDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
    const tikRoot = path.resolve(cliDir, '../..');

    console.log(chalk.bold('\n🔄 Updating Tik\n'));
    console.log(chalk.dim(`  Source: ${tikRoot}\n`));

    try {
      const spinner = ora('Installing dependencies...').start();
      await execFileAsync('pnpm', ['install'], { cwd: tikRoot, timeout: 60_000 });
      spinner.text = 'Building packages...';
      const { stdout } = await execFileAsync('pnpm', ['build'], { cwd: tikRoot, timeout: 120_000 });
      spinner.stop();

      const match = stdout.match(/Tasks:\s+(\d+) successful/);
      console.log(chalk.green(`  ✅ Build complete (${match ? match[1] : '?'} packages)`));
      console.log(chalk.dim('  tik command is now up to date.\n'));
    } catch (err) {
      console.log(chalk.red(`  Build failed: ${(err as Error).message}`));
    }
  });

// ── tik serve ────────────────────────────────────────────────

program
  .command('serve')
  .description('Start the API server')
  .option('-p, --port <port>', 'Port', '3000')
  .option('--project <path>', 'Default project/workspace root', process.cwd())
  .option('--provider <provider>', serverProviderHelp, 'codex')
  .option('--model <model>', 'Override model name')
  .option('--mock', 'Force mock LLM')
  .addHelpText('after', `

Examples:
  tik serve --provider claude
  tik serve --provider codex
`)
  .action(async (opts: { port: string; project: string; provider: ProviderOption; model?: string; mock?: boolean }) => {
    const provider = opts.mock ? 'mock' : opts.provider;
    const { kernel, llmName } = createKernel(opts.project, { provider, model: opts.model });
    const { createServer } = await import('@tik/kernel');

    console.log(chalk.bold('\n🌐 Tik Workbench Server\n'));
    console.log(chalk.dim(`  LLM: ${llmName}`));
    console.log(chalk.dim(`  Workspace root: ${opts.project}`));

    await createServer(kernel, { port: parseInt(opts.port), host: '0.0.0.0' }, { workspaceRoot: opts.project });

    console.log(chalk.green(`  API: http://localhost:${opts.port}`));
    console.log(chalk.dim('  Workbench UI expects the dashboard dev server on http://localhost:5173'));
    console.log(chalk.dim('  Press Ctrl+C to stop\n'));
  });

// ─── Parse & Run ─────────────────────────────────────────────

const argv = process.argv.slice(2);

if (argv.length === 0) {
  program.parse([process.argv[0] ?? 'node', process.argv[1] ?? 'tik', 'shell']);
} else {
  program.parse();
}

function printWorkspaceStatus(snapshot: WorkspaceStatusSnapshot, rootPath: string, projects?: string): void {
  const eventProjection = loadWorkspaceEventProjection(rootPath);
  console.log(chalk.bold('\n🗂 Workspace Status\n'));
  console.log(chalk.dim(`  Root: ${rootPath}`));

  if (!snapshot.state && !snapshot.settings && !snapshot.splitDemands) {
    console.log(chalk.yellow('\n  No .workspace state found. Run `tik workspace run --demand "..."` first.\n'));
    return;
  }

  if (snapshot.state) {
    console.log(chalk.dim(`  Phase: ${snapshot.state.currentPhase}`));
    console.log(chalk.dim(`  Active Projects: ${snapshot.state.activeProjectNames.join(', ') || '(none)'}`));
  }
  const workflowProfile = snapshot.settings?.workflowPolicy?.profile;
  if (workflowProfile) {
    console.log(chalk.dim(`  Workflow Profile: ${workflowProfile}`));
  }

  const visibleItems = selectWorkspaceItems(snapshot, projects);
  const selectedProjectNames = new Set(visibleItems.map((item) => item.projectName));

  if (visibleItems.length) {
    console.log(chalk.bold('\n  Split Demands:'));
    for (const item of visibleItems) {
      console.log(`    ${chalk.cyan(item.projectName)}  ${item.status}  ${chalk.dim(item.reason)}`);
    }
  }

  if (snapshot.state?.notes?.length) {
    console.log(chalk.bold('\n  Notes:'));
    for (const note of snapshot.state.notes) {
      console.log(`    ${chalk.dim(`- ${note}`)}`);
    }
  }

  if (snapshot.state?.workspaceFeedback?.required) {
    console.log(chalk.bold('\n  Workspace Feedback:'));
    console.log(`    ${chalk.yellow(snapshot.state.workspaceFeedback.reason || 'Feedback required')}`);
    if (snapshot.state.workspaceFeedback.affectedProjects?.length) {
      console.log(`    ${chalk.dim(`affected: ${snapshot.state.workspaceFeedback.affectedProjects.join(', ')}`)}`);
    }
    if (snapshot.state.workspaceFeedback.nextPhase) {
      console.log(`    ${chalk.dim(`next: ${snapshot.state.workspaceFeedback.nextPhase}`)}`);
    }
  }

  const pendingDecisions = getPendingWorkspaceDecisions(snapshot.state);
  if (pendingDecisions.length > 0) {
    console.log(chalk.bold('\n  Pending Decisions:'));
    for (const decision of pendingDecisions) {
      console.log(`    ${chalk.magenta(decision.id)}  ${decision.kind}  ${chalk.cyan(decision.projectName || 'workspace')}  ${chalk.dim(decision.title)}`);
      console.log(`      ${chalk.dim(decision.prompt)}`);
      if (decision.confidence || decision.rationale) {
        const parts = [
          decision.confidence ? `confidence=${decision.confidence}` : '',
          decision.rationale || '',
        ].filter(Boolean);
        console.log(`      ${chalk.dim(parts.join(' | '))}`);
      }
      if (decision.signals?.length) {
        console.log(`      ${chalk.dim(`signals: ${decision.signals.join(', ')}`)}`);
      }
      if (decision.options?.length) {
        for (const option of decision.options) {
          const marker = option.recommended ? '*' : '-';
          console.log(`      ${chalk.dim(`${marker} ${option.id}: ${option.label}${option.nextPhase ? ` -> ${option.nextPhase}` : ''}`)}`);
        }
      }
      console.log(`      ${chalk.dim(`next: tik workspace decide --id ${decision.id}${decision.recommendedOptionId ? ` --option ${decision.recommendedOptionId}` : ''}${decision.allowFreeform ? ' --message "..."' : ''}`)}`);
    }
  }

  const visibleProjects = ((snapshot.state?.projects || []) as WorkspaceProjectSnapshot[]).filter((project) =>
    selectedProjectNames.size === 0 || selectedProjectNames.has(project.projectName),
  );

  if (visibleProjects.length) {
    console.log(chalk.bold('\n  Project State:'));
    for (const project of visibleProjects) {
      console.log(`    ${chalk.cyan(project.projectName)}  ${project.phase}  ${project.status}`);
      if (project.sourceProjectPath) console.log(`      ${chalk.dim(`source: ${project.sourceProjectPath}`)}`);
      if (project.effectiveProjectPath && project.effectiveProjectPath !== project.sourceProjectPath) {
        console.log(`      ${chalk.dim(`exec: ${project.effectiveProjectPath}`)}`);
      }
      if (project.worktree?.status) console.log(`      ${chalk.dim(`worktree: ${project.worktree.status}`)}`);
      if (project.worktree?.worktreeBranch) console.log(`      ${chalk.dim(`worktree-branch: ${project.worktree.worktreeBranch}`)}`);
      if (project.specPath) console.log(`      ${chalk.dim(`spec: ${project.specPath}`)}`);
      if (project.planPath) console.log(`      ${chalk.dim(`plan: ${project.planPath}`)}`);
      if (project.workflowContract) console.log(`      ${chalk.dim(`contract: ${project.workflowContract}`)}`);
      if (project.workflowRole) console.log(`      ${chalk.dim(`role: ${project.workflowRole}`)}`);
      if (project.workflowSkillName) console.log(`      ${chalk.dim(`skill: ${project.workflowSkillName}`)}`);
      if (project.workflowSkillPath) console.log(`      ${chalk.dim(`skill-path: ${project.workflowSkillPath}`)}`);
      if (project.executionMode) console.log(`      ${chalk.dim(`exec-mode: ${project.executionMode}`)}`);
      if (project.blockerKind) console.log(`      ${chalk.dim(`blocker: ${project.blockerKind}`)}`);
      if (project.taskId) console.log(`      ${chalk.dim(`task: ${project.taskId}`)}`);
      if (project.specTaskId) console.log(`      ${chalk.dim(`spec-task: ${project.specTaskId}`)}`);
      if (project.planTaskId) console.log(`      ${chalk.dim(`plan-task: ${project.planTaskId}`)}`);
      if (project.aceTaskId) console.log(`      ${chalk.dim(`ace-task: ${project.aceTaskId}`)}`);
      if (project.summary) console.log(`      ${chalk.dim(project.summary)}`);
      if (project.recommendedCommand) console.log(`      ${chalk.dim(`next: ${project.recommendedCommand}`)}`);
    }
  }

  if (snapshot.state?.summary) {
    console.log(chalk.bold('\n  Summary:'));
    console.log(`    completed=${chalk.green(String(snapshot.state.summary.completedProjects))} blocked=${chalk.yellow(String(snapshot.state.summary.blockedProjects))} failed=${chalk.red(String(snapshot.state.summary.failedProjects))} total=${snapshot.state.summary.totalProjects}`);
    console.log(`    need-human=${chalk.magenta(String(snapshot.state.summary.needsHumanProjects))} replan=${chalk.yellow(String(snapshot.state.summary.replanProjects))}`);
  }

  if (eventProjection.totalEvents > 0) {
    console.log(chalk.bold('\n  Recent Events:'));
    for (const event of eventProjection.recentDisplay.slice(-5)) {
      const scope = event.projectName ? `${event.projectName} / ` : '';
      const repeat = event.count > 1 ? ` x${event.count}` : '';
      console.log(`    ${chalk.dim(`${scope}${event.phase} ${event.kind}${repeat} :: ${event.message}`)}`);
    }
  }

  console.log('');
}

function resolveWorkspacePolicyOption(profile?: string): WorkspaceSettings['workflowPolicy'] | undefined {
  if (!profile) return undefined;
  const normalized = profile.trim() as WorkspaceWorkflowPolicyProfile;
  if (!['balanced', 'fast-feedback', 'deep-verify'].includes(normalized)) {
    throw new Error(`Unsupported workflow profile: ${profile}. Use balanced, fast-feedback, or deep-verify.`);
  }
  return { profile: normalized };
}

function resolveWorkspaceWorktreePolicyOption(nonGit?: string): WorkspaceSettings['worktreePolicy'] | undefined {
  if (!nonGit) return undefined;
  const normalized = nonGit.trim();
  if (normalized !== 'block' && normalized !== 'source' && normalized !== 'copy') {
    throw new Error(`Unsupported non-git worktree strategy: ${nonGit}. Use block, source, or copy.`);
  }
  return { nonGitStrategy: normalized as 'block' | 'source' | 'copy' };
}

function printWorkspaceBoard(snapshot: WorkspaceStatusSnapshot, rootPath: string, projects?: string): void {
  const eventProjection = loadWorkspaceEventProjection(rootPath);
  console.log(chalk.bold('\n🧭 Workspace Board\n'));
  console.log(chalk.dim(`  Root: ${rootPath}`));
  console.log(chalk.dim(`  Phase: ${snapshot.state?.currentPhase || 'WORKSPACE_SPLIT'}`));

  const visibleItems = selectWorkspaceItems(snapshot, projects);
  const selectedProjectNames = new Set(visibleItems.map((item) => item.projectName));
  const visibleProjects = ((snapshot.state?.projects || []) as WorkspaceProjectSnapshot[]).filter((project) =>
    selectedProjectNames.size === 0 || selectedProjectNames.has(project.projectName),
  );

  const needsHuman = visibleProjects.filter((project) => project.blockerKind === 'NEED_HUMAN');
  const replan = visibleProjects.filter((project) => project.blockerKind === 'REPLAN');
  const healthy = visibleProjects.filter((project) => !project.blockerKind);

  if (needsHuman.length) {
    console.log(chalk.bold('\n  Need Human:'));
    for (const project of needsHuman) {
      console.log(`    ${chalk.magenta(project.projectName)}  ${project.phase}  ${project.status}`);
      if (project.effectiveProjectPath && project.effectiveProjectPath !== project.sourceProjectPath) console.log(`      ${chalk.dim(`exec: ${project.effectiveProjectPath}`)}`);
      if (project.worktree?.status) console.log(`      ${chalk.dim(`worktree: ${project.worktree.status}`)}`);
      if (project.summary) console.log(`      ${chalk.dim(project.summary)}`);
      if (project.recommendedCommand) console.log(`      ${chalk.dim(`next: ${project.recommendedCommand}`)}`);
    }
  }

  const pendingDecisions = getPendingWorkspaceDecisions(snapshot.state).filter((decision) =>
    selectedProjectNames.size === 0 || !decision.projectName || selectedProjectNames.has(decision.projectName),
  );
  if (pendingDecisions.length) {
    console.log(chalk.bold('\n  Pending Decisions:'));
    for (const decision of pendingDecisions) {
      console.log(`    ${chalk.magenta(decision.id)}  ${decision.kind}  ${chalk.cyan(decision.projectName || 'workspace')}`);
      console.log(`      ${chalk.dim(decision.title)}`);
      if (decision.confidence) {
        console.log(`      ${chalk.dim(`confidence: ${decision.confidence}`)}`);
      }
      if (decision.rationale) {
        console.log(`      ${chalk.dim(decision.rationale)}`);
      }
      if (decision.recommendedOptionId) {
        console.log(`      ${chalk.dim(`recommended: ${decision.recommendedOptionId}`)}`);
      }
      console.log(`      ${chalk.dim(`next: tik workspace decide --id ${decision.id}${decision.recommendedOptionId ? ` --option ${decision.recommendedOptionId}` : ''}${decision.allowFreeform ? ' --message "..."' : ''}`)}`);
    }
  }

  if (replan.length) {
    console.log(chalk.bold('\n  Replan Required:'));
    for (const project of replan) {
      console.log(`    ${chalk.yellow(project.projectName)}  ${project.phase}  ${project.status}`);
      if (project.effectiveProjectPath && project.effectiveProjectPath !== project.sourceProjectPath) console.log(`      ${chalk.dim(`exec: ${project.effectiveProjectPath}`)}`);
      if (project.worktree?.status) console.log(`      ${chalk.dim(`worktree: ${project.worktree.status}`)}`);
      if (project.summary) console.log(`      ${chalk.dim(project.summary)}`);
      if (project.recommendedCommand) console.log(`      ${chalk.dim(`next: ${project.recommendedCommand}`)}`);
    }
  }

  if (healthy.length) {
    const healthyHeading = healthy.every((project) => project.status === 'completed')
      ? 'Healthy / Completed:'
      : 'Healthy / In Flight:';
    console.log(chalk.bold(`\n  ${healthyHeading}`));
    for (const project of healthy) {
      console.log(`    ${chalk.cyan(project.projectName)}  ${project.phase}  ${project.status}`);
      if (project.effectiveProjectPath && project.effectiveProjectPath !== project.sourceProjectPath) console.log(`      ${chalk.dim(`exec: ${project.effectiveProjectPath}`)}`);
      if (project.worktree?.status) console.log(`      ${chalk.dim(`worktree: ${project.worktree.status}`)}`);
      if (project.workflowContract) console.log(`      ${chalk.dim(`contract: ${project.workflowContract}`)}`);
      if (project.workflowRole) console.log(`      ${chalk.dim(`role: ${project.workflowRole}`)}`);
      if (project.executionMode) console.log(`      ${chalk.dim(`exec-mode: ${project.executionMode}`)}`);
      if (project.recommendedCommand) console.log(`      ${chalk.dim(`next: ${project.recommendedCommand}`)}`);
      const projectEvents = eventProjection.projects.find(
        (entry: WorkspaceEventProjection['projects'][number]) => entry.projectName === project.projectName,
      );
      if (projectEvents?.lastMessage) console.log(`      ${chalk.dim(`last-event: ${projectEvents.lastMessage}`)}`);
    }
  }

  if (visibleProjects.length === 0) {
    console.log(chalk.dim('\n  No matching workspace projects.\n'));
    return;
  }

  console.log('');
}

function workspacePhaseToCommand(phase: 'PARALLEL_CLARIFY' | 'PARALLEL_SPECIFY' | 'PARALLEL_PLAN' | 'PARALLEL_ACE'): 'clarify' | 'specify' | 'plan-phase' | 'ace' {
  if (phase === 'PARALLEL_CLARIFY') return 'clarify';
  if (phase === 'PARALLEL_SPECIFY') return 'specify';
  if (phase === 'PARALLEL_PLAN') return 'plan-phase';
  return 'ace';
}

function printWorkspaceExplanation(explanation: import('@tik/shared').WorkspaceExplanation): void {
  console.log('\n## Explanation');
  console.log(`- Status: ${explanation.status}`);
  console.log(`- Confidence: ${explanation.confidence}`);
  console.log(`- Summary: ${explanation.summary}`);
  if (explanation.whyThisStatus.length > 0) {
    console.log('\n### Why this status');
    for (const reason of explanation.whyThisStatus) console.log(`- ${reason}`);
  }
  if (explanation.changedFiles.length > 0) {
    console.log('\n### Changed Files');
    for (const file of explanation.changedFiles) {
      const project = file.projectName ? `${file.projectName}: ` : '';
      console.log(`- ${project}${file.path} (${file.changeType})`);
    }
  }
  if (explanation.blockers.length > 0) {
    console.log('\n### Blockers');
    for (const blocker of explanation.blockers) {
      const project = blocker.projectName ? `${blocker.projectName}: ` : '';
      console.log(`- ${project}${blocker.message}`);
    }
  }
  if (explanation.nextActions.length > 0) {
    console.log('\n### Next Actions');
    for (const action of explanation.nextActions) console.log(`- ${action}`);
  }
}
 function printWorkspaceReport(snapshot: WorkspaceStatusSnapshot, rootPath: string, projects?: string): void {
  const eventProjection = loadWorkspaceEventProjection(rootPath);
  console.log(chalk.bold('\n# Workspace SDD Summary\n'));
  const visibleItems = selectWorkspaceItems(snapshot, projects);
  const selectedProjectNames = new Set(visibleItems.map((item) => item.projectName));
  const visibleProjects = ((snapshot.state?.projects || []) as WorkspaceProjectSnapshot[]).filter((project) =>
    selectedProjectNames.size === 0 || selectedProjectNames.has(project.projectName),
  );
  console.log(`- Root: ${rootPath}`);
  console.log(`- Phase: ${snapshot.state?.currentPhase || 'WORKSPACE_SPLIT'}`);
  console.log(`- Total Projects: ${visibleProjects.length || visibleItems.length || 0}`);
  console.log(`- Completed: ${visibleProjects.filter((project) => project.status === 'completed').length}`);
  console.log(`- Blocked: ${visibleProjects.filter((project) => project.status === 'blocked').length}`);
  console.log(`- Failed: ${visibleProjects.filter((project) => project.status === 'failed').length}`);
  console.log(`- Need Human: ${visibleProjects.filter((project) => project.blockerKind === 'NEED_HUMAN').length}`);
  console.log(`- Replan: ${visibleProjects.filter((project) => project.blockerKind === 'REPLAN').length}`);
  console.log(`- Clarified: ${visibleProjects.filter((project) => project.phase === 'PARALLEL_CLARIFY' && project.status === 'completed').length}`);
  console.log(`- Pending Decisions: ${getPendingWorkspaceDecisions(snapshot.state).length}`);
  console.log(`- Event Count: ${eventProjection.totalEvents}`);
  const policy = snapshot.settings?.workflowPolicy;
  if (policy?.profile) {
    console.log(`- Workflow Profile: ${policy.profile}`);
  }
  if (policy?.phaseBudgetsMs) {
    console.log(`- Phase Budgets: clarify=${policy.phaseBudgetsMs.PARALLEL_CLARIFY ?? '-'}ms, specify=${policy.phaseBudgetsMs.PARALLEL_SPECIFY ?? '-'}ms, plan=${policy.phaseBudgetsMs.PARALLEL_PLAN ?? '-'}ms, ace=${policy.phaseBudgetsMs.PARALLEL_ACE ?? '-'}ms`);
  }
  if (snapshot.state?.workspaceFeedback?.required) {
    console.log(`- Feedback: ${snapshot.state.workspaceFeedback.reason || 'required'}`);
    if (snapshot.state.workspaceFeedback.nextPhase) {
      console.log(`- Feedback Next Phase: ${snapshot.state.workspaceFeedback.nextPhase}`);
    }
  }
  const explanation = new TikKernel.WorkspaceExplanationBuilder().build({ workspaceRoot: rootPath, settings: snapshot.settings, state: snapshot.state, splitDemands: snapshot.splitDemands, projectNames: Array.from(selectedProjectNames), }); printWorkspaceExplanation(explanation); console.log('\n## Project Details');
  console.log('| Project | Phase | Status | Exec | Blocker | Contract | Role | Skill | Summary | Next |');
  console.log('|---------|-------|--------|------|---------|----------|------|-------|---------|------|');
  for (const project of visibleProjects) {
    const ids = Array.from(new Set([project.clarifyTaskId, project.specTaskId, project.planTaskId, project.aceTaskId, project.taskId].filter(Boolean))).join(', ');
    const summary = [project.summary || '', ids ? `(tasks: ${ids})` : ''].filter(Boolean).join(' ');
    const executionMode = (project.executionMode || '').replace(/\|/g, '\\|');
    const worktreeMode = project.worktree?.status ? `${executionMode}${executionMode ? ';' : ''}${project.worktree.status}` : executionMode;
    const blocker = (project.blockerKind || '').replace(/\|/g, '\\|');
    const contract = (project.workflowContract || '').replace(/\|/g, '\\|');
    const role = (project.workflowRole || '').replace(/\|/g, '\\|');
    const skill = (project.workflowSkillName || '').replace(/\|/g, '\\|');
    const next = (project.recommendedCommand || '').replace(/\|/g, '\\|');
    console.log(`| ${project.projectName} | ${project.phase} | ${project.status} | ${worktreeMode.replace(/\|/g, '\\|')} | ${blocker} | ${contract} | ${role} | ${skill} | ${summary.replace(/\|/g, '\\|')} | ${next} |`);
  }
  if (eventProjection.projects.length > 0) {
    console.log('\n## Event Projection');
    console.log('| Project | Events | Feedback | Recoveries | Completions | Last Event |');
    console.log('|---------|--------|----------|------------|-------------|------------|');
    for (const project of eventProjection.projects) {
      console.log(`| ${project.projectName} | ${project.eventCount} | ${project.feedbackCount} | ${project.recoveryCount} | ${project.completionCount} | ${(project.lastMessage || '').replace(/\|/g, '\\|')} |`);
    }
  }
  if (eventProjection.recentDisplay.length > 0) {
    console.log('\n## Recent Events');
    for (const event of eventProjection.recentDisplay) {
      const scope = event.projectName ? `${event.projectName} / ` : '';
      const repeat = event.count > 1 ? ` x${event.count}` : '';
      console.log(`- ${scope}${event.phase} ${event.kind}${repeat}: ${event.message}`);
    }
  }
  const pendingDecisions = getPendingWorkspaceDecisions(snapshot.state);
  if (pendingDecisions.length > 0) {
    console.log('\n## Pending Decisions');
    for (const decision of pendingDecisions) {
      console.log(`- ${decision.id} | ${decision.kind} | ${decision.projectName || 'workspace'} | ${decision.title}`);
      console.log(`  - prompt: ${decision.prompt}`);
      if (decision.confidence) {
        console.log(`  - confidence: ${decision.confidence}`);
      }
      if (decision.rationale) {
        console.log(`  - rationale: ${decision.rationale}`);
      }
      if (decision.signals?.length) {
        console.log(`  - signals: ${decision.signals.join(', ')}`);
      }
      if (decision.options?.length) {
        for (const option of decision.options) {
          const recommended = option.recommended ? ' (recommended)' : '';
          console.log(`  - option ${option.id}: ${option.label}${recommended}${option.nextPhase ? ` -> ${option.nextPhase}` : ''}`);
        }
      }
    }
  }
  console.log('');
}

function printWorkspaceDecisions(snapshot: WorkspaceStatusSnapshot): void {
  const decisions = snapshot.state?.decisions || [];
  const pending = decisions.filter((decision) => decision.status === 'pending');
  console.log(chalk.bold('\n🧠 Workspace Decisions\n'));
  if (pending.length === 0) {
    console.log(chalk.dim('  No pending human decisions.\n'));
    return;
  }
  for (const decision of pending) {
    console.log(`  ${chalk.magenta(decision.id)}  ${chalk.cyan(decision.kind)}  ${chalk.dim(decision.projectName || 'workspace')}`);
    console.log(`    ${decision.title}`);
    console.log(`    ${chalk.dim(decision.prompt)}`);
    if (decision.confidence) {
      console.log(`    ${chalk.dim(`confidence: ${decision.confidence}`)}`);
    }
    if (decision.rationale) {
      console.log(`    ${chalk.dim(decision.rationale)}`);
    }
    if (decision.signals?.length) {
      console.log(`    ${chalk.dim(`signals: ${decision.signals.join(', ')}`)}`);
    }
    if (decision.options?.length) {
      console.log(chalk.dim('    Options:'));
      for (const option of decision.options) {
        const recommended = option.recommended ? ' (recommended)' : '';
        const next = option.nextPhase ? ` -> ${option.nextPhase}` : '';
        console.log(`      ${chalk.dim(`${option.id}: ${option.label}${recommended}${next}`)}`);
        if (option.description) {
          console.log(`      ${chalk.dim(`  ${option.description}`)}`);
        }
      }
    }
    console.log(`    ${chalk.dim(`Resolve with: tik workspace decide --id ${decision.id}${decision.recommendedOptionId ? ` --option ${decision.recommendedOptionId}` : ''}${decision.allowFreeform ? ' --message "..."' : ''}`)}`);
    console.log('');
  }
}

function getPendingWorkspaceDecisions(snapshot: WorkspaceStatusSnapshot['state']) {
  return (snapshot?.decisions || []).filter((decision) => decision.status === 'pending');
}

function selectWorkspaceProjectSnapshot(
  projects: WorkspaceProjectSnapshot[],
  activeProjectPath: string,
  target?: string,
): WorkspaceProjectSnapshot | undefined {
  if (target) {
    return projects.find((project) => (
      project.projectName === target
      || path.basename(project.projectPath) === target
      || path.basename(project.sourceProjectPath || project.projectPath) === target
    ));
  }
  return projects.find((project) => (
    activeProjectPath === project.projectPath
    || activeProjectPath === project.sourceProjectPath
    || activeProjectPath === project.effectiveProjectPath
    || activeProjectPath.startsWith(project.projectPath)
    || (project.sourceProjectPath ? activeProjectPath.startsWith(project.sourceProjectPath) : false)
    || (project.effectiveProjectPath ? activeProjectPath.startsWith(project.effectiveProjectPath) : false)
  )) || projects[0];
}

function selectManagedWorktreeEntry(
  entries: Array<{
    projectName: string;
    sourceProjectPath: string;
    laneId?: string;
    active: boolean;
    kind: string;
    dirtyFileCount?: number;
    warnings: string[];
    safeToActivate: boolean;
    safeToRemove: boolean;
    effectiveProjectPath: string;
    worktree?: WorkspaceProjectWorktreeState;
  }>,
  projectName: string,
  sourceProjectPath?: string,
  laneId?: string,
) {
  const normalizedLaneId = normalizeWorktreeLaneId(laneId);
  const projectEntries = entries.filter((entry) => (
    entry.projectName === projectName
    && (!sourceProjectPath || entry.sourceProjectPath === sourceProjectPath)
  ));
  if (laneId) {
    return projectEntries.find((entry) => normalizeWorktreeLaneId(entry.laneId) === normalizedLaneId);
  }
  return projectEntries.find((entry) => entry.active) || projectEntries[0];
}

function normalizeWorktreeLaneId(value?: string): string {
  return (value || 'primary')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'primary';
}

function parseProjectNames(projects?: string): string[] {
  return (projects || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
}

function printWorkspacePhaseKickoff(
  title: string,
  rootPath: string,
  provider: ProviderOption,
  items: Array<{ projectName: string; projectPath: string; demand: string }>,
  effectiveProvider?: ProviderOption,
): void {
  console.log(chalk.dim(`  Workspace: ${rootPath}`));
  console.log(chalk.dim(`  Provider: ${provider}`));
  if (effectiveProvider && effectiveProvider !== provider) {
    console.log(chalk.dim(`  Execution engine: ${effectiveProvider} (${title === 'Parallel ACE' ? 'phase-specific override' : 'document/delegated subtask mode'})`));
  }
  console.log(chalk.dim(`  Projects: ${items.map((item) => item.projectName).join(', ')}`));
  console.log(chalk.dim(`  Running ${items.length} project subtask(s).`));
  if (effectiveProvider === 'codex' || effectiveProvider === 'codex-delegate' || provider === 'codex' || provider === 'codex-delegate') {
    console.log(chalk.dim('  Codex may spend a short while reading context before the first visible action.'));
  }
  console.log('');
}

function printWorkspaceSubtaskTransition(record: {
  projectName: string;
  skillName?: string;
  taskId: string;
  state: 'prepared' | 'running' | 'completed' | 'blocked' | 'failed';
  summary?: string;
}): void {
  if (record.state === 'running') {
    console.log(`  ${chalk.cyan('→')} ${chalk.cyan(record.projectName)} ${chalk.dim(`started ${record.skillName || 'subtask'} (${record.taskId})`)}`);
    return;
  }

  const marker = record.state === 'completed'
    ? chalk.green('✓')
    : record.state === 'blocked'
      ? chalk.yellow('!')
      : chalk.red('✗');
  const detail = [record.skillName, record.taskId].filter(Boolean).join(' · ');
  console.log(`  ${marker} ${chalk.cyan(record.projectName)} ${chalk.dim(`${record.state}${detail ? ` (${detail})` : ''}`)}`);
  if (record.summary) {
    console.log(chalk.dim(`    ${record.summary}`));
  }
}

function createWorkspaceSubtaskEventMonitor(provider: ProviderOption): WorkspaceSubtaskEventMonitor {
  const heartbeatTimers = new Map<string, NodeJS.Timeout>();
  const lastVisibleAt = new Map<string, number>();
  const idleThresholdMs = 8000;
  const heartbeatEveryMs = 12000;

  const clearHeartbeat = (taskId: string) => {
    const timer = heartbeatTimers.get(taskId);
    if (timer) {
      clearInterval(timer);
      heartbeatTimers.delete(taskId);
    }
    lastVisibleAt.delete(taskId);
  };

  const startHeartbeat = (record: { projectName: string; taskId: string }) => {
    if (provider !== 'codex' && provider !== 'codex-delegate') return;
    if (heartbeatTimers.has(record.taskId)) return;
    lastVisibleAt.set(record.taskId, Date.now());
    const timer = setInterval(() => {
      const lastVisible = lastVisibleAt.get(record.taskId) || 0;
      const idleMs = Date.now() - lastVisible;
      if (idleMs < idleThresholdMs) return;
      const time = new Date().toLocaleTimeString();
      console.log(`${chalk.gray(time)} ${chalk.cyan(`[${record.projectName}]`)} ${chalk.dim('still working; waiting for the next visible Codex action...')}`);
      lastVisibleAt.set(record.taskId, Date.now());
    }, heartbeatEveryMs);
    heartbeatTimers.set(record.taskId, timer);
  };

  return {
    onEvent(event: AgentEvent, context: WorkspaceSubtaskEventContext) {
      lastVisibleAt.set(context.taskId, Date.now());
      if (!shouldDisplayWorkspaceSubtaskEvent(event)) return;
      displayWorkspaceSubtaskEvent(event, context);
    },
    onSubtaskRunning(record) {
      startHeartbeat(record);
    },
    onSubtaskFinished(record) {
      clearHeartbeat(record.taskId);
    },
  };
}

function createWorkspaceSubtaskEventForwarder(monitor: WorkspaceSubtaskEventMonitor) {
  return (event: AgentEvent, context: WorkspaceSubtaskEventContext) => {
    monitor.onEvent(event, context);
  };
}

function shouldDisplayWorkspaceSubtaskEvent(event: AgentEvent): boolean {
  const type = event.type;
  if (
    type === 'session.message'
    || type === 'session.usage'
    || type === 'evaluation.started'
    || type === 'evaluation.fitness'
    || type === 'evaluation.drift'
    || type === 'evaluation.entropy'
  ) {
    return false;
  }
  return (
    type === 'session.started'
    || type === 'iteration.started'
    || type === 'iteration.completed'
    || type === 'context.built'
    || type === 'plan.started'
    || type === 'plan.generated'
    || type === 'tool.called'
    || type === 'tool.result'
    || type === 'tool.error'
    || type === 'system.warning'
    || type === 'convergence.achieved'
    || type === 'evaluation.completed'
  );
}

function displayWorkspaceSubtaskEvent(
  event: AgentEvent,
  context: WorkspaceSubtaskEventContext,
): void {
  const time = new Date(event.timestamp).toLocaleTimeString();
  const prefix = chalk.cyan(`[${context.projectName}]`);
  const line = formatWorkspaceSubtaskEventLine(event);
  if (!line) return;
  console.log(`${chalk.gray(time)} ${prefix} ${line}`);
}

function formatWorkspaceSubtaskEventLine(event: AgentEvent): string | null {
  const payload = (event.payload && typeof event.payload === 'object')
    ? event.payload as Record<string, any>
    : {};

  switch (event.type) {
    case 'session.started':
      return chalk.blue('session started');
    case 'iteration.started':
      return chalk.cyan(`iteration ${payload.iteration ?? '?'} started`);
    case 'iteration.completed':
      return chalk.cyan(`iteration ${payload.iteration ?? '?'} completed`);
    case 'context.built':
      return chalk.blue(`context built${payload.tokensUsed ? ` (${payload.tokensUsed} tokens)` : ''}`);
    case 'plan.started':
      return chalk.blue('plan started');
    case 'plan.generated':
      return chalk.blue('plan generated');
    case 'tool.called':
      return chalk.yellow(`tool ${payload.toolName || 'unknown'} called`);
    case 'tool.result':
      return chalk.green(`tool ${payload.toolName || 'unknown'} ok`);
    case 'tool.error':
      return chalk.red(`tool ${payload.toolName || 'unknown'} failed`);
    case 'evaluation.completed':
      return chalk.blue(`evaluation completed${typeof payload.fitness === 'number' ? ` (fitness=${payload.fitness.toFixed(3)})` : ''}`);
    case 'convergence.achieved':
      return chalk.green('converged');
    case 'system.warning':
      return chalk.yellow(String(payload.message || 'warning'));
    default:
      return null;
  }
}

function selectWorkspaceItems(
  snapshot: WorkspaceStatusSnapshot,
  projects?: string,
) {
  const items = snapshot.splitDemands?.items || [];
  const selected = parseProjectNames(projects);
  if (selected.length === 0) return items;
  const wanted = new Set(selected);
  return items.filter((item) => wanted.has(item.projectName));
}

function createWorkspaceSubtaskRuntime(
  provider: ProviderOption,
  model?: string,
  executionMode: 'single' | 'multi' = 'single',
  onEvent?: (event: AgentEvent, context: WorkspaceSubtaskEventContext) => void | Promise<void>,
) {
  return new WorkflowSubtaskRuntime((projectPath: string) => {
    const { kernel } = createKernel(projectPath, { provider, model, stream: false });
    return {
      kernel,
      dispose: () => kernel.dispose(),
    };
  }, executionMode, onEvent);
}

function createWorkspacePhaseReporter(): WorkspacePhaseReporter {
  return {
    onKickoff: () => {},
    onRunning: (record: { projectName: string; skillName?: string; taskId: string; state: 'running'; summary?: string }) => {
      printWorkspaceSubtaskTransition(record);
    },
    onTerminal: () => {},
    onProjectResult: () => {},
    onInfo: (message: string) => {
      if (message) console.log(message);
    },
  };
}

function workspaceEventLogPath(rootPath: string): string {
  return path.join(rootPath, '.workspace', 'events.jsonl');
}

function loadWorkspaceEventProjection(rootPath: string): WorkspaceEventProjection {
  const store = new WorkspaceEventStore({ persistPath: workspaceEventLogPath(rootPath) });
  return buildWorkspaceEventProjection(store.snapshot());
}

function createWorkspaceWorkflowEngineInstance(rootPath: string, policyConfig?: WorkspaceSettings['workflowPolicy']): WorkspaceWorkflowEngine {
  const contextAssembler = new WorkspaceContextAssembler();
  const policyEngine = new WorkspacePolicyEngine(policyConfig);
  const eventStore = new WorkspaceEventStore({ persistPath: workspaceEventLogPath(rootPath) });
  const memoryStore = new WorkspaceMemoryStore(rootPath);
  const normalizeArtifactResolution = async (
    promise: Promise<{ path: string | null; ambiguous?: boolean; candidates: string[] }>,
  ): Promise<{ path?: string; ambiguous?: boolean; candidates: string[] }> => {
    const resolution = await promise;
    return {
      path: resolution.path ?? undefined,
      ambiguous: resolution.ambiguous,
      candidates: resolution.candidates,
    };
  };
  return new WorkspaceWorkflowEngine({
    orchestrator: workspaceOrchestrator,
    contextAssembler,
    clarifier: new TikKernel.WorkspaceSuperpowersClarifier(),
    policyEngine,
    eventStore,
    memoryStore,
    policyConfig,
    resolveWorkspaceSpecArtifact: (projectPath: string, preferredPath: string) =>
      normalizeArtifactResolution(resolveWorkspaceSpecArtifact(projectPath, preferredPath)),
    resolveWorkspacePlanArtifact: (
      projectPath: string,
      options: { preferredPlanPath: string; preferredFeatureDir?: string | null },
    ) => normalizeArtifactResolution(resolveWorkspacePlanArtifact(projectPath, options)),
    buildWorkspaceSpecTargetPath,
    buildWorkspacePlanTargetPath,
    buildWorkspaceFeatureDir,
    workspaceFeatureDirForArtifact,
    skillRuntimeFactory: () => new LocalWorkflowSkillRuntimeAdapter(),
    materializeWorkflowSkillDelegatedSpec,
    createSubtaskRuntime: (
      provider: string,
      model: string | undefined,
      executionMode: 'single' | 'multi',
      onEvent?: (event: AgentEvent, context: WorkspaceSubtaskEventContext) => void | Promise<void>,
    ) => createWorkspaceSubtaskRuntime(provider as ProviderOption, model, executionMode, onEvent),
    createEventMonitor: (provider: string) => createWorkspaceSubtaskEventMonitor(provider as ProviderOption),
    createEventForwarder: (monitor: WorkspaceSubtaskEventMonitor) => createWorkspaceSubtaskEventForwarder(monitor),
    ensureWorkspaceExecutionTarget: async (input: {
      workspaceName: string;
      workspaceRoot: string;
      projectName: string;
      sourceProjectPath: string;
      existingEffectiveProjectPath?: string;
      existingWorktree?: WorkspaceProjectWorktreeState;
      existingWorktreeLanes?: WorkspaceProjectWorktreeState[];
    }) => {
      const snapshot = await workspaceOrchestrator.getStatus(rootPath);
      const worktreePolicy = snapshot.settings?.worktreePolicy;
      try {
        const target = await workspaceWorktreeManager.getExecutionTarget({
          ...input,
          policy: worktreePolicy,
        });
        if (target.worktree) {
          const shouldPersist = target.effectiveProjectPath !== input.existingEffectiveProjectPath
            || target.worktree.worktreePath !== input.existingWorktree?.worktreePath
            || target.worktree.status !== input.existingWorktree?.status
            || target.worktree.worktreeBranch !== input.existingWorktree?.worktreeBranch
            || target.worktree.laneId !== input.existingWorktree?.laneId;
          if (shouldPersist) {
            await workspaceOrchestrator.markProjectWorktreeReady(rootPath, input.projectName, {
              effectiveProjectPath: target.effectiveProjectPath,
              worktree: target.worktree,
            });
          }
          await workspaceOrchestrator.activateProjectWorktreeLane(rootPath, input.projectName, {
            effectiveProjectPath: target.effectiveProjectPath,
            worktree: target.worktree,
          });
        }
        return target;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const failedPolicy = workspaceWorktreeManager.resolvePolicy(input.workspaceRoot, worktreePolicy);
        await workspaceOrchestrator.markProjectWorktreeFailed(rootPath, input.projectName, {
          effectiveProjectPath: input.existingEffectiveProjectPath || input.sourceProjectPath,
          worktree: {
            enabled: failedPolicy.mode === 'managed',
            status: 'failed',
            laneId: input.existingWorktree?.laneId || 'primary',
            sourceBranch: workspaceWorktreeManager.readSourceBranch(input.sourceProjectPath),
            worktreeBranch: input.existingWorktree?.worktreeBranch || workspaceWorktreeManager.buildManagedWorktreeBranch(input.workspaceName, input.projectName, input.sourceProjectPath, input.existingWorktree?.laneId),
            worktreePath: input.existingWorktree?.worktreePath || workspaceWorktreeManager.buildManagedWorktreePath(input.workspaceRoot, input.projectName, input.sourceProjectPath, input.existingWorktree?.laneId, worktreePolicy),
            createdAt: input.existingWorktree?.createdAt,
            updatedAt: new Date().toISOString(),
            retainedAfterCompletion: failedPolicy.defaultRetention === 'retain',
            lastError: message,
          },
          summary: `Worktree preparation failed: ${message}`,
        });
        throw error;
      }
    },
    resolvePhaseProvider: (provider: string, phase: 'PARALLEL_CLARIFY' | 'PARALLEL_SPECIFY' | 'PARALLEL_PLAN' | 'PARALLEL_ACE') =>
      resolveWorkspacePhaseProvider(provider as ProviderOption, phase),
    resolveNativeRescueProvider: (provider: string) => resolveNativeRescueProvider(provider as ProviderOption),
    runNativeWorkspaceArtifactRescue: (
      spec: WorkflowSubtaskSpec,
      provider: string,
      model: string | undefined,
      summary: string,
    ) => runNativeWorkspaceArtifactRescue(spec, provider as ProviderOption, model, summary),
    safeReadFile,
    artifactWasMaterializedDuringWorkspaceRun,
    isWorkspacePlanValid,
    killWorkspaceTaskProcesses,
    captureGitChangedFiles,
  });
}

async function runNativeWorkspaceArtifactRescue(
  spec: WorkflowSubtaskSpec,
  provider: ProviderOption,
  model: string | undefined,
  summary: string,
) {
  const { kernel, llm } = createKernel(spec.projectPath, { provider, model, stream: false });
  try {
    const completion: WorkspaceSkillCompletionAdapter = {
      complete: async (_projectPath: string, prompt: string, options?: {
        onProviderEvent?: (event: import('@tik/shared').ProviderRuntimeEvent) => void;
      }) => ({
        content: await llm.complete(prompt, {
          allowWrites: false,
          onProviderEvent: options?.onProviderEvent,
        }),
        executionMode: 'native' as const,
      }),
    };
    const registry = createWorkspaceSkillExecutorRegistry({
      completion,
      skillRuntime: new LocalWorkflowSkillRuntimeAdapter(),
    });

    return await registry.execute(spec.contract, {
      spec,
      subtask: {
        taskId: `native-rescue-${Date.now()}`,
        projectName: spec.projectName,
        projectPath: spec.projectPath,
        phase: spec.phase,
        contract: spec.contract,
        role: spec.role,
        skillName: spec.skillName,
        status: 'completed',
        summary,
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
      },
    });
  } finally {
    kernel.dispose();
  }
}

function resolveNativeRescueProvider(provider: ProviderOption): ProviderOption {
  return provider === 'codex-delegate' ? 'codex' : provider;
}

function resolveWorkspacePhaseProvider(
  provider: ProviderOption,
  phase: 'PARALLEL_CLARIFY' | 'PARALLEL_SPECIFY' | 'PARALLEL_PLAN' | 'PARALLEL_ACE',
): ProviderOption {
  if (
    provider === 'codex'
    && (phase === 'PARALLEL_SPECIFY' || phase === 'PARALLEL_PLAN')
  ) {
    return 'codex-delegate';
  }
  return provider;
}

async function safeReadFile(filePath: string): Promise<string> {
  const fs = await import('node:fs/promises');
  try {
    return await fs.readFile(filePath, 'utf-8');
  } catch {
    return '';
  }
}

async function artifactWasMaterializedDuringWorkspaceRun(
  artifactPath: string,
  workspaceCreatedAt?: string,
): Promise<boolean> {
  if (!workspaceCreatedAt) return false;
  const startedAt = Date.parse(workspaceCreatedAt);
  if (Number.isNaN(startedAt)) return false;
  const fs = await import('node:fs/promises');
  try {
    const stat = await fs.stat(artifactPath);
    return stat.mtimeMs >= startedAt - 1000;
  } catch {
    return false;
  }
}

async function captureGitChangedFiles(projectPath: string): Promise<Set<string>> {
  return captureWorkspaceGitChangedFiles(projectPath);
}

async function killWorkspaceTaskProcesses(taskIds: string[]): Promise<void> {
  const { spawnSync } = await import('node:child_process');
  for (const taskId of taskIds.filter(Boolean)) {
    spawnSync('pkill', ['-f', taskId], { stdio: 'ignore' });
  }
}
