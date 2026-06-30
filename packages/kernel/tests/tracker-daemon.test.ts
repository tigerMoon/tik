import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { EventType, type EnvironmentPackSnapshot } from '@tik/shared';
import { EventBus } from '../src/event-bus.js';
import { FileTrackerDaemonStateStore } from '../src/tracker-daemon/file-state-store.js';
import { TrackerDaemon } from '../src/tracker-daemon/tracker-daemon.js';
import { WorkflowV2WorkbenchTaskImporter } from '../src/tracker-daemon/workbench-tracker-client.js';
import { WorkbenchTrackerLauncher } from '../src/tracker-daemon/workbench-launcher.js';
import { runWorkbenchKernelTaskInBackground } from '../src/tracker-daemon/workbench-runner.js';
import type {
  AgentRunHandle,
  AgentRunInput,
  AgentRunStatusSnapshot,
  AgentRuntimeRunner,
  ArtifactCandidate,
  PreparedRun,
} from '../src/agent-runners/agent-runtime-runner.js';
import type { DiffSummary, TranscriptRef } from '@tik/shared';
import type {
  AgentRuntimeMode,
  AgentRuntimeName,
  TrackerWorkflowDefinition,
  TrackerDaemonStateStore,
  TrackerDaemonWorkLauncher,
  TrackedTask,
  TrackedTaskStateKind,
} from '../src/tracker-daemon/types.js';
import { WorkbenchService } from '../src/workbench/workbench-service.js';
import { WorkbenchStore } from '../src/workbench/workbench-store.js';
import { FileArtifactRegistry } from '../src/artifacts/artifact-registry.js';
import { FileAgentRunStore } from '../src/agent-runners/agent-run-store.js';
import { FileRunProofStore } from '../src/agent-runners/run-proof-store.js';
import { RunProofService } from '../src/agent-runners/run-proof-service.js';

const tempDirs: string[] = [];

const TEST_ENVIRONMENT_SNAPSHOT: EnvironmentPackSnapshot = {
  id: 'test-engineering',
  name: 'Test Engineering',
  version: '1.0.0',
  taskLabels: [
    {
      value: 'backend',
      label: 'Backend',
      action: 'codex_dispatch',
      description: 'Backend implementation work.',
      aliases: [],
    },
    {
      value: 'codex-fix',
      label: 'Codex fix',
      action: 'codex_fix',
      description: 'Fix review blockers.',
      aliases: ['needs-codex-fix'],
    },
    {
      value: 'needs-claude-review',
      label: 'Claude review',
      action: 'claude_code_review',
      description: 'Review with Claude Code.',
      aliases: ['claude-review'],
    },
    {
      value: 'needs-human-review',
      label: 'Human review',
      action: 'human_review',
      description: 'Wait for human review.',
      aliases: ['human-review'],
    },
    {
      value: 'worktree',
      label: 'Worktree',
      action: 'maintenance_manual',
      description: 'Manual workspace maintenance.',
      aliases: ['workspace-maintenance'],
    },
    {
      value: 'loop-complete',
      label: 'Loop complete',
      action: 'loop_complete',
      description: 'Review loop complete.',
      aliases: [],
    },
  ],
};

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

class MemoryTaskImporter {
  constructor(public tasks: TrackedTask[]) {}

  async listCandidateTasks(): Promise<TrackedTask[]> {
    return this.tasks;
  }

  async listOpenAttemptTasks(): Promise<TrackedTask[]> {
    return this.tasks.filter((task) => Boolean(task.activeKernelTaskId));
  }

  async fetchTasksByStates(stateNames: string[]): Promise<TrackedTask[]> {
    const allowed = new Set(stateNames.map((state) => state.toLowerCase()));
    return this.tasks.filter((task) => allowed.has(task.state.toLowerCase()));
  }
}

class MemoryTrackerStateStore implements TrackerDaemonStateStore {
  state = { retries: {} };

  async load() {
    return this.state;
  }

  async save(nextState: typeof this.state): Promise<void> {
    this.state = JSON.parse(JSON.stringify(nextState));
  }
}

class RecordingLauncher implements TrackerDaemonWorkLauncher {
  created: Array<{ task: TrackedTask; taskId: string; projectPath: string }> = [];
  stopped: Array<{ taskId: string; reason: string }> = [];
  failedAttempts: Array<{ taskId: string; error: string }> = [];
  failCreate = false;
  activeRunIds = new Set<string>();
  private nextTask = 1;

  constructor(private readonly workbench: WorkbenchService) {}

  async launchTask(task: TrackedTask, input: { workspaceRoot: string; projectPath: string }) {
    if (this.failCreate) throw new Error('launch failed');
    const kernelTaskId = `kernel-task-${this.nextTask++}`;
    const created = await this.workbench.createTask({
      id: task.id,
      shortIdentifier: task.shortIdentifier,
      title: task.title,
      description: task.description,
      goal: task.description || task.title,
      state: task.state,
      priority: task.priority,
      labels: task.labels,
      blockedBy: task.blockedBy,
      sourceUrl: task.sourceUrl,
      workspaceBinding: {
        workspaceRoot: input.workspaceRoot,
        workspaceName: path.basename(input.workspaceRoot),
        effectiveProjectPath: input.projectPath,
        projectName: task.repository?.name,
        sourceProjectPath: input.projectPath,
        worktreeKind: 'root',
      },
      runs: [{
        runId: `run-${kernelTaskId}`,
        startedAt: new Date().toISOString(),
        status: 'running',
        kernelTaskId,
        agentName: 'tracker-daemon',
      }],
    }, task.id);
    this.created.push({ task, taskId: created.id, projectPath: input.projectPath });
    return { taskId: kernelTaskId, workbenchTaskId: created.id };
  }

  async stopRun(input: { taskId: string; reason: string }): Promise<void> {
    this.stopped.push({ taskId: input.taskId, reason: input.reason });
  }

  isRunActive(kernelTaskId: string): boolean {
    return this.activeRunIds.has(kernelTaskId);
  }

  async markAttemptFailed(taskId: string, error: string): Promise<void> {
    this.failedAttempts.push({ taskId, error });
    await this.workbench.finishAttempt?.(taskId, 1, 'failed', error);
    await this.workbench.transitionTask?.(taskId, 'failed', {
      actor: 'daemon',
      reason: error,
    });
  }
}

class CompletingRuntimeRunner implements AgentRuntimeRunner {
  readonly name: AgentRuntimeName;
  preparedInputs: AgentRunInput[] = [];
  startedInputs: PreparedRun[] = [];
  stdoutText = '';
  transcriptRefs: TranscriptRef[] = [];
  diffSummary: DiffSummary = { changedFiles: [] };
  private statuses = new Map<string, AgentRunStatusSnapshot>();

  constructor(name: AgentRuntimeName) {
    this.name = name;
  }

  async prepare(input: AgentRunInput): Promise<PreparedRun> {
    this.preparedInputs.push(input);
    const runDir = path.join(input.workspaceRoot, '.tik', 'runs', input.runId);
    await fs.mkdir(runDir, { recursive: true });
    const promptFile = path.join(runDir, 'prompt.md');
    await fs.writeFile(promptFile, input.renderedPrompt, 'utf-8');
    return {
      runId: input.runId,
      runner: this.name,
      mode: input.runnerMode,
      cwd: input.projectPath,
      prompt: input.renderedPrompt,
      promptFile,
    };
  }

  async start(input: PreparedRun): Promise<AgentRunHandle> {
    this.startedInputs.push(input);
    this.statuses.set(input.runId, 'running');
    if (this.stdoutText && input.promptFile) {
      await fs.writeFile(path.join(path.dirname(input.promptFile), 'stdout.log'), this.stdoutText, 'utf-8');
    }
    const completion = Promise.resolve({ status: 'completed' as const }).then((result) => {
      this.statuses.set(input.runId, result.status);
      return result;
    });
    return {
      runId: input.runId,
      startedAt: new Date().toISOString(),
      completion,
      stop: async () => {
        this.statuses.set(input.runId, 'cancelled');
      },
    };
  }

  async stop(runId: string): Promise<void> {
    this.statuses.set(runId, 'cancelled');
  }

  async getStatus(runId: string): Promise<AgentRunStatusSnapshot> {
    return this.statuses.get(runId) || 'unknown';
  }

  async collectTranscript() {
    return this.transcriptRefs;
  }

  async collectDiff() {
    return this.diffSummary;
  }

  async collectArtifacts(): Promise<ArtifactCandidate[]> {
    return [];
  }

  async cleanup(runId: string): Promise<void> {
    await this.stop(runId);
  }
}

function task(id: string, shortIdentifier: string, stateKind: TrackedTaskStateKind = 'active'): TrackedTask {
  return {
    id,
    shortIdentifier,
    title: `Task ${shortIdentifier}`,
    description: `Do ${shortIdentifier}`,
    state: stateKind === 'active' ? 'Todo' : stateKind,
    stateKind,
    sourceUrl: `https://tracker.local/${shortIdentifier}`,
    labels: [],
    blockedBy: [],
    repository: {
      name: 'tik',
      path: '/repo/tik',
    },
  };
}

function workflowV2(input: {
  root: string;
  runner: AgentRuntimeName;
  mode: AgentRuntimeMode;
  validationCommands?: string[];
  renderPrompt?: (task: TrackedTask, attempt: number) => string;
}): TrackerWorkflowDefinition {
  return {
    version: 2,
    path: path.join(input.root, '.tik', 'WORKFLOW.md'),
    workflowConfigHash: 'config-hash',
    workflowPromptHash: 'prompt-hash',
    config: {
      tracker: {
        kind: 'json',
        activeStates: ['todo', 'in_progress', 'running', 'failed'],
        terminalStates: ['completed', 'cancelled', 'archived'],
      },
      polling: { intervalMs: 1_000, maxConcurrentAgents: 3 },
      workspace: {
        root: '.tik/workspaces',
        cleanupTerminal: false,
        hooks: { afterCreate: [], beforeRun: [], afterRun: [], beforeRemove: [] },
      },
      agent: { timeoutMs: 10_000 },
      routing: {
        rules: [{
          labelsAny: input.runner === 'claude-code'
            ? ['needs-claude-review']
            : ['needs-codex-fix'],
          runner: input.runner,
          mode: input.mode,
        }],
      },
      concurrency: { lock: 'repository_branch', respectLabels: [] },
      sandbox: { envWhitelist: [] },
      validation: input.validationCommands ? { commands: input.validationCommands } : undefined,
      hooks: { root: '.tik/hooks', timeoutMs: 30_000, allowExecutableOnly: true },
    },
    promptTemplate: 'Review {{ task.shortIdentifier }}',
    renderPrompt(taskInput, renderInput) {
      return input.renderPrompt?.(taskInput, renderInput?.attempt || 0) || `Review ${taskInput.shortIdentifier}.`;
    },
    resolveRouting() {
      return {
        runner: input.runner,
        mode: input.mode,
        matchedSource: 'rule[0]',
        matchedLabels: input.runner === 'claude-code'
          ? ['needs-claude-review']
          : ['needs-codex-fix'],
      };
    },
  };
}

async function waitForWorkbenchTask(
  workbench: WorkbenchService,
  taskId: string,
  predicate: (task: Awaited<ReturnType<WorkbenchService['readTask']>>) => boolean | Promise<boolean>,
) {
  for (let attempt = 0; attempt < 20; attempt++) {
    const task = await workbench.readTask(taskId);
    if (await predicate(task)) return task;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  const latest = await workbench.readTask(taskId);
  throw new Error(`Timed out waiting for workbench task ${taskId}. Latest status: ${latest?.status || 'missing'}`);
}

async function makeHarness() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-tracker-daemon-'));
  tempDirs.push(root);
  const workbench = new WorkbenchService({
    rootPath: root,
    eventBus: new EventBus(),
    store: new WorkbenchStore(root),
  });
  const importer = new MemoryTaskImporter([]);
  const stateStore = new MemoryTrackerStateStore();
  const launcher = new RecordingLauncher(workbench);
  const daemon = new TrackerDaemon({
    importer,
    stateStore,
    launcher,
    workspaceRoot: root,
    defaultProjectPath: root,
    now: () => 1_000,
    retry: {
      initialDelayMs: 500,
      maxDelayMs: 2_000,
      maxAttempts: 3,
    },
  });
  return { root, workbench, importer, stateStore, launcher, daemon };
}

async function runGit(cwd: string, args: string[]): Promise<string> {
  const result = spawnSync('git', args, { cwd, encoding: 'utf-8' });
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || `git ${args.join(' ')} failed`);
  }
  return result.stdout.trim();
}

describe('TrackerDaemon', () => {
  it('dispatches each eligible tracked task once into a workbench task with workspace binding', async () => {
    const { root, importer, launcher, daemon, workbench } = await makeHarness();
    importer.tasks = [task('task-1', 'TIK-1')];

    const first = await daemon.tick();
    launcher.activeRunIds.add('kernel-task-1');
    importer.tasks = [{ ...task('task-1', 'TIK-1'), state: 'in_progress' }];
    const second = await daemon.tick();

    expect(first.dispatched).toEqual(['TIK-1']);
    expect(second.dispatched).toEqual([]);
    expect(second.skipped).toEqual([{ shortIdentifier: 'TIK-1', reason: 'already-running' }]);
    expect(launcher.created).toHaveLength(1);
    const workbenchTask = await workbench.readTask('task-1');
    expect(workbenchTask?.title).toBe('Task TIK-1');
    expect(workbenchTask?.shortIdentifier).toBe('TIK-1');
    expect(workbenchTask?.workspaceBinding).toMatchObject({
      workspaceRoot: root,
      workspaceName: path.basename(root),
      effectiveProjectPath: '/repo/tik',
      projectName: 'tik',
      sourceProjectPath: '/repo/tik',
    });
  });

  it('does not dispatch blocked tasks until blockers clear', async () => {
    const { importer, launcher, daemon } = await makeHarness();
    importer.tasks = [
      {
        ...task('task-2', 'TIK-2'),
        blockedBy: [{ id: 'dep-1', shortIdentifier: 'TIK-1', state: 'Todo' }],
      },
    ];

    expect((await daemon.tick()).skipped).toEqual([
      { shortIdentifier: 'TIK-2', reason: 'blocked' },
    ]);
    importer.tasks = [task('task-2', 'TIK-2')];
    expect((await daemon.tick()).dispatched).toEqual(['TIK-2']);
    expect(launcher.created).toHaveLength(1);
  });

  it('stops active runs when tracker state becomes terminal', async () => {
    const { importer, launcher, daemon } = await makeHarness();
    importer.tasks = [{
      ...task('task-3', 'TIK-3', 'terminal'),
      state: 'completed',
      activeKernelTaskId: 'kernel-task-1',
      activeAttemptStartedAt: '2026-01-01T00:00:00.000Z',
    }];
    const result = await daemon.tick();

    expect(result.stopped).toEqual(['TIK-3']);
    expect(launcher.stopped).toEqual([
      { taskId: 'kernel-task-1', reason: 'Task TIK-3 is no longer active: terminal' },
    ]);
  });

  it('records retry state with exponential backoff when dispatch fails', async () => {
    const { importer, launcher, daemon, stateStore } = await makeHarness();
    importer.tasks = [task('task-4', 'TIK-4')];
    launcher.failCreate = true;

    const first = await daemon.tick();
    const second = await daemon.tick();

    expect(first.failed).toEqual([{ shortIdentifier: 'TIK-4', error: 'launch failed' }]);
    expect(second.skipped).toEqual([{ shortIdentifier: 'TIK-4', reason: 'retry-wait' }]);
    expect(stateStore.state.retries['task-4']).toMatchObject({
      shortIdentifier: 'TIK-4',
      attempt: 1,
      dueAtMs: 1_500,
      lastError: 'launch failed',
    });
  });

  it('respects maxConcurrentAgents across ticks based on in-progress tasks instead of legacy runs', async () => {
    const { importer, daemon } = await makeHarness();
    const activeTasks = [
      { ...task('task-1', 'TIK-1'), state: 'todo' },
      { ...task('task-2', 'TIK-2'), state: 'todo' },
    ];
    importer.tasks = [activeTasks[0]!];
    const runningLauncher = new RecordingLauncher((await makeHarness()).workbench);
    const firstDaemon = new TrackerDaemon({
      importer,
      stateStore: new MemoryTrackerStateStore(),
      launcher: runningLauncher,
      workspaceRoot: '/workspace',
      defaultProjectPath: '/repo/default',
      maxConcurrentAgents: 1,
    });

    const first = await firstDaemon.tick();
    runningLauncher.activeRunIds.add('kernel-task-1');
    importer.tasks = [
      { ...activeTasks[0]!, state: 'in_progress' },
      activeTasks[1]!,
    ];
    const second = await firstDaemon.tick();

    expect(first.dispatched).toEqual(['TIK-1']);
    expect(second.dispatched).toEqual([]);
    expect(second.skipped).toEqual(expect.arrayContaining([
      { shortIdentifier: 'TIK-1', reason: 'already-running' },
      { shortIdentifier: 'TIK-2', reason: 'concurrency-limit' },
    ]));
  });

  it('stops terminal in-progress tasks by reading workbench attempts when legacy runs are absent', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-tracker-daemon-'));
    tempDirs.push(root);
    const store = new WorkbenchStore(root);
    const workbench = new WorkbenchService({
      rootPath: root,
      eventBus: new EventBus(),
      store,
    });
    await workbench.createTask({
      id: 'task-stop',
      shortIdentifier: 'TIK-STOP',
      title: 'Stop me',
      goal: 'Verify terminal cleanup',
      status: 'in_progress',
      attempts: [{
        attemptNumber: 1,
        startedAt: '2026-01-01T00:00:00.000Z',
        kernelTaskId: 'kernel-stop-1',
      }],
    }, 'task-stop');

    const launcher = new RecordingLauncher(workbench);
    const importer = new MemoryTaskImporter([
      { ...task('task-stop', 'TIK-STOP', 'terminal'), state: 'completed' },
    ]);
    importer.tasks = [{
      ...task('task-stop', 'TIK-STOP', 'terminal'),
      state: 'completed',
      activeKernelTaskId: 'kernel-stop-1',
      activeAttemptStartedAt: '2026-01-01T00:00:00.000Z',
    }];
    const daemon = new TrackerDaemon({
      importer,
      stateStore: new MemoryTrackerStateStore(),
      launcher,
      workspaceRoot: root,
      defaultProjectPath: root,
      terminalStates: ['completed'],
    });

    const result = await daemon.tick();

    expect(result.stopped).toEqual(['TIK-STOP']);
    expect(launcher.stopped).toEqual([
      { taskId: 'kernel-stop-1', reason: 'Task TIK-STOP is no longer active: terminal' },
    ]);
  });

  it('fails stale open attempts when the kernel task is absent from the current daemon runtime', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-tracker-daemon-'));
    tempDirs.push(root);
    const workbench = new WorkbenchService({
      rootPath: root,
      eventBus: new EventBus(),
      store: new WorkbenchStore(root),
    });
    await workbench.createTask({
      id: 'task-stale',
      shortIdentifier: 'TIK-STALE',
      title: 'Stale task',
      goal: 'Recover an orphaned attempt',
      status: 'in_progress',
      labels: ['backend'],
      environmentPackSnapshot: TEST_ENVIRONMENT_SNAPSHOT,
      attempts: [{
        attemptNumber: 1,
        startedAt: '2026-01-01T00:00:00.000Z',
        kernelTaskId: 'kernel-missing',
      }],
    }, 'task-stale');

    const importer = new WorkflowV2WorkbenchTaskImporter(workbench, root);
    const launcher = new WorkbenchTrackerLauncher(workbench, {
      workspaceRoot: root,
      defaultProjectPath: root,
      createKernelTask: () => ({ id: 'kernel-new' }),
      isRunActive: () => false,
    });
    const daemon = new TrackerDaemon({
      importer,
      stateStore: new MemoryTrackerStateStore(),
      launcher,
      workspaceRoot: root,
      defaultProjectPath: root,
    });

    const result = await daemon.tick();
    const recovered = await workbench.readTask('task-stale');

    expect(result.stopped).toEqual(['TIK-STALE']);
    expect(result.skipped).not.toContainEqual({ shortIdentifier: 'TIK-STALE', reason: 'already-running' });
    expect(recovered?.status).toBe('failed');
    expect(recovered?.attempts?.[0]).toMatchObject({
      outcome: 'failed',
      error: 'Kernel task kernel-missing is no longer active in this daemon runtime.',
    });
    expect(recovered?.attempts?.[0]?.finishedAt).toBeTruthy();
  });

  it('redispatches a running workbench task that has no open kernel attempt after restart', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-tracker-daemon-'));
    tempDirs.push(root);
    const workbench = new WorkbenchService({
      rootPath: root,
      eventBus: new EventBus(),
      store: new WorkbenchStore(root),
    });
    await workbench.createTask({
      id: 'task-orphan-running',
      shortIdentifier: 'TIK-ORPHAN',
      title: 'Orphan running task',
      goal: 'Recover after daemon restart',
      status: 'running',
      labels: ['backend'],
      environmentPackSnapshot: TEST_ENVIRONMENT_SNAPSHOT,
      activeSessionId: 'stale-session-id',
    }, 'task-orphan-running');

    const importer = new WorkflowV2WorkbenchTaskImporter(workbench, root);
    const launcher = new WorkbenchTrackerLauncher(workbench, {
      workspaceRoot: root,
      defaultProjectPath: root,
      createKernelTask: () => ({ id: 'kernel-recovered' }),
      runTask: () => undefined,
    });
    const daemon = new TrackerDaemon({
      importer,
      stateStore: new MemoryTrackerStateStore(),
      launcher,
      workspaceRoot: root,
      defaultProjectPath: root,
    });

    const result = await daemon.tick();
    const recovered = await workbench.readTask('task-orphan-running');

    expect(result.dispatched).toEqual(['TIK-ORPHAN']);
    expect(result.skipped).not.toContainEqual({ shortIdentifier: 'TIK-ORPHAN', reason: 'already-running' });
    expect(recovered?.status).toBe('in_progress');
    expect(recovered?.attempts?.[0]).toMatchObject({
      attemptNumber: 1,
      kernelTaskId: 'kernel-recovered',
    });
  });

  it('uses a resolved execution target so tracker tasks can run inside managed worktree lanes', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-tracker-daemon-'));
    tempDirs.push(root);
    const workbench = new WorkbenchService({
      rootPath: root,
      eventBus: new EventBus(),
      store: new WorkbenchStore(root),
    });
    const launcher = new WorkbenchTrackerLauncher(workbench, {
      workspaceRoot: root,
      defaultProjectPath: path.join(root, 'source'),
      resolveExecutionTarget: async (input) => ({
        sourceProjectPath: input.sourceProjectPath,
        effectiveProjectPath: path.join(root, '.workspace', 'worktrees', 'tik-5'),
        worktreeKind: 'git-worktree',
        worktreePath: path.join(root, '.workspace', 'worktrees', 'tik-5'),
      }),
    });

    await launcher.launchTask(task('task-5', 'TIK-5'), {
      workspaceRoot: root,
      projectPath: path.join(root, 'source'),
    });

    const [workbenchTask] = await workbench.listTasks();
    expect(workbenchTask?.workspaceBinding).toMatchObject({
      sourceProjectPath: path.join(root, 'source'),
      effectiveProjectPath: path.join(root, '.workspace', 'worktrees', 'tik-5'),
      laneId: 'tik-5',
      worktreeKind: 'git-worktree',
      worktreePath: path.join(root, '.workspace', 'worktrees', 'tik-5'),
    });
  });

  it('imports a tracked task as the unified workbench task record with attempt history', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-tracker-daemon-'));
    tempDirs.push(root);
    const workbench = new WorkbenchService({
      rootPath: root,
      eventBus: new EventBus(),
      store: new WorkbenchStore(root),
    });
    const launcher = new WorkbenchTrackerLauncher(workbench, {
      workspaceRoot: root,
      defaultProjectPath: path.join(root, 'source'),
      createKernelTask: () => ({ id: 'kernel-task-1' }),
    });

    const trackedTask = {
      ...task('linear-task-id', 'TIK-42'),
      title: 'Ship daemon',
      description: 'Build the tracker daemon.',
      priority: 1,
      labels: ['backend'],
      blockedBy: [{ id: 'dep-1', shortIdentifier: 'TIK-1', state: 'Done' }],
      updatedAt: '2026-01-02T00:00:00.000Z',
    };
    const launched = await launcher.launchTask(trackedTask, {
      workspaceRoot: root,
      projectPath: path.join(root, 'source'),
      attempt: 2,
    });

    const workbenchTask = await workbench.readTask('linear-task-id');
    expect(launched).toMatchObject({
      taskId: 'kernel-task-1',
      workbenchTaskId: 'linear-task-id',
    });
    expect(workbenchTask).toMatchObject({
      id: 'linear-task-id',
      shortIdentifier: 'TIK-42',
      title: 'Ship daemon',
      description: 'Build the tracker daemon.',
      state: 'Todo',
      priority: 1,
      labels: ['backend'],
      blockedBy: [{ id: 'dep-1', shortIdentifier: 'TIK-1', state: 'Done' }],
      sourceUrl: 'https://tracker.local/TIK-42',
    });
    expect(workbenchTask?.title).not.toContain('TIK-42:');
    expect(workbenchTask?.attempts).toEqual([
      expect.objectContaining({
        attemptNumber: 1,
        kernelTaskId: 'kernel-task-1',
      }),
    ]);
  });

  it('uses the tracked task id for kernel execution so runtime events project onto the same workbench task', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-tracker-daemon-'));
    tempDirs.push(root);
    const workbench = new WorkbenchService({
      rootPath: root,
      eventBus: new EventBus(),
      store: new WorkbenchStore(root),
    });
    const captureKernelTaskInputs: Array<Record<string, unknown>> = [];
    const launcher = new WorkbenchTrackerLauncher(workbench, {
      workspaceRoot: root,
      defaultProjectPath: path.join(root, 'source'),
      createKernelTask: (input) => {
        captureKernelTaskInputs.push(input);
        return { id: input.id || 'kernel-task-1' };
      },
    });

    await launcher.launchTask(task('tracked-task-id', 'TIK-83'), {
      workspaceRoot: root,
      projectPath: path.join(root, 'source'),
    });

    const workbenchTask = await workbench.readTask('tracked-task-id');
    expect(captureKernelTaskInputs[0]).toMatchObject({ id: 'tracked-task-id' });
    expect(workbenchTask?.attempts?.[0]?.kernelTaskId).toBe('tracked-task-id');
  });

  it('appends a new attempt when the same tracked task is relaunched', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-tracker-daemon-'));
    tempDirs.push(root);
    const workbench = new WorkbenchService({
      rootPath: root,
      eventBus: new EventBus(),
      store: new WorkbenchStore(root),
    });
    let nextKernelTask = 1;
    const launcher = new WorkbenchTrackerLauncher(workbench, {
      workspaceRoot: root,
      defaultProjectPath: path.join(root, 'source'),
      createKernelTask: () => ({ id: `kernel-task-${nextKernelTask++}` }),
    });

    await launcher.launchTask(task('tracked-task-id', 'TIK-77'), {
      workspaceRoot: root,
      projectPath: path.join(root, 'source'),
    });
    await launcher.launchTask(task('tracked-task-id', 'TIK-77'), {
      workspaceRoot: root,
      projectPath: path.join(root, 'source'),
    });

    const workbenchTask = await workbench.readTask('tracked-task-id');
    expect(workbenchTask?.attempts?.map((attempt) => attempt.kernelTaskId)).toEqual([
      'kernel-task-1',
      'kernel-task-2',
    ]);
  });

  it('finishes the attempt and fails the workbench task when background kernel execution rejects', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-tracker-daemon-'));
    tempDirs.push(root);
    const workbench = new WorkbenchService({
      rootPath: root,
      eventBus: new EventBus(),
      store: new WorkbenchStore(root),
    });
    const launcher = new WorkbenchTrackerLauncher(workbench, {
      workspaceRoot: root,
      defaultProjectPath: path.join(root, 'source'),
      createKernelTask: () => ({ id: 'kernel-task-fails' }),
      runTask: (kernelTask, input) => runWorkbenchKernelTaskInBackground(kernelTask, {
        taskId: input.workbenchTaskId,
        workbench,
        runTask: async () => {
          throw new Error('agent boot failed');
        },
      }),
    });

    await launcher.launchTask(task('tracked-task-id', 'TIK-83'), {
      workspaceRoot: root,
      projectPath: path.join(root, 'source'),
    });

    const workbenchTask = await waitForWorkbenchTask(workbench, 'tracked-task-id', (candidate) => (
      candidate?.status === 'failed'
      && candidate.attempts?.[0]?.outcome === 'failed'
    ));
    expect(workbenchTask?.status).toBe('failed');
    expect(workbenchTask?.attempts).toEqual([
      expect.objectContaining({
        attemptNumber: 1,
        kernelTaskId: 'kernel-task-fails',
        outcome: 'failed',
        error: 'agent boot failed',
      }),
    ]);
    expect(workbenchTask?.attempts?.[0]?.finishedAt).toBeTruthy();

    const importer = new WorkflowV2WorkbenchTaskImporter(workbench, root);
    const running = await importer.listOpenAttemptTasks();
    expect(running).toEqual([]);
  });

  it('syncs tracker metadata onto an existing workbench task before appending a new attempt', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-tracker-daemon-'));
    tempDirs.push(root);
    const workbench = new WorkbenchService({
      rootPath: root,
      eventBus: new EventBus(),
      store: new WorkbenchStore(root),
    });
    const launcher = new WorkbenchTrackerLauncher(workbench, {
      workspaceRoot: root,
      defaultProjectPath: path.join(root, 'source'),
      createKernelTask: () => ({ id: 'kernel-task-1' }),
    });

    await workbench.createTask({
      id: 'tracked-task-id',
      shortIdentifier: 'TIK-77',
      title: 'Old title',
      description: 'Old description',
      goal: 'Old goal',
      status: 'todo',
      priority: 4,
      labels: ['old'],
      assignee: 'old-owner',
      humanAssignee: 'old-owner',
      createdBy: 'legacy',
      sourceUrl: 'https://old.local/TIK-77',
    }, 'tracked-task-id');

    await launcher.launchTask({
      ...task('tracked-task-id', 'TIK-77'),
      title: 'New title',
      description: 'New description',
      priority: 1,
      labels: ['backend', 'tracker'],
      assignee: 'new-owner',
      createdBy: 'linear-import',
      sourceUrl: 'https://tracker.local/TIK-77',
    }, {
      workspaceRoot: root,
      projectPath: path.join(root, 'source'),
    });

    const workbenchTask = await workbench.readTask('tracked-task-id');
    expect(workbenchTask).toMatchObject({
      title: 'New title',
      description: 'New description',
      priority: 1,
      labels: ['backend', 'tracker'],
      assignee: 'new-owner',
      humanAssignee: 'new-owner',
      createdBy: 'linear-import',
      sourceUrl: 'https://tracker.local/TIK-77',
    });
    expect(workbenchTask?.attempts).toEqual([
      expect.objectContaining({
        attemptNumber: 1,
        kernelTaskId: 'kernel-task-1',
      }),
    ]);
  });

  it('imports candidate tasks directly from the workbench task store', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-tracker-daemon-'));
    tempDirs.push(root);
    const workbench = new WorkbenchService({
      rootPath: root,
      eventBus: new EventBus(),
      store: new WorkbenchStore(root),
    });
    await workbench.createTask({
      title: 'Ready task',
      goal: 'This should dispatch',
      status: 'todo',
      priority: 1,
      labels: ['backend'],
      environmentPackSnapshot: TEST_ENVIRONMENT_SNAPSHOT,
      workspaceBinding: {
        workspaceRoot: root,
        workspaceName: 'tik',
        projectName: 'api',
        sourceProjectPath: path.join(root, 'api'),
        effectiveProjectPath: path.join(root, 'api'),
        worktreeKind: 'root',
      },
    }, 'task-ready');
    await workbench.createTask({
      title: 'Parked task',
      goal: 'This should not dispatch',
      status: 'backlog',
    }, 'task-backlog');

    const importer = new WorkflowV2WorkbenchTaskImporter(workbench, root);
    const tasks = await importer.listCandidateTasks();

    expect(tasks.map((entry) => entry.id)).toEqual(['task-ready']);
    expect(tasks[0]).toMatchObject({
      shortIdentifier: expect.stringMatching(/^TIK-/),
      title: 'Ready task',
      description: 'This should dispatch',
      priority: 1,
      labels: ['backend'],
      state: 'todo',
      stateKind: 'active',
      repository: {
        name: 'api',
        path: path.join(root, 'api'),
      },
    });

    const fetched = await importer.fetchTaskStatesByIds?.(['task-ready', 'task-backlog']);
    expect(fetched?.map((entry) => [entry.id, entry.stateKind])).toEqual([
      ['task-ready', 'active'],
      ['task-backlog', 'blocked'],
    ]);
  });

  it('keeps workspace maintenance tasks out of the Codex dispatch queue', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-tracker-daemon-'));
    tempDirs.push(root);
    const workbench = new WorkbenchService({
      rootPath: root,
      eventBus: new EventBus(),
      store: new WorkbenchStore(root),
    });
    await workbench.createTask({
      title: 'Ready coding task',
      goal: 'This should dispatch',
      status: 'todo',
      labels: ['backend'],
      environmentPackSnapshot: TEST_ENVIRONMENT_SNAPSHOT,
    }, 'task-coding');
    await workbench.createTask({
      title: 'Clean worktrees',
      goal: 'Remove stale workspace worktrees',
      status: 'todo',
      labels: ['worktree'],
      environmentPackSnapshot: TEST_ENVIRONMENT_SNAPSHOT,
    }, 'task-maintenance');

    const importer = new WorkflowV2WorkbenchTaskImporter(workbench, root);

    await expect(importer.listCandidateTasks()).resolves.toEqual([
      expect.objectContaining({ id: 'task-coding' }),
    ]);
    await expect(importer.fetchTaskStatesByIds?.(['task-maintenance'])).resolves.toEqual([
      expect.objectContaining({ id: 'task-maintenance', stateKind: 'blocked' }),
    ]);
  });

  it('marks environment-routed Claude review tasks active for workflow v2 dispatch', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-tracker-daemon-'));
    tempDirs.push(root);
    const workbench = new WorkbenchService({
      rootPath: root,
      eventBus: new EventBus(),
      store: new WorkbenchStore(root),
    });
    await workbench.createTask({
      id: 'task-claude-review',
      shortIdentifier: 'TIK-101',
      title: 'Review workspace changes',
      goal: 'Review the current worktree.',
      status: 'todo',
      labels: ['needs-claude-review'],
      environmentPackSnapshot: TEST_ENVIRONMENT_SNAPSHOT,
    }, 'task-claude-review');

    const workflowImporter = new WorkflowV2WorkbenchTaskImporter(workbench, root);

    await expect(workflowImporter.listCandidateTasks()).resolves.toEqual([
      expect.objectContaining({
        id: 'task-claude-review',
        shortIdentifier: 'TIK-101',
        labels: ['needs-claude-review'],
        stateKind: 'active',
        repository: expect.objectContaining({
          path: root,
          executionPath: root,
        }),
      }),
    ]);
  });

  it('keeps externally-owned Claude review tasks out of workflow v2 dispatch', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-tracker-daemon-'));
    tempDirs.push(root);
    const workbench = new WorkbenchService({
      rootPath: root,
      eventBus: new EventBus(),
      store: new WorkbenchStore(root),
    });
    await workbench.createTask({
      id: 'task-external-claude-review',
      shortIdentifier: 'TIK-EXT-REVIEW',
      title: 'Review workspace changes externally',
      goal: 'Review the current worktree in a separately managed Claude Code session.',
      status: 'todo',
      labels: ['needs-claude-review', 'external-claude-review'],
      environmentPackSnapshot: TEST_ENVIRONMENT_SNAPSHOT,
      agentLoop: {
        kind: 'claude_review',
        phase: 'needs_claude_review',
        rootTaskId: 'task-root',
        round: 1,
        maxRounds: 3,
        headSha: 'abc123',
        idempotencyKey: 'external-review',
        changeRequest: {
          scm: 'internal',
          repo: 'repo',
          id: 'task-root:abc123',
          type: 'internal_review',
          baseRef: 'HEAD~1',
          headRef: 'feature',
          headSha: 'abc123',
        },
      },
    }, 'task-external-claude-review');

    const workflowImporter = new WorkflowV2WorkbenchTaskImporter(workbench, root);

    await expect(workflowImporter.listCandidateTasks()).resolves.toEqual([]);
    await expect(workflowImporter.fetchTaskStatesByIds?.(['task-external-claude-review'])).resolves.toEqual([
      expect.objectContaining({
        id: 'task-external-claude-review',
        stateKind: 'blocked',
      }),
    ]);

    await workbench.completeAgentLoopReview('task-external-claude-review', {
      verdict: 'request_changes',
      headShaReviewed: 'abc123',
      blockingIssues: [{
        title: 'Missing regression test',
        file: 'packages/kernel/tests/tracker-daemon.test.ts',
        reason: 'The external review loop should remain owned by the invoking Codex skill.',
      }],
      markdown: 'Blocking issue found.',
    });

    await expect(workflowImporter.listCandidateTasks()).resolves.toEqual([]);
    await expect(workflowImporter.fetchTaskStatesByIds?.(['task-external-claude-review'])).resolves.toEqual([
      expect.objectContaining({
        id: 'task-external-claude-review',
        labels: ['agent-loop', 'codex-fix', 'external-claude-review', 'needs-codex-fix'],
        stateKind: 'blocked',
        agentLoop: expect.objectContaining({
          kind: 'codex_fix',
          phase: 'needs_codex_fix',
        }),
      }),
    ]);
  });

  it('injects a Tik-generated diff summary into Claude review prompts', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-tracker-daemon-'));
    tempDirs.push(root);
    const repo = path.join(root, 'repo');
    await fs.mkdir(repo, { recursive: true });
    await fs.writeFile(path.join(repo, 'feature.ts'), 'export const oldValue = 1;\n', 'utf-8');
    await runGit(repo, ['init']);
    await runGit(repo, ['config', 'user.email', 'test@example.com']);
    await runGit(repo, ['config', 'user.name', 'Tik Test']);
    await runGit(repo, ['add', 'feature.ts']);
    await runGit(repo, ['commit', '-m', 'init']);
    await fs.writeFile(path.join(repo, 'feature.ts'), 'export const newValue = 2;\n', 'utf-8');

    const workbench = new WorkbenchService({
      rootPath: root,
      eventBus: new EventBus(),
      store: new WorkbenchStore(root),
    });
    await workbench.createTask({
      id: 'task-review-context',
      shortIdentifier: 'TIK-REVIEW',
      title: 'Review current diff',
      goal: 'Review the current diff.',
      status: 'todo',
      labels: ['needs-claude-review'],
      environmentPackSnapshot: TEST_ENVIRONMENT_SNAPSHOT,
      workspaceBinding: {
        workspaceRoot: root,
        workspaceName: 'tik',
        projectName: 'repo',
        sourceProjectPath: repo,
        effectiveProjectPath: repo,
        worktreeKind: 'root',
      },
    }, 'task-review-context');

    const trackedTask = (await new WorkflowV2WorkbenchTaskImporter(workbench, repo).fetchTaskStatesByIds?.(['task-review-context']))![0]!;
    const runtimeRunner = new CompletingRuntimeRunner('claude-code');
    const daemon = new TrackerDaemon({
      importer: new MemoryTaskImporter([trackedTask]),
      stateStore: new MemoryTrackerStateStore(),
      launcher: new WorkbenchTrackerLauncher(workbench, {
        workspaceRoot: root,
        defaultProjectPath: repo,
      }),
      workspaceRoot: root,
      defaultProjectPath: repo,
      now: () => 1_000,
      runtimeRunners: { 'claude-code': runtimeRunner },
      workflow: workflowV2({
        root,
        runner: 'claude-code',
        mode: 'claude_print',
        renderPrompt: (trackedTask) => `Review ${trackedTask.shortIdentifier}.`,
      }),
    });

    const result = await daemon.tick();

    expect(result.dispatched).toEqual(['TIK-REVIEW']);
    expect(runtimeRunner.preparedInputs[0]?.renderedPrompt).toContain('Tik-generated review context');
    expect(runtimeRunner.preparedInputs[0]?.renderedPrompt).toContain('git status --short');
    expect(runtimeRunner.preparedInputs[0]?.renderedPrompt).toContain('M feature.ts');
    expect(runtimeRunner.preparedInputs[0]?.renderedPrompt).toContain('feature.ts');
    expect(runtimeRunner.preparedInputs[0]?.renderedPrompt).toContain('-export const oldValue = 1;');
    expect(runtimeRunner.preparedInputs[0]?.renderedPrompt).toContain('+export const newValue = 2;');
    await waitForWorkbenchTask(workbench, 'task-review-context', (candidate) => candidate?.status === 'in_review');
  });

  it('keeps worktree diff snippets in Claude review prompts when a head sha is pinned', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-tracker-daemon-'));
    tempDirs.push(root);
    const repo = path.join(root, 'repo');
    await fs.mkdir(repo, { recursive: true });
    await fs.writeFile(path.join(repo, 'feature.ts'), 'export const oldValue = 1;\n', 'utf-8');
    await runGit(repo, ['init']);
    await runGit(repo, ['config', 'user.email', 'test@example.com']);
    await runGit(repo, ['config', 'user.name', 'Tik Test']);
    await runGit(repo, ['add', 'feature.ts']);
    await runGit(repo, ['commit', '-m', 'init']);
    const headSha = await runGit(repo, ['rev-parse', 'HEAD']);
    await fs.writeFile(path.join(repo, 'feature.ts'), 'export const dirtyValue = 3;\n', 'utf-8');

    const workbench = new WorkbenchService({
      rootPath: root,
      eventBus: new EventBus(),
      store: new WorkbenchStore(root),
    });
    const reviewTask = await workbench.createReviewRound({
      rootTaskId: 'task-root',
      round: 1,
      maxRounds: 2,
      changeRequest: {
        scm: 'internal',
        repo: 'repo',
        id: 'task-root',
        type: 'internal_review',
        title: 'Review pinned head with local diff',
        baseRef: 'HEAD',
        headRef: 'main',
        headSha,
      },
      idempotencyKey: 'review-pinned-head-with-dirty-worktree',
      workspaceBinding: {
        workspaceRoot: root,
        workspaceName: 'tik',
        projectName: 'repo',
        sourceProjectPath: repo,
        effectiveProjectPath: repo,
        worktreeKind: 'root',
      },
    });

    const runtimeRunner = new CompletingRuntimeRunner('claude-code');
    const daemon = new TrackerDaemon({
      importer: new WorkflowV2WorkbenchTaskImporter(workbench, repo),
      stateStore: new MemoryTrackerStateStore(),
      launcher: new WorkbenchTrackerLauncher(workbench, {
        workspaceRoot: root,
        defaultProjectPath: repo,
      }),
      workspaceRoot: root,
      defaultProjectPath: repo,
      now: () => 1_000,
      runtimeRunners: { 'claude-code': runtimeRunner },
      workflow: workflowV2({
        root,
        runner: 'claude-code',
        mode: 'claude_print',
        renderPrompt: (trackedTask) => `Review ${trackedTask.shortIdentifier}.`,
      }),
    });

    const trackedTask = (await new WorkflowV2WorkbenchTaskImporter(workbench, repo).fetchTaskStatesByIds?.([reviewTask.id]))![0]!;
    const result = await daemon.runExplicitTask(trackedTask);

    expect(result.dispatched).toEqual(['TIK-1']);
    const prompt = runtimeRunner.preparedInputs[0]?.renderedPrompt || '';
    expect(prompt).toContain(`HEAD..${headSha}`);
    expect(prompt).toContain('M feature.ts');
    expect(prompt).toContain('-export const oldValue = 1;');
    expect(prompt).toContain('+export const dirtyValue = 3;');
    await waitForWorkbenchTask(workbench, reviewTask.id, (candidate) => candidate?.status === 'in_review');
  });

  it('limits Claude review context to the agent-loop allowed scope', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-tracker-daemon-'));
    tempDirs.push(root);
    const repo = path.join(root, 'repo');
    await fs.mkdir(path.join(repo, 'src'), { recursive: true });
    await fs.mkdir(path.join(repo, 'docs'), { recursive: true });
    await fs.writeFile(path.join(repo, 'src', 'feature.ts'), 'export const oldValue = 1;\n', 'utf-8');
    await fs.writeFile(path.join(repo, 'docs', 'notes.md'), 'old notes\n', 'utf-8');
    await runGit(repo, ['init']);
    await runGit(repo, ['config', 'user.email', 'test@example.com']);
    await runGit(repo, ['config', 'user.name', 'Tik Test']);
    await runGit(repo, ['add', '.']);
    await runGit(repo, ['commit', '-m', 'init']);
    const headSha = await runGit(repo, ['rev-parse', 'HEAD']);
    await fs.writeFile(path.join(repo, 'src', 'feature.ts'), 'export const scopedValue = 2;\n', 'utf-8');
    await fs.writeFile(path.join(repo, 'docs', 'notes.md'), 'unrelated notes\n', 'utf-8');

    const workbench = new WorkbenchService({
      rootPath: root,
      eventBus: new EventBus(),
      store: new WorkbenchStore(root),
    });
    const reviewTask = await workbench.createReviewRound({
      rootTaskId: 'task-root',
      round: 1,
      maxRounds: 2,
      changeRequest: {
        scm: 'internal',
        repo: 'repo',
        id: 'task-root',
        type: 'internal_review',
        title: 'Review scoped local diff',
        baseRef: 'HEAD',
        headRef: 'main',
        headSha,
      },
      idempotencyKey: 'review-allowed-scope-context',
      allowedScope: ['src'],
      workspaceBinding: {
        workspaceRoot: root,
        workspaceName: 'tik',
        projectName: 'repo',
        sourceProjectPath: repo,
        effectiveProjectPath: repo,
        worktreeKind: 'root',
      },
    });

    const runtimeRunner = new CompletingRuntimeRunner('claude-code');
    const daemon = new TrackerDaemon({
      importer: new WorkflowV2WorkbenchTaskImporter(workbench, repo),
      stateStore: new MemoryTrackerStateStore(),
      launcher: new WorkbenchTrackerLauncher(workbench, {
        workspaceRoot: root,
        defaultProjectPath: repo,
      }),
      workspaceRoot: root,
      defaultProjectPath: repo,
      now: () => 1_000,
      runtimeRunners: { 'claude-code': runtimeRunner },
      workflow: workflowV2({
        root,
        runner: 'claude-code',
        mode: 'claude_print',
        renderPrompt: (trackedTask) => `Review ${trackedTask.shortIdentifier}.`,
      }),
    });

    const trackedTask = (await new WorkflowV2WorkbenchTaskImporter(workbench, repo).fetchTaskStatesByIds?.([reviewTask.id]))![0]!;
    const result = await daemon.runExplicitTask(trackedTask);

    expect(result.dispatched).toEqual(['TIK-1']);
    const prompt = runtimeRunner.preparedInputs[0]?.renderedPrompt || '';
    expect(prompt).toContain('src/feature.ts');
    expect(prompt).toContain('+export const scopedValue = 2;');
    expect(prompt).not.toContain('docs/notes.md');
    expect(prompt).not.toContain('unrelated notes');
    await waitForWorkbenchTask(workbench, reviewTask.id, (candidate) => candidate?.status === 'in_review');
  });

  it('does not dispatch Claude review when there are no reviewable git changes', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-tracker-daemon-'));
    tempDirs.push(root);
    const repo = path.join(root, 'repo');
    await fs.mkdir(repo, { recursive: true });
    await fs.writeFile(path.join(repo, 'README.md'), '# demo\n', 'utf-8');
    await runGit(repo, ['init']);
    await runGit(repo, ['config', 'user.email', 'test@example.com']);
    await runGit(repo, ['config', 'user.name', 'Tik Test']);
    await runGit(repo, ['add', 'README.md']);
    await runGit(repo, ['commit', '-m', 'init']);

    const workbench = new WorkbenchService({
      rootPath: root,
      eventBus: new EventBus(),
      store: new WorkbenchStore(root),
    });
    await workbench.createTask({
      id: 'task-clean-review',
      shortIdentifier: 'TIK-CLEAN',
      title: 'Review clean tree',
      goal: 'Review should wait for changes.',
      status: 'todo',
      labels: ['needs-claude-review'],
      environmentPackSnapshot: TEST_ENVIRONMENT_SNAPSHOT,
      agentLoop: {
        kind: 'claude_review',
        phase: 'needs_claude_review',
        round: 1,
        maxRounds: 3,
        rootTaskId: 'task-clean-review',
        changeRequest: {
          scm: 'local',
          repo: 'tik',
          id: 'task-clean-review',
          baseRef: 'main',
          headRef: 'docs',
          headSha: 'abc123',
        },
      },
      workspaceBinding: {
        workspaceRoot: root,
        workspaceName: 'tik',
        projectName: 'repo',
        sourceProjectPath: repo,
        effectiveProjectPath: repo,
        worktreeKind: 'root',
      },
    }, 'task-clean-review');

    const runtimeRunner = new CompletingRuntimeRunner('claude-code');
    const daemon = new TrackerDaemon({
      importer: new WorkflowV2WorkbenchTaskImporter(workbench, repo),
      stateStore: new MemoryTrackerStateStore(),
      launcher: new WorkbenchTrackerLauncher(workbench, {
        workspaceRoot: root,
        defaultProjectPath: repo,
      }),
      workspaceRoot: root,
      defaultProjectPath: repo,
      now: () => 1_000,
      runtimeRunners: { 'claude-code': runtimeRunner },
      workflow: workflowV2({
        root,
        runner: 'claude-code',
        mode: 'claude_print',
        renderPrompt: (trackedTask) => `Review ${trackedTask.shortIdentifier}.`,
      }),
    });

    const result = await daemon.tick();

    expect(result.dispatched).toEqual([]);
    expect(result.skipped).toContainEqual({
      shortIdentifier: 'TIK-CLEAN',
      reason: 'no-reviewable-changes',
    });
    expect(runtimeRunner.preparedInputs).toHaveLength(0);
  });

  it('explicitly runs externally-owned Claude reviews through the Tik runtime workflow', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-tracker-daemon-'));
    tempDirs.push(root);
    const repo = path.join(root, 'repo');
    await fs.mkdir(repo, { recursive: true });
    await fs.writeFile(path.join(repo, 'feature.ts'), 'export const before = 1;\n', 'utf-8');
    await runGit(repo, ['init']);
    await runGit(repo, ['config', 'user.email', 'test@example.com']);
    await runGit(repo, ['config', 'user.name', 'Tik Test']);
    await runGit(repo, ['add', 'feature.ts']);
    await runGit(repo, ['commit', '-m', 'init']);
    await fs.writeFile(path.join(repo, 'feature.ts'), 'export const after = 2;\n', 'utf-8');
    await runGit(repo, ['add', 'feature.ts']);
    await runGit(repo, ['commit', '-m', 'change']);
    const headSha = await runGit(repo, ['rev-parse', 'HEAD']);

    const workbench = new WorkbenchService({
      rootPath: root,
      eventBus: new EventBus(),
      store: new WorkbenchStore(root),
    });
    const reviewTask = await workbench.createReviewRound({
      rootTaskId: 'external-review',
      round: 1,
      maxRounds: 3,
      idempotencyKey: 'explicit-external-review',
      labels: ['external-claude-review'],
      changeRequest: {
        scm: 'internal',
        repo: 'repo',
        id: 'external-review',
        type: 'internal_review',
        baseRef: 'HEAD~1',
        headRef: 'HEAD',
        headSha,
      },
      workspaceBinding: {
        workspaceRoot: root,
        workspaceName: 'tik',
        projectName: 'repo',
        sourceProjectPath: repo,
        effectiveProjectPath: repo,
        worktreeKind: 'root',
      },
    });
    const taskRecord = await workbench.readTask(reviewTask.id);
    expect(taskRecord?.labels).toContain('external-claude-review');

    const runtimeRunner = new CompletingRuntimeRunner('claude-code');
    const daemon = new TrackerDaemon({
      importer: new WorkflowV2WorkbenchTaskImporter(workbench, repo),
      stateStore: new MemoryTrackerStateStore(),
      launcher: new WorkbenchTrackerLauncher(workbench, {
        workspaceRoot: root,
        defaultProjectPath: repo,
      }),
      workspaceRoot: root,
      defaultProjectPath: repo,
      now: () => 1_000,
      runtimeRunners: { 'claude-code': runtimeRunner },
      workflow: workflowV2({
        root,
        runner: 'claude-code',
        mode: 'claude_print',
        renderPrompt: (trackedTask) => `Review ${trackedTask.shortIdentifier}.`,
      }),
    });

    const result = await daemon.runExplicitTask({
      ...task(taskRecord!.id, taskRecord!.shortIdentifier),
      stateKind: 'blocked',
      state: taskRecord!.status,
      labels: taskRecord!.labels || [],
      agentLoop: taskRecord!.agentLoop,
      repository: {
        name: 'repo',
        path: repo,
        executionPath: repo,
        sourcePath: repo,
      },
      sourceKind: 'workbench',
    });

    expect(result.dispatched).toEqual([taskRecord!.shortIdentifier]);
    expect(result.skipped).toEqual([]);
    expect(runtimeRunner.preparedInputs[0]).toMatchObject({
      runnerMode: 'claude_print',
      projectPath: repo,
    });
    expect(runtimeRunner.preparedInputs[0]?.renderedPrompt).toContain('Review range');
    expect(runtimeRunner.preparedInputs[0]?.renderedPrompt).toContain('ReviewResult JSON');
    expect(runtimeRunner.preparedInputs[0]?.renderedPrompt).toContain(`http://127.0.0.1:3300/api/v1/agent-loop/tasks/${reviewTask.id}/review-result`);
    expect(runtimeRunner.startedInputs[0]?.env).toMatchObject({
      TIK_API_BASE_URL: 'http://127.0.0.1:3300/api',
    });
    expect(runtimeRunner.preparedInputs[0]?.renderedPrompt).toContain(`HEAD~1..${headSha}`);
    expect(runtimeRunner.preparedInputs[0]?.renderedPrompt).toContain('-export const before = 1;');
    expect(runtimeRunner.preparedInputs[0]?.renderedPrompt).toContain('+export const after = 2;');
    await waitForWorkbenchTask(workbench, reviewTask.id, (candidate) => candidate?.status === 'in_review');
  });

  it('records Claude review output as a task comment and routes blocking reviews to Codex fix', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-tracker-daemon-'));
    tempDirs.push(root);
    const repo = path.join(root, 'repo');
    await fs.mkdir(repo, { recursive: true });
    const workbench = new WorkbenchService({
      rootPath: root,
      eventBus: new EventBus(),
      store: new WorkbenchStore(root),
    });
    await workbench.createTask({
      id: 'task-review-output',
      shortIdentifier: 'TIK-OUTPUT',
      title: 'Review output loop',
      goal: 'Review and fix blockers.',
      status: 'todo',
      labels: ['needs-claude-review'],
      environmentPackSnapshot: TEST_ENVIRONMENT_SNAPSHOT,
      workspaceBinding: {
        workspaceRoot: root,
        workspaceName: 'tik',
        projectName: 'repo',
        sourceProjectPath: repo,
        effectiveProjectPath: repo,
        worktreeKind: 'root',
      },
    }, 'task-review-output');
    const runtimeRunner = new CompletingRuntimeRunner('claude-code');
    runtimeRunner.stdoutText = [
      '## Blocking Findings',
      '',
      '- packages/kernel/src/tracker-daemon/tracker-daemon.ts: Claude output is not written back to the task.',
    ].join('\n');
    const daemon = new TrackerDaemon({
      importer: new WorkflowV2WorkbenchTaskImporter(workbench, repo),
      stateStore: new MemoryTrackerStateStore(),
      launcher: new WorkbenchTrackerLauncher(workbench, {
        workspaceRoot: root,
        defaultProjectPath: repo,
      }),
      workspaceRoot: root,
      defaultProjectPath: repo,
      now: () => 1_000,
      runtimeRunners: { 'claude-code': runtimeRunner },
      workflow: workflowV2({ root, runner: 'claude-code', mode: 'claude_print' }),
    });

    await daemon.tick();

    const updated = await waitForWorkbenchTask(workbench, 'task-review-output', (candidate) => (
      candidate?.status === 'todo'
      && candidate.labels?.includes('needs-codex-fix')
      && Boolean(candidate.comments?.some((comment) => comment.authorId === 'claude-code'))
    ));
    expect(updated?.comments?.at(-1)).toMatchObject({
      authorKind: 'agent',
      authorId: 'claude-code',
      body: expect.stringContaining('## Blocking Findings'),
    });
    expect(updated?.labels).toEqual(['codex-fix', 'needs-codex-fix']);
    expect(updated?.latestSummary).toContain('Claude review found blocking issues');
  });

  it('routes clean Claude review output to human review without triggering Codex fix', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-tracker-daemon-'));
    tempDirs.push(root);
    const repo = path.join(root, 'repo');
    await fs.mkdir(repo, { recursive: true });
    const workbench = new WorkbenchService({
      rootPath: root,
      eventBus: new EventBus(),
      store: new WorkbenchStore(root),
    });
    await workbench.createTask({
      id: 'task-review-clean',
      shortIdentifier: 'TIK-CLEAN',
      title: 'Clean review loop',
      goal: 'Review and hand to human.',
      status: 'todo',
      labels: ['needs-claude-review'],
      environmentPackSnapshot: TEST_ENVIRONMENT_SNAPSHOT,
      workspaceBinding: {
        workspaceRoot: root,
        workspaceName: 'tik',
        projectName: 'repo',
        sourceProjectPath: repo,
        effectiveProjectPath: repo,
        worktreeKind: 'root',
      },
    }, 'task-review-clean');
    const runtimeRunner = new CompletingRuntimeRunner('claude-code');
    runtimeRunner.stdoutText = 'No blocking findings. Ready for human review.\n';
    const daemon = new TrackerDaemon({
      importer: new WorkflowV2WorkbenchTaskImporter(workbench, repo),
      stateStore: new MemoryTrackerStateStore(),
      launcher: new WorkbenchTrackerLauncher(workbench, {
        workspaceRoot: root,
        defaultProjectPath: repo,
      }),
      workspaceRoot: root,
      defaultProjectPath: repo,
      now: () => 1_000,
      runtimeRunners: { 'claude-code': runtimeRunner },
      workflow: workflowV2({ root, runner: 'claude-code', mode: 'claude_print' }),
    });

    await daemon.tick();

    const updated = await waitForWorkbenchTask(workbench, 'task-review-clean', (candidate) => (
      candidate?.status === 'in_review'
      && candidate.labels?.includes('needs-human-review')
    ));
    expect(updated?.labels).toEqual(['human-review', 'needs-human-review']);
    expect(updated?.comments?.at(-1)?.body).toContain('No blocking findings');
  });

  it('returns Codex fix completions to Claude review for the next loop round', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-tracker-daemon-'));
    tempDirs.push(root);
    const repo = path.join(root, 'repo');
    await fs.mkdir(repo, { recursive: true });
    const workbench = new WorkbenchService({
      rootPath: root,
      eventBus: new EventBus(),
      store: new WorkbenchStore(root),
    });
    await workbench.createTask({
      id: 'task-fix-complete',
      shortIdentifier: 'TIK-FIX',
      title: 'Fix review blockers',
      goal: 'Fix blockers and request another review.',
      status: 'todo',
      labels: ['needs-codex-fix', 'codex-fix'],
      environmentPackSnapshot: TEST_ENVIRONMENT_SNAPSHOT,
      workspaceBinding: {
        workspaceRoot: root,
        workspaceName: 'tik',
        projectName: 'repo',
        sourceProjectPath: repo,
        effectiveProjectPath: repo,
        worktreeKind: 'root',
      },
      agentLoop: {
        kind: 'codex_fix',
        phase: 'needs_codex_fix',
        rootTaskId: 'task-fix-complete',
        round: 1,
        maxRounds: 3,
        nextReviewRound: 2,
        headSha: 'abc123',
        previousHeadSha: 'abc123',
        idempotencyKey: 'fix-complete',
        changeRequest: {
          scm: 'internal',
          repo: 'repo',
          id: 'repo:abc123',
          type: 'internal_review',
          baseRef: 'HEAD~1',
          headRef: 'worktree',
          headSha: 'abc123',
        },
      },
    }, 'task-fix-complete');
    const runtimeRunner = new CompletingRuntimeRunner('codex');
    const daemon = new TrackerDaemon({
      importer: new WorkflowV2WorkbenchTaskImporter(workbench, repo),
      stateStore: new MemoryTrackerStateStore(),
      launcher: new WorkbenchTrackerLauncher(workbench, {
        workspaceRoot: root,
        defaultProjectPath: repo,
      }),
      workspaceRoot: root,
      defaultProjectPath: repo,
      now: () => 1_000,
      runtimeRunners: { codex: runtimeRunner },
      workflow: workflowV2({ root, runner: 'codex', mode: 'codex_app_server' }),
    });

    await daemon.tick();

    const updated = await waitForWorkbenchTask(workbench, 'task-fix-complete', (candidate) => (
      candidate?.status === 'todo'
      && candidate.labels?.includes('needs-claude-review')
      && candidate.agentLoop?.kind === 'claude_review'
    ));
    expect(updated).toMatchObject({
      status: 'todo',
      labels: ['agent-loop', 'claude-review', 'needs-claude-review'],
      agentLoop: {
        kind: 'claude_review',
        phase: 'needs_claude_review',
        round: 2,
        previousHeadSha: 'abc123',
      },
    });
  });

  it('generates a run proof and review artifact when a workflow v2 runtime completes', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-tracker-daemon-'));
    tempDirs.push(root);
    const repo = path.join(root, 'repo');
    await fs.mkdir(path.join(repo, 'src'), { recursive: true });
    const artifacts = new FileArtifactRegistry({ rootPath: root });
    const workbench = new WorkbenchService({
      rootPath: root,
      eventBus: new EventBus(),
      store: new WorkbenchStore(root),
      artifacts,
    });
    await workbench.createTask({
      id: 'task-proof',
      shortIdentifier: 'TIK-PROOF',
      title: 'Generate proof',
      goal: 'Runtime completion should produce review evidence.',
      status: 'todo',
      labels: ['backend'],
      environmentPackSnapshot: TEST_ENVIRONMENT_SNAPSHOT,
      workspaceBinding: {
        workspaceRoot: root,
        workspaceName: 'tik',
        projectName: 'repo',
        sourceProjectPath: repo,
        effectiveProjectPath: repo,
        worktreeKind: 'root',
      },
    }, 'task-proof');
    const stdoutPath = path.join(root, '.tik', 'runs', 'tik-proof-attempt-0-1000', 'stdout.log');
    const patchPath = path.join(root, '.tik', 'runs', 'tik-proof-attempt-0-1000', 'run-diff.patch');
    await fs.mkdir(path.dirname(stdoutPath), { recursive: true });
    await fs.writeFile(stdoutPath, 'implemented proof\n', 'utf-8');
    await fs.writeFile(patchPath, 'diff --git a/src/proof.ts b/src/proof.ts\n', 'utf-8');
    const runtimeRunner = new CompletingRuntimeRunner('codex');
    runtimeRunner.transcriptRefs = [{ path: stdoutPath, contentType: 'text/plain' }];
    runtimeRunner.diffSummary = {
      changedFiles: ['src/proof.ts'],
      insertions: 4,
      deletions: 1,
      patchPath,
    };
    const agentRunStore = new FileAgentRunStore(root);
    const daemon = new TrackerDaemon({
      importer: new WorkflowV2WorkbenchTaskImporter(workbench, repo),
      stateStore: new MemoryTrackerStateStore(),
      agentRunStore,
      runProofService: new RunProofService({
        proofStore: new FileRunProofStore(root),
        artifacts,
        runCommand: async ({ command, cwd }) => ({
          exitCode: 0,
          stdout: `${command} passed in ${cwd}\n`,
          stderr: '',
          durationMs: 12,
        }),
      }),
      launcher: new WorkbenchTrackerLauncher(workbench, {
        workspaceRoot: root,
        defaultProjectPath: repo,
      }),
      workspaceRoot: root,
      defaultProjectPath: repo,
      now: () => 1_000,
      runtimeRunners: { codex: runtimeRunner },
      workflow: {
        ...workflowV2({
          root,
          runner: 'codex',
          mode: 'codex_app_server',
          validationCommands: ['pnpm typecheck'],
        }),
        resolveRouting: () => ({
          runner: 'codex',
          mode: 'codex_app_server',
          matchedSource: 'default',
        }),
      },
    });

    await daemon.tick();

    const proofPath = path.join(root, '.tik', 'runs', 'tik-proof-attempt-0-1000', 'proof.json');
    const updated = await waitForWorkbenchTask(workbench, 'task-proof', async (candidate) => (
      candidate?.status === 'needs_review'
      && Boolean(await fs.stat(proofPath).catch(() => null))
    ));
    const proof = JSON.parse(await fs.readFile(proofPath, 'utf-8'));
    const reviewArtifacts = await artifacts.list({ taskId: 'task-proof', tag: 'run-review' });

    expect(updated?.status).toBe('needs_review');
    expect(proof).toMatchObject({
      runId: 'tik-proof-attempt-0-1000',
      status: 'ready_for_review',
      diff: {
        filesChanged: 1,
        changedFiles: ['src/proof.ts'],
      },
      validationRefs: [
        {
          command: 'pnpm typecheck',
          cwd: repo,
          exitCode: 0,
          stdoutArtifactId: expect.any(String),
        },
      ],
      producedArtifactIds: [expect.any(String)],
    });
    expect(reviewArtifacts).toHaveLength(1);
    expect(reviewArtifacts[0]).toMatchObject({
      title: 'Run Review: TIK-PROOF attempt 1',
      status: 'needs_review',
      changedFiles: ['src/proof.ts'],
      producedBy: {
        provider: 'codex',
        template: 'run-review',
      },
    });
  });

  it('renders a Tik-generated fix prompt for Codex agent-loop phases', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-tracker-daemon-'));
    tempDirs.push(root);
    const repo = path.join(root, 'repo');
    await fs.mkdir(repo, { recursive: true });
    const workbench = new WorkbenchService({
      rootPath: root,
      eventBus: new EventBus(),
      store: new WorkbenchStore(root),
    });
    await workbench.createTask({
      id: 'task-fix-prompt',
      shortIdentifier: 'TIK-FIX-PROMPT',
      title: 'Fix review blockers',
      goal: 'Fix blockers and request another review.',
      description: 'Kind: claude_review\nRoot task: tik\nRound: 1/3',
      status: 'todo',
      labels: ['agent-loop', 'codex-fix', 'needs-codex-fix'],
      environmentPackSnapshot: TEST_ENVIRONMENT_SNAPSHOT,
      comments: [{
        id: 'comment-claude-review',
        authorKind: 'agent',
        authorId: 'claude-code',
        body: '## Blocking Findings\n\n- packages/kernel/src/tracker-daemon/tracker-daemon.ts: Codex fix prompt is using the Claude review prompt.',
        createdAt: '2026-06-24T00:00:00.000Z',
      }],
      workspaceBinding: {
        workspaceRoot: root,
        workspaceName: 'tik',
        projectName: 'repo',
        sourceProjectPath: repo,
        effectiveProjectPath: repo,
        worktreeKind: 'root',
      },
      agentLoop: {
        kind: 'codex_fix',
        phase: 'needs_codex_fix',
        rootTaskId: 'task-fix-prompt',
        round: 2,
        maxRounds: 3,
        nextReviewRound: 3,
        headSha: 'abc123',
        previousHeadSha: 'abc123',
        idempotencyKey: 'fix-prompt',
        changeRequest: {
          scm: 'internal',
          repo: 'repo',
          id: 'repo:abc123',
          type: 'internal_review',
          baseRef: 'HEAD~1',
          headRef: 'worktree',
          headSha: 'abc123',
        },
        reviewResult: {
          verdict: 'request_changes',
          headShaReviewed: 'abc123',
          blockingIssues: [{
            title: 'Codex fix prompt used the Claude review instructions',
            file: 'packages/kernel/src/tracker-daemon/tracker-daemon.ts',
            reason: 'The fix lane should receive fix instructions, not read-only review instructions.',
            suggestedFix: 'Render a Tik-generated Codex fix prompt from agent-loop metadata.',
          }],
          nonBlockingSuggestions: [],
          testsNeeded: [],
          markdown: '## Blocking Findings\n\nCodex fix prompt used the Claude review instructions.',
        },
      },
    }, 'task-fix-prompt');

    const runtimeRunner = new CompletingRuntimeRunner('codex');
    const daemon = new TrackerDaemon({
      importer: new WorkflowV2WorkbenchTaskImporter(workbench, repo),
      stateStore: new MemoryTrackerStateStore(),
      launcher: new WorkbenchTrackerLauncher(workbench, {
        workspaceRoot: root,
        defaultProjectPath: repo,
      }),
      workspaceRoot: root,
      defaultProjectPath: repo,
      now: () => 1_000,
      runtimeRunners: { codex: runtimeRunner },
      workflow: workflowV2({
        root,
        runner: 'codex',
        mode: 'codex_exec',
        renderPrompt: () => [
          'For `needs-claude-review` tasks, perform a read-only review.',
          'Do not edit files.',
        ].join('\n'),
      }),
    });

    await daemon.tick();

    const renderedPrompt = runtimeRunner.preparedInputs[0]?.renderedPrompt || '';
    expect(renderedPrompt).toContain('Tik-generated Codex fix context');
    expect(renderedPrompt).toContain('Codex fix prompt used the Claude review instructions');
    expect(renderedPrompt).toContain('Render a Tik-generated Codex fix prompt from agent-loop metadata.');
    expect(renderedPrompt).toContain('Recent agent review comments');
    expect(renderedPrompt).not.toContain('For `needs-claude-review` tasks');
    expect(renderedPrompt).not.toContain('Do not edit files.');
    await waitForWorkbenchTask(workbench, 'task-fix-prompt', (candidate) => (
      candidate?.status === 'todo'
      && candidate.labels?.includes('needs-claude-review')
      && candidate.agentLoop?.kind === 'claude_review'
    ));
  });

  it('injects the previous review rejection reason into workflow retry prompts', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-tracker-daemon-'));
    tempDirs.push(root);
    const repo = path.join(root, 'repo');
    await fs.mkdir(repo, { recursive: true });
    const workbench = new WorkbenchService({
      rootPath: root,
      eventBus: new EventBus(),
      store: new WorkbenchStore(root),
    });
    await workbench.createTask({
      id: 'task-retry-prompt',
      shortIdentifier: 'TIK-RETRY',
      title: 'Retry rejected run',
      goal: 'Retry with review feedback.',
      status: 'retry',
      labels: ['backend'],
      comments: [{
        id: 'comment-rejected-run',
        authorKind: 'human',
        authorId: 'reviewer',
        body: [
          'Run review rejected.',
          '',
          'Artifact: Run Review: TIK-RETRY attempt 1',
          'Reason: Add regression coverage before touching implementation.',
        ].join('\n'),
        createdAt: '2026-06-24T00:00:00.000Z',
      }],
      environmentPackSnapshot: TEST_ENVIRONMENT_SNAPSHOT,
      workspaceBinding: {
        workspaceRoot: root,
        workspaceName: 'tik',
        projectName: 'repo',
        sourceProjectPath: repo,
        effectiveProjectPath: repo,
        worktreeKind: 'root',
      },
    }, 'task-retry-prompt');

    const runtimeRunner = new CompletingRuntimeRunner('codex');
    const daemon = new TrackerDaemon({
      importer: new WorkflowV2WorkbenchTaskImporter(workbench, repo),
      stateStore: new MemoryTrackerStateStore(),
      launcher: new WorkbenchTrackerLauncher(workbench, {
        workspaceRoot: root,
        defaultProjectPath: repo,
      }),
      workspaceRoot: root,
      defaultProjectPath: repo,
      now: () => 1_000,
      runtimeRunners: { codex: runtimeRunner },
      workflow: workflowV2({
        root,
        runner: 'codex',
        mode: 'codex_exec',
        renderPrompt: (trackedTask) => `Implement ${trackedTask.shortIdentifier}.`,
      }),
    });

    await daemon.tick();

    const renderedPrompt = runtimeRunner.preparedInputs[0]?.renderedPrompt || '';
    expect(renderedPrompt).toContain('Previous review rejection reason');
    expect(renderedPrompt).toContain('Add regression coverage before touching implementation.');
    await waitForWorkbenchTask(workbench, 'task-retry-prompt', (candidate) => candidate?.status === 'needs_review');
  });

  it('stops open workspace maintenance attempts instead of keeping them in the Codex lane', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-tracker-daemon-'));
    tempDirs.push(root);
    const workbench = new WorkbenchService({
      rootPath: root,
      eventBus: new EventBus(),
      store: new WorkbenchStore(root),
    });
    await workbench.createTask({
      id: 'task-maintenance-running',
      shortIdentifier: 'TIK-OPS',
      title: 'Clean worktrees',
      goal: 'Remove stale workspace worktrees',
      status: 'running',
      labels: ['worktree'],
      environmentPackSnapshot: TEST_ENVIRONMENT_SNAPSHOT,
      attempts: [{
        attemptNumber: 1,
        startedAt: '2026-01-01T00:00:00.000Z',
        kernelTaskId: 'kernel-maintenance',
      }],
    }, 'task-maintenance-running');

    const importer = new WorkflowV2WorkbenchTaskImporter(workbench, root);
    const launcher = new WorkbenchTrackerLauncher(workbench, {
      workspaceRoot: root,
      defaultProjectPath: root,
      stopTask: () => undefined,
    });
    const daemon = new TrackerDaemon({
      importer,
      stateStore: new MemoryTrackerStateStore(),
      launcher,
      workspaceRoot: root,
      defaultProjectPath: root,
    });

    const result = await daemon.tick();

    expect(result.dispatched).toEqual([]);
    expect(result.stopped).toEqual(['TIK-OPS']);
  });

  it('leaves Claude review work items for explicit review runs while importing Codex fix items through workflow v2', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-tracker-daemon-'));
    tempDirs.push(root);
    const workbench = new WorkbenchService({
      rootPath: root,
      eventBus: new EventBus(),
      store: new WorkbenchStore(root),
    });
    const changeRequest = {
      scm: 'internal' as const,
      repo: 'tik',
      id: 'tik:abc123',
      type: 'internal_review' as const,
      title: 'Review tik at abc123',
      baseRef: 'HEAD~1',
      headRef: 'feature',
      headSha: 'abc123',
    };

    await workbench.createTask({
      title: 'Regular task',
      goal: 'This should dispatch',
      status: 'todo',
      labels: ['backend'],
      environmentPackSnapshot: TEST_ENVIRONMENT_SNAPSHOT,
    }, 'task-regular');
    await workbench.createTask({
      title: 'Claude review',
      goal: 'This should be claimed by Claude Code',
      status: 'todo',
      labels: ['agent-loop', 'claude-review', 'external-claude-review', 'needs-claude-review'],
      environmentPackSnapshot: TEST_ENVIRONMENT_SNAPSHOT,
      agentLoop: {
        kind: 'claude_review',
        phase: 'needs_claude_review',
        rootTaskId: 'root',
        round: 1,
        maxRounds: 3,
        headSha: 'abc123',
        idempotencyKey: 'claude-review-key',
        changeRequest,
      },
    }, 'task-claude-review');
    await workbench.createTask({
      title: 'Codex fix',
      goal: 'This should dispatch',
      status: 'todo',
      labels: ['agent-loop', 'codex-fix'],
      environmentPackSnapshot: TEST_ENVIRONMENT_SNAPSHOT,
      agentLoop: {
        kind: 'codex_fix',
        rootTaskId: 'root',
        round: 1,
        maxRounds: 3,
        headSha: 'abc123',
        idempotencyKey: 'codex-fix-key',
        changeRequest,
      },
    }, 'task-codex-fix');

    const importer = new WorkflowV2WorkbenchTaskImporter(workbench, root);

    await expect(importer.listCandidateTasks()).resolves.toEqual([
      expect.objectContaining({ id: 'task-regular' }),
      expect.objectContaining({ id: 'task-codex-fix' }),
    ]);
    await expect(importer.fetchTasksByStates?.(['todo'])).resolves.toEqual([
      expect.objectContaining({ id: 'task-regular' }),
      expect.objectContaining({ id: 'task-codex-fix' }),
    ]);
  });

  it('imports workbench tasks with an execution path and a separate source project path', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-tracker-daemon-'));
    tempDirs.push(root);
    const sourceProjectPath = path.join(root, 'repo');
    const previousWorktreePath = path.join(root, '.workspace', 'worktrees', 'repo--tik-83');
    const workbench = new WorkbenchService({
      rootPath: root,
      eventBus: new EventBus(),
      store: new WorkbenchStore(root),
    });
    await workbench.createTask({
      id: 'task-reopened',
      identifier: 'TIK-85',
      title: 'Reopened task',
      goal: 'Continue from the original repo, not the previous worktree',
      status: 'todo',
      labels: ['backend'],
      environmentPackSnapshot: TEST_ENVIRONMENT_SNAPSHOT,
      workspaceBinding: {
        workspaceRoot: root,
        workspaceName: 'tik',
        projectName: 'tik',
        sourceProjectPath,
        effectiveProjectPath: previousWorktreePath,
        laneId: 'tik-83',
        worktreeKind: 'git-worktree',
        worktreePath: previousWorktreePath,
      },
    }, 'task-reopened');

    const importer = new WorkflowV2WorkbenchTaskImporter(workbench, root);
    const tasks = await importer.listCandidateTasks();

    expect(tasks[0]?.repository).toMatchObject({
      name: 'tik',
      path: previousWorktreePath,
      sourcePath: sourceProjectPath,
    });
  });

  it('persists only retry state for the daemon while tolerating legacy runs on load', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-tracker-state-'));
    tempDirs.push(root);
    const statePath = path.join(root, '.tik', 'tracker-daemon', 'state.json');
    await fs.mkdir(path.dirname(statePath), { recursive: true });
    await fs.writeFile(statePath, JSON.stringify({
      runs: {
        'task-old': {
          taskId: 'task-old',
          shortIdentifier: 'TIK-OLD',
          kernelTaskId: 'kernel-old',
          workspaceRoot: root,
          projectPath: root,
          startedAt: '2026-01-01T00:00:00.000Z',
          status: 'running',
          lastTaskState: 'Todo',
          lastSeenAt: '2026-01-01T00:00:00.000Z',
        },
      },
      retries: {
        'task-1': {
          taskId: 'task-1',
          shortIdentifier: 'TIK-1',
          attempt: 2,
          dueAtMs: 123,
          lastError: 'boom',
          updatedAt: '2026-01-02T00:00:00.000Z',
        },
      },
    }), 'utf-8');

    const store = new FileTrackerDaemonStateStore(statePath);
    const loaded = await store.load();
    await store.save(loaded);
    const saved = JSON.parse(await fs.readFile(statePath, 'utf-8'));

    expect(loaded.retries['task-1']).toMatchObject({ attempt: 2 });
    expect(saved.runs).toBeUndefined();
    expect(saved.retries['task-1']).toMatchObject({
      shortIdentifier: 'TIK-1',
      attempt: 2,
    });
  });

  it('forwards only human comments (most recent first, capped at 5) into the kernel task as recentComments', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-tracker-daemon-'));
    tempDirs.push(root);
    const workbench = new WorkbenchService({
      rootPath: root,
      eventBus: new EventBus(),
      store: new WorkbenchStore(root),
    });
    const captureKernelTaskInputs: Array<Record<string, unknown>> = [];
    const launcher = new WorkbenchTrackerLauncher(workbench, {
      workspaceRoot: root,
      defaultProjectPath: path.join(root, 'source'),
      createKernelTask: (input) => {
        captureKernelTaskInputs.push(input);
        return { id: 'kernel-task-1' };
      },
    });

    // Seed an existing workbench task with a mix of comments
    await workbench.createTask({
      id: 'task-with-comments',
      identifier: 'TIK-100',
      title: 'Carry comments',
      goal: 'Forward human comments only',
      status: 'todo',
    }, 'task-with-comments');

    const seedComments: Array<{ authorKind: 'human' | 'agent' | 'system'; authorId?: string; body: string }> = [
      { authorKind: 'human', authorId: 'op-1', body: 'first guidance' },
      { authorKind: 'agent', authorId: 'supervisor', body: 'agent commented' },
      { authorKind: 'system', body: 'system commented' },
      { authorKind: 'human', authorId: 'op-2', body: 'second guidance' },
      { authorKind: 'human', authorId: 'op-3', body: 'third guidance' },
      { authorKind: 'human', authorId: 'op-4', body: 'fourth guidance' },
      { authorKind: 'human', authorId: 'op-5', body: 'fifth guidance' },
      { authorKind: 'human', authorId: 'op-6', body: 'sixth guidance (newest)' },
    ];
    for (const comment of seedComments) {
      await workbench.addComment('task-with-comments', comment);
    }

    // Build a TrackedTask projection matching the seeded workbench task id
    const trackedTask = {
      ...task('task-with-comments', 'TIK-100'),
      title: 'Carry comments',
    };
    await launcher.launchTask(trackedTask, {
      workspaceRoot: root,
      projectPath: path.join(root, 'source'),
    });

    // The launcher should have called createKernelTask with operator-only,
    // most-recent-five comments, in oldest-to-newest order.
    expect(captureKernelTaskInputs).toHaveLength(1);
    const recentComments = captureKernelTaskInputs[0].recentComments as Array<{
      authorKind: 'human';
      authorId?: string;
      body: string;
    }> | undefined;
    expect(recentComments).toBeDefined();
    expect(recentComments).toHaveLength(5);
    expect(recentComments?.map((c) => c.authorId)).toEqual(['op-2', 'op-3', 'op-4', 'op-5', 'op-6']);
    expect(recentComments?.every((c) => c.authorKind === 'human')).toBe(true);
  });

  it('passes a compact task context snapshot when relaunching an existing workbench task', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-tracker-daemon-'));
    tempDirs.push(root);
    const store = new WorkbenchStore(root);
    const workbench = new WorkbenchService({
      rootPath: root,
      eventBus: new EventBus(),
      store,
    });
    const captureKernelTaskInputs: Array<Record<string, unknown>> = [];
    const launcher = new WorkbenchTrackerLauncher(workbench, {
      workspaceRoot: root,
      defaultProjectPath: path.join(root, 'source'),
      createKernelTask: (input) => {
        captureKernelTaskInputs.push(input);
        return { id: 'kernel-task-restart' };
      },
    });

    await workbench.createTask({
      id: 'task-relaunch-context',
      identifier: 'TIK-101',
      title: 'Restart with memory',
      goal: 'Keep task-local context between runs',
      status: 'todo',
      latestSummary: 'Previous run changed the dashboard but hit a tool error.',
      comments: [{
        id: 'comment-retry',
        authorKind: 'human',
        authorId: 'op',
        body: 'Please retry after checking the code diff.',
        createdAt: '2026-06-18T01:06:00.000Z',
      }],
      attempts: [{
        attemptNumber: 1,
        startedAt: '2026-06-18T01:00:00.000Z',
        finishedAt: '2026-06-18T01:03:00.000Z',
        outcome: 'failed',
        error: 'tool unavailable',
        kernelTaskId: 'kernel-task-old',
        turnCount: 4,
      }],
    }, 'task-relaunch-context');
    await store.appendTimelineItem({
      id: 'timeline-relaunch-diff',
      taskId: 'task-relaunch-context',
      kind: 'raw',
      actor: 'system',
      body: [
        'Tool: git_diff',
        'Files modified:',
        '- packages/dashboard/src/App.tsx',
        'Output:',
        'Dashboard diff',
      ].join('\n'),
      createdAt: '2026-06-18T01:04:00.000Z',
    });
    await store.appendTimelineItem({
      id: 'timeline-relaunch-artifact',
      taskId: 'task-relaunch-context',
      kind: 'raw',
      actor: 'system',
      body: [
        'Tool: write_file',
        'Files modified:',
        '- /tmp/dashboard.html',
        'Output:',
        'Wrote preview',
      ].join('\n'),
      createdAt: '2026-06-18T01:05:00.000Z',
    });

    await launcher.launchTask({
      ...task('task-relaunch-context', 'TIK-101'),
      title: 'Restart with memory',
    }, {
      workspaceRoot: root,
      projectPath: path.join(root, 'source'),
    });

    expect(captureKernelTaskInputs).toHaveLength(1);
    const snapshot = captureKernelTaskInputs[0].taskContextSnapshot as {
      identifier?: string;
      status?: string;
      latestSummary?: string;
      lastAttempt?: { outcome?: string; error?: string; kernelTaskId?: string };
      recentComments?: Array<{ body: string }>;
      timelineSummary?: string[];
      evidenceSummary?: { modifiedFileCount: number; previewableArtifactCount: number; hasErrorEvidence: boolean };
    } | undefined;
    expect(snapshot).toMatchObject({
      identifier: 'TIK-101',
      status: 'todo',
      lastAttempt: {
        outcome: 'failed',
        error: 'tool unavailable',
        kernelTaskId: 'kernel-task-old',
      },
      evidenceSummary: {
        modifiedFileCount: 2,
        previewableArtifactCount: 1,
        hasErrorEvidence: false,
      },
    });
    expect(snapshot?.latestSummary).toBeTruthy();
    expect(snapshot?.recentComments?.map((comment) => comment.body)).toEqual([
      'Please retry after checking the code diff.',
    ]);
    expect(snapshot?.timelineSummary?.join('\n')).toContain('Dashboard diff');
  });
});
