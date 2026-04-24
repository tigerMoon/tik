import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import type {
  WorkspaceProjectWorktreeKind,
  WorkspaceProjectWorktreeState,
  WorkspaceWorktreeBranchStrategy,
  WorkspaceWorktreeMode,
  WorkspaceWorktreeNonGitStrategy,
  WorkspaceWorktreePolicyConfig,
  WorkspaceWorktreeRetention,
} from '@tik/shared';

export interface WorkspaceExecutionTarget {
  sourceProjectPath: string;
  effectiveProjectPath: string;
  worktree?: WorkspaceProjectWorktreeState;
}

export interface WorkspaceExecutionTargetInput {
  workspaceName: string;
  workspaceRoot: string;
  projectName: string;
  sourceProjectPath: string;
  laneId?: string;
  existingEffectiveProjectPath?: string;
  existingWorktree?: WorkspaceProjectWorktreeState;
  existingWorktreeLanes?: WorkspaceProjectWorktreeState[];
  policy?: WorkspaceWorktreePolicyConfig;
}

export interface WorkspaceRemoveManagedWorktreeInput {
  workspaceName: string;
  workspaceRoot: string;
  projectName: string;
  sourceProjectPath: string;
  laneId?: string;
  existingWorktree?: WorkspaceProjectWorktreeState;
  existingWorktreeLanes?: WorkspaceProjectWorktreeState[];
  policy?: WorkspaceWorktreePolicyConfig;
  force?: boolean;
}

export interface WorkspaceManagedWorktreeEntry {
  projectName: string;
  sourceProjectPath: string;
  effectiveProjectPath: string;
  laneId?: string;
  active: boolean;
  kind: WorkspaceProjectWorktreeKind;
  dirtyFileCount?: number;
  dirtyFiles?: string[];
  warnings: string[];
  safeToActivate: boolean;
  safeToRemove: boolean;
  worktree?: WorkspaceProjectWorktreeState;
}

interface ResolvedWorktreePolicy {
  mode: WorkspaceWorktreeMode;
  defaultBranchStrategy: WorkspaceWorktreeBranchStrategy;
  defaultRetention: WorkspaceWorktreeRetention;
  nonGitStrategy: WorkspaceWorktreeNonGitStrategy;
  worktreeRoot: string;
}

interface GitResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

export class WorkspaceWorktreeManager {
  resolvePolicy(
    workspaceRoot: string,
    policy?: WorkspaceWorktreePolicyConfig,
  ): ResolvedWorktreePolicy {
    return {
      mode: policy?.mode || 'managed',
      defaultBranchStrategy: policy?.defaultBranchStrategy || 'auto-create',
      defaultRetention: policy?.defaultRetention || 'retain',
      nonGitStrategy: policy?.nonGitStrategy || 'source',
      worktreeRoot: policy?.worktreeRoot || path.join(workspaceRoot, '.workspace', 'worktrees'),
    };
  }

  buildManagedWorktreeBranch(
    workspaceName: string,
    projectName: string,
    sourceProjectPath: string,
    laneId?: string,
  ): string {
    const normalizedLaneId = normalizeLaneId(laneId);
    const base = `tik/${slug(workspaceName)}/${buildProjectToken(projectName, sourceProjectPath)}`;
    return normalizedLaneId === 'primary'
      ? base
      : `${base}--${slug(normalizedLaneId)}`;
  }

  buildManagedWorktreePath(
    workspaceRoot: string,
    projectName: string,
    sourceProjectPath: string,
    laneId?: string,
    policy?: WorkspaceWorktreePolicyConfig,
  ): string {
    const resolved = this.resolvePolicy(workspaceRoot, policy);
    const normalizedLaneId = normalizeLaneId(laneId);
    const base = buildProjectToken(projectName, sourceProjectPath);
    return path.join(
      resolved.worktreeRoot,
      normalizedLaneId === 'primary' ? base : `${base}--${slug(normalizedLaneId)}`,
    );
  }

  isGitRepository(projectPath: string): boolean {
    const result = this.runGit(projectPath, ['rev-parse', '--is-inside-work-tree']);
    return result.status === 0 && result.stdout.trim() === 'true';
  }

  readSourceBranch(projectPath: string): string | undefined {
    const result = this.runGit(projectPath, ['rev-parse', '--abbrev-ref', 'HEAD']);
    const branch = result.stdout.trim();
    return result.status === 0 && branch ? branch : undefined;
  }

  async getExecutionTarget(input: WorkspaceExecutionTargetInput): Promise<WorkspaceExecutionTarget> {
    const policy = this.resolvePolicy(input.workspaceRoot, input.policy);
    const laneId = normalizeLaneId(input.laneId || input.existingWorktree?.laneId);
    if (policy.mode === 'disabled') {
      return {
        sourceProjectPath: input.sourceProjectPath,
        effectiveProjectPath: input.sourceProjectPath,
      };
    }

    if (!this.isGitRepository(input.sourceProjectPath)) {
      if (policy.nonGitStrategy === 'source') {
        const existingLane = this.findExistingLane(input.existingWorktree, input.existingWorktreeLanes, laneId);
        return {
          sourceProjectPath: input.sourceProjectPath,
          effectiveProjectPath: input.sourceProjectPath,
          worktree: {
            enabled: false,
            status: 'source',
            kind: 'source',
            laneId,
            createdAt: existingLane?.createdAt,
            updatedAt: new Date().toISOString(),
            retainedAfterCompletion: false,
            lastError: 'Project is not inside a git repository; using source path.',
          },
        };
      }
      if (policy.nonGitStrategy === 'copy') {
        const existingLane = this.findExistingLane(input.existingWorktree, input.existingWorktreeLanes, laneId);
        const copyPath = existingLane?.worktreePath
          || this.buildManagedWorktreePath(input.workspaceRoot, input.projectName, input.sourceProjectPath, laneId, input.policy);
        const retainedAfterCompletion = policy.defaultRetention === 'retain';
        const existingCopy = await this.readExistingNonGitCopy(copyPath, {
          laneId,
          retainedAfterCompletion,
          existing: existingLane,
        });
        if (existingCopy) {
          return {
            sourceProjectPath: input.sourceProjectPath,
            effectiveProjectPath: copyPath,
            worktree: existingCopy,
          };
        }
        await fs.mkdir(path.dirname(copyPath), { recursive: true });
        await fs.cp(input.sourceProjectPath, copyPath, {
          recursive: true,
          errorOnExist: false,
          force: true,
          preserveTimestamps: true,
        });
        return {
          sourceProjectPath: input.sourceProjectPath,
          effectiveProjectPath: copyPath,
          worktree: {
            enabled: true,
            status: 'ready',
            kind: 'copy',
            laneId,
            worktreePath: copyPath,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            retainedAfterCompletion,
          },
        };
      }
      throw new Error(`Project is not inside a git repository: ${input.sourceProjectPath}`);
    }

    const sourceBranch = this.readSourceBranch(input.sourceProjectPath);
    if (!sourceBranch) {
      throw new Error(`Unable to resolve source branch for project: ${input.sourceProjectPath}`);
    }

    const existingLane = this.findExistingLane(input.existingWorktree, input.existingWorktreeLanes, laneId);
    const worktreeBranch = existingLane?.worktreeBranch
      || this.buildManagedWorktreeBranch(input.workspaceName, input.projectName, input.sourceProjectPath, laneId);
    const worktreePath = existingLane?.worktreePath
      || this.buildManagedWorktreePath(input.workspaceRoot, input.projectName, input.sourceProjectPath, laneId, input.policy);
    const retainedAfterCompletion = policy.defaultRetention === 'retain';

    const existingReady = await this.readExistingManagedWorktree(worktreePath, {
      sourceBranch,
      laneId,
      worktreeBranch,
      retainedAfterCompletion,
      existing: existingLane,
    });
    if (existingReady) {
      return {
        sourceProjectPath: input.sourceProjectPath,
        effectiveProjectPath: worktreePath,
        worktree: existingReady,
      };
    }

    await fs.mkdir(path.dirname(worktreePath), { recursive: true });
    const branchExists = this.branchExists(input.sourceProjectPath, worktreeBranch);
    const strategy = existingLane?.worktreeBranch ? 'reuse-existing' : policy.defaultBranchStrategy;
    const addArgs = branchExists || strategy === 'reuse-existing'
      ? ['worktree', 'add', worktreePath, worktreeBranch]
      : ['worktree', 'add', '-b', worktreeBranch, worktreePath, sourceBranch];
    const addResult = this.runGit(input.sourceProjectPath, addArgs);
    if (addResult.status !== 0) {
      throw new Error(addResult.stderr.trim() || `git ${addArgs.join(' ')} failed`);
    }

    return {
      sourceProjectPath: input.sourceProjectPath,
      effectiveProjectPath: worktreePath,
      worktree: {
        enabled: true,
        status: 'ready',
        kind: 'git-worktree',
        laneId,
        sourceBranch,
        worktreeBranch,
        worktreePath,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        retainedAfterCompletion,
      },
    };
  }

  async readManagedWorktreeStatus(input: WorkspaceExecutionTargetInput): Promise<WorkspaceExecutionTarget> {
    const policy = this.resolvePolicy(input.workspaceRoot, input.policy);
    const laneId = normalizeLaneId(input.laneId || input.existingWorktree?.laneId);
    if (policy.mode === 'disabled') {
      return {
        sourceProjectPath: input.sourceProjectPath,
        effectiveProjectPath: input.sourceProjectPath,
      };
    }
    if (!this.isGitRepository(input.sourceProjectPath)) {
      if (policy.nonGitStrategy === 'source') {
        const existingLane = this.findExistingLane(input.existingWorktree, input.existingWorktreeLanes, laneId);
        return {
          sourceProjectPath: input.sourceProjectPath,
          effectiveProjectPath: input.sourceProjectPath,
          worktree: {
            enabled: false,
            status: 'source',
            kind: 'source',
            laneId,
            createdAt: existingLane?.createdAt,
            updatedAt: new Date().toISOString(),
            retainedAfterCompletion: false,
            lastError: 'Project is not inside a git repository; using source path.',
          },
        };
      }
      if (policy.nonGitStrategy === 'copy') {
        const existingLane = this.findExistingLane(input.existingWorktree, input.existingWorktreeLanes, laneId);
        const copyPath = existingLane?.worktreePath
          || this.buildManagedWorktreePath(input.workspaceRoot, input.projectName, input.sourceProjectPath, laneId, input.policy);
        const retainedAfterCompletion = policy.defaultRetention === 'retain';
        const existingCopy = await this.readExistingNonGitCopy(copyPath, {
          laneId,
          retainedAfterCompletion,
          existing: existingLane,
        });
        return {
          sourceProjectPath: input.sourceProjectPath,
          effectiveProjectPath: existingCopy?.worktreePath || input.sourceProjectPath,
          worktree: existingCopy,
        };
      }
      return {
        sourceProjectPath: input.sourceProjectPath,
        effectiveProjectPath: input.sourceProjectPath,
      };
    }
    const sourceBranch = this.readSourceBranch(input.sourceProjectPath);
    const existingLane = this.findExistingLane(input.existingWorktree, input.existingWorktreeLanes, laneId);
    const worktreeBranch = existingLane?.worktreeBranch
      || this.buildManagedWorktreeBranch(input.workspaceName, input.projectName, input.sourceProjectPath, laneId);
    const worktreePath = existingLane?.worktreePath
      || this.buildManagedWorktreePath(input.workspaceRoot, input.projectName, input.sourceProjectPath, laneId, input.policy);
    const retainedAfterCompletion = policy.defaultRetention === 'retain';
    const existingReady = await this.readExistingManagedWorktree(worktreePath, {
      sourceBranch,
      laneId,
      worktreeBranch,
      retainedAfterCompletion,
      existing: existingLane,
    });
    if (!existingReady && existingLane && (existingLane.status === 'removed' || existingLane.status === 'failed' || existingLane.status === 'source')) {
      return {
        sourceProjectPath: input.sourceProjectPath,
        effectiveProjectPath: input.sourceProjectPath,
        worktree: {
          ...existingLane,
          kind: existingLane.kind || 'git-worktree',
          laneId,
          sourceBranch: existingLane.sourceBranch || sourceBranch,
          worktreeBranch,
          worktreePath,
          updatedAt: new Date().toISOString(),
        },
      };
    }
    return {
      sourceProjectPath: input.sourceProjectPath,
      effectiveProjectPath: existingReady?.worktreePath || input.sourceProjectPath,
      worktree: existingReady,
    };
  }

  async listManagedWorktrees(input: {
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
  }): Promise<WorkspaceManagedWorktreeEntry[]> {
    const entries: WorkspaceManagedWorktreeEntry[] = [];
    for (const project of input.projects) {
      const lanes = dedupeWorktreeLanes(project.worktree, project.worktreeLanes);
      if (lanes.length === 0) {
        const target = await this.readManagedWorktreeStatus({
          workspaceName: input.workspaceName,
          workspaceRoot: input.workspaceRoot,
          projectName: project.projectName,
          sourceProjectPath: project.sourceProjectPath,
          existingEffectiveProjectPath: project.effectiveProjectPath,
          existingWorktree: project.worktree,
          existingWorktreeLanes: project.worktreeLanes,
          policy: input.policy,
        });
        const dirtyFiles = await this.captureDirtyFiles(target.effectiveProjectPath, {
          worktree: target.worktree,
          sourceProjectPath: project.sourceProjectPath,
        });
        entries.push({
          projectName: project.projectName,
          sourceProjectPath: target.sourceProjectPath,
          effectiveProjectPath: target.effectiveProjectPath,
          laneId: target.worktree?.laneId,
          active: true,
          kind: inferWorktreeKind(target.worktree),
          dirtyFileCount: dirtyFiles?.length,
          dirtyFiles,
          warnings: await this.buildWorktreeWarnings(target.worktree, target.effectiveProjectPath, project.sourceProjectPath),
          safeToActivate: Boolean(target.worktree && (target.worktree.status === 'ready' || target.worktree.status === 'source')),
          safeToRemove: Boolean(target.worktree && target.worktree.status !== 'failed' && (dirtyFiles?.length || 0) === 0),
          worktree: target.worktree,
        });
        continue;
      }
      for (const lane of lanes) {
        const target = await this.readManagedWorktreeStatus({
          workspaceName: input.workspaceName,
          workspaceRoot: input.workspaceRoot,
          projectName: project.projectName,
          sourceProjectPath: project.sourceProjectPath,
          laneId: lane.laneId,
          existingEffectiveProjectPath: project.effectiveProjectPath,
          existingWorktree: lane,
          existingWorktreeLanes: project.worktreeLanes,
          policy: input.policy,
        });
        const dirtyFiles = await this.captureDirtyFiles(target.effectiveProjectPath, {
          worktree: target.worktree,
          sourceProjectPath: project.sourceProjectPath,
        });
        entries.push({
          projectName: project.projectName,
          sourceProjectPath: target.sourceProjectPath,
          effectiveProjectPath: target.effectiveProjectPath,
          laneId: lane.laneId,
          active: Boolean(project.worktree) && normalizeLaneId(project.worktree?.laneId) === normalizeLaneId(lane.laneId),
          kind: inferWorktreeKind(target.worktree),
          dirtyFileCount: dirtyFiles?.length,
          dirtyFiles,
          warnings: await this.buildWorktreeWarnings(target.worktree, target.effectiveProjectPath, project.sourceProjectPath),
          safeToActivate: Boolean(target.worktree && (target.worktree.status === 'ready' || target.worktree.status === 'source')),
          safeToRemove: Boolean(target.worktree && target.worktree.status !== 'failed' && (dirtyFiles?.length || 0) === 0),
          worktree: target.worktree,
        });
      }
    }
    return entries;
  }

  async removeManagedWorktree(input: WorkspaceRemoveManagedWorktreeInput): Promise<WorkspaceExecutionTarget> {
    const policy = this.resolvePolicy(input.workspaceRoot, input.policy);
    const laneId = normalizeLaneId(input.laneId || input.existingWorktree?.laneId);
    if (policy.mode === 'disabled') {
      return {
        sourceProjectPath: input.sourceProjectPath,
        effectiveProjectPath: input.sourceProjectPath,
      };
    }

    const existingLane = this.findExistingLane(input.existingWorktree, input.existingWorktreeLanes, laneId);
    if (!this.isGitRepository(input.sourceProjectPath)) {
      if (policy.nonGitStrategy === 'copy') {
        const copyPath = existingLane?.worktreePath
          || this.buildManagedWorktreePath(input.workspaceRoot, input.projectName, input.sourceProjectPath, laneId, input.policy);
        const dirtyFiles = await this.captureDirtyFiles(copyPath, {
          worktree: existingLane,
          sourceProjectPath: input.sourceProjectPath,
        });
        if ((dirtyFiles?.length || 0) > 0 && !input.force) {
          throw new Error(`Copy lane has local changes and cannot be removed safely: ${(dirtyFiles || []).slice(0, 10).join(', ')}`);
        }
        if (await isDirectory(copyPath)) {
          await fs.rm(copyPath, { recursive: true, force: true });
        }
        return {
          sourceProjectPath: input.sourceProjectPath,
          effectiveProjectPath: input.sourceProjectPath,
          worktree: {
            enabled: true,
            status: 'removed',
            kind: 'copy',
            laneId,
            worktreePath: copyPath,
            createdAt: existingLane?.createdAt,
            updatedAt: new Date().toISOString(),
            retainedAfterCompletion: false,
          },
        };
      }
      return {
        sourceProjectPath: input.sourceProjectPath,
        effectiveProjectPath: input.sourceProjectPath,
        worktree: {
          enabled: false,
          status: 'removed',
          kind: 'source',
          laneId,
          createdAt: existingLane?.createdAt,
          updatedAt: new Date().toISOString(),
          retainedAfterCompletion: false,
          lastError: 'No managed worktree exists for a non-git project; source path remains active.',
        },
      };
    }

    const worktreePath = existingLane?.worktreePath
      || this.buildManagedWorktreePath(input.workspaceRoot, input.projectName, input.sourceProjectPath, laneId, input.policy);
    const sourceBranch = this.readSourceBranch(input.sourceProjectPath);
    const worktreeBranch = existingLane?.worktreeBranch
      || this.buildManagedWorktreeBranch(input.workspaceName, input.projectName, input.sourceProjectPath, laneId);

    if (!(await isDirectory(worktreePath))) {
      return {
        sourceProjectPath: input.sourceProjectPath,
        effectiveProjectPath: input.sourceProjectPath,
        worktree: {
          enabled: true,
          status: 'removed',
          laneId,
          sourceBranch,
          worktreeBranch,
          worktreePath,
          createdAt: existingLane?.createdAt,
          updatedAt: new Date().toISOString(),
          retainedAfterCompletion: false,
        },
      };
    }

    const removeArgs = ['worktree', 'remove', ...(input.force ? ['--force'] : []), worktreePath];
    const removeResult = this.runGit(input.sourceProjectPath, removeArgs);
    if (removeResult.status !== 0) {
      throw new Error(removeResult.stderr.trim() || `git ${removeArgs.join(' ')} failed`);
    }

    return {
      sourceProjectPath: input.sourceProjectPath,
      effectiveProjectPath: input.sourceProjectPath,
      worktree: {
        enabled: true,
        status: 'removed',
        kind: 'git-worktree',
        laneId,
        sourceBranch,
        worktreeBranch,
        worktreePath,
        createdAt: existingLane?.createdAt,
        updatedAt: new Date().toISOString(),
        retainedAfterCompletion: false,
      },
    };
  }

  resolveManagedWorktreeLane(
    worktree: WorkspaceProjectWorktreeState | undefined,
    worktreeLanes: WorkspaceProjectWorktreeState[] | undefined,
    laneId?: string,
  ): WorkspaceProjectWorktreeState | undefined {
    return this.findExistingLane(worktree, worktreeLanes, laneId);
  }

  private async readExistingManagedWorktree(
    worktreePath: string,
    input: {
      sourceBranch?: string;
      laneId: string;
      worktreeBranch: string;
      retainedAfterCompletion: boolean;
      existing?: WorkspaceProjectWorktreeState;
    },
  ): Promise<WorkspaceProjectWorktreeState | undefined> {
    if (!(await isDirectory(worktreePath))) return undefined;
    if (!this.isGitRepository(worktreePath)) return undefined;
    const worktreeBranch = this.readSourceBranch(worktreePath) || input.worktreeBranch;
    return {
      enabled: true,
      status: 'ready',
      kind: 'git-worktree',
      laneId: input.laneId,
      sourceBranch: input.sourceBranch,
      worktreeBranch,
      worktreePath,
      createdAt: input.existing?.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      retainedAfterCompletion: input.existing?.retainedAfterCompletion ?? input.retainedAfterCompletion,
    };
  }

  private branchExists(projectPath: string, branchName: string): boolean {
    const result = this.runGit(projectPath, ['show-ref', '--verify', '--quiet', `refs/heads/${branchName}`]);
    return result.status === 0;
  }

  private findExistingLane(
    worktree: WorkspaceProjectWorktreeState | undefined,
    worktreeLanes: WorkspaceProjectWorktreeState[] | undefined,
    laneId?: string,
  ): WorkspaceProjectWorktreeState | undefined {
    const normalizedLaneId = normalizeLaneId(laneId || worktree?.laneId);
    const lanes = dedupeWorktreeLanes(worktree, worktreeLanes);
    return lanes.find((lane) => normalizeLaneId(lane.laneId) === normalizedLaneId)
      || (normalizeLaneId(worktree?.laneId) === normalizedLaneId ? worktree : undefined);
  }

  private async readExistingNonGitCopy(
    copyPath: string,
    input: {
      laneId: string;
      retainedAfterCompletion: boolean;
      existing?: WorkspaceProjectWorktreeState;
    },
  ): Promise<WorkspaceProjectWorktreeState | undefined> {
    if (!(await isDirectory(copyPath))) return undefined;
    return {
      enabled: true,
      status: 'ready',
      kind: 'copy',
      laneId: input.laneId,
      worktreePath: copyPath,
      createdAt: input.existing?.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      retainedAfterCompletion: input.existing?.retainedAfterCompletion ?? input.retainedAfterCompletion,
    };
  }

  private async captureDirtyFiles(
    projectPath: string,
    input?: {
      worktree?: WorkspaceProjectWorktreeState;
      sourceProjectPath?: string;
    },
  ): Promise<string[] | undefined> {
    if (input?.worktree?.kind === 'copy') {
      if (!input.sourceProjectPath) return undefined;
      return this.captureCopyDirtyFiles(projectPath, input.sourceProjectPath);
    }
    if (!this.isGitRepository(projectPath)) return undefined;
    const result = this.runGit(projectPath, ['status', '--porcelain']);
    if (result.status !== 0) return undefined;
    return result.stdout
      .split('\n')
      .map((line) => line.replace(/\r$/, ''))
      .filter(Boolean)
      .map((line) => line.slice(3).trim())
      .filter(Boolean);
  }

  private async buildWorktreeWarnings(
    worktree: WorkspaceProjectWorktreeState | undefined,
    effectiveProjectPath: string,
    sourceProjectPath?: string,
  ): Promise<string[]> {
    const warnings: string[] = [];
    if (!worktree) return warnings;
    if (worktree.status === 'source') {
      warnings.push('Project executes on the source path; changes are not isolated.');
    }
    if (worktree.kind === 'copy') {
      warnings.push('Lane uses a managed copy and is not backed by git history.');
    }
    const dirtyFiles = await this.captureDirtyFiles(effectiveProjectPath, {
      worktree,
      sourceProjectPath,
    });
    if (dirtyFiles && dirtyFiles.length > 0) {
      warnings.push(`Lane has ${dirtyFiles.length} uncommitted change(s).`);
    }
    if (worktree.lastError && worktree.status === 'failed') {
      warnings.push(worktree.lastError);
    }
    return warnings;
  }

  private runGit(projectPath: string, args: string[]): GitResult {
    const result = spawnSync('git', ['-C', projectPath, ...args], {
      encoding: 'utf-8',
    });
    return {
      status: result.status,
      stdout: result.stdout || '',
      stderr: result.stderr || '',
    };
  }

  private async captureCopyDirtyFiles(copyPath: string, sourceProjectPath: string): Promise<string[]> {
    if (!(await isDirectory(copyPath)) || !(await isDirectory(sourceProjectPath))) {
      return [];
    }
    const [copySnapshot, sourceSnapshot] = await Promise.all([
      this.buildFileSnapshot(copyPath),
      this.buildFileSnapshot(sourceProjectPath),
    ]);
    const files = new Set([...copySnapshot.keys(), ...sourceSnapshot.keys()]);
    const dirtyFiles: string[] = [];
    for (const file of files) {
      if ((copySnapshot.get(file) || '') !== (sourceSnapshot.get(file) || '')) {
        dirtyFiles.push(file);
      }
    }
    return dirtyFiles.sort();
  }

  private async buildFileSnapshot(rootPath: string): Promise<Map<string, string>> {
    const snapshot = new Map<string, string>();
    await this.collectFileSnapshot(rootPath, rootPath, snapshot);
    return snapshot;
  }

  private async collectFileSnapshot(
    rootPath: string,
    currentPath: string,
    snapshot: Map<string, string>,
  ): Promise<void> {
    const entries = await fs.readdir(currentPath, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === '.git') continue;
      const absolutePath = path.join(currentPath, entry.name);
      const relativePath = path.relative(rootPath, absolutePath).replace(/\\/g, '/');
      if (entry.isDirectory()) {
        await this.collectFileSnapshot(rootPath, absolutePath, snapshot);
        continue;
      }
      if (!entry.isFile()) continue;
      const content = await fs.readFile(absolutePath);
      snapshot.set(relativePath, createHash('sha1').update(content).digest('hex'));
    }
  }
}

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'workspace';
}

function buildProjectToken(projectName: string, sourceProjectPath: string): string {
  return `${slug(projectName).slice(0, 32) || 'project'}-${createHash('sha1').update(sourceProjectPath).digest('hex').slice(0, 8)}`;
}

function normalizeLaneId(value?: string): string {
  return slug(value || 'primary');
}

function dedupeWorktreeLanes(
  active: WorkspaceProjectWorktreeState | undefined,
  lanes: WorkspaceProjectWorktreeState[] | undefined,
): WorkspaceProjectWorktreeState[] {
  const merged = [...(lanes || []), ...(active ? [active] : [])];
  const seen = new Set<string>();
  const result: WorkspaceProjectWorktreeState[] = [];
  for (const lane of merged) {
    const key = normalizeLaneId(lane.laneId);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({
      ...lane,
      laneId: key,
    });
  }
  return result;
}

function inferWorktreeKind(worktree: WorkspaceProjectWorktreeState | undefined): WorkspaceProjectWorktreeKind {
  if (!worktree) return 'source';
  if (worktree.kind) return worktree.kind;
  if (worktree.status === 'source') return 'source';
  return worktree.enabled ? 'git-worktree' : 'source';
}

async function isDirectory(targetPath: string): Promise<boolean> {
  try {
    return (await fs.stat(targetPath)).isDirectory();
  } catch {
    return false;
  }
}
