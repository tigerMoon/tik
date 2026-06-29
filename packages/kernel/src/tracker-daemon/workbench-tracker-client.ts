import { isWorkbenchTaskCodexDispatchable, isWorkbenchTaskWorkflowDispatchable } from '@tik/shared';
import type { WorkbenchTaskRecord, WorkbenchTaskStatus } from '@tik/shared';
import type {
  TrackedTask,
  TrackedTaskStateKind,
  WorkbenchPort,
  TrackedTaskImporter,
} from './types.js';

const WORKBENCH_SOURCE = 'workbench';
type WorkbenchTaskDispatchPredicate = (task: WorkbenchTaskRecord) => boolean;

export class WorkbenchTaskImporter implements TrackedTaskImporter {
  constructor(private readonly workbench: WorkbenchPort) {}

  async listCandidateTasks(): Promise<TrackedTask[]> {
    const tasks = await this.listWorkbenchTasks();
    return tasks
      .filter(isWorkbenchTaskCodexDispatchable)
      .map((task) => taskToTrackedTask(task));
  }

  async listOpenAttemptTasks(): Promise<TrackedTask[]> {
    const tasks = await this.listWorkbenchTasks();
    return tasks
      .filter((task) => Boolean(task.attempts?.some((attempt) => attempt.kernelTaskId && !attempt.finishedAt)))
      .map((task) => taskToTrackedTask(task));
  }

  async fetchTaskStatesByIds(taskIds: string[]): Promise<TrackedTask[]> {
    const tasks = await Promise.all(taskIds.map(async (taskId) => this.workbench.readTask?.(taskId)));
    return tasks
      .filter((task): task is WorkbenchTaskRecord => Boolean(task))
      .map((task) => taskToTrackedTask(task));
  }

  async fetchTasksByStates(stateNames: string[]): Promise<TrackedTask[]> {
    const stateSet = new Set(stateNames.map((state) => state.toLowerCase()));
    const tasks = await this.listWorkbenchTasks();
    return tasks
      .filter(isWorkbenchTaskCodexDispatchable)
      .filter((task) => stateSet.has(task.status.toLowerCase()) || (task.state && stateSet.has(task.state.toLowerCase())))
      .map((task) => taskToTrackedTask(task));
  }

  private async listWorkbenchTasks(): Promise<WorkbenchTaskRecord[]> {
    if (!this.workbench.listTasks) {
      throw new Error('Workbench task importer requires listTasks support.');
    }
    return this.workbench.listTasks();
  }
}

export class WorkflowV2WorkbenchTaskImporter implements TrackedTaskImporter {
  constructor(
    private readonly workbench: WorkbenchPort,
    private readonly defaultProjectPath: string,
  ) {}

  async listCandidateTasks(): Promise<TrackedTask[]> {
    const tasks = await this.listWorkbenchTasks();
    return tasks
      .filter((task) => isWorkbenchTaskWorkflowDispatchable(task) || hasOpenTrackerAttempt(task))
      .map((task) => taskToTrackedTask(task, this.defaultProjectPath, isWorkbenchTaskWorkflowDispatchable));
  }

  async listOpenAttemptTasks(): Promise<TrackedTask[]> {
    const tasks = await this.listWorkbenchTasks();
    return tasks
      .filter(hasOpenTrackerAttempt)
      .map((task) => taskToTrackedTask(task, this.defaultProjectPath, isWorkbenchTaskWorkflowDispatchable));
  }

  async fetchTaskStatesByIds(taskIds: string[]): Promise<TrackedTask[]> {
    const tasks = await Promise.all(taskIds.map(async (taskId) => this.workbench.readTask?.(taskId)));
    return tasks
      .filter((task): task is WorkbenchTaskRecord => Boolean(task))
      .map((task) => taskToTrackedTask(task, this.defaultProjectPath, isWorkbenchTaskWorkflowDispatchable));
  }

  async fetchTasksByStates(stateNames: string[]): Promise<TrackedTask[]> {
    const stateSet = new Set(stateNames.map((state) => state.toLowerCase()));
    const tasks = await this.listWorkbenchTasks();
    return tasks
      .filter((task) => isWorkbenchTaskWorkflowDispatchable(task) || hasOpenTrackerAttempt(task))
      .filter((task) => stateSet.has(task.status.toLowerCase()) || (task.state && stateSet.has(task.state.toLowerCase())))
      .map((task) => taskToTrackedTask(task, this.defaultProjectPath, isWorkbenchTaskWorkflowDispatchable));
  }

  private async listWorkbenchTasks(): Promise<WorkbenchTaskRecord[]> {
    if (!this.workbench.listTasks) {
      throw new Error('Workbench task importer requires listTasks support.');
    }
    return this.workbench.listTasks();
  }
}

function taskToTrackedTask(
  task: WorkbenchTaskRecord,
  defaultProjectPath?: string,
  isDispatchable: WorkbenchTaskDispatchPredicate = isWorkbenchTaskCodexDispatchable,
): TrackedTask {
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

function hasOpenTrackerAttempt(task: WorkbenchTaskRecord): boolean {
  return Boolean(task.attempts?.some((attempt) => attempt.kernelTaskId && !attempt.finishedAt));
}

function buildBlockers(task: WorkbenchTaskRecord): TrackedTask['blockedBy'] {
  const explicit = task.blockedBy || [];
  const explicitIds = new Set(explicit.map((blocker) => blocker.id).filter(Boolean));
  const idOnlyBlockers = (task.blockedByTaskIds || [])
    .filter((id) => !explicitIds.has(id))
    .map((id) => ({ id, shortIdentifier: id, state: null }));
  return [...explicit, ...idOnlyBlockers];
}

function stateKindFromTask(
  task: WorkbenchTaskRecord,
  isDispatchable: WorkbenchTaskDispatchPredicate,
): TrackedTaskStateKind {
  const statusKind = stateKindFromStatus(task.status);
  if (statusKind !== 'active') {
    return statusKind;
  }
  return isDispatchable(task) ? 'active' : 'blocked';
}

function stateKindFromStatus(status: WorkbenchTaskStatus): TrackedTaskStateKind {
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
