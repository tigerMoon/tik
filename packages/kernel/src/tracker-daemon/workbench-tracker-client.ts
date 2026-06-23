import { isWorkbenchTaskCodexDispatchable } from '@tik/shared';
import type { WorkbenchTaskRecord, WorkbenchTaskStatus } from '@tik/shared';
import type {
  TrackedTask,
  TrackedTaskStateKind,
  WorkbenchPort,
  TrackedTaskImporter,
} from './types.js';

const WORKBENCH_SOURCE = 'workbench';

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

function taskToTrackedTask(task: WorkbenchTaskRecord): TrackedTask {
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
    stateKind: stateKindFromTask(task),
    sourceUrl: task.sourceUrl,
    labels: task.labels || [],
    blockedBy: buildBlockers(task),
    repository: task.workspaceBinding
      ? {
          name: task.workspaceBinding.projectName,
          path: task.workspaceBinding.sourceProjectPath || task.workspaceBinding.effectiveProjectPath,
          workspaceFile: task.workspaceBinding.workspaceFile,
        }
      : undefined,
    assignee: task.humanAssignee ?? task.assignee ?? null,
    createdBy: task.createdBy,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    activeKernelTaskId: latestOpenAttempt?.kernelTaskId || null,
    activeAttemptStartedAt: latestOpenAttempt?.startedAt || null,
    sourceKind: WORKBENCH_SOURCE,
  };
}

function buildBlockers(task: WorkbenchTaskRecord): TrackedTask['blockedBy'] {
  const explicit = task.blockedBy || [];
  const explicitIds = new Set(explicit.map((blocker) => blocker.id).filter(Boolean));
  const idOnlyBlockers = (task.blockedByTaskIds || [])
    .filter((id) => !explicitIds.has(id))
    .map((id) => ({ id, shortIdentifier: id, state: null }));
  return [...explicit, ...idOnlyBlockers];
}

function stateKindFromTask(task: WorkbenchTaskRecord): TrackedTaskStateKind {
  const statusKind = stateKindFromStatus(task.status);
  if (statusKind !== 'active') {
    return statusKind;
  }
  return isWorkbenchTaskCodexDispatchable(task) ? 'active' : 'blocked';
}

function stateKindFromStatus(status: WorkbenchTaskStatus): TrackedTaskStateKind {
  switch (status) {
    case 'todo':
    case 'in_progress':
    case 'running':
    case 'failed':
      return 'active';
    case 'completed':
    case 'cancelled':
    case 'archived':
      return 'terminal';
    default:
      return 'blocked';
  }
}
