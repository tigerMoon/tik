import { isWorkbenchTaskWorkflowDispatchable } from '@tik/shared';
const WORKBENCH_SOURCE = 'workbench';
export class WorkflowV2WorkbenchTaskImporter {
    workbench;
    defaultProjectPath;
    constructor(workbench, defaultProjectPath) {
        this.workbench = workbench;
        this.defaultProjectPath = defaultProjectPath;
    }
    async listCandidateTasks() {
        const tasks = await this.listWorkbenchTasks();
        return tasks
            .filter((task) => isWorkbenchTaskWorkflowDispatchable(task) || hasOpenTrackerAttempt(task))
            .map((task) => taskToTrackedTask(task, this.defaultProjectPath, isWorkbenchTaskWorkflowDispatchable));
    }
    async listOpenAttemptTasks() {
        const tasks = await this.listWorkbenchTasks();
        return tasks
            .filter(hasOpenTrackerAttempt)
            .map((task) => taskToTrackedTask(task, this.defaultProjectPath, isWorkbenchTaskWorkflowDispatchable));
    }
    async fetchTaskStatesByIds(taskIds) {
        const tasks = await Promise.all(taskIds.map(async (taskId) => this.workbench.readTask?.(taskId)));
        return tasks
            .filter((task) => Boolean(task))
            .map((task) => taskToTrackedTask(task, this.defaultProjectPath, isWorkbenchTaskWorkflowDispatchable));
    }
    async fetchTasksByStates(stateNames) {
        const stateSet = new Set(stateNames.map((state) => state.toLowerCase()));
        const tasks = await this.listWorkbenchTasks();
        return tasks
            .filter((task) => isWorkbenchTaskWorkflowDispatchable(task) || hasOpenTrackerAttempt(task))
            .filter((task) => stateSet.has(task.status.toLowerCase()) || (task.state && stateSet.has(task.state.toLowerCase())))
            .map((task) => taskToTrackedTask(task, this.defaultProjectPath, isWorkbenchTaskWorkflowDispatchable));
    }
    async listWorkbenchTasks() {
        if (!this.workbench.listTasks) {
            throw new Error('Workbench task importer requires listTasks support.');
        }
        return this.workbench.listTasks();
    }
}
function taskToTrackedTask(task, defaultProjectPath, isDispatchable = isWorkbenchTaskWorkflowDispatchable) {
    const identifier = task.identifier || task.shortIdentifier || task.id.slice(0, 8).toUpperCase();
    const latestOpenAttempt = (task.attempts || [])
        .filter((attempt) => attempt.kernelTaskId && !attempt.finishedAt)
        .sort((left, right) => left.attemptNumber - right.attemptNumber)
        .at(-1);
    return {
        id: task.id,
        shortIdentifier: identifier,
        title: task.title,
        description: task.description ?? task.goal,
        priority: task.priority ?? null,
        state: task.status,
        stateKind: stateKindFromTask(task, isDispatchable),
        sourceUrl: task.sourceUrl,
        labels: task.labels || [],
        blockedBy: buildBlockers(task),
        repository: task.workspaceBinding
            ? {
                name: task.workspaceBinding.projectName,
                path: task.workspaceBinding.effectiveProjectPath || task.workspaceBinding.sourceProjectPath,
                executionPath: task.workspaceBinding.effectiveProjectPath || task.workspaceBinding.sourceProjectPath,
                sourcePath: task.workspaceBinding.sourceProjectPath || task.workspaceBinding.effectiveProjectPath,
                workspaceFile: task.workspaceBinding.workspaceFile,
            }
            : defaultProjectPath
                ? {
                    name: defaultProjectPath.split(/[\\/]/).filter(Boolean).at(-1),
                    path: defaultProjectPath,
                    executionPath: defaultProjectPath,
                    sourcePath: defaultProjectPath,
                }
                : undefined,
        assignee: task.humanAssignee ?? task.assignee ?? null,
        createdBy: task.createdBy,
        createdAt: task.createdAt,
        updatedAt: task.updatedAt,
        activeKernelTaskId: latestOpenAttempt?.kernelTaskId || null,
        activeAttemptStartedAt: latestOpenAttempt?.startedAt || null,
        sourceKind: WORKBENCH_SOURCE,
        agentLoop: task.agentLoop,
        comments: task.comments,
        latestSummary: task.latestSummary,
    };
}
function hasOpenTrackerAttempt(task) {
    return Boolean(task.attempts?.some((attempt) => attempt.kernelTaskId && !attempt.finishedAt));
}
function buildBlockers(task) {
    const explicit = task.blockedBy || [];
    const explicitIds = new Set(explicit.map((blocker) => blocker.id).filter(Boolean));
    const idOnlyBlockers = (task.blockedByTaskIds || [])
        .filter((id) => !explicitIds.has(id))
        .map((id) => ({ id, shortIdentifier: id, state: null }));
    return [...explicit, ...idOnlyBlockers];
}
function stateKindFromTask(task, isDispatchable) {
    const statusKind = stateKindFromStatus(task.status);
    if (statusKind !== 'active') {
        return statusKind;
    }
    return isDispatchable(task) ? 'active' : 'blocked';
}
function stateKindFromStatus(status) {
    switch (status) {
        case 'todo':
        case 'retry':
        case 'in_progress':
        case 'running':
        case 'failed':
            return 'active';
        case 'completed':
        case 'accepted':
        case 'cancelled':
        case 'archived':
            return 'terminal';
        default:
            return 'blocked';
    }
}
//# sourceMappingURL=workbench-tracker-client.js.map