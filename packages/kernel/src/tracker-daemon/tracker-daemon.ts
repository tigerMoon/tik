import type {
  TrackerDaemonRetryConfig,
  TrackerDaemonState,
  TrackerDaemonStateStore,
  TrackerDaemonTickResult,
  TrackerDaemonWatchHandle,
  TrackerDaemonWorkLauncher,
  TrackerRunRecord,
  TrackerWorkflowDefinition,
  TrackedTask,
  TrackedTaskImporter,
} from './types.js';
import { emptyState } from './file-state-store.js';

export interface TrackerDaemonOptions {
  importer: TrackedTaskImporter;
  stateStore: TrackerDaemonStateStore;
  launcher: TrackerDaemonWorkLauncher;
  workspaceRoot: string;
  defaultProjectPath: string;
  now?: () => number;
  retry?: Partial<TrackerDaemonRetryConfig>;
  maxConcurrentAgents?: number;
  pollIntervalMs?: number;
  workflow?: TrackerWorkflowDefinition;
  workflowProvider?: () => Promise<TrackerWorkflowDefinition | undefined>;
  terminalStates?: string[];
  cleanupTerminalWorkspaces?: boolean;
  workspaceHooks?: {
    afterCreate?: string[];
    beforeRun?: string[];
    afterRun?: string[];
    beforeRemove?: string[];
  };
}

const DEFAULT_RETRY: TrackerDaemonRetryConfig = {
  initialDelayMs: 30_000,
  maxDelayMs: 15 * 60_000,
  maxAttempts: 5,
};

export class TrackerDaemon {
  private readonly retry: TrackerDaemonRetryConfig;
  private readonly now: () => number;
  private watchTimer?: ReturnType<typeof setTimeout>;
  private tickInFlight = false;
  private watchStopped = false;
  private watchModeActive = false;

  constructor(private readonly options: TrackerDaemonOptions) {
    this.retry = { ...DEFAULT_RETRY, ...(options.retry || {}) };
    this.now = options.now || Date.now;
  }

  watch(): TrackerDaemonWatchHandle {
    const runTick = async () => {
      if (this.watchStopped || this.tickInFlight) return;
      this.tickInFlight = true;
      const workflow = await this.resolveWorkflow();
      await this.tick().finally(() => {
        this.tickInFlight = false;
      });
      if (this.watchStopped) return;
      const nextDelay = this.options.pollIntervalMs || workflow?.config.polling.intervalMs || this.options.workflow?.config.polling.intervalMs || 30_000;
      this.watchTimer = setTimeout(() => {
        void runTick();
      }, nextDelay);
    };
    this.watchStopped = false;
    this.watchModeActive = true;
    void this.persistWatching(true);
    void runTick();
    return {
      stop: () => {
        this.watchStopped = true;
        this.watchModeActive = false;
        if (this.watchTimer) clearTimeout(this.watchTimer);
        this.watchTimer = undefined;
        void this.persistWatching(false);
      },
    };
  }

  async tick(): Promise<TrackerDaemonTickResult> {
    const result: TrackerDaemonTickResult = {
      dispatched: [],
      stopped: [],
      skipped: [],
      failed: [],
    };
    const stoppedTaskIds = new Set<string>();
    const workflow = await this.resolveWorkflow();

    const state = await this.options.stateStore.load().catch(() => emptyState());
    state.watching = this.watchModeActive || state.watching === true;
    let tasks: TrackedTask[];
    try {
      tasks = sortTasksForDispatch(await this.options.importer.listCandidateTasks());
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      result.failed.push({ shortIdentifier: 'tracker', error });
      await this.options.stateStore.save(state);
      return result;
    }
    this.resetUpdatedRetries(state, tasks);
    const runningTasks = await this.listRunningTasks(tasks);
    const reconciledTasks = mergeTasks(tasks, runningTasks);
    const allTasks = reconciledTasks;
    await this.cleanupTerminalTasks(allTasks, result, stoppedTaskIds, workflow);
    await this.cleanupStaleOpenAttempts(allTasks, result, stoppedTaskIds);
    const tasksById = new Map(allTasks.map((task) => [task.id, task]));

    await this.stopIneligibleRuns(tasksById, result, stoppedTaskIds, workflow);

    const dispatchCandidates: TrackedTask[] = [];
    let runningCount = this.runningCount(allTasks, stoppedTaskIds);

    for (const task of tasks) {
      if (stoppedTaskIds.has(task.id)) {
        continue;
      }
      if (task.stateKind !== 'active') {
        result.skipped.push({ shortIdentifier: task.shortIdentifier, reason: task.stateKind });
        continue;
      }
      if (hasOpenBlockers(task)) {
        result.skipped.push({ shortIdentifier: task.shortIdentifier, reason: 'blocked' });
        continue;
      }
      if (isAlreadyRunningTask(task)) {
        result.skipped.push({ shortIdentifier: task.shortIdentifier, reason: 'already-running' });
        continue;
      }
      if (!this.retryIsDue(state, task, result)) {
        continue;
      }
      if (runningCount >= this.maxConcurrentAgents(workflow)) {
        result.skipped.push({ shortIdentifier: task.shortIdentifier, reason: 'concurrency-limit' });
        continue;
      }
      dispatchCandidates.push(task);
      runningCount += 1;
    }

    const dispatchOutcomes = await Promise.all(dispatchCandidates.map(async (task): Promise<{
      dispatched?: string;
      failed?: { shortIdentifier: string; error: string };
    }> => {
      try {
        const projectPath = task.repository?.path || this.options.defaultProjectPath;
        await this.runHooks('afterCreate', task, projectPath, undefined, workflow);
        await this.runHooks('beforeRun', task, projectPath, undefined, workflow);
        const attempt = state.retries[task.id]?.attempt || 0;
        const prompt = workflow?.renderPrompt(task, { attempt });
        const launched = await this.options.launcher.launchTask?.(task, {
          workspaceRoot: this.options.workspaceRoot,
          projectPath,
          prompt,
          attempt,
        });
        if (!launched) throw new Error('Tracker daemon launcher does not implement launchTask.');
        await this.runHooks('afterRun', task, projectPath, undefined, workflow);
        delete state.retries[task.id];
        return { dispatched: task.shortIdentifier };
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        await this.options.launcher.markAttemptFailed?.(task.id, error);
        state.retries[task.id] = this.nextRetry(state, task, error);
        return { failed: { shortIdentifier: task.shortIdentifier, error } };
      }
    }));
    for (const outcome of dispatchOutcomes) {
      if (outcome.dispatched) result.dispatched.push(outcome.dispatched);
      if (outcome.failed) result.failed.push(outcome.failed);
    }

    state.recent = appendRecent(state.recent, result, new Date(this.now()).toISOString());
    await this.options.stateStore.save(state);
    return result;
  }

  private async stopIneligibleRuns(
    tasksById: Map<string, TrackedTask>,
    result: TrackerDaemonTickResult,
    stoppedTaskIds: Set<string>,
    workflow?: TrackerWorkflowDefinition,
  ): Promise<void> {
    for (const task of tasksById.values()) {
      if (!task.activeKernelTaskId) continue;
      if (stoppedTaskIds.has(task.id)) continue;
      if (task.stateKind === 'active' && !hasOpenBlockers(task)) continue;
      const reason = `Task ${task.shortIdentifier} is no longer active: ${task.stateKind === 'active' ? 'blocked' : task.stateKind}`;
      const projectPath = task.repository?.path || this.options.defaultProjectPath;
      const run = {
        taskId: task.id,
        shortIdentifier: task.shortIdentifier,
        kernelTaskId: task.activeKernelTaskId,
        workspaceRoot: this.options.workspaceRoot,
        projectPath,
        startedAt: task.activeAttemptStartedAt || new Date(this.now()).toISOString(),
        status: 'running' as const,
        lastTaskState: task.state,
        lastSeenAt: new Date(this.now()).toISOString(),
      };
      await this.runHooks('beforeRemove', task, projectPath, run, workflow);
      await this.options.launcher.stopRun({ taskId: task.activeKernelTaskId, reason, task, run });
      if (this.options.cleanupTerminalWorkspaces || workflow?.config.workspace.cleanupTerminal) {
        await this.options.launcher.cleanupWorkspace?.({
          task,
          workspaceRoot: this.options.workspaceRoot,
          projectPath,
          run,
        });
      }
      stoppedTaskIds.add(task.id);
      result.stopped.push(task.shortIdentifier);
    }
  }

  private async cleanupStaleOpenAttempts(
    tasks: TrackedTask[],
    result: TrackerDaemonTickResult,
    stoppedTaskIds: Set<string>,
  ): Promise<void> {
    if (!this.options.launcher.isRunActive || !this.options.launcher.markAttemptFailed) {
      return;
    }

    for (const task of tasks) {
      if (!task.activeKernelTaskId) continue;
      if (stoppedTaskIds.has(task.id)) continue;
      if (task.stateKind !== 'active' || hasOpenBlockers(task)) continue;
      const active = await this.options.launcher.isRunActive(task.activeKernelTaskId);
      if (active) continue;
      const reason = `Kernel task ${task.activeKernelTaskId} is no longer active in this daemon runtime.`;
      await this.options.launcher.markAttemptFailed(task.id, reason);
      stoppedTaskIds.add(task.id);
      result.stopped.push(task.shortIdentifier);
    }
  }

  private async listRunningTasks(
    candidateTasks: TrackedTask[],
  ): Promise<TrackedTask[]> {
    const runningIds = candidateTasks
      .filter((task) => Boolean(task.activeKernelTaskId) || isAlreadyRunningTask(task))
      .map((task) => task.id);
    if (this.options.importer.listOpenAttemptTasks) {
      const openAttemptTasks = await this.options.importer.listOpenAttemptTasks();
      runningIds.push(...openAttemptTasks.map((task) => task.id));
    }
    const candidateIds = new Set(candidateTasks.map((task) => task.id));
    const missingIds = Array.from(new Set(runningIds)).filter((id) => !candidateIds.has(id));
    if (missingIds.length === 0 || !this.options.importer.fetchTaskStatesByIds) return [];
    return this.options.importer.fetchTaskStatesByIds(missingIds);
  }

  private async cleanupTerminalTasks(
    tasks: TrackedTask[],
    result: TrackerDaemonTickResult,
    stoppedTaskIds: Set<string>,
    workflow?: TrackerWorkflowDefinition,
  ): Promise<void> {
    const terminalStates = this.options.terminalStates || workflow?.config.tracker.terminalStates || [];
    if (!this.options.importer.fetchTasksByStates || terminalStates.length === 0) return;
    const terminalTasks = await this.options.importer.fetchTasksByStates(terminalStates);
    const terminalById = new Map(terminalTasks.map((task) => [task.id, task]));
    for (const candidate of tasks) {
      if (!candidate.activeKernelTaskId) continue;
      if (stoppedTaskIds.has(candidate.id)) continue;
      const task = terminalById.get(candidate.id);
      if (!task) continue;
      const projectPath = candidate.repository?.path || this.options.defaultProjectPath;
      const run = {
        taskId: candidate.id,
        shortIdentifier: candidate.shortIdentifier,
        kernelTaskId: candidate.activeKernelTaskId,
        workspaceRoot: this.options.workspaceRoot,
        projectPath,
        startedAt: candidate.activeAttemptStartedAt || new Date(this.now()).toISOString(),
        status: 'running' as const,
        lastTaskState: candidate.state,
        lastSeenAt: new Date(this.now()).toISOString(),
      };
      await this.runHooks('beforeRemove', task, projectPath, run, workflow);
      await this.options.launcher.stopRun({
        taskId: candidate.activeKernelTaskId,
        reason: `Task ${task.shortIdentifier} is no longer active: terminal`,
        task,
        run,
      });
      if (this.options.cleanupTerminalWorkspaces || workflow?.config.workspace.cleanupTerminal) {
        await this.options.launcher.cleanupWorkspace?.({
          task,
          workspaceRoot: this.options.workspaceRoot,
          projectPath,
          run,
        });
      }
      stoppedTaskIds.add(candidate.id);
      result.stopped.push(task.shortIdentifier);
    }
  }

  private maxConcurrentAgents(workflow?: TrackerWorkflowDefinition): number {
    return this.options.maxConcurrentAgents
      || workflow?.config.polling.maxConcurrentAgents
      || Number.POSITIVE_INFINITY;
  }

  private async resolveWorkflow(): Promise<TrackerWorkflowDefinition | undefined> {
    if (!this.options.workflowProvider) return this.options.workflow;
    return this.options.workflowProvider().catch(() => this.options.workflow);
  }

  private async persistWatching(watching: boolean): Promise<void> {
    const state = await this.options.stateStore.load().catch(() => emptyState());
    state.watching = watching;
    await this.options.stateStore.save(state);
  }

  private runningCount(tasks: TrackedTask[], stoppedTaskIds: Set<string>): number {
    return tasks
      .filter((task) => !stoppedTaskIds.has(task.id))
      .filter((task) => isAlreadyRunningTask(task) || Boolean(task.activeKernelTaskId))
      .length;
  }

  private async runHooks(
    hook: 'afterCreate' | 'beforeRun' | 'afterRun' | 'beforeRemove',
    task: TrackedTask,
    projectPath: string,
    run?: TrackerRunRecord,
    workflow?: TrackerWorkflowDefinition,
  ): Promise<void> {
    const configured = this.options.workspaceHooks?.[hook]
      || workflow?.config.workspace.hooks[hook]
      || [];
    for (const name of configured) {
      await this.options.launcher.runHook?.(name, {
        task,
        workspaceRoot: this.options.workspaceRoot,
        projectPath,
        run,
      });
    }
  }

  private retryIsDue(
    state: TrackerDaemonState,
    task: TrackedTask,
    result: TrackerDaemonTickResult,
  ): boolean {
    const retry = state.retries[task.id];
    if (!retry) return true;
    if (retry.attempt >= this.retry.maxAttempts) {
      result.skipped.push({ shortIdentifier: task.shortIdentifier, reason: 'retry-exhausted' });
      return false;
    }
    if (retry.dueAtMs > this.now()) {
      result.skipped.push({ shortIdentifier: task.shortIdentifier, reason: 'retry-wait' });
      return false;
    }
    return true;
  }

  private resetUpdatedRetries(state: TrackerDaemonState, tasks: TrackedTask[]): void {
    for (const task of tasks) {
      const retry = state.retries[task.id];
      if (!retry || !task.updatedAt) continue;
      const taskUpdatedAt = Date.parse(task.updatedAt);
      const retryUpdatedAt = Date.parse(retry.updatedAt);
      if (Number.isFinite(taskUpdatedAt) && Number.isFinite(retryUpdatedAt) && taskUpdatedAt > retryUpdatedAt) {
        delete state.retries[task.id];
      }
    }
  }

  private nextRetry(
    state: TrackerDaemonState,
    task: TrackedTask,
    error: string,
  ) {
    const previous = state.retries[task.id];
    const attempt = (previous?.attempt || 0) + 1;
    const delay = Math.min(
      this.retry.maxDelayMs,
      this.retry.initialDelayMs * (2 ** Math.max(0, attempt - 1)),
    );
    return {
      taskId: task.id,
      shortIdentifier: task.shortIdentifier,
      attempt,
      dueAtMs: this.now() + delay,
      lastError: error,
      updatedAt: new Date(this.now()).toISOString(),
    };
  }
}

function hasOpenBlockers(task: TrackedTask): boolean {
  return task.blockedBy.some((blocker) => {
    const state = blocker.state?.toLowerCase();
    return state !== 'done' && state !== 'closed' && state !== 'completed' && state !== 'terminal';
  });
}

function isAlreadyRunningTask(task: TrackedTask): boolean {
  const state = task.state.toLowerCase();
  if (task.sourceKind === 'workbench') {
    return Boolean(task.activeKernelTaskId) && (state === 'in_progress' || state === 'running');
  }
  return state === 'in_progress' || state === 'running';
}

function mergeTasks(primary: TrackedTask[], secondary: TrackedTask[]): TrackedTask[] {
  const byId = new Map<string, TrackedTask>();
  for (const task of primary) byId.set(task.id, task);
  for (const task of secondary) byId.set(task.id, task);
  return Array.from(byId.values());
}

function sortTasksForDispatch(tasks: TrackedTask[]): TrackedTask[] {
  return [...tasks].sort((left, right) => {
    const priorityDelta = normalizePriority(left.priority) - normalizePriority(right.priority);
    if (priorityDelta !== 0) return priorityDelta;

    const createdDelta = normalizeCreatedAt(left.createdAt) - normalizeCreatedAt(right.createdAt);
    if (createdDelta !== 0) return createdDelta;

    return left.shortIdentifier.localeCompare(right.shortIdentifier);
  });
}

function normalizePriority(priority: number | null | undefined): number {
  return typeof priority === 'number' && Number.isFinite(priority)
    ? priority
    : Number.POSITIVE_INFINITY;
}

function normalizeCreatedAt(createdAt: string | null | undefined): number {
  if (!createdAt) return Number.POSITIVE_INFINITY;
  const parsed = Date.parse(createdAt);
  return Number.isFinite(parsed) ? parsed : Number.POSITIVE_INFINITY;
}

function appendRecent(
  previous: TrackerDaemonState['recent'],
  result: TrackerDaemonTickResult,
  createdAt: string,
): NonNullable<TrackerDaemonState['recent']> {
  const recent = [...(previous || [])];
  for (const shortIdentifier of result.dispatched) {
    recent.push({ type: 'dispatched', shortIdentifier, message: `${shortIdentifier} dispatched`, createdAt });
  }
  for (const shortIdentifier of result.stopped) {
    recent.push({ type: 'stopped', shortIdentifier, message: `${shortIdentifier} stopped`, createdAt });
  }
  for (const item of result.skipped) {
    recent.push({ type: 'skipped', shortIdentifier: item.shortIdentifier, message: `${item.shortIdentifier}:${item.reason}`, createdAt });
  }
  for (const item of result.failed) {
    recent.push({ type: 'failed', shortIdentifier: item.shortIdentifier, message: `${item.shortIdentifier}:${item.error}`, createdAt });
  }
  return recent.slice(-20);
}
