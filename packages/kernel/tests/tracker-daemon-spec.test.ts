import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TrackerDaemon } from '../src/tracker-daemon/tracker-daemon.js';
import { loadTrackerWorkflow } from '../src/tracker-daemon/workflow-loader.js';
import { LinearTaskImporter } from '../src/tracker-daemon/linear-tracker-client.js';
import { JsonTaskImporter } from '../src/tracker-daemon/json-tracker-client.js';
import { FileAgentRunStore } from '../src/agent-runners/agent-run-store.js';
import type {
  AgentRunHandle,
  AgentRunInput,
  AgentRunCompletion,
  AgentRunStatusSnapshot,
  AgentRuntimeRunner,
  ArtifactCandidate,
  PreparedRun,
} from '../src/agent-runners/agent-runtime-runner.js';
import type {
  AgentRuntimeName,
  TrackerDaemonStateStore,
  TrackerDaemonWorkLauncher,
  TrackerWorkflowDefinition,
  TrackedTask,
  TrackedTaskStateKind,
  WorkbenchPort,
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
  runtimeStarts: Array<{ task: TrackedTask; runId: string; attempt: number; projectPath: string }> = [];
  runtimeFinishes: Array<{ taskId: string; runId: string; attemptNumber: number; completion: AgentRunCompletion }> = [];
  private nextId = 1;

  constructor(private readonly workbench?: WorkbenchPort) {}

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

  async markRuntimeRunStarted(
    task: TrackedTask,
    input: { runId: string; attempt: number; projectPath: string; runner: AgentRuntimeName },
  ): Promise<{ attemptNumber: number } | void> {
    this.runtimeStarts.push({ task, runId: input.runId, attempt: input.attempt, projectPath: input.projectPath });
    if (!this.workbench) return undefined;
    const existing = await this.workbench.readTask?.(task.id);
    if (!existing) {
      await this.workbench.createTask({
        id: task.id,
        shortIdentifier: task.shortIdentifier,
        title: task.title,
        goal: task.description || task.title,
        status: 'todo',
      } as any, task.id);
    }
    const current = await this.workbench.readTask?.(task.id);
    const attemptNumber = ((current?.attempts || []).length) + 1;
    await this.workbench.appendAttempt?.(task.id, {
      attemptNumber,
      startedAt: '2026-01-01T00:00:00.000Z',
      kernelTaskId: input.runId,
      turnCount: input.attempt,
    });
    await this.workbench.appendTaskRun?.(task.id, {
      runId: input.runId,
      startedAt: '2026-01-01T00:00:00.000Z',
      status: 'running',
      kernelTaskId: input.runId,
      agentName: input.runner,
      turnCount: input.attempt,
    } as any);
    return { attemptNumber };
  }

  async markRuntimeRunFinished(
    taskId: string,
    input: { runId: string; attemptNumber: number; completion: AgentRunCompletion },
  ): Promise<void> {
    this.runtimeFinishes.push({ taskId, runId: input.runId, attemptNumber: input.attemptNumber, completion: input.completion });
    if (!this.workbench) return;
    const status = input.completion.status === 'completed' ? 'completed' : 'failed';
    await this.workbench.finishAttempt?.(
      taskId,
      input.attemptNumber,
      input.completion.status === 'completed' ? 'completed' : 'failed',
      input.completion.error,
    );
    await this.workbench.appendTaskRun?.(taskId, {
      runId: input.runId,
      startedAt: '2026-01-01T00:00:00.000Z',
      endedAt: '2026-01-01T00:00:01.000Z',
      status,
      kernelTaskId: input.runId,
      errorReason: input.completion.error,
    } as any);
    await this.workbench.transitionTask?.(taskId, input.completion.status === 'completed' ? 'in_review' : 'blocked');
  }
}

class RecordingRuntimeRunner implements AgentRuntimeRunner {
  readonly name: AgentRuntimeName;
  preparedInputs: AgentRunInput[] = [];
  startedInputs: PreparedRun[] = [];
  startError?: Error;
  completion?: Promise<AgentRunCompletion>;

  constructor(name: AgentRuntimeName) {
    this.name = name;
  }

  async prepare(input: AgentRunInput): Promise<PreparedRun> {
    this.preparedInputs.push(input);
    return {
      runId: input.runId,
      runner: this.name,
      mode: this.name === 'claude-code' ? 'claude_print' : 'codex_app_server',
      cwd: input.projectPath,
      prompt: input.renderedPrompt,
    };
  }

  async start(input: PreparedRun): Promise<AgentRunHandle> {
    this.startedInputs.push(input);
    if (this.startError) throw this.startError;
    return {
      runId: input.runId,
      startedAt: '2026-01-01T00:00:00.000Z',
      completion: this.completion,
      stop: async () => undefined,
    };
  }

  async stop(): Promise<void> {}

  async getStatus(): Promise<AgentRunStatusSnapshot> {
    return 'running';
  }

  async collectTranscript() {
    return [];
  }

  async collectDiff() {
    return { changedFiles: [] };
  }

  async collectArtifacts(): Promise<ArtifactCandidate[]> {
    return [];
  }

  async cleanup(): Promise<void> {}
}

class MemoryWorkbenchPort implements WorkbenchPort {
  tasks = new Map<string, {
    id: string;
    status: 'todo' | 'in_progress' | 'in_review' | 'failed' | 'blocked';
    attempts: Array<{ attemptNumber: number; startedAt: string; finishedAt?: string; outcome?: 'completed' | 'failed'; kernelTaskId?: string; error?: string }>;
    runs: Array<{ runId: string; startedAt: string; endedAt?: string; status: 'running' | 'completed' | 'failed'; kernelTaskId?: string; agentName?: string; errorReason?: string }>;
  }>();

  constructor(initial: Array<{ id: string; status?: 'todo' | 'in_progress' | 'in_review' | 'failed' | 'blocked' }> = []) {
    for (const item of initial) {
      this.tasks.set(item.id, {
        id: item.id,
        status: item.status || 'todo',
        attempts: [],
        runs: [],
      });
    }
  }

  async createTask(input: any, taskId?: string) {
    const id = taskId || input.id;
    const task = {
      id,
      status: input.status || 'todo',
      attempts: input.attempts || [],
      runs: input.runs || [],
    };
    this.tasks.set(id, task);
    return task as any;
  }

  async readTask(taskId: string) {
    return this.tasks.get(taskId) as any || null;
  }

  async transitionTask(taskId: string, to: any) {
    const task = this.tasks.get(taskId);
    if (!task) return null;
    task.status = to;
    return task as any;
  }

  async appendAttempt(taskId: string, input: any) {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`missing task ${taskId}`);
    const attempt = {
      attemptNumber: input.attemptNumber || task.attempts.length + 1,
      startedAt: input.startedAt || '2026-01-01T00:00:00.000Z',
      kernelTaskId: input.kernelTaskId,
    };
    task.status = 'in_progress';
    task.attempts.push(attempt);
    return attempt as any;
  }

  async finishAttempt(taskId: string, attemptNumber: number, outcome: 'completed' | 'failed', error?: string) {
    const task = this.tasks.get(taskId);
    if (!task) return null;
    task.attempts = task.attempts.map((attempt) => attempt.attemptNumber === attemptNumber
      ? { ...attempt, finishedAt: '2026-01-01T00:00:01.000Z', outcome, error }
      : attempt);
    return task as any;
  }

  async appendTaskRun(taskId: string, run: any) {
    const task = this.tasks.get(taskId);
    if (!task) return null;
    task.runs = [...task.runs.filter((item) => item.runId !== run.runId), run];
    return task as any;
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

function workflowV2(input: {
  root?: string;
  runner?: AgentRuntimeName;
  mode?: 'codex_exec' | 'codex_app_server' | 'claude_print' | 'claude_hooked';
  renderPrompt?: (task: TrackedTask, attempt: number) => string;
} = {}): TrackerWorkflowDefinition {
  const runner = input.runner || 'codex';
  const mode = input.mode || (runner === 'claude-code' ? 'claude_print' : 'codex_app_server');
  return {
    version: 2,
    path: input.root ? path.join(input.root, '.tik', 'WORKFLOW.md') : undefined,
    workflowConfigHash: 'config-hash',
    workflowPromptHash: 'prompt-hash',
    config: {
      tracker: { kind: 'json', activeStates: ['Todo'], terminalStates: ['Done'] },
      polling: { intervalMs: 1000, maxConcurrentAgents: 3 },
      workspace: {
        root: '.tik/workspaces',
        cleanupTerminal: false,
        hooks: { afterCreate: [], beforeRun: [], afterRun: [], beforeRemove: [] },
      },
      agent: { timeoutMs: 1000 },
      selector: { includeLabels: ['ready'], excludeLabels: [] },
      routing: { defaultRunner: runner, defaultMode: mode, rules: [] },
      concurrency: { lock: 'repository_branch', respectLabels: [] },
      sandbox: { envWhitelist: [] },
      hooks: { root: '.tik/hooks', timeoutMs: 30_000, allowExecutableOnly: true },
    },
    promptTemplate: 'Implement {{ task.shortIdentifier }}',
    renderPrompt(taskInput, renderInput) {
      return input.renderPrompt?.(taskInput, renderInput?.attempt || 0) || `Implement ${taskInput.shortIdentifier}`;
    },
    resolveRouting() {
      return { runner, mode, matchedSource: 'default' };
    },
  };
}

describe('tracker-daemon Symphony spec behavior', () => {
  it('rejects workflow files that do not declare version 2', async () => {
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

    await expect(loadTrackerWorkflow(root)).rejects.toThrow('Workflow files must declare version: 2.');
  });

  it('loads workflow v2 front matter and renders task prompts from the prompt body', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-workflow-loader-'));
    tempDirs.push(root);
    await fs.writeFile(path.join(root, 'WORKFLOW.md'), [
      '---',
      'version: 2',
      'polling:',
      '  interval_ms: 2500',
      '  max_concurrent_agents: 2',
      'workspace:',
      '  root: .tik/workspaces',
      '  cleanup_terminal: true',
      'routing:',
      '  default_runner: codex',
      '  default_mode: codex_app_server',
      '---',
      'Please work on {{task.shortIdentifier}}: {{task.title}}.',
      '',
      '{{task.description}}',
    ].join('\n'), 'utf-8');

    const workflow = await loadTrackerWorkflow(root);

    expect(workflow.version).toBe(2);
    expect(workflow.config.polling.intervalMs).toBe(2500);
    expect(workflow.config.polling.maxConcurrentAgents).toBe(2);
    expect(workflow.config.workspace.cleanupTerminal).toBe(true);
    expect(workflow.renderPrompt(task('task-1', 'TIK-1'))).toContain('Please work on TIK-1: Title TIK-1.');
    expect(workflow.renderPrompt(task('task-1', 'TIK-1'))).toContain('Description TIK-1');
  });

  it('fails prompt rendering on unknown workflow variables', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-workflow-loader-'));
    tempDirs.push(root);
    await fs.writeFile(path.join(root, 'WORKFLOW.md'), [
      '---',
      'version: 2',
      'routing:',
      '  default_runner: codex',
      '  default_mode: codex_app_server',
      '---',
      'Implement {{issue.missing_field}}.',
    ].join('\n'), 'utf-8');

    const workflow = await loadTrackerWorkflow(root);

    expect(() => workflow.renderPrompt(task('task-1', 'TIK-1'))).toThrow(
      'Unknown workflow template variable: issue.missing_field',
    );
  });

  it('keeps issue template aliases for workflow v2 files', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-workflow-loader-'));
    tempDirs.push(root);
    await fs.writeFile(path.join(root, 'WORKFLOW.md'), [
      '---',
      'version: 2',
      'routing:',
      '  default_runner: codex',
      '  default_mode: codex_app_server',
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
      'version: 2',
      'tracker:',
      '  kind: json',
      '  active_states:',
      '    - Todo',
      '    - Ready',
      '  terminal_states: [Done, Closed]',
      'workspace:',
      '  hooks:',
      '    before_run:',
      '      - .tik/hooks/first.sh',
      '      - .tik/hooks/second.sh',
      'polling:',
      '  interval_ms: 2500',
      'routing:',
      '  default_runner: codex',
      '  default_mode: codex_app_server',
      '---',
      '{% if attempt > 0 %}Retry {{attempt}} for {% endif %}{{ task.shortIdentifier }}',
      'Labels: {{ task.labels | join: ", " }}',
      '{% for label in task.labels %}- {{ label }}{% endfor %}',
    ].join('\n'), 'utf-8');
    await fs.mkdir(path.join(root, '.tik', 'hooks'), { recursive: true });
    await Promise.all(['first.sh', 'second.sh'].map(async (name) => {
      const hookPath = path.join(root, '.tik', 'hooks', name);
      await fs.writeFile(hookPath, '#!/bin/sh\nexit 0\n', 'utf-8');
      await fs.chmod(hookPath, 0o755);
    }));

    const workflow = await loadTrackerWorkflow(root);
    const rendered = workflow.renderPrompt({
      ...task('task-1', 'TIK-1'),
      labels: ['backend', 'tracker'],
    }, { attempt: 2 });

    expect(workflow.config.tracker.activeStates).toEqual(['Todo', 'Ready']);
    expect(workflow.config.tracker.terminalStates).toEqual(['Done', 'Closed']);
    expect(workflow.config.workspace.hooks.beforeRun).toEqual(['.tik/hooks/first.sh', '.tik/hooks/second.sh']);
    expect(rendered).toContain('Retry 2 for TIK-1');
    expect(rendered).toContain('Labels: backend, tracker');
    expect(rendered).toContain('- backend');
    expect(rendered).toContain('- tracker');
  });

  it('renders previous review rejection context when workflow templates request it', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-workflow-loader-'));
    tempDirs.push(root);
    await fs.writeFile(path.join(root, 'WORKFLOW.md'), [
      '---',
      'version: 2',
      'routing:',
      '  default_runner: codex',
      '  default_mode: codex_app_server',
      '---',
      '{% if previousReview %}',
      'Previous review rejection reason:',
      '{{ previousReview }}',
      '{% endif %}',
      'Implement {{ task.shortIdentifier }}.',
    ].join('\n'), 'utf-8');

    const workflow = await loadTrackerWorkflow(root);
    const rendered = workflow.renderPrompt(task('task-1', 'TIK-1'), {
      previousReview: 'Add regression coverage before touching implementation.',
    });

    expect(rendered).toContain('Previous review rejection reason:');
    expect(rendered).toContain('Add regression coverage before touching implementation.');
  });

  it('loads workflow v2 hashes and resolves explicit runner labels before rules', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-workflow-v2-'));
    tempDirs.push(root);
    await fs.writeFile(path.join(root, 'WORKFLOW.md'), [
      '---',
      'version: 2',
      'selector:',
      '  include_labels: [ready]',
      'routing:',
      '  default_runner: codex',
      '  default_mode: codex_app_server',
      '  rules:',
      '    - labels_any: [type:docs]',
      '      runner: claude-code',
      '      mode: claude_print',
      'sandbox:',
      '  env_whitelist: [GITHUB_TOKEN]',
      '---',
      'Review {{ task.shortIdentifier }}.',
    ].join('\n'), 'utf-8');

    const workflow = await loadTrackerWorkflow(root);
    const resolved = workflow.resolveRouting?.({
      ...task('task-1', 'TIK-1'),
      labels: ['ready', 'runner:codex', 'type:docs'],
    });

    expect(workflow.version).toBe(2);
    expect(workflow.workflowConfigHash).toMatch(/^[a-f0-9]{64}$/);
    expect(workflow.workflowPromptHash).toMatch(/^[a-f0-9]{64}$/);
    expect(resolved).toMatchObject({
      runner: 'codex',
      mode: 'codex_app_server',
      matchedSource: 'explicit-label',
    });
  });

  it('routes implementation labels before review labels until the task reaches the review phase', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-workflow-v2-'));
    tempDirs.push(root);
    await fs.writeFile(path.join(root, 'WORKFLOW.md'), [
      '---',
      'version: 2',
      'routing:',
      '  rules:',
      '    - labels_any: [needs-claude-review, claude-review]',
      '      runner: claude-code',
      '      mode: claude_print',
      '    - labels_any: [docs, implementation]',
      '      runner: codex',
      '      mode: codex_exec',
      '---',
      'Run {{ task.shortIdentifier }}.',
    ].join('\n'), 'utf-8');

    const workflow = await loadTrackerWorkflow(root);
    const implementationFirst = workflow.resolveRouting?.({
      ...task('task-1', 'TIK-1'),
      labels: ['docs', 'needs-claude-review'],
    });
    const reviewPhase = workflow.resolveRouting?.({
      ...task('task-2', 'TIK-2'),
      labels: ['docs', 'needs-claude-review'],
      agentLoop: {
        kind: 'claude_review',
        phase: 'needs_claude_review',
        round: 1,
        maxRounds: 3,
        rootTaskId: 'task-2',
        changeRequest: {
          scm: 'local',
          repo: 'tik',
          id: 'task-2',
          baseRef: 'main',
          headRef: 'docs',
          headSha: 'abc123',
        },
      },
    });
    const codexFixPhase = workflow.resolveRouting?.({
      ...task('task-3', 'TIK-3'),
      labels: ['needs-codex-fix', 'needs-claude-review'],
      agentLoop: {
        kind: 'codex_fix',
        phase: 'needs_codex_fix',
        round: 1,
        maxRounds: 3,
        rootTaskId: 'task-3',
        changeRequest: {
          scm: 'local',
          repo: 'tik',
          id: 'task-3',
          baseRef: 'main',
          headRef: 'fix',
          headSha: 'def456',
        },
      },
    });

    expect(implementationFirst).toMatchObject({
      runner: 'codex',
      mode: 'codex_exec',
      matchedSource: 'rule[1]',
      matchedLabels: ['docs'],
    });
    expect(reviewPhase).toMatchObject({
      runner: 'claude-code',
      mode: 'claude_print',
      matchedSource: 'phase',
    });
    expect(codexFixPhase).toMatchObject({
      runner: 'codex',
      mode: 'codex_exec',
      matchedSource: 'phase',
    });
  });

  it('loads workflow v2 validation commands for run proof collection', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-workflow-v2-'));
    tempDirs.push(root);
    await fs.writeFile(path.join(root, 'WORKFLOW.md'), [
      '---',
      'version: 2',
      'routing:',
      '  default_runner: codex',
      '  default_mode: codex_exec',
      'validation:',
      '  commands:',
      '    - pnpm typecheck',
      '    - pnpm test',
      '---',
      'Implement {{ task.shortIdentifier }}.',
    ].join('\n'), 'utf-8');

    const workflow = await loadTrackerWorkflow(root);

    expect(workflow.config.validation?.commands).toEqual(['pnpm typecheck', 'pnpm test']);
  });

  it('fails workflow v2 routing for conflicting explicit runner labels', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-workflow-v2-'));
    tempDirs.push(root);
    await fs.writeFile(path.join(root, 'WORKFLOW.md'), [
      '---',
      'version: 2',
      'routing:',
      '  default_runner: codex',
      '  default_mode: codex_app_server',
      '---',
      'Implement {{ task.shortIdentifier }}.',
    ].join('\n'), 'utf-8');

    const workflow = await loadTrackerWorkflow(root);

    expect(() => workflow.resolveRouting?.({
      ...task('task-1', 'TIK-1'),
      labels: ['ready', 'runner:codex', 'runner:claude'],
    })).toThrow('Conflicting explicit runner labels');
  });

  it('fails workflow v2 routing when no rule matches and no default runner is configured', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-workflow-v2-'));
    tempDirs.push(root);
    await fs.writeFile(path.join(root, 'WORKFLOW.md'), [
      '---',
      'version: 2',
      'routing:',
      '  rules:',
      '    - labels_any: [type:docs]',
      '      runner: claude-code',
      '      mode: claude_print',
      '---',
      'Implement {{ task.shortIdentifier }}.',
    ].join('\n'), 'utf-8');

    const workflow = await loadTrackerWorkflow(root);

    expect(() => workflow.resolveRouting?.({
      ...task('task-1', 'TIK-1'),
      labels: ['ready', 'type:implement'],
    })).toThrow('No workflow routing rule matched');
  });

  it('rejects workflow v2 hooks outside .tik/hooks', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-workflow-v2-'));
    tempDirs.push(root);
    await fs.writeFile(path.join(root, 'WORKFLOW.md'), [
      '---',
      'version: 2',
      'routing:',
      '  default_runner: codex',
      '  default_mode: codex_app_server',
      'workspace:',
      '  hooks:',
      '    before_run: echo unsafe',
      '---',
      'Implement {{ task.shortIdentifier }}.',
    ].join('\n'), 'utf-8');

    await expect(loadTrackerWorkflow(root)).rejects.toThrow('Workflow v2 hook must be under .tik/hooks');
  });

  it('accepts executable workflow v2 hooks under .tik/hooks', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-workflow-v2-'));
    tempDirs.push(root);
    await fs.mkdir(path.join(root, '.tik', 'hooks'), { recursive: true });
    const hookPath = path.join(root, '.tik', 'hooks', 'before-run.sh');
    await fs.writeFile(hookPath, '#!/bin/sh\nexit 0\n', 'utf-8');
    await fs.chmod(hookPath, 0o755);
    await fs.writeFile(path.join(root, 'WORKFLOW.md'), [
      '---',
      'version: 2',
      'routing:',
      '  default_runner: codex',
      '  default_mode: codex_app_server',
      'workspace:',
      '  hooks:',
      '    before_run: .tik/hooks/before-run.sh',
      '---',
      'Implement {{ task.shortIdentifier }}.',
    ].join('\n'), 'utf-8');

    const workflow = await loadTrackerWorkflow(root);

    expect(workflow.config.workspace.hooks.beforeRun).toEqual(['.tik/hooks/before-run.sh']);
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

  it('skips workflow v2 tasks missing the ready label before dispatch', async () => {
    const importer = new MemoryTaskImporter([
      { ...task('task-1', 'TIK-1'), labels: ['type:implement'] },
    ]);
    const launcher = new RecordingLauncher();
    const daemon = new TrackerDaemon({
      importer,
      stateStore: new MemoryStateStore(),
      launcher,
      workspaceRoot: '/workspace',
      defaultProjectPath: '/repo/default',
      workflow: {
        version: 2,
        workflowConfigHash: 'config-hash',
        workflowPromptHash: 'prompt-hash',
        config: {
          tracker: { kind: 'json', activeStates: ['Todo'], terminalStates: ['Done'] },
          polling: { intervalMs: 1000, maxConcurrentAgents: 3 },
          workspace: {
            root: '.tik/workspaces',
            cleanupTerminal: false,
            hooks: { afterCreate: [], beforeRun: [], afterRun: [], beforeRemove: [] },
          },
          agent: { timeoutMs: 1000 },
          selector: { includeLabels: ['ready'], excludeLabels: [] },
          routing: { defaultRunner: 'codex', defaultMode: 'codex_app_server', rules: [] },
          concurrency: { lock: 'repository_branch', respectLabels: [] },
          sandbox: { envWhitelist: [] },
          hooks: { root: '.tik/hooks', timeoutMs: 30_000, allowExecutableOnly: true },
        },
        promptTemplate: 'Implement {{ task.shortIdentifier }}',
        renderPrompt(taskInput) {
          return `Implement ${taskInput.shortIdentifier}`;
        },
        resolveRouting() {
          return { runner: 'codex', mode: 'codex_app_server', matchedSource: 'default' };
        },
      },
    });

    const result = await daemon.tick();

    expect(result.dispatched).toEqual([]);
    expect(result.skipped).toContainEqual({ shortIdentifier: 'TIK-1', reason: 'skipped, missing label ready' });
    expect(launcher.launched).toHaveLength(0);
  });

  it('applies the workflow v2 repository branch lock before starting runners', async () => {
    const importer = new MemoryTaskImporter([
      { ...task('task-1', 'TIK-1'), labels: ['ready'] },
      { ...task('task-2', 'TIK-2'), labels: ['ready'] },
    ]);
    const launcher = new RecordingLauncher();
    const daemon = new TrackerDaemon({
      importer,
      stateStore: new MemoryStateStore(),
      launcher,
      workspaceRoot: '/workspace',
      defaultProjectPath: '/repo/default',
      maxConcurrentAgents: 3,
      workflow: {
        version: 2,
        workflowConfigHash: 'config-hash',
        workflowPromptHash: 'prompt-hash',
        config: {
          tracker: { kind: 'json', activeStates: ['Todo'], terminalStates: ['Done'] },
          polling: { intervalMs: 1000, maxConcurrentAgents: 3 },
          workspace: {
            root: '.tik/workspaces',
            cleanupTerminal: false,
            hooks: { afterCreate: [], beforeRun: [], afterRun: [], beforeRemove: [] },
          },
          agent: { timeoutMs: 1000 },
          selector: { includeLabels: ['ready'], excludeLabels: [] },
          routing: { defaultRunner: 'codex', defaultMode: 'codex_app_server', rules: [] },
          concurrency: { lock: 'repository_branch', respectLabels: [] },
          sandbox: { envWhitelist: [] },
          hooks: { root: '.tik/hooks', timeoutMs: 30_000, allowExecutableOnly: true },
        },
        promptTemplate: 'Implement {{ task.shortIdentifier }}',
        renderPrompt(taskInput) {
          return `Implement ${taskInput.shortIdentifier}`;
        },
        resolveRouting() {
          return { runner: 'codex', mode: 'codex_app_server', matchedSource: 'default' };
        },
      },
    });

    const result = await daemon.tick();

    expect(result.dispatched).toEqual(['TIK-1']);
    expect(result.skipped).toContainEqual({ shortIdentifier: 'TIK-2', reason: 'repository-branch-lock' });
    expect(launcher.launched).toHaveLength(1);
  });

  it('records workflow v2 dispatches as AgentRun metadata and events', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-tracker-v2-runs-'));
    tempDirs.push(root);
    const importer = new MemoryTaskImporter([
      { ...task('task-1', 'TIK-1'), labels: ['ready', 'runner:codex'] },
    ]);
    const launcher = new RecordingLauncher();
    const agentRunStore = new FileAgentRunStore(root);
    const daemon = new TrackerDaemon({
      importer,
      stateStore: new MemoryStateStore(),
      launcher,
      workspaceRoot: root,
      defaultProjectPath: '/repo/default',
      now: () => 1_000,
      agentRunStore,
      workflow: {
        version: 2,
        path: path.join(root, '.tik', 'WORKFLOW.md'),
        workflowConfigHash: 'config-hash',
        workflowPromptHash: 'prompt-hash',
        config: {
          tracker: { kind: 'json', activeStates: ['Todo'], terminalStates: ['Done'] },
          polling: { intervalMs: 1000, maxConcurrentAgents: 3 },
          workspace: {
            root: '.tik/workspaces',
            cleanupTerminal: false,
            hooks: { afterCreate: [], beforeRun: [], afterRun: [], beforeRemove: [] },
          },
          agent: { timeoutMs: 1000 },
          selector: { includeLabels: ['ready'], excludeLabels: [] },
          routing: { defaultRunner: 'codex', defaultMode: 'codex_app_server', rules: [] },
          concurrency: { lock: 'repository_branch', respectLabels: [] },
          sandbox: { envWhitelist: [] },
          hooks: { root: '.tik/hooks', timeoutMs: 30_000, allowExecutableOnly: true },
        },
        promptTemplate: 'Implement {{ task.shortIdentifier }}',
        renderPrompt(taskInput) {
          return `Implement ${taskInput.shortIdentifier}`;
        },
        resolveRouting() {
          return { runner: 'codex', mode: 'codex_app_server', matchedSource: 'explicit-label' };
        },
      },
    });

    const result = await daemon.tick();
    const runs = await agentRunStore.listRuns();
    const events = await agentRunStore.readEvents('tik-1-attempt-0-1000');

    expect(result.dispatched).toEqual(['TIK-1']);
    expect(runs[0]).toMatchObject({
      id: 'tik-1-attempt-0-1000',
      taskId: 'task-1',
      shortIdentifier: 'TIK-1',
      runner: 'codex',
      runnerMode: 'codex_app_server',
      status: 'running',
      workflowConfigHash: 'config-hash',
      workflowPromptHash: 'prompt-hash',
    });
    expect(events.map((event) => event.kind)).toEqual(['run.start']);
  });

  it('dispatches workflow v2 tasks through a configured runtime runner without using the legacy launcher', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-tracker-v2-direct-runner-'));
    tempDirs.push(root);
    const importer = new MemoryTaskImporter([
      { ...task('task-1', 'TIK-1'), labels: ['ready', 'review'], repository: { name: 'tik', path: path.join(root, 'repo') } },
    ]);
    const launcher = new RecordingLauncher();
    const agentRunStore = new FileAgentRunStore(root);
    const runtimeRunner = new RecordingRuntimeRunner('claude-code');
    const daemon = new TrackerDaemon({
      importer,
      stateStore: new MemoryStateStore(),
      launcher,
      workspaceRoot: root,
      defaultProjectPath: path.join(root, 'repo'),
      now: () => 1_000,
      agentRunStore,
      runtimeRunners: { 'claude-code': runtimeRunner },
      workflow: workflowV2({
        root,
        runner: 'claude-code',
        mode: 'claude_print',
        renderPrompt: (trackedTask, attempt) => `Review ${trackedTask.shortIdentifier} attempt ${attempt}.`,
      }),
    });

    const result = await daemon.tick();
    const runs = await agentRunStore.listRuns();
    const events = await agentRunStore.readEvents('tik-1-attempt-0-1000');

    expect(result.dispatched).toEqual(['TIK-1']);
    expect(launcher.launched).toHaveLength(0);
    expect(runtimeRunner.preparedInputs[0]).toMatchObject({
      runId: 'tik-1-attempt-0-1000',
      attempt: 0,
      renderedPrompt: 'Review TIK-1 attempt 0.',
      workspaceRoot: root,
      projectPath: path.join(root, 'repo'),
      labels: ['ready', 'review'],
      artifactOutputDir: path.join(root, '.tik', 'artifacts', 'TIK-1', 'attempt-0'),
    });
    expect(runtimeRunner.startedInputs[0]).toMatchObject({
      runId: 'tik-1-attempt-0-1000',
      runner: 'claude-code',
      mode: 'claude_print',
      prompt: 'Review TIK-1 attempt 0.',
    });
    expect(runs[0]).toMatchObject({
      id: 'tik-1-attempt-0-1000',
      runner: 'claude-code',
      runnerMode: 'claude_print',
      status: 'running',
    });
    expect(events.map((event) => event.kind)).toEqual(['run.start']);
  });

  it('marks direct workflow v2 runtime runs on the workbench so repeat ticks do not redispatch them', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-tracker-v2-direct-workbench-'));
    tempDirs.push(root);
    const sourceProjectPath = path.join(root, 'repo');
    const workbench = new MemoryWorkbenchPort([{ id: 'task-1', status: 'todo' }]);
    const importer = new MemoryTaskImporter([
      {
        ...task('task-1', 'TIK-1'),
        sourceKind: 'workbench',
        labels: ['ready', 'runner:claude'],
        repository: {
          name: 'tik',
          executionPath: path.join(root, '.tik', 'worktrees', 'tik-1'),
          path: path.join(root, '.tik', 'worktrees', 'tik-1'),
          sourcePath: sourceProjectPath,
        },
      },
    ]);
    const launcher = new RecordingLauncher(workbench);
    const runtimeRunner = new RecordingRuntimeRunner('claude-code');
    const daemon = new TrackerDaemon({
      importer,
      stateStore: new MemoryStateStore(),
      launcher,
      workspaceRoot: root,
      defaultProjectPath: sourceProjectPath,
      now: () => 1_000,
      runtimeRunners: { 'claude-code': runtimeRunner },
      workflow: workflowV2({ root, runner: 'claude-code', mode: 'claude_print' }),
    });

    const first = await daemon.tick();
    importer.tasks = [{
      ...importer.tasks[0]!,
      state: 'in_progress',
      activeKernelTaskId: 'tik-1-attempt-0-1000',
      activeAttemptStartedAt: '2026-01-01T00:00:00.000Z',
    }];
    const second = await daemon.tick();
    const taskRecord = await workbench.readTask('task-1');

    expect(first.dispatched).toEqual(['TIK-1']);
    expect(second.dispatched).toEqual([]);
    expect(second.skipped).toContainEqual({ shortIdentifier: 'TIK-1', reason: 'already-running' });
    expect(runtimeRunner.startedInputs).toHaveLength(1);
    expect(runtimeRunner.preparedInputs[0]?.projectPath).toBe(path.join(root, '.tik', 'worktrees', 'tik-1'));
    expect(taskRecord?.status).toBe('in_progress');
    expect(taskRecord?.attempts).toEqual([
      expect.objectContaining({
        attemptNumber: 1,
        kernelTaskId: 'tik-1-attempt-0-1000',
      }),
    ]);
    expect(taskRecord?.runs).toEqual([
      expect.objectContaining({
        runId: 'tik-1-attempt-0-1000',
        status: 'running',
        kernelTaskId: 'tik-1-attempt-0-1000',
        agentName: 'claude-code',
      }),
    ]);
  });

  it('records direct workflow v2 runtime completion on AgentRunStore and Workbench', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-tracker-v2-direct-complete-'));
    tempDirs.push(root);
    let completeRun: (completion: AgentRunCompletion) => void = () => undefined;
    const workbench = new MemoryWorkbenchPort([{ id: 'task-1', status: 'todo' }]);
    const importer = new MemoryTaskImporter([
      { ...task('task-1', 'TIK-1'), sourceKind: 'workbench', labels: ['ready'], repository: { name: 'tik', path: path.join(root, 'repo') } },
    ]);
    const launcher = new RecordingLauncher(workbench);
    const agentRunStore = new FileAgentRunStore(root);
    const runtimeRunner = new RecordingRuntimeRunner('codex');
    runtimeRunner.completion = new Promise((resolve) => {
      completeRun = resolve;
    });
    const daemon = new TrackerDaemon({
      importer,
      stateStore: new MemoryStateStore(),
      launcher,
      workspaceRoot: root,
      defaultProjectPath: path.join(root, 'repo'),
      now: () => 1_000,
      agentRunStore,
      runtimeRunners: { codex: runtimeRunner },
      workflow: workflowV2({ root, runner: 'codex', mode: 'codex_app_server' }),
    });

    await daemon.tick();
    completeRun({ status: 'completed', artifactIds: ['artifact-1'] });

    await waitFor(async () => {
      const run = await agentRunStore.readRun('tik-1-attempt-0-1000');
      return run.status === 'completed_by_agent';
    });
    const run = await agentRunStore.readRun('tik-1-attempt-0-1000');
    const events = await agentRunStore.readEvents('tik-1-attempt-0-1000');
    const taskRecord = await workbench.readTask('task-1');

    expect(run).toMatchObject({
      status: 'completed_by_agent',
      artifactIds: ['artifact-1'],
    });
    expect(events.map((event) => event.kind)).toEqual(['run.start', 'run.complete']);
    expect(taskRecord?.status).toBe('in_review');
    expect(taskRecord?.attempts?.[0]).toMatchObject({
      attemptNumber: 1,
      outcome: 'completed',
      kernelTaskId: 'tik-1-attempt-0-1000',
    });
    expect(taskRecord?.runs?.[0]).toMatchObject({
      runId: 'tik-1-attempt-0-1000',
      status: 'completed',
    });
  });

  it('records workflow v2 runtime runner start failures and schedules retry', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-tracker-v2-direct-runner-fail-'));
    tempDirs.push(root);
    const importer = new MemoryTaskImporter([
      { ...task('task-1', 'TIK-1'), labels: ['ready'] },
    ]);
    const launcher = new RecordingLauncher();
    const agentRunStore = new FileAgentRunStore(root);
    const runtimeRunner = new RecordingRuntimeRunner('claude-code');
    runtimeRunner.startError = new Error('claude unavailable');
    const stateStore = new MemoryStateStore();
    const daemon = new TrackerDaemon({
      importer,
      stateStore,
      launcher,
      workspaceRoot: root,
      defaultProjectPath: '/repo/default',
      now: () => 1_000,
      retry: {
        initialDelayMs: 100,
        maxDelayMs: 1_000,
        maxAttempts: 3,
      },
      agentRunStore,
      runtimeRunners: { 'claude-code': runtimeRunner },
      workflow: workflowV2({ root, runner: 'claude-code', mode: 'claude_print' }),
    });

    const result = await daemon.tick();
    const run = await agentRunStore.readRun('tik-1-attempt-0-1000');
    const events = await agentRunStore.readEvents('tik-1-attempt-0-1000');

    expect(result.dispatched).toEqual([]);
    expect(result.failed).toEqual([{ shortIdentifier: 'TIK-1', error: 'claude unavailable' }]);
    expect(launcher.launched).toHaveLength(0);
    expect(stateStore.state.retries['task-1']).toMatchObject({
      taskId: 'task-1',
      shortIdentifier: 'TIK-1',
      attempt: 1,
      dueAtMs: 1_100,
      lastError: 'claude unavailable',
    });
    expect(run).toMatchObject({
      id: 'tik-1-attempt-0-1000',
      status: 'failed',
      failure: {
        kind: 'runtime_error',
        message: 'claude unavailable',
        retryable: true,
      },
    });
    expect(events.map((event) => event.kind)).toEqual(['run.start', 'run.fail']);
  });

  it('does not redispatch workflow v2 runtime completion failures without an explicit task update', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-tracker-v2-runtime-fail-'));
    tempDirs.push(root);
    const failedTask = { ...task('task-1', 'TIK-1'), labels: ['ready'] };
    const importer = new MemoryTaskImporter([failedTask]);
    const workbench = new MemoryWorkbenchPort([{ id: 'task-1' }]);
    const launcher = new RecordingLauncher(workbench);
    const runtimeRunner = new RecordingRuntimeRunner('codex');
    runtimeRunner.completion = Promise.resolve({
      status: 'failed',
      error: 'Codex App Server request timed out: initialize',
    });
    const daemon = new TrackerDaemon({
      importer,
      stateStore: new MemoryStateStore(),
      launcher,
      workspaceRoot: root,
      defaultProjectPath: '/repo/default',
      now: () => 1_000,
      runtimeRunners: { codex: runtimeRunner },
      workflow: workflowV2({ root, runner: 'codex', mode: 'codex_app_server' }),
    });

    const first = await daemon.tick();
    await waitFor(async () => launcher.runtimeFinishes.length === 1);
    failedTask.state = 'Blocked';
    failedTask.stateKind = 'blocked';
    failedTask.activeKernelTaskId = null;

    const second = await daemon.tick();

    expect(first.dispatched).toEqual(['TIK-1']);
    expect(launcher.runtimeFinishes[0]).toMatchObject({
      taskId: 'task-1',
      completion: {
        status: 'failed',
        error: 'Codex App Server request timed out: initialize',
      },
    });
    expect(second.dispatched).toEqual([]);
    expect(second.skipped).toEqual([{ shortIdentifier: 'TIK-1', reason: 'blocked' }]);
    expect(runtimeRunner.startedInputs).toHaveLength(1);
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
        version: 2,
        workflowConfigHash: 'config-hash',
        workflowPromptHash: 'prompt-hash',
        config: {
          tracker: { kind: 'json', activeStates: ['Todo'], terminalStates: ['Done'] },
          polling: { intervalMs: workflowPollMs, maxConcurrentAgents: 3 },
          workspace: {
            root: '.tik/workspaces',
            cleanupTerminal: false,
            hooks: { afterCreate: [], beforeRun: [], afterRun: [], beforeRemove: [] },
          },
          agent: { timeoutMs: 1000 },
          routing: { defaultRunner: 'codex', defaultMode: 'codex_app_server', rules: [] },
        },
        promptTemplate: 'Implement {{ task.shortIdentifier }}',
        renderPrompt(taskInput) {
          return `Implement ${taskInput.shortIdentifier}`;
        },
        resolveRouting() {
          return { runner: 'codex', mode: 'codex_app_server', matchedSource: 'default' };
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

async function waitFor(predicate: () => Promise<boolean> | boolean, timeoutMs = 100): Promise<void> {
  const startedAt = Date.now();
  while (!(await predicate())) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error('Timed out waiting for predicate.');
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
