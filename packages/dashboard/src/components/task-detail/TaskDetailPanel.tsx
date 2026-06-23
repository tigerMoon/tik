import React, { useMemo, useState } from 'react';
import type { EnvironmentPackManifest } from '@tik/shared';
import { canArchiveWorkbenchTask, canRetryWorkbenchTask } from '@tik/shared';
import type {
  UpdateWorkbenchTaskBriefResult,
  UpdateWorkbenchTaskConfigurationInput,
  WorkbenchDecisionResponse,
  WorkbenchTaskResponse,
  WorkbenchTimelineResponseItem,
} from '../../api/client';
import {
  buildTaskStatusBannerSpec,
  type TaskStatusBannerAction,
} from '../../view-models/workbench';
import { TaskDetailHeader } from './TaskDetailHeader';
import { TaskStatusBanner } from './TaskStatusBanner';
import { TaskDecisionBlock } from './TaskDecisionBlock';
import { TaskBriefBlock } from './TaskBriefBlock';
import { TaskActivityBlock } from './TaskActivityBlock';
import { TaskAcceptanceBlock } from './TaskAcceptanceBlock';
import { TaskExecutionSetupBlock } from './TaskExecutionSetupBlock';
import { TaskCommentsBlock } from './TaskCommentsBlock';
import { TaskPropertiesRail } from './TaskPropertiesRail';

interface TaskDetailPanelProps {
  task: WorkbenchTaskResponse | null;
  pack: EnvironmentPackManifest | null;
  packs: EnvironmentPackManifest[];
  timeline: WorkbenchTimelineResponseItem[];
  decisions: WorkbenchDecisionResponse[];
  resolvingDecisionId?: string | null;
  retrying: boolean;
  archiving: boolean;
  savingAdjustment: boolean;
  revertingAdjustment: boolean;
  savingConfiguration: boolean;
  controllingTaskAction?: 'pause' | 'resume' | 'stop' | null;
  timelineError?: string | null;
  onRetryTask: (task: WorkbenchTaskResponse) => Promise<void>;
  onArchiveTask: (task: WorkbenchTaskResponse) => Promise<void>;
  onApplyTaskAdjustment: (
    task: WorkbenchTaskResponse,
    input: { title: string; goal: string; adjustment?: string; launchFollowUp?: boolean },
  ) => Promise<UpdateWorkbenchTaskBriefResult>;
  onRevertLastAdjustment: (task: WorkbenchTaskResponse) => Promise<void>;
  onResolveDecision?: (
    taskId: string,
    decisionId: string,
    body: { optionId?: string; message?: string },
  ) => Promise<void>;
  onSaveTaskConfiguration: (taskId: string, selection: UpdateWorkbenchTaskConfigurationInput) => Promise<void>;
  /** Status transitions triggered by banner actions (reopen, unblock) reuse this handler. */
  onUpdateTaskMetadata: (
    task: WorkbenchTaskResponse,
    input: Partial<Pick<WorkbenchTaskResponse, 'status' | 'priority' | 'labels' | 'parentTaskId' | 'humanAssignee'>>,
  ) => Promise<void>;
  onAddTaskComment: (task: WorkbenchTaskResponse, body: string) => Promise<void>;
  /** Banner stop/resume route through this. */
  onControlTask: (taskId: string, action: 'pause' | 'resume' | 'stop') => Promise<void>;
}

export function TaskDetailPanel(props: TaskDetailPanelProps) {
  const {
    task,
    pack,
    packs,
    timeline,
    decisions,
    resolvingDecisionId,
    retrying,
    archiving,
    savingAdjustment,
    revertingAdjustment,
    savingConfiguration,
    controllingTaskAction,
    timelineError,
    onRetryTask,
    onArchiveTask,
    onApplyTaskAdjustment,
    onRevertLastAdjustment,
    onResolveDecision,
    onSaveTaskConfiguration,
    onUpdateTaskMetadata,
    onAddTaskComment,
    onControlTask,
  } = props;

  const [bannerActionId, setBannerActionId] = useState<TaskStatusBannerAction['id'] | null>(null);

  const bannerSpec = useMemo(
    () => buildTaskStatusBannerSpec(task, decisions),
    [task, decisions],
  );
  const primaryDecision = decisions[0] || null;

  if (!task) {
    return (
      <section className="task-detail-panel task-detail-panel-empty">
        <div className="task-detail-panel-empty-body">
          <strong>Pick a task</strong>
          <span>Choose a task on the right to inspect status, activity, and metadata.</span>
        </div>
      </section>
    );
  }

  const handleBannerAction = async (action: TaskStatusBannerAction) => {
    if (bannerActionId) return;
    setBannerActionId(action.id);
    try {
      switch (action.id) {
        case 'retry':
        case 'run-next-pass':
          if (!canRetryWorkbenchTask(task.status) && action.id === 'retry') break;
          await onRetryTask(task);
          break;
        case 'archive':
          if (!canArchiveWorkbenchTask(task.status)) break;
          await onArchiveTask(task);
          break;
        case 'cancel':
        case 'stop':
          await onControlTask(task.id, 'stop');
          break;
        case 'resume':
          await onControlTask(task.id, 'resume');
          break;
        case 'reopen':
          await onUpdateTaskMetadata(task, { status: 'todo' });
          break;
        case 'unblock':
          await onUpdateTaskMetadata(task, { status: 'todo' });
          break;
        default:
          break;
      }
    } finally {
      setBannerActionId(null);
    }
  };

  return (
    <section className="task-detail-panel">
      <div className="task-detail-main">
        <TaskDetailHeader task={task} />

        <TaskStatusBanner
          spec={bannerSpec}
          busyActionId={bannerActionId}
          onAction={handleBannerAction}
        />

        <TaskDecisionBlock
          task={task}
          decision={primaryDecision}
          resolvingDecisionId={resolvingDecisionId}
          onResolveDecision={onResolveDecision}
        />

        {timelineError ? (
          <div className="task-detail-error-banner">{timelineError}</div>
        ) : null}

        <TaskBriefBlock
          task={task}
          savingAdjustment={savingAdjustment}
          revertingAdjustment={revertingAdjustment}
          onApplyTaskAdjustment={onApplyTaskAdjustment}
          onRevertLastAdjustment={onRevertLastAdjustment}
        />

        <TaskActivityBlock task={task} timeline={timeline} />

        <TaskAcceptanceBlock task={task} timeline={timeline} decisions={decisions} />

        <TaskExecutionSetupBlock
          task={task}
          pack={pack}
          packs={packs}
          savingConfiguration={savingConfiguration}
          onSaveTaskConfiguration={onSaveTaskConfiguration}
        />

        {/* Indicator for retrying/archiving still in progress when banner button isn't lit */}
        {(retrying && bannerActionId !== 'retry' && bannerActionId !== 'run-next-pass')
          || (archiving && bannerActionId !== 'archive') ? (
            <div className="task-detail-brief-feedback">
              {retrying ? 'Starting next pass…' : 'Archiving task…'}
            </div>
          ) : null}

        <TaskCommentsBlock task={task} timeline={timeline} onAddTaskComment={onAddTaskComment} />
      </div>

      <TaskPropertiesRail
        task={task}
        pack={pack}
        controllingTaskAction={controllingTaskAction}
        onUpdateTaskMetadata={onUpdateTaskMetadata}
        onControlTask={onControlTask}
      />
    </section>
  );
}
