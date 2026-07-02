import React, { useEffect, useMemo, useState } from 'react';
import { allowedMetadataStatuses, buildWorkbenchAgentLoopSummary, buildWorkbenchRuntimeControlActions, buildWorkbenchWorkspaceBindingSummary, } from '../../view-models/workbench';
import { ChipMultiSelect } from './ChipMultiSelect';
import { buildWorkbenchLabelSelectOptions, WorkbenchLabelGuide, } from './WorkbenchLabelGuide';
const PRIORITY_OPTIONS = [
    { value: '', label: 'None' },
    { value: 1, label: 'Urgent' },
    { value: 2, label: 'High' },
    { value: 3, label: 'Normal' },
    { value: 4, label: 'Low' },
];
export function TaskPropertiesRail({ task, pack, controllingTaskAction, wrapperClassName, onUpdateTaskMetadata, onControlTask, }) {
    const [saving, setSaving] = useState(false);
    const [assigneeDraft, setAssigneeDraft] = useState(task.humanAssignee || '');
    useEffect(() => {
        setAssigneeDraft(task.humanAssignee || '');
    }, [task.id]);
    const guardSave = async (fn) => {
        setSaving(true);
        try {
            await fn();
        }
        finally {
            setSaving(false);
        }
    };
    const workspaceSummary = buildWorkbenchWorkspaceBindingSummary(task.workspaceBinding);
    const agentLoopSummary = buildWorkbenchAgentLoopSummary(task.agentLoop);
    const lastAttempt = task.attempts?.at(-1);
    const statuses = allowedMetadataStatuses(task.status);
    const runtimeControlActions = buildWorkbenchRuntimeControlActions(task.status);
    const labelEnvironment = pack || task.environmentPackSnapshot || null;
    const labelOptions = useMemo(() => buildWorkbenchLabelSelectOptions(labelEnvironment), [labelEnvironment]);
    return (<aside className={`task-detail-rail${wrapperClassName ? ` ${wrapperClassName}` : ''}`} aria-busy={saving}>
      <div className="task-detail-rail-section">
        <div className="task-detail-rail-label">Status</div>
        <select className="task-launch-field" value={task.status} disabled={saving} onChange={(event) => guardSave(() => onUpdateTaskMetadata(task, {
            status: event.target.value,
        }))}>
          {statuses.map((status) => (<option key={status} value={status}>{status.replace(/_/g, ' ')}</option>))}
        </select>
      </div>

      <div className="task-detail-rail-section">
        <div className="task-detail-rail-label">Priority</div>
        <select className="task-launch-field" value={task.priority ?? ''} disabled={saving} onChange={(event) => guardSave(() => onUpdateTaskMetadata(task, {
            priority: event.target.value ? Number(event.target.value) : null,
        }))}>
          {PRIORITY_OPTIONS.map((option) => (<option key={String(option.value)} value={option.value}>{option.label}</option>))}
        </select>
      </div>

      <div className="task-detail-rail-section">
        <div className="task-detail-rail-label">Labels</div>
        <ChipMultiSelect values={task.labels || []} options={labelOptions} placeholder="Add label, press Enter" disabled={saving} onChange={(next) => guardSave(() => onUpdateTaskMetadata(task, { labels: next }))}/>
        <WorkbenchLabelGuide environment={labelEnvironment}/>
      </div>

      <div className="task-detail-rail-section">
        <div className="task-detail-rail-label">Assignee</div>
        <input className="task-launch-field" value={assigneeDraft} disabled={saving} onChange={(event) => setAssigneeDraft(event.target.value)} onBlur={() => {
            const next = assigneeDraft.trim() || null;
            if (next === (task.humanAssignee || null)) {
                return;
            }
            void guardSave(() => onUpdateTaskMetadata(task, { humanAssignee: next }));
        }} placeholder="(unassigned)"/>
      </div>

      <div className="task-detail-rail-section">
        <div className="task-detail-rail-label">Workspace</div>
        <div className="task-detail-rail-readonly">
          <strong>{workspaceSummary.headline}</strong>
          <span>{workspaceSummary.scopeLabel}</span>
          <span>{workspaceSummary.pathLabel}</span>
        </div>
      </div>

      {agentLoopSummary ? (<div className="task-detail-rail-section">
          <div className="task-detail-rail-label">Review loop</div>
          <div className="task-detail-rail-readonly">
            <strong>{agentLoopSummary.label}</strong>
            <span>{agentLoopSummary.detail}</span>
            <span>root {task.agentLoop?.rootTaskId} · key {task.agentLoop?.idempotencyKey}</span>
            {task.agentLoop?.reviewResult ? (<span>verdict {task.agentLoop.reviewResult.verdict} · {task.agentLoop.reviewResult.blockingIssues.length} blocking</span>) : null}
            {task.agentLoop?.stale ? (<span>stale expected {task.agentLoop.stale.expectedHeadSha} · actual {task.agentLoop.stale.actualHeadSha}</span>) : null}
          </div>
        </div>) : null}

      <div className="task-detail-rail-section">
        <div className="task-detail-rail-label">Pack</div>
        <div className="task-detail-rail-readonly">
          <strong>{pack ? `${pack.name} · v${pack.version}` : task.environmentPackSnapshot?.id || 'No pack bound'}</strong>
          {pack ? <span>{pack.id}</span> : null}
        </div>
      </div>

      <div className="task-detail-rail-section">
        <div className="task-detail-rail-label">Last run</div>
        <div className="task-detail-rail-readonly">
          <strong>{task.activeSessionId ? `run-${task.activeSessionId.slice(0, 8)}` : 'No active run'}</strong>
          {lastAttempt ? (<span>attempt #{lastAttempt.attemptNumber} · {lastAttempt.outcome || 'running'}</span>) : null}
        </div>
      </div>

      {(task.attempts || []).length > 0 ? (<div className="task-detail-rail-section">
          <div className="task-detail-rail-label">Attempts</div>
          <ul className="task-detail-rail-list">
            {(task.attempts || []).slice().reverse().slice(0, 5).map((attempt) => (<li key={attempt.attemptNumber} className={`task-detail-rail-list-row outcome-${attempt.outcome || 'running'}`}>
                <strong>#{attempt.attemptNumber}</strong>
                <span>{attempt.outcome || 'running'}</span>
                {attempt.error ? <em>{attempt.error}</em> : null}
              </li>))}
          </ul>
        </div>) : null}

      {runtimeControlActions.length > 0 ? (<div className="task-detail-rail-section task-detail-rail-controls">
          {runtimeControlActions.map((action) => (<button key={action.id} type="button" className={action.danger ? 'console-danger-button' : 'console-secondary-button'} disabled={controllingTaskAction !== null} onClick={() => onControlTask(task.id, action.id)}>
              {controllingTaskAction === action.id ? action.pendingLabel : action.label}
            </button>))}
        </div>) : null}
    </aside>);
}
//# sourceMappingURL=TaskPropertiesRail.js.map