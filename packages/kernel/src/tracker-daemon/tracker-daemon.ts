import * as path from 'node:path';
import type {
  AgentRunStorePort,
  AgentRuntimeName,
  TrackerDaemonRetryConfig,
  TrackerDaemonState,
  TrackerDaemonStateStore,
  TrackerDaemonTickResult,
  TrackerDaemonWatchHandle,
  TrackerDaemonWorkLauncher,
  TrackerWorkflowRoutingResolution,
  TrackerRunRecord,
  TrackerWorkflowDefinition,
  TrackedTask,
  TrackedTaskImporter,
} from './types.js';
import { emptyState } from './file-state-store.js';
import type { AgentRuntimeRunner } from '../agent-runners/agent-runtime-runner.js';
import type { AgentRunCompletion } from '../agent-runners/agent-runtime-runner.js';
import type { RunProofService } from '../agent-runners/run-proof-service.js';
import { buildTikGeneratedReviewContext } from './review-context.js';

export interface TrackerDaemonOptions {
  importer: TrackedTaskImporter;
  stateStore: TrackerDaemonStateStore;
  launcher: TrackerDaemonWorkLauncher;
  workspaceRoot: string;
  defaultProjectPath: string;
  now?: () => number;
  retry?: Partial<TrackerDaemonRetryConfig>;
  agentRunStore?: AgentRunStorePort;
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
  runtimeRunners?: Partial<Record<AgentRuntimeName, AgentRuntimeRunner>>;
  runProofService?: RunProofService;
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
    const claimedWorkflowLocks = existingWorkflowLocks(workflow, allTasks, stoppedTaskIds, this.options.defaultProjectPath);

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
      const selectorReason = workflowSelectorSkipReason(workflow, task);
      if (selectorReason) {
        result.skipped.push({ shortIdentifier: task.shortIdentifier, reason: selectorReason });
        continue;
      }
      if (workflow?.version === 2) {
        try {
          workflow.resolveRouting?.(task);
        } catch (err) {
          const error = err instanceof Error ? err.message : String(err);
          result.failed.push({ shortIdentifier: task.shortIdentifier, error });
          continue;
        }
      }
      const lockKey = workflowLockKey(workflow, task, this.options.defaultProjectPath);
      if (lockKey && claimedWorkflowLocks.has(lockKey)) {
        result.skipped.push({ shortIdentifier: task.shortIdentifier, reason: 'repository-branch-lock' });
        continue;
      }
      if (runningCount >= this.maxConcurrentAgents(workflow)) {
        result.skipped.push({ shortIdentifier: task.shortIdentifier, reason: 'concurrency-limit' });
        continue;
      }
      if (lockKey) claimedWorkflowLocks.add(lockKey);
      dispatchCandidates.push(task);
      runningCount += 1;
    }

    const dispatchOutcomes = await Promise.all(dispatchCandidates.map(async (task): Promise<{
      dispatched?: string;
      failed?: { shortIdentifier: string; error: string };
    }> => {
      let runId: string | undefined;
      let attempt = state.retries[task.id]?.attempt || 0;
      try {
        const projectPath = task.repository?.executionPath || task.repository?.path || this.options.defaultProjectPath;
        await this.runHooks('afterCreate', task, projectPath, undefined, workflow);
        await this.runHooks('beforeRun', task, projectPath, undefined, workflow);
        const routing = workflow?.version === 2 ? workflow.resolveRouting?.(task) : undefined;
        runId = workflow?.version === 2 ? buildAgentRunId(task, attempt, this.now()) : undefined;
        const prompt = await this.renderWorkflowPrompt(task, {
          attempt,
          workflow,
          routing,
          projectPath,
        });
        if (workflow?.version === 2 && runId && routing) {
          await this.createAgentRun(task, {
            runId,
            attempt,
            projectPath,
            workflow,
            routing,
          });
        }
        if (workflow?.version === 2 && runId && routing && this.options.runtimeRunners?.[routing.runner]) {
          await this.launchRuntimeRunner(task, {
            runId,
            attempt,
            projectPath,
            prompt,
            workflow,
            routing,
          });
        } else {
          const launched = await this.options.launcher.launchTask?.(task, {
            workspaceRoot: this.options.workspaceRoot,
            projectPath,
            prompt,
            attempt,
            runId,
            workflowConfigHash: workflow?.workflowConfigHash,
            workflowPromptHash: workflow?.workflowPromptHash,
            routing,
          });
          if (!launched) throw new Error('Tracker daemon launcher does not implement launchTask.');
        }
        await this.runHooks('afterRun', task, projectPath, undefined, workflow);
        delete state.retries[task.id];
        return { dispatched: task.shortIdentifier };
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        await this.options.launcher.markAttemptFailed?.(task.id, error);
        if (workflow?.version === 2) {
          await this.appendAgentRunFailure(task, runId || buildAgentRunId(task, attempt, this.now()), error);
        }
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
      if (await this.isRuntimeRunActive(task.activeKernelTaskId)) continue;
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

  private async createAgentRun(
    task: TrackedTask,
    input: {
      runId: string;
      attempt: number;
      projectPath: string;
      workflow: TrackerWorkflowDefinition;
      routing: TrackerWorkflowRoutingResolution;
    },
  ): Promise<void> {
    const store = this.options.agentRunStore;
    if (!store) return;
    await store.createRun({
      id: input.runId,
      taskId: task.id,
      shortIdentifier: task.shortIdentifier,
      attempt: input.attempt,
      runner: input.routing.runner,
      runnerMode: input.routing.mode,
      workflowPath: input.workflow.path || '',
      workflowConfigHash: input.workflow.workflowConfigHash || '',
      workflowPromptHash: input.workflow.workflowPromptHash || '',
      status: 'queued',
      workspaceRoot: this.options.workspaceRoot,
      projectPath: input.projectPath,
      transcriptRefs: [],
      eventRefs: [],
      artifactIds: [],
    });
    await store.appendEvent({
      runId: input.runId,
      ts: new Date(this.now()).toISOString(),
      source: 'tik',
      kind: 'run.start',
      payload: {
        taskId: task.id,
        shortIdentifier: task.shortIdentifier,
        runner: input.routing.runner,
        mode: input.routing.mode,
        matchedSource: input.routing.matchedSource,
      },
    });
  }

  private async renderWorkflowPrompt(
    task: TrackedTask,
    input: {
      attempt: number;
      projectPath: string;
      workflow?: TrackerWorkflowDefinition;
      routing?: TrackerWorkflowRoutingResolution;
    },
  ): Promise<string | undefined> {
    if (!input.workflow) return undefined;
    if (isCodexFixRouting(input.routing, task)) {
      return buildTikGeneratedCodexFixPrompt(task);
    }
    const previousReview = previousReviewReason(task);
    const basePrompt = withPreviousReviewContext(
      input.workflow.renderPrompt(task, { attempt: input.attempt, previousReview }),
      previousReview,
    );
    if (!isClaudeReviewRouting(input.routing, task)) {
      return basePrompt;
    }
    const reviewContext = await buildTikGeneratedReviewContext(input.projectPath).catch((error) => [
      '## Tik-generated review context',
      '',
      `Tik failed to generate review context: ${error instanceof Error ? error.message : String(error)}`,
    ].join('\n'));
    return [
      basePrompt.trimEnd(),
      '',
      reviewContext,
    ].join('\n');
  }

  private async launchRuntimeRunner(
    task: TrackedTask,
    input: {
      runId: string;
      attempt: number;
      projectPath: string;
      prompt?: string;
      workflow: TrackerWorkflowDefinition;
      routing: TrackerWorkflowRoutingResolution;
    },
  ): Promise<void> {
    const runner = this.options.runtimeRunners?.[input.routing.runner];
    if (!runner) throw new Error(`No runtime runner configured for ${input.routing.runner}.`);
    const prepared = await runner.prepare({
      runId: input.runId,
      task,
      attempt: input.attempt,
      runnerMode: input.routing.mode,
      workflowPath: input.workflow.path || '',
      workflowConfigHash: input.workflow.workflowConfigHash || '',
      workflowPromptHash: input.workflow.workflowPromptHash || '',
      renderedPrompt: input.prompt || '',
      workspaceRoot: this.options.workspaceRoot,
      projectPath: input.projectPath,
      labels: task.labels,
      artifactOutputDir: path.join(
        this.options.workspaceRoot,
        '.tik',
        'artifacts',
        task.shortIdentifier,
        `attempt-${input.attempt}`,
      ),
      timeoutMs: input.workflow.config.agent.timeoutMs,
    });
    const startedAt = new Date(this.now()).toISOString();
    const started = await this.options.launcher.markRuntimeRunStarted?.(task, {
      runId: input.runId,
      attempt: input.attempt,
      projectPath: input.projectPath,
      runner: input.routing.runner,
      mode: input.routing.mode,
      startedAt,
    });
    const attemptNumber = started?.attemptNumber || input.attempt + 1;
    const preparedWithEnv = {
      ...prepared,
      env: buildRuntimeEnv(input.workflow.config.sandbox?.envWhitelist || [], {
        runId: input.runId,
        task,
        runner: input.routing.runner,
        mode: input.routing.mode,
        workspaceRoot: this.options.workspaceRoot,
        projectPath: input.projectPath,
      }),
    };
    try {
      const handle = await runner.start(preparedWithEnv);
      if (handle.completion) {
        this.trackRuntimeCompletion(task, {
          runId: input.runId,
          attemptNumber,
          runner: input.routing.runner,
          workflow: input.workflow,
          projectPath: input.projectPath,
          completion: handle.completion,
        });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.options.launcher.markRuntimeRunFinished?.(task.id, {
        runId: input.runId,
        attemptNumber,
        runner: input.routing.runner,
        completion: { status: 'failed', error: message },
        endedAt: new Date(this.now()).toISOString(),
      });
      throw err;
    }
  }

  private trackRuntimeCompletion(
    task: TrackedTask,
    input: {
      runId: string;
      attemptNumber: number;
      runner: AgentRuntimeName;
      workflow: TrackerWorkflowDefinition;
      projectPath: string;
      completion: Promise<AgentRunCompletion>;
    },
  ): void {
    void input.completion.then(
      (completion) => this.recordRuntimeCompletion(task, {
        runId: input.runId,
        attemptNumber: input.attemptNumber,
        runner: input.runner,
        workflow: input.workflow,
        projectPath: input.projectPath,
        completion,
      }),
      (err) => this.recordRuntimeCompletion(task, {
        runId: input.runId,
        attemptNumber: input.attemptNumber,
        runner: input.runner,
        workflow: input.workflow,
        projectPath: input.projectPath,
        completion: {
          status: 'failed',
          error: err instanceof Error ? err.message : String(err),
        },
      }),
    );
  }

  private async recordRuntimeCompletion(
    task: TrackedTask,
    input: {
      runId: string;
      attemptNumber: number;
      runner: AgentRuntimeName;
      workflow?: TrackerWorkflowDefinition;
      projectPath?: string;
      completion: AgentRunCompletion;
    },
  ): Promise<void> {
    const endedAt = new Date(this.now()).toISOString();
    if (input.completion.status === 'completed') {
      await this.appendAgentRunComplete(task, input.runId, input.completion, endedAt);
    } else if (input.completion.status === 'cancelled') {
      await this.appendAgentRunCancel(input.runId, endedAt);
    } else {
      await this.appendAgentRunFailure(task, input.runId, input.completion.error || 'Runtime runner failed.', false, endedAt);
    }
    await this.createRunProof(task, input);
    await this.options.launcher.markRuntimeRunFinished?.(task.id, {
      runId: input.runId,
      attemptNumber: input.attemptNumber,
      runner: input.runner,
      completion: input.completion,
      endedAt,
    });
  }

  private async createRunProof(
    task: TrackedTask,
    input: {
      runId: string;
      runner: AgentRuntimeName;
      workflow?: TrackerWorkflowDefinition;
      projectPath?: string;
      completion: AgentRunCompletion;
    },
  ): Promise<void> {
    const proofService = this.options.runProofService;
    const runner = this.options.runtimeRunners?.[input.runner];
    const store = this.options.agentRunStore;
    if (!proofService || !runner || !store?.readRun) return;
    try {
      const run = await store.readRun(input.runId);
      await proofService.createProof({
        task: {
          id: task.id,
          shortIdentifier: task.shortIdentifier,
          title: task.title,
          goal: task.description || task.title,
        },
        run,
        runner,
        completion: input.completion,
        validationCommands: input.workflow?.config.validation?.commands,
        validationCwd: input.projectPath || run.projectPath,
        now: new Date(this.now()).toISOString(),
      });
    } catch {
      // Proof collection is best-effort relative to daemon completion bookkeeping.
    }
  }

  private async isRuntimeRunActive(runId: string): Promise<boolean> {
    const runners = Object.values(this.options.runtimeRunners || {});
    for (const runner of runners) {
      const status = await runner?.getStatus(runId).catch(() => 'unknown');
      if (status === 'running' || status === 'queued') return true;
    }
    return false;
  }

  private async appendAgentRunComplete(
    task: TrackedTask,
    runId: string,
    completion: AgentRunCompletion,
    ts = new Date(this.now()).toISOString(),
  ): Promise<void> {
    const store = this.options.agentRunStore;
    if (!store) return;
    try {
      await store.appendEvent({
        runId,
        ts,
        source: 'tik',
        kind: 'run.complete',
        payload: {
          taskId: task.id,
          artifactIds: completion.artifactIds || [],
        },
      });
    } catch {
      // Runtime completion should not crash the daemon if metadata was pruned.
    }
  }

  private async appendAgentRunCancel(
    runId: string,
    ts = new Date(this.now()).toISOString(),
  ): Promise<void> {
    const store = this.options.agentRunStore;
    if (!store) return;
    try {
      await store.appendEvent({
        runId,
        ts,
        source: 'tik',
        kind: 'run.cancel',
        payload: {},
      });
    } catch {
      // Runtime completion should not crash the daemon if metadata was pruned.
    }
  }

  private async appendAgentRunFailure(
    task: TrackedTask,
    runId: string,
    message: string,
    retryable = true,
    ts = new Date(this.now()).toISOString(),
  ): Promise<void> {
    const store = this.options.agentRunStore;
    if (!store) return;
    try {
      await store.appendEvent({
        runId,
        ts,
        source: 'tik',
        kind: 'run.fail',
        payload: {
          taskId: task.id,
          message,
          kind: 'runtime_error',
          retryable,
        },
      });
    } catch {
      // Missing run metadata should not mask the original dispatch failure.
    }
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
        workflowVersion: workflow?.version,
        envWhitelist: workflow?.config.sandbox?.envWhitelist,
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

function workflowSelectorSkipReason(workflow: TrackerWorkflowDefinition | undefined, task: TrackedTask): string | undefined {
  if (workflow?.version !== 2) return undefined;
  const selector = workflow.config.selector;
  if (!selector) return undefined;
  const labels = new Set(task.labels.map(normalizeLabel));
  for (const required of selector.includeLabels) {
    if (!labels.has(normalizeLabel(required))) {
      return `skipped, missing label ${required}`;
    }
  }
  for (const excluded of selector.excludeLabels) {
    if (labels.has(normalizeLabel(excluded))) {
      return `skipped, excluded label ${excluded}`;
    }
  }
  return undefined;
}

function existingWorkflowLocks(
  workflow: TrackerWorkflowDefinition | undefined,
  tasks: TrackedTask[],
  stoppedTaskIds: Set<string>,
  defaultProjectPath: string,
): Set<string> {
  const locks = new Set<string>();
  for (const task of tasks) {
    if (stoppedTaskIds.has(task.id)) continue;
    if (!isAlreadyRunningTask(task) && !task.activeKernelTaskId) continue;
    const lock = workflowLockKey(workflow, task, defaultProjectPath);
    if (lock) locks.add(lock);
  }
  return locks;
}

function workflowLockKey(
  workflow: TrackerWorkflowDefinition | undefined,
  task: TrackedTask,
  defaultProjectPath: string,
): string | undefined {
  if (workflow?.version !== 2) return undefined;
  if (workflow.config.concurrency?.lock !== 'repository_branch') return undefined;
  const repository = task.repository?.sourcePath || task.repository?.path || task.repository?.name || defaultProjectPath;
  const branch = workflowBranchForTask(task);
  return `${repository}#${branch}`;
}

function buildRuntimeEnv(
  whitelist: string[],
  input: {
    runId: string;
    task: TrackedTask;
    runner: AgentRuntimeName;
    mode: string;
    workspaceRoot: string;
    projectPath: string;
  },
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of BASE_RUNTIME_ENV_KEYS) {
    const value = process.env[name];
    if (typeof value === 'string') env[name] = value;
  }
  for (const name of whitelist) {
    const value = process.env[name];
    if (typeof value === 'string') env[name] = value;
  }
  return {
    ...env,
    TIK_RUN_ID: input.runId,
    TIK_TASK_ID: input.task.id,
    TIK_TASK_IDENTIFIER: input.task.shortIdentifier,
    TIK_RUNNER: input.runner,
    TIK_RUNNER_MODE: input.mode,
    TIK_WORKSPACE_ROOT: input.workspaceRoot,
    TIK_PROJECT_PATH: input.projectPath,
  };
}

const BASE_RUNTIME_ENV_KEYS = [
  'PATH',
  'HOME',
  'SHELL',
  'TMPDIR',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
];

function workflowBranchForTask(task: TrackedTask): string {
  const branchLabel = task.labels.find((label) => normalizeLabel(label).startsWith('branch:'));
  return branchLabel ? branchLabel.slice('branch:'.length).trim() || 'default' : 'default';
}

function buildAgentRunId(task: TrackedTask, attempt: number, nowMs: number): string {
  return `${task.shortIdentifier.toLowerCase()}-attempt-${attempt}-${nowMs}`;
}

function normalizeLabel(label: string): string {
  return label.trim().toLowerCase();
}

function isClaudeReviewRouting(
  routing: TrackerWorkflowRoutingResolution | undefined,
  task: TrackedTask,
): boolean {
  if (routing?.runner !== 'claude-code') return false;
  const labels = new Set(task.labels.map(normalizeLabel));
  return labels.has('needs-claude-review') || labels.has('claude-review');
}

function isCodexFixRouting(
  routing: TrackerWorkflowRoutingResolution | undefined,
  task: TrackedTask,
): boolean {
  if (routing?.runner !== 'codex') return false;
  const labels = new Set(task.labels.map(normalizeLabel));
  const phase = task.agentLoop?.phase;
  return labels.has('needs-codex-fix')
    || labels.has('codex-fix')
    || phase === 'needs_codex_fix'
    || phase === 'codex_fixing'
    || task.agentLoop?.kind === 'codex_fix';
}

function previousReviewReason(task: TrackedTask): string | undefined {
  const comments = [...(task.comments || [])].sort((left, right) => (
    right.createdAt.localeCompare(left.createdAt)
  ));
  for (const comment of comments) {
    if (!/run review rejected/i.test(comment.body)) continue;
    const reason = comment.body.match(/(?:^|\n)Reason:\s*([\s\S]+)/i)?.[1]?.trim();
    if (reason) return reason;
    const trimmed = comment.body.trim();
    if (trimmed) return trimmed;
  }
  const summaryReason = task.latestSummary?.match(/changes requested[^:]*:\s*([\s\S]+)/i)?.[1]?.trim();
  return summaryReason || undefined;
}

function withPreviousReviewContext(prompt: string, previousReview: string | undefined): string {
  if (!previousReview) return prompt;
  if (prompt.includes(previousReview)) return prompt;
  return [
    prompt.trimEnd(),
    '',
    'Previous review rejection reason:',
    previousReview,
  ].join('\n');
}

function buildTikGeneratedCodexFixPrompt(task: TrackedTask): string {
  const metadata = task.agentLoop;
  const blockingIssues = metadata?.blockingIssues?.length
    ? metadata.blockingIssues
    : metadata?.reviewResult?.blockingIssues || [];
  const reviewMarkdown = metadata?.reviewResult?.markdown?.trim();
  const agentComments = (task.comments || [])
    .filter((comment) => comment.authorKind === 'agent')
    .slice(-3);
  const humanComments = (task.comments || [])
    .filter((comment) => comment.authorKind === 'human')
    .slice(-3);

  return [
    'You are running a Tik agent-loop Codex fix task.',
    '',
    `Task: ${task.shortIdentifier} - ${task.title}`,
    `Labels: ${task.labels.join(', ') || '(none)'}`,
    metadata ? [
      `Agent loop phase: ${metadata.phase || metadata.kind}`,
      `Round: ${metadata.round}/${metadata.maxRounds}`,
      metadata.nextReviewRound ? `Next review round: ${metadata.nextReviewRound}` : undefined,
      `Change request: ${metadata.changeRequest.scm}:${metadata.changeRequest.repo}#${metadata.changeRequest.id}`,
      `Base ref: ${metadata.changeRequest.baseRef}`,
      `Head ref: ${metadata.changeRequest.headRef}`,
      `Head sha: ${metadata.headSha || metadata.changeRequest.headSha}`,
    ].filter(Boolean).join('\n') : undefined,
    '',
    'Objective:',
    '- Edit the repository to address the blocking review findings below.',
    '- Keep the fix scoped to the listed findings and the current task.',
    '- Add or update focused tests when the finding calls for it.',
    '- Do not perform another review, approve, merge, or mark the loop complete.',
    '- When finished, leave the worktree ready for the next Claude review round.',
    '',
    '## Tik-generated Codex fix context',
    '',
    '### Blocking issues',
    blockingIssues.length
      ? blockingIssues.map((issue, index) => [
          `${index + 1}. ${issue.title}`,
          `   File: ${issue.file}${issue.line ? `:${issue.line}` : ''}`,
          `   Reason: ${issue.reason}`,
          issue.suggestedFix ? `   Suggested fix: ${issue.suggestedFix}` : undefined,
        ].filter(Boolean).join('\n')).join('\n')
      : '(No structured blocking issues were captured. Use the Claude review comments below as the source of truth.)',
    reviewMarkdown ? [
      '',
      '### Claude review markdown',
      reviewMarkdown,
    ].join('\n') : undefined,
    agentComments.length ? [
      '',
      '### Recent agent review comments',
      ...agentComments.map((comment) => [
        `#### ${comment.authorId || 'agent'} at ${comment.createdAt}`,
        truncatePromptSection(comment.body, 4_000),
      ].join('\n')),
    ].join('\n\n') : undefined,
    humanComments.length ? [
      '',
      '### Recent human comments',
      ...humanComments.map((comment) => [
        `#### ${comment.authorId || 'human'} at ${comment.createdAt}`,
        truncatePromptSection(comment.body, 1_000),
      ].join('\n')),
    ].join('\n\n') : undefined,
    task.latestSummary ? [
      '',
      '### Latest task summary',
      task.latestSummary,
    ].join('\n') : undefined,
    task.description ? [
      '',
      '### Original task description',
      truncatePromptSection(task.description, 2_000),
    ].join('\n') : undefined,
  ].filter((part): part is string => Boolean(part)).join('\n');
}

function truncatePromptSection(value: string, maxChars: number): string {
  return value.length <= maxChars ? value : `${value.slice(0, maxChars - 1)}…`;
}
