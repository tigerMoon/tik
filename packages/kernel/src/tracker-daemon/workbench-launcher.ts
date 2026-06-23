import * as path from 'node:path';
import type { TaskWorkspaceBinding, WorkbenchTaskBlockerRecord } from '@tik/shared';
import type {
  TrackerDaemonLaunchInput,
  TrackerDaemonWorkLauncher,
  TrackerRunRecord,
  TrackedTask,
  WorkbenchLaunchTaskOptions,
  WorkbenchPort,
} from './types.js';
import { buildTaskContextSnapshot, humanCommentsBudget } from './task-context-snapshot.js';

export class WorkbenchTrackerLauncher implements TrackerDaemonWorkLauncher {
  constructor(
    private readonly workbench: WorkbenchPort,
    private readonly options: WorkbenchLaunchTaskOptions,
  ) {}

  async launchTask(task: TrackedTask, input: TrackerDaemonLaunchInput) {
    const existingTask = await this.workbench.readTask?.(task.id);
    const existingTimeline = existingTask ? await this.workbench.readTimeline?.(task.id) : undefined;
    const taskContextSnapshot = buildTaskContextSnapshot(existingTask, existingTimeline);
    if (existingTask && (existingTask.status === 'todo' || existingTask.status === 'failed' || existingTask.status === 'backlog')) {
      await this.workbench.transitionTask?.(task.id, 'in_progress', {
        actor: 'daemon',
        reason: `Dispatching tracker task ${task.shortIdentifier}.`,
      });
    }

    const sourceProjectPath = input.projectPath || task.repository?.path || this.options.defaultProjectPath;
    const workspaceRoot = input.workspaceRoot;
    const workspaceName = this.options.workspaceName || path.basename(workspaceRoot);
    const projectName = task.repository?.name || path.basename(sourceProjectPath);
    const laneId = task.shortIdentifier.toLowerCase().replace(/[^a-z0-9._-]+/g, '-');
    const executionTarget = await this.options.resolveExecutionTarget?.({
      task,
      workspaceRoot,
      workspaceName,
      projectName,
      sourceProjectPath,
      laneId,
    });
    const projectPath = executionTarget?.effectiveProjectPath || sourceProjectPath;
    const workspaceBinding = input.workspaceBinding || this.buildWorkspaceBinding(task, {
      workspaceRoot,
      workspaceName,
      projectName,
      sourceProjectPath: executionTarget?.sourceProjectPath || sourceProjectPath,
      effectiveProjectPath: projectPath,
      laneId,
      worktreeKind: executionTarget?.worktreeKind,
      worktreePath: executionTarget?.worktreePath,
    });
    const title = task.title;
    const goalBody = input.prompt || task.description?.trim() || task.title;
    const goal = [
      goalBody,
      task.sourceUrl ? `Tracker: ${task.sourceUrl}` : undefined,
      task.labels.length ? `Labels: ${task.labels.join(', ')}` : undefined,
    ].filter(Boolean).join('\n\n');
    const kernelTask = this.options.createKernelTask?.({
      id: task.id,
      description: `${task.shortIdentifier}: ${title}\n\n${goal}`,
      projectPath,
      workspaceBinding,
      recentComments: humanCommentsBudget(existingTask?.comments),
      taskContextSnapshot,
    });
    const attemptNumber = (existingTask?.attempts?.length || 0) + 1;
    if (existingTask) {
      await this.workbench.updateTaskTrackerMetadata?.(task.id, {
        title,
        description: task.description,
        goal,
        priority: task.priority,
        labels: task.labels,
        assignee: task.assignee,
        humanAssignee: task.assignee,
        createdBy: task.createdBy,
        sourceUrl: task.sourceUrl,
      });
    }
    const workbenchTask = existingTask
      ? existingTask
      : await this.workbench.createTask({
      id: task.id,
      identifier: task.shortIdentifier,
      shortIdentifier: task.shortIdentifier,
      title,
      description: task.description,
      goal,
      status: 'in_progress',
      state: task.state,
      priority: task.priority,
      labels: task.labels,
      blockedBy: normalizeBlockers(task.blockedBy),
      blockedByTaskIds: task.blockedBy.map((blocker) => blocker.id).filter((id): id is string => Boolean(id)),
      assignee: task.assignee,
      humanAssignee: task.assignee,
      createdBy: task.createdBy,
      sourceUrl: task.sourceUrl,
      workspaceBinding,
    }, task.id);
    await this.workbench.appendAttempt?.(workbenchTask.id, {
      attemptNumber,
      startedAt: new Date().toISOString(),
      kernelTaskId: kernelTask?.id,
      turnCount: input.attempt,
    });
    if (kernelTask) {
      await this.options.runTask?.(kernelTask, { workbenchTaskId: workbenchTask.id });
    }
    return {
      taskId: kernelTask?.id || workbenchTask.id,
      workbenchTaskId: workbenchTask.id,
      projectPath,
    };
  }

  async stopRun(input: { taskId: string; reason: string; task: TrackedTask; run: TrackerRunRecord }): Promise<void> {
    await this.options.stopTask?.(input.taskId, input.reason);
  }

  async isRunActive(kernelTaskId: string): Promise<boolean> {
    return Boolean(await this.options.isRunActive?.(kernelTaskId));
  }

  async runHook(name: string, input: { task: TrackedTask; workspaceRoot: string; projectPath: string; run?: TrackerRunRecord }): Promise<void> {
    await this.options.runHook?.(name, input);
  }

  async cleanupWorkspace(input: { task: TrackedTask; workspaceRoot: string; projectPath: string; run?: TrackerRunRecord }): Promise<void> {
    await this.options.cleanupWorkspace?.(input);
  }

  async markAttemptFailed(taskId: string, error: string): Promise<void> {
    const task = await this.workbench.readTask?.(taskId);
    const openAttempts = task?.attempts?.filter((attempt) => !attempt.finishedAt) || [];
    for (const attempt of openAttempts) {
      await this.workbench.finishAttempt?.(taskId, attempt.attemptNumber, 'failed', error);
    }
    if (task && task.status !== 'failed') {
      await this.workbench.transitionTask?.(taskId, 'failed', {
        actor: 'daemon',
        reason: error,
      });
    }
  }

  private buildWorkspaceBinding(
    task: TrackedTask,
    target: {
      workspaceRoot: string;
      workspaceName: string;
      projectName?: string;
      sourceProjectPath: string;
      effectiveProjectPath: string;
      laneId?: string;
      worktreeKind?: TaskWorkspaceBinding['worktreeKind'];
      worktreePath?: string;
    },
  ): TaskWorkspaceBinding {
    return {
      workspaceRoot: target.workspaceRoot,
      workspaceName: target.workspaceName,
      workspaceFile: task.repository?.workspaceFile,
      projectName: target.projectName,
      sourceProjectPath: target.sourceProjectPath,
      effectiveProjectPath: target.effectiveProjectPath,
      laneId: target.laneId,
      worktreeKind: target.worktreeKind || 'root',
      worktreePath: target.worktreePath,
    };
  }
}

function normalizeBlockers(blockers: TrackedTask['blockedBy']): WorkbenchTaskBlockerRecord[] {
  return blockers.map((blocker) => ({
    id: blocker.id,
    shortIdentifier: blocker.shortIdentifier,
    state: blocker.state,
  }));
}
