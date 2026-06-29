import * as path from 'node:path';
import * as fs from 'node:fs/promises';
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
    if (existingTask) {
      task.agentLoop = existingTask.agentLoop;
      task.comments = existingTask.comments;
      task.latestSummary = existingTask.latestSummary;
      task.timeline = existingTimeline;
    }
    const taskContextSnapshot = buildTaskContextSnapshot(existingTask, existingTimeline);
    if (existingTask && (existingTask.status === 'todo' || existingTask.status === 'retry' || existingTask.status === 'failed' || existingTask.status === 'backlog')) {
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

  async markRuntimeRunStarted(
    task: TrackedTask,
    input: {
      runId: string;
      attempt: number;
      projectPath: string;
      runner: string;
      mode: string;
      startedAt: string;
    },
  ): Promise<{ attemptNumber: number }> {
    const existingTask = await this.workbench.readTask?.(task.id);
    const sourceProjectPath = task.repository?.sourcePath || task.repository?.path || this.options.defaultProjectPath;
    const effectiveProjectPath = input.projectPath || task.repository?.path || sourceProjectPath;
    const workspaceBinding = existingTask?.workspaceBinding || this.buildWorkspaceBinding(task, {
      workspaceRoot: this.options.workspaceRoot,
      workspaceName: this.options.workspaceName || path.basename(this.options.workspaceRoot),
      projectName: task.repository?.name || path.basename(sourceProjectPath),
      sourceProjectPath,
      effectiveProjectPath,
      laneId: task.shortIdentifier.toLowerCase().replace(/[^a-z0-9._-]+/g, '-'),
      worktreeKind: effectiveProjectPath === sourceProjectPath ? 'root' : 'git-worktree',
      worktreePath: effectiveProjectPath === sourceProjectPath ? undefined : effectiveProjectPath,
    });
    const goalBody = task.description?.trim() || task.title;
    const goal = [
      goalBody,
      task.sourceUrl ? `Tracker: ${task.sourceUrl}` : undefined,
      task.labels.length ? `Labels: ${task.labels.join(', ')}` : undefined,
    ].filter(Boolean).join('\n\n');
    const workbenchTask = existingTask || await this.workbench.createTask({
      id: task.id,
      identifier: task.shortIdentifier,
      shortIdentifier: task.shortIdentifier,
      title: task.title,
      description: task.description,
      goal,
      status: 'todo',
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

    if (existingTask) {
      await this.workbench.updateTaskTrackerMetadata?.(task.id, {
        title: task.title,
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

    const attemptNumber = (workbenchTask.attempts?.length || 0) + 1;
    await this.workbench.appendAttempt?.(workbenchTask.id, {
      attemptNumber,
      startedAt: input.startedAt,
      kernelTaskId: input.runId,
      turnCount: input.attempt,
    });
    await this.workbench.appendTaskRun?.(workbenchTask.id, {
      runId: input.runId,
      startedAt: input.startedAt,
      status: 'running',
      kernelTaskId: input.runId,
      agentName: input.runner,
      turnCount: input.attempt,
    });
    return { attemptNumber };
  }

  async markRuntimeRunFinished(
    taskId: string,
    input: {
      runId: string;
      attemptNumber: number;
      completion: { status: 'completed' | 'failed' | 'cancelled'; error?: string };
      endedAt: string;
      runner?: 'codex' | 'claude-code';
    },
  ): Promise<void> {
    const outcome = input.completion.status === 'completed'
      ? 'completed'
      : input.completion.status === 'cancelled'
        ? 'cancelled'
        : 'failed';
    await this.workbench.finishAttempt?.(taskId, input.attemptNumber, outcome, input.completion.error);

    const task = await this.workbench.readTask?.(taskId);
    const existingRun = task?.runs?.find((run) => run.runId === input.runId);
    await this.workbench.appendTaskRun?.(taskId, {
      ...(existingRun || {
        runId: input.runId,
        startedAt: input.endedAt,
      }),
      endedAt: input.endedAt,
      status: outcome,
      kernelTaskId: existingRun?.kernelTaskId || input.runId,
      errorReason: input.completion.error,
    });

    const latestTask = await this.workbench.readTask?.(taskId);
    if (!latestTask) return;
    const stdout = await readRuntimeStdout(this.options.workspaceRoot, input.runId);
    const advanced = await this.workbench.advanceReviewLoopAfterRuntime?.(taskId, {
      runner: input.runner
        || (existingRun?.agentName === 'claude-code' ? 'claude-code' : existingRun?.agentName === 'codex' ? 'codex' : undefined)
        || 'codex',
      status: input.completion.status,
      stdout,
      runId: input.runId,
    });
    if (advanced) {
      return;
    }
    if (input.completion.status === 'completed' && latestTask.status !== 'in_review' && latestTask.status !== 'needs_review') {
      await this.workbench.transitionTask?.(taskId, 'needs_review', {
        actor: 'daemon',
        reason: 'Runtime runner completed and is ready for review.',
      });
    } else if (input.completion.status === 'failed' && latestTask.status !== 'blocked') {
      await this.workbench.transitionTask?.(taskId, 'blocked', {
        actor: 'daemon',
        reason: input.completion.error
          ? `Runtime runner failed: ${input.completion.error}`
          : 'Runtime runner failed. Add /retry when ready to run it again.',
      });
    } else if (input.completion.status === 'cancelled' && latestTask.status !== 'cancelled') {
      await this.workbench.transitionTask?.(taskId, 'cancelled', {
        actor: 'daemon',
        reason: input.completion.error || 'Runtime runner was cancelled.',
      });
    }
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

async function readRuntimeStdout(workspaceRoot: string, runId: string): Promise<string | undefined> {
  const stdoutPath = path.join(workspaceRoot, '.tik', 'runs', runId, 'stdout.log');
  return fs.readFile(stdoutPath, 'utf-8').catch(() => undefined);
}
