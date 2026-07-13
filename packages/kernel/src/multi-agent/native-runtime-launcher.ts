import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import type { AgentRuntimeName } from '@tik/shared';
import type {
  AgentRunCompletion,
  AgentRunHandle,
  AgentRunInput,
  AgentRuntimeRunner,
  PreparedRun,
} from '../agent-runners/agent-runtime-runner.js';
import type { TrackedTask } from '../tracker-daemon/types.js';
import {
  FileMultiAgentWorkflowStore,
  MultiAgentCoordinationError,
  type CreateAgentInvocationInput,
} from './workflow-store.js';
import type { AgentInvocationRecord, QuestionerRun } from '@tik/shared';

const execFileAsync = promisify(execFile);
const DEFAULT_BUILDER_TIMEOUT_MS = 15 * 60 * 1000;
const DEFAULT_READONLY_TIMEOUT_MS = 8 * 60 * 1000;
const DEFAULT_QUESTIONER_TIMEOUT_MS = 5 * 60 * 1000;

export interface NativeInvocationLaunchInput {
  invocation: CreateAgentInvocationInput;
  prompt?: string;
  parentThreadId?: string;
  timeoutMs?: number;
}

export interface NativeQuestionerLaunchInput {
  run: QuestionerRun;
  invocation: AgentInvocationRecord;
  token: string;
  prompt?: string;
  timeoutMs?: number;
  gitStatusBefore?: string;
}

export interface NativeRuntimeLaunchResult {
  invocation: AgentInvocationRecord;
  runId: string;
  runtimeRef: string;
  status: 'running' | 'completed';
}

export class MultiAgentNativeRuntimeLauncher {
  private readonly activeHandles = new Map<string, AgentRunHandle>();

  constructor(
    private readonly store: FileMultiAgentWorkflowStore,
    private readonly workspaceRoot: string,
    private readonly apiBaseUrl: string,
    private readonly runtimeRunners: Partial<Record<AgentRuntimeName, AgentRuntimeRunner>>,
  ) {}

  isAvailable(): boolean {
    return Boolean(this.runtimeRunners.codex && this.runtimeRunners['claude-code']);
  }

  async launchCodexInvocation(
    workflowId: string,
    input: NativeInvocationLaunchInput,
  ): Promise<NativeRuntimeLaunchResult> {
    const runner = this.runtimeRunners.codex;
    if (!runner) throw new MultiAgentCoordinationError('runtime_unavailable', 'Tik Codex native runtime is unavailable.');
    if (input.invocation.runner !== 'codex' && input.invocation.runner !== 'codex-evaluator') {
      throw new MultiAgentCoordinationError('invalid_transition', 'Native Codex launch requires runner=codex or codex-evaluator.');
    }
    const bundle = await this.store.readBundle(workflowId);
    if (!bundle) throw new MultiAgentCoordinationError('workflow_not_found', `Multi-agent workflow not found: ${workflowId}.`);
    const role = input.invocation.role;
    if (role !== 'executor' && role !== 'reviewer' && role !== 'evaluator') {
      throw new MultiAgentCoordinationError('invalid_transition', `Tik native Codex launch does not support role=${role}.`);
    }
    if ((role === 'executor') !== (input.invocation.runner === 'codex')) {
      throw new MultiAgentCoordinationError('invalid_transition', 'Executor requires runner=codex; Reviewer and Evaluator require runner=codex-evaluator.');
    }
    if (bundle.workflow.mode === 'review' && role === 'executor') {
      throw new MultiAgentCoordinationError('invalid_transition', 'Review workflows cannot launch Builder invocations.');
    }
    if (bundle.workflow.mode !== 'review' && role === 'reviewer') {
      throw new MultiAgentCoordinationError('invalid_transition', 'Readonly Reviewer invocations require mode=review.');
    }
    if (input.invocation.subtaskId && input.invocation.subtaskId !== '__final__' && !bundle.subtasks[input.invocation.subtaskId]) {
      throw new MultiAgentCoordinationError('subtask_not_found', `Subtask not found: ${input.invocation.subtaskId}.`);
    }
    if (input.invocation.id) {
      const existing = await this.store.readInvocation(workflowId, input.invocation.id);
      if (existing) {
        if (!sameNativeInvocationRequest(existing, input.invocation)) {
          throw new MultiAgentCoordinationError('version_conflict', `Agent invocation ${input.invocation.id} already exists with different input.`);
        }
        if (existing.status === 'created' || existing.status === 'started' || existing.status === 'completed') {
          return {
            invocation: existing,
            runId: existing.id,
            runtimeRef: existing.actualSubagentThreadId || existing.threadId || `run:${existing.id}`,
            status: existing.status === 'completed' ? 'completed' : 'running',
          };
        }
        throw new MultiAgentCoordinationError('version_conflict', `Agent invocation ${input.invocation.id} is ${existing.status}.`);
      }
    }
    const projectPath = bundle.workflow.workspaceBinding?.effectiveProjectPath || this.workspaceRoot;
    const invocation = await this.store.createInvocation(workflowId, input.invocation);
    const runId = invocation.id;
    const readonly = invocation.role === 'reviewer' || invocation.role === 'evaluator';
    const statusBefore = readonly ? await readGitStatus(projectPath) : undefined;
    try {
      const prepared = await runner.prepare(buildAgentRunInput({
        runId,
        workflowId,
        projectPath,
        workspaceRoot: this.workspaceRoot,
        invocation,
        prompt: input.prompt || buildCodexPrompt(bundle.workflow.goal, invocation),
        runnerMode: 'codex_app_server',
        timeoutMs: input.timeoutMs ?? (readonly ? DEFAULT_READONLY_TIMEOUT_MS : DEFAULT_BUILDER_TIMEOUT_MS),
      }));
      const handle = await runner.start({
        ...prepared,
        allowWrites: !readonly,
        requireThreadId: true,
        developerInstructions: buildCodexDeveloperInstructions(invocation, readonly),
      });
      this.activeHandles.set(runId, handle);
      if (!handle.threadId) {
        await handle.stop('native thread id missing').catch(() => undefined);
        throw new MultiAgentCoordinationError(
          'missing_subagent_invocation',
          'Codex App Server did not return the native thread id for the launched subagent.',
        );
      }
      if (!handle.completion) {
        await handle.stop('native completion handle missing').catch(() => undefined);
        throw new MultiAgentCoordinationError('runtime_unavailable', 'Codex native runtime did not expose completion tracking.');
      }
      const parentThreadId = input.parentThreadId
        || invocation.parentThreadId
        || readString(bundle.workflow.metadata, 'parentCodexThreadId')
        || `tik:${workflowId}`;
      const started = await this.store.attestNativeInvocationStart(workflowId, invocation.id, {
        parentThreadId,
        actualSubagentThreadId: handle.threadId,
        role: invocation.role,
        nonce: randomUUID(),
        startedAt: handle.startedAt,
      });
      void this.trackCodexCompletion({
        workflowId,
        invocation: started,
        runner,
        completion: handle.completion,
        projectPath,
        statusBefore,
        readonly,
      });
      return {
        invocation: started,
        runId,
        runtimeRef: handle.threadId,
        status: 'running',
      };
    } catch (error) {
      this.activeHandles.delete(runId);
      const current = await this.store.readInvocation(workflowId, invocation.id);
      if (current?.status === 'created') {
        await this.store.updateInvocation(workflowId, invocation.id, {
          status: 'cancelled',
          error: error instanceof Error ? error.message : String(error),
        }).catch(() => undefined);
      }
      throw error;
    }
  }

  async launchQuestioner(
    workflowId: string,
    input: NativeQuestionerLaunchInput,
  ): Promise<NativeRuntimeLaunchResult> {
    const runner = this.runtimeRunners['claude-code'];
    if (!runner) throw new MultiAgentCoordinationError('runtime_unavailable', 'Tik Claude Questioner runtime is unavailable.');
    const bundle = await this.store.readBundle(workflowId);
    if (!bundle) throw new MultiAgentCoordinationError('workflow_not_found', `Multi-agent workflow not found: ${workflowId}.`);
    const projectPath = bundle.workflow.workspaceBinding?.effectiveProjectPath || this.workspaceRoot;
    const runtimeEnv = readRecord(input.invocation.input, 'runtimeEnv');
    const isolatedWorkspace = await createIsolatedQuestionerWorkspace(
      projectPath,
      this.workspaceRoot,
      input.run.id,
      input.run.headSha,
    );
    try {
      const prepared = await runner.prepare(buildAgentRunInput({
        runId: input.invocation.id,
        workflowId,
        projectPath: isolatedWorkspace.path,
        workspaceRoot: this.workspaceRoot,
        invocation: input.invocation,
        prompt: input.prompt || buildQuestionerPrompt(input.run),
        runnerMode: 'claude_hooked',
        timeoutMs: input.timeoutMs ?? DEFAULT_QUESTIONER_TIMEOUT_MS,
      }));
      const handle = await runner.start({
        ...prepared,
        env: {
          ...safeRuntimeBaseEnv(),
          ...absoluteQuestionerEnv(this.apiBaseUrl, runtimeEnv),
          TIK_QUESTIONER_TOKEN: input.token,
          TIK_QUESTIONER_GIT_STATUS_BEFORE: input.gitStatusBefore || '',
        },
      });
      this.activeHandles.set(input.invocation.id, handle);
      if (!handle.completion) {
        await handle.stop('native completion handle missing').catch(() => undefined);
        throw new MultiAgentCoordinationError('runtime_unavailable', 'Claude native runtime did not expose completion tracking.');
      }
      const runtimeRef = handle.threadId || (handle.pid ? `pid:${handle.pid}` : `run:${input.invocation.id}`);
      const started = await this.store.startQuestionerRunRuntime(workflowId, input.run.id, runtimeRef);
      void this.trackQuestionerCompletion(
        workflowId,
        input.run.id,
        input.invocation.id,
        handle.completion,
        isolatedWorkspace.cleanup,
      );
      return {
        invocation: started.invocation,
        runId: input.run.id,
        runtimeRef,
        status: 'running',
      };
    } catch (error) {
      this.activeHandles.delete(input.invocation.id);
      await isolatedWorkspace.cleanup().catch(() => undefined);
      await this.store.failQuestionerRunRuntime(
        workflowId,
        input.run.id,
        error instanceof Error ? error.message : String(error),
      ).catch(() => undefined);
      throw error;
    }
  }

  async shutdown(): Promise<void> {
    const handles = Array.from(this.activeHandles.values());
    this.activeHandles.clear();
    await Promise.allSettled(handles.map((handle) => handle.stop('Tik server shutdown')));
  }

  private async trackCodexCompletion(input: {
    workflowId: string;
    invocation: AgentInvocationRecord;
    runner: AgentRuntimeRunner;
    completion: Promise<AgentRunCompletion>;
    projectPath: string;
    statusBefore?: string;
    readonly: boolean;
  }): Promise<void> {
    try {
      const completion = await input.completion;
      const [headSha, statusAfter, diff, transcripts] = await Promise.all([
        readGitHead(input.projectPath),
        input.readonly ? readGitStatus(input.projectPath) : Promise.resolve(undefined),
        input.runner.collectDiff(input.invocation.id).catch(() => ({ changedFiles: [] })),
        input.runner.collectTranscript(input.invocation.id).catch(() => []),
      ]);
      const violations = input.readonly && input.statusBefore !== statusAfter ? ['worktree_changed'] : [];
      const readonlyPolicy = input.readonly ? {
        ...(input.invocation.readonlyPolicy || { enforced: true }),
        enforced: violations.length === 0,
        violations,
        gitStatusBefore: input.statusBefore,
        gitStatusAfter: statusAfter,
      } : input.invocation.readonlyPolicy;
      await this.store.completeNativeInvocation(input.workflowId, input.invocation.id, {
        status: completion.status,
        error: completion.error,
        headSha,
        readonlyPolicy,
        result: {
          ...(completion.result || {}),
          headSha,
          diff,
          transcripts,
          readonlyPolicy,
        },
      });
    } catch (error) {
      const current = await this.store.readInvocation(input.workflowId, input.invocation.id);
      if (current?.status === 'started') {
        await this.store.completeNativeInvocation(input.workflowId, input.invocation.id, {
          status: 'failed',
          error: error instanceof Error ? error.message : String(error),
        }).catch(() => undefined);
      }
    } finally {
      this.activeHandles.delete(input.invocation.id);
      await input.runner.cleanup(input.invocation.id).catch(() => undefined);
    }
  }

  private async trackQuestionerCompletion(
    workflowId: string,
    runId: string,
    invocationId: string,
    completion: Promise<AgentRunCompletion>,
    cleanupWorkspace: () => Promise<void>,
  ): Promise<void> {
    try {
      const result = await completion.catch((error) => ({
        status: 'failed' as const,
        error: error instanceof Error ? error.message : String(error),
      }));
      const run = await this.store.readQuestionerRun(workflowId, runId);
      if (run?.status === 'validated') return;
      const message = result.status === 'completed'
        ? 'Claude Questioner runtime exited without submitting QuestionerOutputV2.'
        : result.error || `Claude Questioner runtime ${result.status}.`;
      await new Promise((resolve) => setTimeout(resolve, 250));
      await this.store.failQuestionerRunRuntime(workflowId, runId, message).catch(() => undefined);
    } finally {
      this.activeHandles.delete(invocationId);
      await this.runtimeRunners['claude-code']?.cleanup(invocationId).catch(() => undefined);
      await cleanupWorkspace().catch(() => undefined);
    }
  }
}

async function createIsolatedQuestionerWorkspace(
  projectPath: string,
  workspaceRoot: string,
  runId: string,
  headSha: string,
): Promise<{ path: string; cleanup: () => Promise<void> }> {
  let target = path.join(workspaceRoot, '.tik', 'runtime-worktrees', runId.replace(/[^A-Za-z0-9._-]/g, '_'));
  await fs.rm(target, { recursive: true, force: true });
  await fs.mkdir(path.dirname(target), { recursive: true });
  let gitWorktree = false;
  try {
    await execFileAsync('git', ['worktree', 'add', '--detach', target, headSha], {
      cwd: projectPath,
      maxBuffer: 8 * 1024 * 1024,
    });
    gitWorktree = true;
  } catch {
    await fs.rm(target, { recursive: true, force: true });
    target = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-questioner-'));
    await fs.cp(projectPath, target, {
      recursive: true,
      filter: (source) => {
        const relative = path.relative(projectPath, source);
        return relative !== '.git'
          && !relative.startsWith(`.git${path.sep}`)
          && relative !== '.tik'
          && !relative.startsWith(`.tik${path.sep}`);
      },
    });
  }
  return {
    path: target,
    cleanup: async () => {
      if (gitWorktree) {
        await execFileAsync('git', ['worktree', 'remove', '--force', target], {
          cwd: projectPath,
          maxBuffer: 8 * 1024 * 1024,
        }).catch(() => undefined);
      }
      await fs.rm(target, { recursive: true, force: true });
    },
  };
}

function buildAgentRunInput(input: {
  runId: string;
  workflowId: string;
  projectPath: string;
  workspaceRoot: string;
  invocation: AgentInvocationRecord;
  prompt: string;
  runnerMode: 'codex_app_server' | 'claude_hooked';
  timeoutMs?: number;
}): AgentRunInput {
  const task: TrackedTask = {
    id: input.invocation.id,
    shortIdentifier: input.invocation.id,
    title: `${input.invocation.role} for ${input.workflowId}`,
    description: input.prompt,
    state: 'In Progress',
    stateKind: 'active',
    labels: ['multi-agent', input.invocation.role],
    blockedBy: [],
    repository: { path: input.projectPath, executionPath: input.projectPath },
  };
  return {
    runId: input.runId,
    task,
    attempt: 0,
    runnerMode: input.runnerMode,
    workflowPath: '',
    workflowConfigHash: 'multi-agent-native-v1',
    workflowPromptHash: 'multi-agent-native-v1',
    renderedPrompt: input.prompt,
    workspaceRoot: input.workspaceRoot,
    projectPath: input.projectPath,
    labels: task.labels,
    artifactOutputDir: path.join(input.workspaceRoot, '.tik', 'multi-agent-runtime', input.runId),
    timeoutMs: input.timeoutMs,
  };
}

function buildCodexPrompt(goal: string, invocation: AgentInvocationRecord): string {
  const outputContract = invocation.role === 'reviewer'
    ? 'Return JSON only: {"summary":string,"findings":[{"severity":"blocker|high|medium|low","file":string,"line":number,"message":string,"evidence":string}]}.'
    : invocation.role === 'evaluator'
      ? 'Return JSON only: {"verdict":"pass|fail|inconclusive","criteriaResults":array,"runtimeFindings":array,"coverageGaps":array,"artifacts":array}. Include concrete artifact or reproduction evidence for every required criterion.'
      : 'Return a concise structured result. Tik owns workflow state and evidence recording.';
  return [
    `You are the Tik-owned ${invocation.role} native subagent for workflow ${invocation.workflowId}.`,
    `Workflow goal: ${goal}`,
    `Prompt contract: ${invocation.promptContract}`,
    invocation.subtaskId ? `Subtask: ${invocation.subtaskId}` : undefined,
    invocation.allowedPaths?.length ? `Scoped paths: ${invocation.allowedPaths.join(', ')}` : undefined,
    invocation.validationCommands?.length ? `Validation commands: ${invocation.validationCommands.join(' | ')}` : undefined,
    invocation.input ? `Structured input: ${JSON.stringify(invocation.input)}` : undefined,
    outputContract,
  ].filter(Boolean).join('\n');
}

function buildCodexDeveloperInstructions(invocation: AgentInvocationRecord, readonly: boolean): string {
  return [
    `Act only as ${invocation.role}.`,
    readonly
      ? 'This is a read-only run. Do not modify source, tests, manifests, lockfiles, or git state.'
      : `Writes are limited to: ${(invocation.allowedPaths || []).join(', ') || 'the invocation scope'}.`,
    'Do not commit, push, merge, or mutate Tik workflow state directly.',
  ].join('\n');
}

function buildQuestionerPrompt(run: QuestionerRun): string {
  return [
    'Use the question-tik-agent-loop skill.',
    `Process Tik QuestionerRun ${run.id} with intent ${run.intent}.`,
    'Read the token-scoped context from the provided environment, produce QuestionerOutputV2, and submit it exactly once.',
    'Do not edit repository files or workflow state outside the submission endpoint.',
  ].join('\n');
}

function absoluteQuestionerEnv(apiBaseUrl: string, runtimeEnv: Record<string, unknown>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(runtimeEnv)) {
    if (typeof value !== 'string') continue;
    result[key] = (key.endsWith('_URL') && value.startsWith('/'))
      ? new URL(value, apiBaseUrl).toString()
      : value;
  }
  return result;
}

function safeRuntimeBaseEnv(): Record<string, string> {
  return Object.fromEntries([
    ['PATH', process.env.PATH],
    ['HOME', process.env.HOME],
    ['TMPDIR', process.env.TMPDIR],
    ['LANG', process.env.LANG],
  ].filter((entry): entry is [string, string] => Boolean(entry[1])));
}

function readString(record: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function readRecord(record: Record<string, unknown> | undefined, key: string): Record<string, unknown> {
  const value = record?.[key];
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function sameNativeInvocationRequest(existing: AgentInvocationRecord, requested: CreateAgentInvocationInput): boolean {
  return existing.role === requested.role
    && existing.runner === requested.runner
    && existing.subtaskId === requested.subtaskId
    && existing.promptContract === requested.promptContract
    && existing.headSha === requested.headSha
    && (!requested.parentThreadId || existing.parentThreadId === requested.parentThreadId)
    && JSON.stringify(existing.input || {}) === JSON.stringify(requested.input || {})
    && JSON.stringify(existing.allowedPaths || []) === JSON.stringify(requested.allowedPaths || [])
    && JSON.stringify(existing.validationCommands || []) === JSON.stringify(requested.validationCommands || []);
}

async function readGitHead(cwd: string): Promise<string | undefined> {
  return runGit(cwd, ['rev-parse', 'HEAD']);
}

async function readGitStatus(cwd: string): Promise<string> {
  return (await runGit(cwd, ['status', '--porcelain=v1'])) || '';
}

async function runGit(cwd: string, args: string[]): Promise<string | undefined> {
  try {
    const result = await execFileAsync('git', args, { cwd, maxBuffer: 8 * 1024 * 1024 });
    return result.stdout.trim();
  } catch {
    return undefined;
  }
}
