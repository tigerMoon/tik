import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TrackerDaemon } from '../src/tracker-daemon/tracker-daemon.js';
import { loadTrackerWorkflow } from '../src/tracker-daemon/workflow-loader.js';
import { LinearTaskImporter } from '../src/tracker-daemon/linear-tracker-client.js';
import { JsonTaskImporter } from '../src/tracker-daemon/json-tracker-client.js';
import type {
  TrackerDaemonStateStore,
  TrackerDaemonWorkLauncher,
  TrackedTask,
  TrackedTaskStateKind,
} from '../src/tracker-daemon/types.js';

const tempDirs: string[] = [];

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

class MemoryTaskImporter {
  byTick: TrackedTask[][] = [];
  byIdCalls: string[][] = [];
  terminalStateCalls: string[][] = [];
  failListError?: Error;

  constructor(public tasks: TrackedTask[] = []) {}

  async listCandidateTasks(): Promise<TrackedTask[]> {
    if (this.failListError) throw this.failListError;
    return this.byTick.shift() || this.tasks;
  }

  async fetchTaskStatesByIds(taskIds: string[]): Promise<TrackedTask[]> {
    this.byIdCalls.push(taskIds);
    return this.tasks.filter((task) => taskIds.includes(task.id));
  }

  async listOpenAttemptTasks(): Promise<TrackedTask[]> {
    return this.tasks.filter((task) => Boolean(task.activeKernelTaskId));
  }

  async fetchTasksByStates(stateNames: string[]): Promise<TrackedTask[]> {
    this.terminalStateCalls.push(stateNames);
    const allowed = new Set(stateNames.map((state) => state.toLowerCase()));
    return this.tasks.filter((task) => allowed.has(task.state.toLowerCase()));
  }
}

class MemoryStateStore implements TrackerDaemonStateStore {
  state = { retries: {} };

  async load() {
    return this.state;
  }

  async save(nextState: typeof this.state): Promise<void> {
    this.state = JSON.parse(JSON.stringify(nextState));
  }
}

class RecordingLauncher implements TrackerDaemonWorkLauncher {
  launched: Array<{ task: TrackedTask; prompt?: string; projectPath: string }> = [];
  stopped: Array<{ taskId: string; reason: string }> = [];
  hooks: string[] = [];
  private nextId = 1;

  async launchTask(task: TrackedTask, input: { projectPath: string; prompt?: string }) {
    this.launched.push({ task, prompt: input.prompt, projectPath: input.projectPath });
    return { taskId: `kernel-task-${this.nextId++}`, workbenchTaskId: task.id };
  }

  async stopRun(input: { taskId: string; reason: string }): Promise<void> {
    this.stopped.push({ taskId: input.taskId, reason: input.reason });
  }

  async runHook(name: string): Promise<void> {
    this.hooks.push(name);
  }

  async cleanupWorkspace(input: { task: TrackedTask }): Promise<void> {
    this.hooks.push(`cleanup:${input.task.shortIdentifier}`);
  }
}

function task(id: string, shortIdentifier: string, stateKind: TrackedTaskStateKind = 'active'): TrackedTask {
  return {
    id,
    shortIdentifier,
    title: `Title ${shortIdentifier}`,
    description: `Description ${shortIdentifier}`,
    state: stateKind === 'terminal' ? 'Done' : stateKind === 'blocked' ? 'Blocked' : 'Todo',
    stateKind,
    labels: [],
    blockedBy: [],
    sourceUrl: `https://linear.local/${shortIdentifier}`,
    repository: { name: 'repo', path: '/repo/default' },
  };
}

describe('tracker-daemon Symphony spec behavior', () => {
  it('loads WORKFLOW.md front matter and renders task prompts from the prompt body', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-workflow-loader-'));
    tempDirs.push(root);
    await fs.writeFile(path.join(root, 'WORKFLOW.md'), [
      '---',
      'tracker:',
      '  kind: json',
      'polling:',
      '  interval_ms: 2500',
      '  max_concurrent_agents: 2',
      'workspace:',
      '  root: .symphony/workspaces',
      '  cleanup_terminal: true',
      'agent:',
      '  timeout_ms: 12345',
      '---',
      'Please work on {{task.shortIdentifier}}: {{task.title}}.',
      '',
      '{{task.description}}',
    ].join('\n'), 'utf-8');

    const workflow = await loadTrackerWorkflow(root);

    expect(workflow.config.polling.intervalMs).toBe(2500);
    expect(workflow.config.polling.maxConcurrentAgents).toBe(2);
    expect(workflow.config.workspace.cleanupTerminal).toBe(true);
    expect(workflow.renderPrompt(task('task-1', 'TIK-1'))).toContain('Please work on TIK-1: Title TIK-1.');
    expect(workflow.renderPrompt(task('task-1', 'TIK-1'))).toContain('Description TIK-1');
  });

  it('loads SPEC-style top-level hooks and agent concurrency settings', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-workflow-loader-'));
    tempDirs.push(root);
    await fs.writeFile(path.join(root, 'WORKFLOW.md'), [
      '---',
      'tracker:',
      '  kind: linear',
      '  api_key: $LINEAR_API_KEY',
      '  endpoint: https://linear.example/graphql',
      '  project_slug: tik',
      'agent:',
      '  max_concurrent_agents: 4',
      '  timeout_ms: 12345',
      'hooks:',
      '  after_create: |',
      '    echo created',
      '    echo done',
      '  before_run: echo before',
      '  after_run: echo after',
      '  before_remove: echo remove',
      '---',
      'Implement {{task.shortIdentifier}}.',
    ].join('\n'), 'utf-8');

    const workflow = await loadTrackerWorkflow(root);

    expect(workflow.config.tracker.kind).toBe('linear');
    expect(workflow.config.tracker.apiKeyEnv).toBe('LINEAR_API_KEY');
    expect(workflow.config.tracker.endpoint).toBe('https://linear.example/graphql');
    expect(workflow.config.tracker.projectSlug).toBe('tik');
    expect(workflow.config.polling.maxConcurrentAgents).toBe(4);
    expect(workflow.config.workspace.hooks).toEqual({
      afterCreate: ['echo created\necho done'],
      beforeRun: ['echo before'],
      afterRun: ['echo after'],
      beforeRemove: ['echo remove'],
    });
  });

  it('fails prompt rendering on unknown workflow variables', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-workflow-loader-'));
    tempDirs.push(root);
    await fs.writeFile(path.join(root, 'WORKFLOW.md'), [
      '---',
      'tracker:',
      '  kind: json',
      '---',
      'Implement {{issue.missing_field}}.',
    ].join('\n'), 'utf-8');

    const workflow = await loadTrackerWorkflow(root);

    expect(() => workflow.renderPrompt(task('task-1', 'TIK-1'))).toThrow(
      'Unknown workflow template variable: issue.missing_field',
    );
  });

  it('keeps backward-compatible issue template variables for existing WORKFLOW.md files', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-workflow-loader-'));
    tempDirs.push(root);
    await fs.writeFile(path.join(root, 'WORKFLOW.md'), [
      '---',
      'tracker:',
      '  kind: json',
      '---',
      'Implement {{issue.identifier}} from {{issue.url}}.',
    ].join('\n'), 'utf-8');

    const workflow = await loadTrackerWorkflow(root);

    expect(workflow.renderPrompt(task('task-1', 'TIK-1'))).toContain(
      'Implement TIK-1 from https://linear.local/TIK-1.',
    );
  });

  it('supports YAML arrays and Liquid conditionals, loops, and filters in WORKFLOW.md', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-workflow-loader-'));
    tempDirs.push(root);
    await fs.writeFile(path.join(root, 'WORKFLOW.md'), [
      '---',
      'tracker:',
      '  kind: json',
      '  active_states:',
      '    - Todo',
      '    - Ready',
      '  terminal_states: [Done, Closed]',
      'workspace:',
      '  hooks:',
      '    before_run:',
      '      - echo first',
      '      - echo second',
      'polling:',
      '  interval_ms: 2500',
      '---',
      '{% if attempt > 0 %}Retry {{attempt}} for {% endif %}{{ task.shortIdentifier }}',
      'Labels: {{ task.labels | join: ", " }}',
      '{% for label in task.labels %}- {{ label }}{% endfor %}',
    ].join('\n'), 'utf-8');

    const workflow = await loadTrackerWorkflow(root);
    const rendered = workflow.renderPrompt({
      ...task('task-1', 'TIK-1'),
      labels: ['backend', 'tracker'],
    }, { attempt: 2 });

    expect(workflow.config.tracker.activeStates).toEqual(['Todo', 'Ready']);
    expect(workflow.config.tracker.terminalStates).toEqual(['Done', 'Closed']);
    expect(workflow.config.workspace.hooks.beforeRun).toEqual(['echo first', 'echo second']);
    expect(rendered).toContain('Retry 2 for TIK-1');
    expect(rendered).toContain('Labels: backend, tracker');
    expect(rendered).toContain('- backend');
    expect(rendered).toContain('- tracker');
  });

  it('enforces bounded concurrency when dispatching active tasks', async () => {
    const importer = new MemoryTaskImporter([
      task('task-1', 'TIK-1'),
      task('task-2', 'TIK-2'),
      task('task-3', 'TIK-3'),
    ]);
    const stateStore = new MemoryStateStore();
    const launcher = new RecordingLauncher();
    const daemon = new TrackerDaemon({
      importer,
      stateStore,
      launcher,
      workspaceRoot: '/workspace',
      defaultProjectPath: '/repo/default',
      maxConcurrentAgents: 2,
    });

    const result = await daemon.tick();

    expect(result.dispatched).toEqual(['TIK-1', 'TIK-2']);
    expect(result.skipped).toContainEqual({ shortIdentifier: 'TIK-3', reason: 'concurrency-limit' });
    expect(launcher.launched).toHaveLength(2);
  });

  it('sorts dispatch by priority, creation time, then short identifier instead of importer return order', async () => {
    const importer = new MemoryTaskImporter([
      { ...task('task-3', 'TIK-3'), priority: 3, createdAt: '2026-01-01T00:00:00.000Z' },
      { ...task('task-1', 'TIK-1'), priority: 1, createdAt: '2026-01-03T00:00:00.000Z' },
      { ...task('task-2', 'TIK-2'), priority: 1, createdAt: '2026-01-01T00:00:00.000Z' },
      { ...task('task-0', 'TIK-0'), priority: 1, createdAt: '2026-01-01T00:00:00.000Z' },
    ]);
    const launcher = new RecordingLauncher();
    const daemon = new TrackerDaemon({
      importer,
      stateStore: new MemoryStateStore(),
      launcher,
      workspaceRoot: '/workspace',
      defaultProjectPath: '/repo/default',
    });

    const result = await daemon.tick();

    expect(result.dispatched).toEqual(['TIK-0', 'TIK-2', 'TIK-1', 'TIK-3']);
    expect(launcher.launched.map((item) => item.task.shortIdentifier)).toEqual(['TIK-0', 'TIK-2', 'TIK-1', 'TIK-3']);
  });

  it('runs dispatch hooks for selected tasks concurrently within the agent limit', async () => {
    const importer = new MemoryTaskImporter([
      task('task-1', 'TIK-1'),
      task('task-2', 'TIK-2'),
    ]);
    const launcher = new RecordingLauncher();
    let hookStarts = 0;
    let releaseFirstHook: (() => void) | undefined;
    const firstHookGate = new Promise<void>((resolve) => {
      releaseFirstHook = resolve;
    });
    launcher.runHook = vi.fn(async () => {
      hookStarts += 1;
      if (hookStarts === 1) {
        await firstHookGate;
      }
    });
    const daemon = new TrackerDaemon({
      importer,
      stateStore: new MemoryStateStore(),
      launcher,
      workspaceRoot: '/workspace',
      defaultProjectPath: '/repo/default',
      maxConcurrentAgents: 2,
      workspaceHooks: {
        afterCreate: ['after-create'],
      },
    });

    const tick = daemon.tick();
    let sawSecondHook = false;
    try {
      await waitFor(() => hookStarts >= 2, 80);
      sawSecondHook = true;
    } finally {
      releaseFirstHook?.();
    }
    const result = await tick;

    expect(sawSecondHook).toBe(true);
    expect(result.dispatched).toEqual(['TIK-1', 'TIK-2']);
  });

  it('skips the tick and preserves state when candidate fetch fails', async () => {
    const importer = new MemoryTaskImporter();
    importer.failListError = new Error('Linear 502');
    const stateStore = new MemoryStateStore();
    stateStore.state = {
      runs: {
        'task-1': {
          taskId: 'task-1',
          shortIdentifier: 'TIK-1',
          kernelTaskId: 'kernel-task-1',
          workspaceRoot: '/workspace',
          projectPath: '/repo/default',
          startedAt: '2026-01-01T00:00:00.000Z',
          status: 'running',
          lastTaskState: 'Todo',
          lastSeenAt: '2026-01-01T00:00:00.000Z',
        },
      },
      retries: {},
    };
    const daemon = new TrackerDaemon({
      importer,
      stateStore,
      launcher: new RecordingLauncher(),
      workspaceRoot: '/workspace',
      defaultProjectPath: '/repo/default',
    });

    const result = await daemon.tick();

    expect(result.failed).toEqual([{ shortIdentifier: 'tracker', error: 'Linear 502' }]);
    expect(result.dispatched).toEqual([]);
    expect(stateStore.state.runs?.['task-1']?.status).toBe('running');
  });

  it('preserves an existing watch-mode marker during manual ticks', async () => {
    const importer = new MemoryTaskImporter([task('task-1', 'TIK-1')]);
    const stateStore = new MemoryStateStore();
    stateStore.state = {
      retries: {},
      watching: true,
    };
    const launcher = new RecordingLauncher();
    const daemon = new TrackerDaemon({
      importer,
      stateStore,
      launcher,
      workspaceRoot: '/workspace',
      defaultProjectPath: '/workspace',
      now: () => 1_000,
    });

    const result = await daemon.tick();

    expect(result.dispatched).toEqual(['TIK-1']);
    expect(stateStore.state.watching).toBe(true);
  });

  it('resets exhausted retry state when the tracked task has been updated', async () => {
    const importer = new MemoryTaskImporter([
      { ...task('task-1', 'TIK-1'), updatedAt: '2026-01-02T00:00:00.000Z' },
    ]);
    const stateStore = new MemoryStateStore();
    stateStore.state.retries = {
      'task-1': {
        taskId: 'task-1',
        shortIdentifier: 'TIK-1',
        attempt: 3,
        dueAtMs: 0,
        lastError: 'launch failed',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    };
    const launcher = new RecordingLauncher();
    const daemon = new TrackerDaemon({
      importer,
      stateStore,
      launcher,
      workspaceRoot: '/workspace',
      defaultProjectPath: '/repo/default',
      retry: {
        initialDelayMs: 100,
        maxDelayMs: 100,
        maxAttempts: 3,
      },
    });

    const result = await daemon.tick();

    expect(result.dispatched).toEqual(['TIK-1']);
    expect(stateStore.state.retries['task-1']).toBeUndefined();
  });

  it('reconciles persisted running tasks by id before dispatch decisions', async () => {
    const importer = new MemoryTaskImporter([
      {
        ...task('task-1', 'TIK-1', 'terminal'),
        state: 'Done',
        activeKernelTaskId: 'kernel-task-1',
        activeAttemptStartedAt: '2026-01-01T00:00:00.000Z',
      },
    ]);
    importer.byTick = [[]];
    const launcher = new RecordingLauncher();
    const daemon = new TrackerDaemon({
      importer,
      stateStore: new MemoryStateStore(),
      launcher,
      workspaceRoot: '/workspace',
      defaultProjectPath: '/repo/default',
    });

    const result = await daemon.tick();

    expect(result.stopped).toEqual(['TIK-1']);
    expect(launcher.stopped[0]).toMatchObject({ taskId: 'kernel-task-1' });
  });

  it('runs workspace hooks and cleanup for terminal tasks', async () => {
    const importer = new MemoryTaskImporter([task('task-1', 'TIK-1', 'terminal')]);
    const launcher = new RecordingLauncher();
    const daemon = new TrackerDaemon({
      importer,
      stateStore: new MemoryStateStore(),
      launcher,
      workspaceRoot: '/workspace',
      defaultProjectPath: '/repo/default',
      terminalStates: ['Done'],
      workspaceHooks: {
        afterCreate: ['after-create'],
        beforeRun: ['before-run'],
        afterRun: ['after-run'],
        beforeRemove: ['before-remove'],
      },
      cleanupTerminalWorkspaces: true,
    });

    importer.tasks = [{
      ...task('task-2', 'TIK-2', 'terminal'),
      state: 'Done',
      activeKernelTaskId: 'kernel-task-2',
      activeAttemptStartedAt: '2026-01-01T00:00:00.000Z',
    }];
    await daemon.tick();

    expect(launcher.hooks).toEqual([
      'before-remove',
      'cleanup:TIK-2',
    ]);
  });

  it('runs watch ticks on the configured cadence until stopped', async () => {
    vi.useFakeTimers();
    const importer = new MemoryTaskImporter();
    importer.byTick = [[task('task-1', 'TIK-1')], [task('task-2', 'TIK-2')]];
    const launcher = new RecordingLauncher();
    const daemon = new TrackerDaemon({
      importer,
      stateStore: new MemoryStateStore(),
      launcher,
      workspaceRoot: '/workspace',
      defaultProjectPath: '/repo/default',
      pollIntervalMs: 100,
    });

    const handle = daemon.watch();
    await vi.advanceTimersByTimeAsync(250);
    handle.stop();

    expect(launcher.launched.map((item) => item.task.shortIdentifier)).toEqual(['TIK-1', 'TIK-2']);
  });

  it('does not overlap watch ticks while a tick is still running', async () => {
    vi.useFakeTimers();
    let releaseFirstFetch: (() => void) | undefined;
    let fetchCalls = 0;
    const importer = new MemoryTaskImporter([task('task-1', 'TIK-1')]);
    importer.listCandidateTasks = vi.fn(async () => {
      fetchCalls += 1;
      if (fetchCalls === 1) {
        await new Promise<void>((resolve) => {
          releaseFirstFetch = resolve;
        });
      }
      return importer.tasks;
    });
    const launcher = new RecordingLauncher();
    const daemon = new TrackerDaemon({
      importer,
      stateStore: new MemoryStateStore(),
      launcher,
      workspaceRoot: '/workspace',
      defaultProjectPath: '/repo/default',
      pollIntervalMs: 100,
    });

    const handle = daemon.watch();
    await vi.advanceTimersByTimeAsync(250);
    expect(fetchCalls).toBe(1);

    releaseFirstFetch?.();
    await vi.advanceTimersByTimeAsync(100);
    handle.stop();

    expect(fetchCalls).toBe(2);
  });

  it('recomputes watch cadence from the latest workflow between ticks', async () => {
    vi.useFakeTimers();
    const importer = new MemoryTaskImporter();
    importer.byTick = [[task('task-1', 'TIK-1')], [task('task-2', 'TIK-2')]];
    const launcher = new RecordingLauncher();
    let workflowPollMs = 100;
    const daemon = new TrackerDaemon({
      importer,
      stateStore: new MemoryStateStore(),
      launcher,
      workspaceRoot: '/workspace',
      defaultProjectPath: '/repo/default',
      workflowProvider: async () => ({
        config: {
          tracker: { kind: 'json', activeStates: ['Todo'], terminalStates: ['Done'] },
          polling: { intervalMs: workflowPollMs, maxConcurrentAgents: 3 },
          workspace: {
            root: '.tik/workspaces',
            cleanupTerminal: false,
            hooks: { afterCreate: [], beforeRun: [], afterRun: [], beforeRemove: [] },
          },
          agent: { timeoutMs: 1000 },
        },
        promptTemplate: 'Implement {{ task.shortIdentifier }}',
        renderPrompt(taskInput) {
          return `Implement ${taskInput.shortIdentifier}`;
        },
      }),
    });

    const handle = daemon.watch();
    await vi.advanceTimersByTimeAsync(110);
    workflowPollMs = 20;
    await vi.advanceTimersByTimeAsync(30);
    handle.stop();

    expect(launcher.launched.map((item) => item.task.shortIdentifier)).toEqual(['TIK-1', 'TIK-2']);
  });

  it('normalizes Linear GraphQL issues into tracked tasks', async () => {
    const fetchJson = vi.fn(async () => ({
      data: {
        issues: {
          nodes: [
            {
              id: 'linear-id',
              identifier: 'ENG-1',
              title: 'Ship daemon',
              description: 'Build Symphony compatibility',
              priority: 1,
              url: 'https://linear.app/acme/issue/ENG-1',
              createdAt: '2026-01-01T00:00:00.000Z',
              updatedAt: '2026-01-02T00:00:00.000Z',
              state: { name: 'In Progress', type: 'started' },
              labels: { nodes: [{ name: 'backend' }] },
              relations: {
                nodes: [
                  {
                    type: 'blocked_by',
                    relatedIssue: {
                      id: 'dep',
                      identifier: 'ENG-0',
                      state: { name: 'Done', type: 'completed' },
                    },
                  },
                ],
              },
            },
          ],
        },
      },
    }));
    const importer = new LinearTaskImporter({
      apiKey: 'lin_api_key',
      activeStates: ['In Progress'],
      terminalStates: ['Done'],
      projectSlug: 'tik',
      fetchJson,
    });

    const tasks = await importer.listCandidateTasks();

    expect(fetchJson).toHaveBeenCalledWith(expect.objectContaining({
      headers: expect.objectContaining({ Authorization: 'lin_api_key' }),
      body: expect.objectContaining({
        variables: expect.objectContaining({ projectSlug: 'tik' }),
      }),
    }));
    expect(tasks[0]).toMatchObject({
      id: 'linear-id',
      shortIdentifier: 'ENG-1',
      title: 'Ship daemon',
      state: 'In Progress',
      stateKind: 'active',
      sourceUrl: 'https://linear.app/acme/issue/ENG-1',
      labels: ['backend'],
      blockedBy: [{ id: 'dep', shortIdentifier: 'ENG-0', state: 'Done' }],
    });
  });

  it('lets configured terminal state names override Linear active state types', async () => {
    const importer = new LinearTaskImporter({
      apiKey: 'lin_api_key',
      terminalStates: ['Verified'],
      fetchJson: vi.fn(async () => ({
        data: {
          issues: {
            nodes: [
              {
                id: 'linear-id',
                identifier: 'ENG-2',
                title: 'Verify release',
                state: { name: 'Verified', type: 'started' },
                labels: { nodes: [] },
                relations: { nodes: [] },
              },
            ],
          },
        },
      })),
    });

    const tasks = await importer.fetchTaskStatesByIds(['linear-id']);

    expect(tasks[0]).toMatchObject({
      shortIdentifier: 'ENG-2',
      state: 'Verified',
      stateKind: 'terminal',
    });
  });

  it('re-reads JSON snapshots for task state lookup by id', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-json-tracker-'));
    tempDirs.push(root);
    const filePath = path.join(root, 'tasks.json');
    await fs.writeFile(filePath, JSON.stringify({
      tasks: [
        { id: 'task-1', shortIdentifier: 'TIK-1', title: 'One', state: 'Todo' },
        { id: 'task-2', shortIdentifier: 'TIK-2', title: 'Two', state: 'Done' },
      ],
    }), 'utf-8');
    const importer = new JsonTaskImporter(filePath);

    await fs.writeFile(filePath, JSON.stringify({
      tasks: [
        { id: 'task-1', shortIdentifier: 'TIK-1', title: 'One', state: 'Done' },
      ],
    }), 'utf-8');

    const tasks = await importer.fetchTaskStatesByIds?.(['task-1', 'task-2']);

    expect(tasks?.map((entry) => [entry.shortIdentifier, entry.stateKind])).toEqual([
      ['TIK-1', 'terminal'],
    ]);
  });
});

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error('Timed out waiting for predicate.');
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
