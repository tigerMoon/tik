import React, { useMemo, useState } from 'react';
import { canRetryWorkbenchTask } from '@tik/shared';
import { buildTaskStatusBannerSpec, canArchiveWorkbenchTaskFromBanner, DASHBOARD_AGENT_LOOP_APPROVE_COMMENT, getPreferredReviewArtifactId, } from '../../view-models/workbench';
import { TaskDetailHeader } from './TaskDetailHeader';
import { TaskStatusBanner } from './TaskStatusBanner';
import { TaskDecisionBlock } from './TaskDecisionBlock';
import { TaskBriefBlock } from './TaskBriefBlock';
import { TaskActivityBlock } from './TaskActivityBlock';
import { TaskAcceptanceBlock } from './TaskAcceptanceBlock';
import { TaskRunProofPanel } from './TaskRunProofPanel';
import { TaskExecutionSetupBlock } from './TaskExecutionSetupBlock';
import { TaskCommentsBlock } from './TaskCommentsBlock';
import { TaskArtifactRail } from './TaskArtifactRail';
import { TaskPropertiesRail } from './TaskPropertiesRail';
export function TaskDetailPanel(props) {
    const { task, pack, packs, timeline, decisions, artifacts = [], resolvingDecisionId, retrying, archiving, savingAdjustment, revertingAdjustment, savingConfiguration, controllingTaskAction, timelineError, onRetryTask, onArchiveTask, onApplyTaskAdjustment, onRevertLastAdjustment, onResolveDecision, onSaveTaskConfiguration, onUpdateTaskMetadata, onAddTaskComment, onGenerateArtifact, onAcceptArtifact, onRejectArtifact, onOpenArtifact, generatingArtifact, busyArtifactId, onControlTask, } = props;
    const [bannerActionId, setBannerActionId] = useState(null);
    const bannerSpec = useMemo(() => buildTaskStatusBannerSpec(task, decisions), [task, decisions]);
    const primaryDecision = decisions[0] || null;
    if (!task) {
        return (<section className="task-detail-panel task-detail-panel-empty">
        <div className="task-detail-panel-empty-body">
          <strong>Pick a task</strong>
          <span>Choose a task on the right to inspect status, activity, and metadata.</span>
        </div>
      </section>);
    }
    const handleBannerAction = async (action) => {
        if (bannerActionId)
            return;
        setBannerActionId(action.id);
        try {
            switch (action.id) {
                case 'retry':
                case 'run-next-pass':
                    if (!canRetryWorkbenchTask(task.status) && action.id === 'retry')
                        break;
                    await onRetryTask(task);
                    break;
                case 'archive':
                    if (!canArchiveWorkbenchTaskFromBanner(task))
                        break;
                    await onArchiveTask(task);
                    break;
                case 'approve-review':
                    await onAddTaskComment(task, DASHBOARD_AGENT_LOOP_APPROVE_COMMENT);
                    break;
                case 'cancel':
                case 'stop':
                    await onControlTask(task.id, 'stop');
                    break;
                case 'resume':
                    await onControlTask(task.id, 'resume');
                    break;
                case 'open-review': {
                    const artifactId = getPreferredReviewArtifactId(artifacts);
                    if (artifactId) {
                        onOpenArtifact?.(artifactId);
                    }
                    break;
                }
                case 'reopen':
                    await onUpdateTaskMetadata(task, { status: 'todo' });
                    break;
                case 'unblock':
                    await onUpdateTaskMetadata(task, { status: 'todo' });
                    break;
                default:
                    break;
            }
        }
        finally {
            setBannerActionId(null);
        }
    };
    return (<section className="task-detail-panel">
      <div className="task-detail-main">
        <TaskDetailHeader task={task}/>

        <TaskStatusBanner spec={bannerSpec} busyActionId={bannerActionId} onAction={handleBannerAction}/>

        <TaskDecisionBlock task={task} decision={primaryDecision} resolvingDecisionId={resolvingDecisionId} onResolveDecision={onResolveDecision}/>

        {timelineError ? (<div className="task-detail-error-banner">{timelineError}</div>) : null}

        <TaskBriefBlock task={task} savingAdjustment={savingAdjustment} revertingAdjustment={revertingAdjustment} onApplyTaskAdjustment={onApplyTaskAdjustment} onRevertLastAdjustment={onRevertLastAdjustment}/>

        <TaskActivityBlock task={task} timeline={timeline}/>

        <TaskRunProofPanel task={task} artifacts={artifacts} busyArtifactId={busyArtifactId} onAcceptArtifact={onAcceptArtifact} onRejectArtifact={onRejectArtifact} onOpenArtifact={onOpenArtifact}/>

        <TaskAcceptanceBlock task={task} timeline={timeline} decisions={decisions} artifacts={artifacts}/>

        <TaskArtifactRail task={task} artifacts={artifacts} loading={generatingArtifact} onGenerate={onGenerateArtifact || (async () => { })} onOpenArtifact={onOpenArtifact || (() => { })}/>

        <TaskExecutionSetupBlock task={task} pack={pack} packs={packs} savingConfiguration={savingConfiguration} onSaveTaskConfiguration={onSaveTaskConfiguration}/>

        {/* Indicator for retrying/archiving still in progress when banner button isn't lit */}
        {(retrying && bannerActionId !== 'retry' && bannerActionId !== 'run-next-pass')
            || (archiving && bannerActionId !== 'archive') ? (<div className="task-detail-brief-feedback">
              {retrying ? 'Starting next pass…' : 'Archiving task…'}
            </div>) : null}

        <TaskCommentsBlock task={task} timeline={timeline} onAddTaskComment={onAddTaskComment}/>
      </div>

      <TaskPropertiesRail task={task} pack={pack} controllingTaskAction={controllingTaskAction} onUpdateTaskMetadata={onUpdateTaskMetadata} onControlTask={onControlTask}/>
    </section>);
}
//# sourceMappingURL=TaskDetailPanel.js.map