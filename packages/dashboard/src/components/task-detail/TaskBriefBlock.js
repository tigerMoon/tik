import React, { useEffect, useId, useState } from 'react';
import { buildWorkbenchSteeringUpdateInput } from '../../view-models/workbench';
export function TaskBriefBlock({ task, savingAdjustment, revertingAdjustment, onApplyTaskAdjustment, onRevertLastAdjustment, }) {
    const titleInputId = useId();
    const goalInputId = useId();
    const adjustmentInputId = useId();
    const [editing, setEditing] = useState(false);
    const [draftTitle, setDraftTitle] = useState(task.title);
    const [draftGoal, setDraftGoal] = useState(task.goal);
    const [adjustmentNote, setAdjustmentNote] = useState('');
    const [feedback, setFeedback] = useState(null);
    useEffect(() => {
        setDraftTitle(task.title);
        setDraftGoal(task.goal);
        setAdjustmentNote('');
        setFeedback(null);
        setEditing(false);
    }, [task.id, task.title, task.goal]);
    const description = task.description?.trim() || task.goal?.trim() || '';
    return (<section className="task-detail-brief">
      <div className="task-detail-block-head">
        <span className="task-detail-block-label">Brief</span>
        <button type="button" className="task-detail-block-toggle" onClick={() => setEditing((current) => !current)}>
          {editing ? 'Hide editor' : 'Edit brief'}
        </button>
      </div>

      {description ? (<p className="task-detail-brief-body">{description}</p>) : (<p className="task-detail-brief-body is-empty">No description yet. Edit the brief to add one.</p>)}

      {editing ? (<div className="task-detail-brief-editor">
          <label htmlFor={titleInputId} className="task-launch-label">Task title</label>
          <input id={titleInputId} className="task-launch-field" value={draftTitle} onChange={(event) => {
                setDraftTitle(event.target.value);
                setFeedback(null);
            }}/>

          <label htmlFor={goalInputId} className="task-launch-label">Task brief</label>
          <textarea id={goalInputId} className="task-launch-field task-launch-textarea" rows={4} value={draftGoal} onChange={(event) => {
                setDraftGoal(event.target.value);
                setFeedback(null);
            }}/>

          <label htmlFor={adjustmentInputId} className="task-launch-label">Adjustment note</label>
          <textarea id={adjustmentInputId} className="task-launch-field task-launch-textarea" rows={3} value={adjustmentNote} onChange={(event) => {
                setAdjustmentNote(event.target.value);
                setFeedback(null);
            }} placeholder="Add scope constraints, acceptance bars, or review notes"/>

          <div className="task-detail-brief-actions">
            <button type="button" className="task-launch-button" disabled={savingAdjustment} onClick={async () => {
                try {
                    const result = await onApplyTaskAdjustment(task, buildWorkbenchSteeringUpdateInput(task, {
                        title: draftTitle,
                        goal: draftGoal,
                        adjustment: adjustmentNote,
                    }));
                    setAdjustmentNote('');
                    if (result.followUpTask) {
                        setFeedback('Guidance saved and the next pass is now running.');
                    }
                    else if (task.status !== 'running' && result.task.status === 'running') {
                        setFeedback('Guidance saved and the task resumed.');
                    }
                    else {
                        setFeedback('Guidance saved.');
                    }
                }
                catch (err) {
                    setFeedback(err.message || 'Unable to save task guidance.');
                }
            }}>
              {savingAdjustment ? 'Saving…' : 'Save guidance'}
            </button>
            <button type="button" className="console-secondary-button" disabled={savingAdjustment} onClick={() => {
                setDraftTitle(task.title);
                setDraftGoal(task.goal);
                setAdjustmentNote('');
                setFeedback(null);
            }}>
              Reset
            </button>
            <button type="button" className="console-secondary-button" disabled={!task.lastAdjustment || revertingAdjustment || savingAdjustment} onClick={async () => {
                try {
                    await onRevertLastAdjustment(task);
                    setFeedback('Latest guidance reverted.');
                }
                catch (err) {
                    setFeedback(err.message || 'Unable to revert guidance.');
                }
            }}>
              {revertingAdjustment ? 'Reverting…' : 'Revert last guidance'}
            </button>
          </div>
          {feedback ? <div className="task-detail-brief-feedback">{feedback}</div> : null}
        </div>) : null}
    </section>);
}
//# sourceMappingURL=TaskBriefBlock.js.map