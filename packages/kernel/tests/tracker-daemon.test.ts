import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { EventType, type EnvironmentPackSnapshot } from '@tik/shared';
import { EventBus } from '../src/event-bus.js';
import { FileTrackerDaemonStateStore } from '../src/tracker-daemon/file-state-store.js';
import { TrackerDaemon } from '../src/tracker-daemon/tracker-daemon.js';
import { WorkbenchTaskImporter } from '../src/tracker-daemon/workbench-tracker-client.js';
import { WorkbenchTrackerLauncher } from '../src/tracker-daemon/workbench-launcher.js';
import { runWorkbenchKernelTaskInBackground } from '../src/tracker-daemon/workbench-runner.js';
import type {
  TrackerDaemonStateStore,
  TrackerDaemonWorkLauncher,
  TrackedTask,
  TrackedTaskStateKind,
} from '../src/tracker-daemon/types.js';
import { WorkbenchService } from '../src/workbench/workbench-service.js';
import { WorkbenchStore } from '../src/workbench/workbench-store.js';

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

async function waitForWorkbenchTask(
  workbench: WorkbenchService,
  taskId: string,
  predicate: (task: Awaited<ReturnType<WorkbenchService['readTask']>>) => boolean,
) {
  for (let attempt = 0; attempt < 20; attempt++) {
    const task = await workbench.readTask(taskId);
    if (predicate(task)) return task;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return workbench.readTask(taskId);
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

    const importer = new WorkbenchTaskImporter(workbench);
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

    const importer = new WorkbenchTaskImporter(workbench);
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

    const importer = new WorkbenchTaskImporter(workbench);
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

    const importer = new WorkbenchTaskImporter(workbench);
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

    const importer = new WorkbenchTaskImporter(workbench);

    await expect(importer.listCandidateTasks()).resolves.toEqual([
      expect.objectContaining({ id: 'task-coding' }),
    ]);
    await expect(importer.fetchTaskStatesByIds?.(['task-maintenance'])).resolves.toEqual([
      expect.objectContaining({ id: 'task-maintenance', stateKind: 'blocked' }),
    ]);
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

    const importer = new WorkbenchTaskImporter(workbench);
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

  it('leaves Claude review work items for the Claude Code plugin while importing Codex fix items', async () => {
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
      labels: ['agent-loop', 'claude-review', 'needs-claude-review'],
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

    const importer = new WorkbenchTaskImporter(workbench);

    await expect(importer.listCandidateTasks()).resolves.toEqual([
      expect.objectContaining({ id: 'task-regular' }),
      expect.objectContaining({ id: 'task-codex-fix' }),
    ]);
    await expect(importer.fetchTasksByStates?.(['todo'])).resolves.toEqual([
      expect.objectContaining({ id: 'task-regular' }),
      expect.objectContaining({ id: 'task-codex-fix' }),
    ]);
  });

  it('imports workbench tasks from their source project path instead of their previous worktree path', async () => {
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

    const importer = new WorkbenchTaskImporter(workbench);
    const tasks = await importer.listCandidateTasks();

    expect(tasks[0]?.repository).toMatchObject({
      name: 'tik',
      path: sourceProjectPath,
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
