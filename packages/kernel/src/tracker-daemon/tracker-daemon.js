import * as path from 'node:path';
import { emptyState } from './file-state-store.js';
import { buildTikGeneratedReviewContext, hasTikReviewableChanges } from './review-context.js';
const DEFAULT_RETRY = {
    initialDelayMs: 30_000,
    maxDelayMs: 15 * 60_000,
    maxAttempts: 5,
};
export class TrackerDaemon {
    options;
    retry;
    now;
    watchTimer;
    tickInFlight = false;
    watchStopped = false;
    watchModeActive = false;
    constructor(options) {
        this.options = options;
        this.retry = { ...DEFAULT_RETRY, ...(options.retry || {}) };
        this.now = options.now || Date.now;
    }
    watch() {
        const runTick = async () => {
            if (this.watchStopped || this.tickInFlight)
                return;
            this.tickInFlight = true;
            const workflow = await this.resolveWorkflow();
            await this.tick().finally(() => {
                this.tickInFlight = false;
            });
            if (this.watchStopped)
                return;
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
                if (this.watchTimer)
                    clearTimeout(this.watchTimer);
                this.watchTimer = undefined;
                void this.persistWatching(false);
            },
        };
    }
    async tick() {
        const result = {
            dispatched: [],
            stopped: [],
            skipped: [],
            failed: [],
        };
        const stoppedTaskIds = new Set();
        const workflow = await this.resolveWorkflow();
        const state = await this.options.stateStore.load().catch(() => emptyState());
        state.watching = this.watchModeActive || state.watching === true;
        let tasks;
        try {
            tasks = sortTasksForDispatch(await this.options.importer.listCandidateTasks());
        }
        catch (err) {
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
        const dispatchCandidates = [];
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
            const projectPath = task.repository?.executionPath || task.repository?.path || this.options.defaultProjectPath;
            if (workflow) {
                try {
                    const routing = workflow.resolveRouting(task);
                    if (shouldRunClaudeReview(routing, task) && !hasTikReviewableChanges(projectPath, {
                        baseRef: task.agentLoop?.changeRequest.baseRef,
                        headSha: task.agentLoop?.headSha || task.agentLoop?.changeRequest.headSha,
                    })) {
                        result.skipped.push({ shortIdentifier: task.shortIdentifier, reason: 'no-reviewable-changes' });
                        continue;
                    }
                }
                catch (err) {
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
            if (lockKey)
                claimedWorkflowLocks.add(lockKey);
            dispatchCandidates.push(task);
            runningCount += 1;
        }
        const dispatchOutcomes = await Promise.all(dispatchCandidates.map(async (task) => {
            let runId;
            let attempt = state.retries[task.id]?.attempt || 0;
            try {
                const projectPath = task.repository?.executionPath || task.repository?.path || this.options.defaultProjectPath;
                await this.runHooks('afterCreate', task, projectPath, undefined, workflow);
                await this.runHooks('beforeRun', task, projectPath, undefined, workflow);
                const routing = workflow?.resolveRouting(task);
                runId = workflow ? buildAgentRunId(task, attempt, this.now()) : undefined;
                const prompt = await this.renderWorkflowPrompt(task, {
                    attempt,
                    workflow,
                    routing,
                    projectPath,
                });
                if (workflow && runId && routing) {
                    await this.createAgentRun(task, {
                        runId,
                        attempt,
                        projectPath,
                        workflow,
                        routing,
                    });
                }
                if (workflow && runId && routing && this.options.runtimeRunners?.[routing.runner]) {
                    await this.launchRuntimeRunner(task, {
                        runId,
                        attempt,
                        projectPath,
                        prompt,
                        workflow,
                        routing,
                    });
                }
                else {
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
                    if (!launched)
                        throw new Error('Tracker daemon launcher does not implement launchTask.');
                }
                await this.runHooks('afterRun', task, projectPath, undefined, workflow);
                delete state.retries[task.id];
                return { dispatched: task.shortIdentifier };
            }
            catch (err) {
                const error = err instanceof Error ? err.message : String(err);
                await this.options.launcher.markAttemptFailed?.(task.id, error);
                if (workflow) {
                    await this.appendAgentRunFailure(task, runId || buildAgentRunId(task, attempt, this.now()), error);
                }
                state.retries[task.id] = this.nextRetry(state, task, error);
                return { failed: { shortIdentifier: task.shortIdentifier, error } };
            }
        }));
        for (const outcome of dispatchOutcomes) {
            if (outcome.dispatched)
                result.dispatched.push(outcome.dispatched);
            if (outcome.failed)
                result.failed.push(outcome.failed);
        }
        state.recent = appendRecent(state.recent, result, new Date(this.now()).toISOString());
        await this.options.stateStore.save(state);
        return result;
    }
    async runExplicitTask(task) {
        const result = {
            dispatched: [],
            stopped: [],
            skipped: [],
            failed: [],
        };
        const workflow = await this.resolveWorkflow();
        const state = await this.options.stateStore.load().catch(() => emptyState());
        const attempt = state.retries[task.id]?.attempt || 0;
        const runId = workflow ? buildAgentRunId(task, attempt, this.now()) : undefined;
        try {
            const projectPath = task.repository?.executionPath || task.repository?.path || this.options.defaultProjectPath;
            const routing = workflow?.resolveRouting(task);
            const prompt = await this.renderWorkflowPrompt(task, {
                attempt,
                workflow,
                routing,
                projectPath,
            });
            if (workflow && runId && routing) {
                await this.createAgentRun(task, {
                    runId,
                    attempt,
                    projectPath,
                    workflow,
                    routing,
                });
            }
            if (workflow && runId && routing && this.options.runtimeRunners?.[routing.runner]) {
                await this.launchRuntimeRunner(task, {
                    runId,
                    attempt,
                    projectPath,
                    prompt,
                    workflow,
                    routing,
                });
            }
            else {
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
                if (!launched)
                    throw new Error('Tracker daemon launcher does not implement launchTask.');
            }
            delete state.retries[task.id];
            result.dispatched.push(task.shortIdentifier);
            if (runId) {
                result.runIds = { ...(result.runIds || {}), [task.shortIdentifier]: runId };
            }
        }
        catch (err) {
            const error = err instanceof Error ? err.message : String(err);
            await this.options.launcher.markAttemptFailed?.(task.id, error);
            if (workflow) {
                await this.appendAgentRunFailure(task, runId || buildAgentRunId(task, attempt, this.now()), error);
            }
            state.retries[task.id] = this.nextRetry(state, task, error);
            result.failed.push({ shortIdentifier: task.shortIdentifier, error });
        }
        state.recent = appendRecent(state.recent, result, new Date(this.now()).toISOString());
        await this.options.stateStore.save(state);
        return result;
    }
    async stopIneligibleRuns(tasksById, result, stoppedTaskIds, workflow) {
        for (const task of tasksById.values()) {
            if (!task.activeKernelTaskId)
                continue;
            if (stoppedTaskIds.has(task.id))
                continue;
            if (task.stateKind === 'active' && !hasOpenBlockers(task))
                continue;
            const reason = `Task ${task.shortIdentifier} is no longer active: ${task.stateKind === 'active' ? 'blocked' : task.stateKind}`;
            const projectPath = task.repository?.path || this.options.defaultProjectPath;
            const run = {
                taskId: task.id,
                shortIdentifier: task.shortIdentifier,
                kernelTaskId: task.activeKernelTaskId,
                workspaceRoot: this.options.workspaceRoot,
                projectPath,
                startedAt: task.activeAttemptStartedAt || new Date(this.now()).toISOString(),
                status: 'running',
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
    async cleanupStaleOpenAttempts(tasks, result, stoppedTaskIds) {
        if (!this.options.launcher.isRunActive || !this.options.launcher.markAttemptFailed) {
            return;
        }
        for (const task of tasks) {
            if (!task.activeKernelTaskId)
                continue;
            if (stoppedTaskIds.has(task.id))
                continue;
            if (task.stateKind !== 'active' || hasOpenBlockers(task))
                continue;
            if (await this.isRuntimeRunActive(task.activeKernelTaskId))
                continue;
            const active = await this.options.launcher.isRunActive(task.activeKernelTaskId);
            if (active)
                continue;
            const reason = `Kernel task ${task.activeKernelTaskId} is no longer active in this daemon runtime.`;
            await this.options.launcher.markAttemptFailed(task.id, reason);
            stoppedTaskIds.add(task.id);
            result.stopped.push(task.shortIdentifier);
        }
    }
    async listRunningTasks(candidateTasks) {
        const runningIds = candidateTasks
            .filter((task) => Boolean(task.activeKernelTaskId) || isAlreadyRunningTask(task))
            .map((task) => task.id);
        if (this.options.importer.listOpenAttemptTasks) {
            const openAttemptTasks = await this.options.importer.listOpenAttemptTasks();
            runningIds.push(...openAttemptTasks.map((task) => task.id));
        }
        const candidateIds = new Set(candidateTasks.map((task) => task.id));
        const missingIds = Array.from(new Set(runningIds)).filter((id) => !candidateIds.has(id));
        if (missingIds.length === 0 || !this.options.importer.fetchTaskStatesByIds)
            return [];
        return this.options.importer.fetchTaskStatesByIds(missingIds);
    }
    async cleanupTerminalTasks(tasks, result, stoppedTaskIds, workflow) {
        const terminalStates = this.options.terminalStates || workflow?.config.tracker.terminalStates || [];
        if (!this.options.importer.fetchTasksByStates || terminalStates.length === 0)
            return;
        const terminalTasks = await this.options.importer.fetchTasksByStates(terminalStates);
        const terminalById = new Map(terminalTasks.map((task) => [task.id, task]));
        for (const candidate of tasks) {
            if (!candidate.activeKernelTaskId)
                continue;
            if (stoppedTaskIds.has(candidate.id))
                continue;
            const task = terminalById.get(candidate.id);
            if (!task)
                continue;
            const projectPath = candidate.repository?.path || this.options.defaultProjectPath;
            const run = {
                taskId: candidate.id,
                shortIdentifier: candidate.shortIdentifier,
                kernelTaskId: candidate.activeKernelTaskId,
                workspaceRoot: this.options.workspaceRoot,
                projectPath,
                startedAt: candidate.activeAttemptStartedAt || new Date(this.now()).toISOString(),
                status: 'running',
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
    maxConcurrentAgents(workflow) {
        return this.options.maxConcurrentAgents
            || workflow?.config.polling.maxConcurrentAgents
            || Number.POSITIVE_INFINITY;
    }
    async resolveWorkflow() {
        if (!this.options.workflowProvider)
            return this.options.workflow;
        return this.options.workflowProvider().catch(() => this.options.workflow);
    }
    async persistWatching(watching) {
        const state = await this.options.stateStore.load().catch(() => emptyState());
        state.watching = watching;
        await this.options.stateStore.save(state);
    }
    async createAgentRun(task, input) {
        const store = this.options.agentRunStore;
        if (!store)
            return;
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
    async renderWorkflowPrompt(task, input) {
        if (!input.workflow)
            return undefined;
        if (isCodexFixRouting(input.routing, task)) {
            return buildTikGeneratedCodexFixPrompt(task);
        }
        const previousReview = previousReviewReason(task);
        const basePrompt = withPreviousReviewContext(input.workflow.renderPrompt(task, { attempt: input.attempt, previousReview }), previousReview);
        if (!isClaudeReviewRouting(input.routing, task)) {
            return basePrompt;
        }
        const reviewContext = await buildTikGeneratedReviewContext(input.projectPath, {
            baseRef: task.agentLoop?.changeRequest.baseRef,
            headSha: task.agentLoop?.headSha || task.agentLoop?.changeRequest.headSha,
            allowedScope: task.agentLoop?.allowedScope,
        }).catch((error) => [
            '## Tik-generated review context',
            '',
            `Tik failed to generate review context: ${error instanceof Error ? error.message : String(error)}`,
        ].join('\n'));
        return [
            basePrompt.trimEnd(),
            '',
            buildTikGeneratedClaudeReviewSubmissionPrompt(task),
            '',
            reviewContext,
        ].join('\n');
    }
    async launchRuntimeRunner(task, input) {
        const runner = this.options.runtimeRunners?.[input.routing.runner];
        if (!runner)
            throw new Error(`No runtime runner configured for ${input.routing.runner}.`);
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
            artifactOutputDir: path.join(this.options.workspaceRoot, '.tik', 'artifacts', task.shortIdentifier, `attempt-${input.attempt}`),
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
        }
        catch (err) {
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
    trackRuntimeCompletion(task, input) {
        void input.completion.then((completion) => this.recordRuntimeCompletion(task, {
            runId: input.runId,
            attemptNumber: input.attemptNumber,
            runner: input.runner,
            workflow: input.workflow,
            projectPath: input.projectPath,
            completion,
        }), (err) => this.recordRuntimeCompletion(task, {
            runId: input.runId,
            attemptNumber: input.attemptNumber,
            runner: input.runner,
            workflow: input.workflow,
            projectPath: input.projectPath,
            completion: {
                status: 'failed',
                error: err instanceof Error ? err.message : String(err),
            },
        }));
    }
    async recordRuntimeCompletion(task, input) {
        const endedAt = new Date(this.now()).toISOString();
        if (input.completion.status === 'completed') {
            await this.appendAgentRunComplete(task, input.runId, input.completion, endedAt);
        }
        else if (input.completion.status === 'cancelled') {
            await this.appendAgentRunCancel(input.runId, endedAt);
        }
        else {
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
    async createRunProof(task, input) {
        const proofService = this.options.runProofService;
        const runner = this.options.runtimeRunners?.[input.runner];
        const store = this.options.agentRunStore;
        if (!proofService || !runner || !store?.readRun)
            return;
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
        }
        catch {
            // Proof collection is best-effort relative to daemon completion bookkeeping.
        }
    }
    async isRuntimeRunActive(runId) {
        const runners = Object.values(this.options.runtimeRunners || {});
        for (const runner of runners) {
            const status = await runner?.getStatus(runId).catch(() => 'unknown');
            if (status === 'running' || status === 'queued')
                return true;
        }
        return false;
    }
    async appendAgentRunComplete(task, runId, completion, ts = new Date(this.now()).toISOString()) {
        const store = this.options.agentRunStore;
        if (!store)
            return;
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
        }
        catch {
            // Runtime completion should not crash the daemon if metadata was pruned.
        }
    }
    async appendAgentRunCancel(runId, ts = new Date(this.now()).toISOString()) {
        const store = this.options.agentRunStore;
        if (!store)
            return;
        try {
            await store.appendEvent({
                runId,
                ts,
                source: 'tik',
                kind: 'run.cancel',
                payload: {},
            });
        }
        catch {
            // Runtime completion should not crash the daemon if metadata was pruned.
        }
    }
    async appendAgentRunFailure(task, runId, message, retryable = true, ts = new Date(this.now()).toISOString()) {
        const store = this.options.agentRunStore;
        if (!store)
            return;
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
        }
        catch {
            // Missing run metadata should not mask the original dispatch failure.
        }
    }
    runningCount(tasks, stoppedTaskIds) {
        return tasks
            .filter((task) => !stoppedTaskIds.has(task.id))
            .filter((task) => isAlreadyRunningTask(task) || Boolean(task.activeKernelTaskId))
            .length;
    }
    async runHooks(hook, task, projectPath, run, workflow) {
        const configured = this.options.workspaceHooks?.[hook]
            || workflow?.config.workspace.hooks[hook]
            || [];
        for (const name of configured) {
            await this.options.launcher.runHook?.(name, {
                task,
                workspaceRoot: this.options.workspaceRoot,
                projectPath,
                run,
                envWhitelist: workflow?.config.sandbox?.envWhitelist,
            });
        }
    }
    retryIsDue(state, task, result) {
        const retry = state.retries[task.id];
        if (!retry)
            return true;
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
    resetUpdatedRetries(state, tasks) {
        for (const task of tasks) {
            const retry = state.retries[task.id];
            if (!retry || !task.updatedAt)
                continue;
            const taskUpdatedAt = Date.parse(task.updatedAt);
            const retryUpdatedAt = Date.parse(retry.updatedAt);
            if (Number.isFinite(taskUpdatedAt) && Number.isFinite(retryUpdatedAt) && taskUpdatedAt > retryUpdatedAt) {
                delete state.retries[task.id];
            }
        }
    }
    nextRetry(state, task, error) {
        const previous = state.retries[task.id];
        const attempt = (previous?.attempt || 0) + 1;
        const delay = Math.min(this.retry.maxDelayMs, this.retry.initialDelayMs * (2 ** Math.max(0, attempt - 1)));
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
function hasOpenBlockers(task) {
    return task.blockedBy.some((blocker) => {
        const state = blocker.state?.toLowerCase();
        return state !== 'done' && state !== 'closed' && state !== 'completed' && state !== 'terminal';
    });
}
function isAlreadyRunningTask(task) {
    const state = task.state.toLowerCase();
    if (task.sourceKind === 'workbench') {
        return Boolean(task.activeKernelTaskId) && (state === 'in_progress' || state === 'running');
    }
    return state === 'in_progress' || state === 'running';
}
function mergeTasks(primary, secondary) {
    const byId = new Map();
    for (const task of primary)
        byId.set(task.id, task);
    for (const task of secondary)
        byId.set(task.id, task);
    return Array.from(byId.values());
}
function sortTasksForDispatch(tasks) {
    return [...tasks].sort((left, right) => {
        const priorityDelta = normalizePriority(left.priority) - normalizePriority(right.priority);
        if (priorityDelta !== 0)
            return priorityDelta;
        const createdDelta = normalizeCreatedAt(left.createdAt) - normalizeCreatedAt(right.createdAt);
        if (createdDelta !== 0)
            return createdDelta;
        return left.shortIdentifier.localeCompare(right.shortIdentifier);
    });
}
function normalizePriority(priority) {
    return typeof priority === 'number' && Number.isFinite(priority)
        ? priority
        : Number.POSITIVE_INFINITY;
}
function normalizeCreatedAt(createdAt) {
    if (!createdAt)
        return Number.POSITIVE_INFINITY;
    const parsed = Date.parse(createdAt);
    return Number.isFinite(parsed) ? parsed : Number.POSITIVE_INFINITY;
}
function appendRecent(previous, result, createdAt) {
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
function workflowSelectorSkipReason(workflow, task) {
    if (!workflow)
        return undefined;
    const selector = workflow.config.selector;
    if (!selector)
        return undefined;
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
function existingWorkflowLocks(workflow, tasks, stoppedTaskIds, defaultProjectPath) {
    const locks = new Set();
    for (const task of tasks) {
        if (stoppedTaskIds.has(task.id))
            continue;
        if (!isAlreadyRunningTask(task) && !task.activeKernelTaskId)
            continue;
        const lock = workflowLockKey(workflow, task, defaultProjectPath);
        if (lock)
            locks.add(lock);
    }
    return locks;
}
function workflowLockKey(workflow, task, defaultProjectPath) {
    if (!workflow)
        return undefined;
    if (workflow.config.concurrency?.lock !== 'repository_branch')
        return undefined;
    const repository = task.repository?.sourcePath || task.repository?.path || task.repository?.name || defaultProjectPath;
    const branch = workflowBranchForTask(task);
    return `${repository}#${branch}`;
}
function buildRuntimeEnv(whitelist, input) {
    const env = {};
    for (const name of BASE_RUNTIME_ENV_KEYS) {
        const value = process.env[name];
        if (typeof value === 'string')
            env[name] = value;
    }
    for (const name of whitelist) {
        const value = process.env[name];
        if (typeof value === 'string')
            env[name] = value;
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
        TIK_API_BASE_URL: runtimeApiBaseUrl(),
    };
}
function runtimeApiBaseUrl() {
    return (process.env.TIK_API_BASE_URL || 'http://127.0.0.1:3300/api').replace(/\/$/, '');
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
function workflowBranchForTask(task) {
    const branchLabel = task.labels.find((label) => normalizeLabel(label).startsWith('branch:'));
    return branchLabel ? branchLabel.slice('branch:'.length).trim() || 'default' : 'default';
}
function buildAgentRunId(task, attempt, nowMs) {
    return `${task.shortIdentifier.toLowerCase()}-attempt-${attempt}-${nowMs}`;
}
function normalizeLabel(label) {
    return label.trim().toLowerCase();
}
function isClaudeReviewRouting(routing, task) {
    if (routing?.runner !== 'claude-code')
        return false;
    const labels = new Set(task.labels.map(normalizeLabel));
    return labels.has('needs-claude-review') || labels.has('claude-review');
}
function shouldRunClaudeReview(routing, task) {
    if (routing?.runner !== 'claude-code')
        return false;
    const phase = task.agentLoop?.phase;
    return phase === 'needs_claude_review'
        || phase === 'claude_reviewing'
        || task.agentLoop?.kind === 'claude_review'
        || isClaudeReviewRouting(routing, task);
}
function isCodexFixRouting(routing, task) {
    if (routing?.runner !== 'codex')
        return false;
    const labels = new Set(task.labels.map(normalizeLabel));
    const phase = task.agentLoop?.phase;
    return labels.has('needs-codex-fix')
        || labels.has('codex-fix')
        || phase === 'needs_codex_fix'
        || phase === 'codex_fixing'
        || task.agentLoop?.kind === 'codex_fix';
}
function previousReviewReason(task) {
    const comments = [...(task.comments || [])].sort((left, right) => (right.createdAt.localeCompare(left.createdAt)));
    for (const comment of comments) {
        if (!/run review rejected/i.test(comment.body))
            continue;
        const reason = comment.body.match(/(?:^|\n)Reason:\s*([\s\S]+)/i)?.[1]?.trim();
        if (reason)
            return reason;
        const trimmed = comment.body.trim();
        if (trimmed)
            return trimmed;
    }
    const summaryReason = task.latestSummary?.match(/changes requested[^:]*:\s*([\s\S]+)/i)?.[1]?.trim();
    return summaryReason || undefined;
}
function withPreviousReviewContext(prompt, previousReview) {
    if (!previousReview)
        return prompt;
    if (prompt.includes(previousReview))
        return prompt;
    return [
        prompt.trimEnd(),
        '',
        'Previous review rejection reason:',
        previousReview,
    ].join('\n');
}
function buildTikGeneratedCodexFixPrompt(task) {
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
    ].filter((part) => Boolean(part)).join('\n');
}
function buildTikGeneratedClaudeReviewSubmissionPrompt(task) {
    const metadata = task.agentLoop;
    const expectedHeadSha = metadata?.headSha || metadata?.changeRequest.headSha;
    const reviewInput = metadata?.reviewInput || { source: 'local_diff' };
    const fetchRemote = reviewInput.fetchRemote || 'origin';
    const fetchRef = reviewInput.fetchRef || metadata?.changeRequest.headRef;
    return [
        '## Tik Claude Code review contract',
        '',
        'You are running inside a Tik-managed Claude Code review workflow.',
        'Review only the recorded change and do not edit files, commit, push, merge, approve externally, or call GitHub/GitLab review APIs.',
        reviewInput.source === 'merge_request'
            ? 'Review input source: merge request'
            : 'Review input source: local worktree diff',
        reviewInput.source === 'merge_request' && reviewInput.mergeRequestUrl
            ? `Merge request URL: ${reviewInput.mergeRequestUrl}`
            : undefined,
        expectedHeadSha ? `Recorded head SHA: ${expectedHeadSha}` : undefined,
        metadata?.changeRequest.baseRef && expectedHeadSha
            ? `Review diff range: ${metadata.changeRequest.baseRef}..${expectedHeadSha}`
            : undefined,
        reviewInput.source === 'merge_request'
            ? [
                '',
                'Before reviewing, fetch the merge request code into the local repository if it is not already checked out:',
                '```bash',
                fetchRef ? `git fetch ${fetchRemote} ${fetchRef}` : `git fetch ${fetchRemote}`,
                'git checkout FETCH_HEAD',
                '```',
                'Then review the fetched MR diff against the recorded base/head refs.',
            ].join('\n')
            : [
                '',
                'Start from the Tik-generated local diff context below. It is the primary review input and is faster than rediscovering the change with broad repository scans.',
                'Use `git status --short`, `git diff --stat`, and `git diff --` only to verify or inspect the bounded local diff when needed.',
            ].join('\n'),
        '',
        'Before reviewing, compare the recorded head SHA with `git rev-parse HEAD` in the repository.',
        `If it differs, POST { "expectedHeadSha": "${expectedHeadSha || '<recorded-head-sha>'}", "actualHeadSha": "<current-head-sha>" } to ${runtimeApiBaseUrl()}/v1/agent-loop/tasks/${task.id}/stale and stop.`,
        '',
        'When finished, submit only a ReviewResult JSON object through Tik. Do not finish by printing JSON only; the review is complete only after the Tik POST succeeds.',
        `POST ${runtimeApiBaseUrl()}/v1/agent-loop/tasks/${task.id}/review-result`,
        `Runtime env also exposes TIK_API_BASE_URL=${runtimeApiBaseUrl()}.`,
        '',
        'Submission command pattern:',
        '```bash',
        `cat > /tmp/tik-review-result-${task.id}.json <<'JSON'`,
        '{',
        '  "verdict": "approve",',
        `  "headShaReviewed": "${expectedHeadSha || '<recorded-head-sha>'}",`,
        `  "currentHeadSha": "${expectedHeadSha || '<current-head-sha>'}",`,
        '  "blockingIssues": [],',
        '  "nonBlockingSuggestions": [],',
        '  "testsNeeded": [],',
        '  "markdown": "No blocking findings.",',
        '  "reviewerWorkerId": "claude-code"',
        '}',
        'JSON',
        `curl -sS -X POST "$TIK_API_BASE_URL/v1/agent-loop/tasks/${task.id}/review-result" -H 'Content-Type: application/json' --data-binary @/tmp/tik-review-result-${task.id}.json`,
        '```',
        'Replace the JSON body with the actual review result before running the command.',
        '',
        'ReviewResult JSON schema:',
        '```json',
        JSON.stringify({
            verdict: 'request_changes',
            headShaReviewed: expectedHeadSha || '<recorded-head-sha>',
            currentHeadSha: expectedHeadSha || '<current-head-sha>',
            blockingIssues: [
                {
                    title: 'Short blocking issue title',
                    file: 'relative/path.ts',
                    line: 42,
                    reason: 'Why this blocks acceptance.',
                    suggestedFix: 'Concrete fix direction.',
                },
            ],
            nonBlockingSuggestions: [],
            testsNeeded: [],
            markdown: 'Human-readable review summary.',
            reviewerWorkerId: 'claude-code',
        }, null, 2),
        '```',
        '',
        'Use `verdict=approve` only when there are zero blocking issues. Use `verdict=request_changes` when `blockingIssues` is non-empty.',
    ].filter((part) => Boolean(part)).join('\n');
}
function truncatePromptSection(value, maxChars) {
    return value.length <= maxChars ? value : `${value.slice(0, maxChars - 1)}…`;
}
//# sourceMappingURL=tracker-daemon.js.map