import React, { useEffect, useId, useMemo, useState } from 'react';
import { canArchiveWorkbenchTask, canRetryWorkbenchTask } from '@tik/shared';
import type {
  UpdateWorkbenchTaskBriefResult,
  WorkbenchDecisionResponse,
  WorkbenchTaskResponse,
  WorkbenchTimelineResponseItem,
} from '../api/client';
import { buildWorkbenchArtifactPreviewUrl } from '../api/client';
import {
  buildWorkbenchSteeringUpdateInput,
  buildWorkbenchOperatorNoteSummary,
  buildWorkbenchWorkspaceBindingSummary,
  parseWorkbenchEvidence,
} from '../view-models/workbench';

interface WorkbenchTaskHeaderProps {
  task: WorkbenchTaskResponse | null;
  timeline: WorkbenchTimelineResponseItem[];
  decisions: WorkbenchDecisionResponse[];
  resolvingDecisionId?: string | null;
  retrying: boolean;
  archiving: boolean;
  savingAdjustment: boolean;
  revertingAdjustment: boolean;
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
}

export function WorkbenchTaskHeader({
  task,
  timeline,
  decisions,
  resolvingDecisionId,
  retrying,
  archiving,
  savingAdjustment,
  revertingAdjustment,
  onRetryTask,
  onArchiveTask,
  onApplyTaskAdjustment,
  onRevertLastAdjustment,
  onResolveDecision,
}: WorkbenchTaskHeaderProps) {
  const titleInputId = useId();
  const goalInputId = useId();
  const adjustmentInputId = useId();
  const [draftTitle, setDraftTitle] = useState('');
  const [draftGoal, setDraftGoal] = useState('');
  const [adjustmentNote, setAdjustmentNote] = useState('');
  const [saveMessage, setSaveMessage] = useState<string | null>(null);

  useEffect(() => {
    setDraftTitle(task?.title || '');
    setDraftGoal(task?.goal || '');
    setAdjustmentNote('');
    setSaveMessage(null);
  }, [task?.goal, task?.id, task?.title]);

  const primaryDecision = decisions[0] || null;
  const recommendedOption = primaryDecision?.options.find((option) => option.id === primaryDecision.recommendedOptionId) || null;
  const rawItems = useMemo(() => timeline.filter((item) => item.kind === 'raw'), [timeline]);
  const evidenceFacts = useMemo(() => {
    const files = new Set<string>();
    const artifacts = new Set<string>();

    rawItems.forEach((item) => {
      const parsed = parseWorkbenchEvidence(item);
      parsed.filesModified.forEach((filePath) => files.add(filePath));
      parsed.previewableArtifacts.forEach((filePath) => artifacts.add(filePath));
    });

    return {
      evidenceCount: rawItems.length,
      fileCount: files.size,
      artifactCount: artifacts.size,
    };
  }, [rawItems]);
  const workspaceBindingSummary = useMemo(
    () => buildWorkbenchWorkspaceBindingSummary(task?.workspaceBinding),
    [task?.workspaceBinding],
  );
  const previewArtifactPath = task?.evidenceSummary?.latestPreviewableArtifactPath || null;
  const previewArtifactUrl = previewArtifactPath
    ? buildWorkbenchArtifactPreviewUrl(previewArtifactPath)
    : null;
  const operatorNoteSummary = useMemo(
    () => (task ? buildWorkbenchOperatorNoteSummary(task) : null),
    [task],
  );

  const focusFacts = task ? [
    {
      label: primaryDecision ? 'Operator ask' : 'Task state',
      value: primaryDecision
        ? (recommendedOption?.label || 'Review options')
        : task.status.replace(/_/g, ' '),
      detail: primaryDecision
        ? (primaryDecision.summary || 'Choose the path that lets the task keep moving.')
        : `${evidenceFacts.evidenceCount} evidence event${evidenceFacts.evidenceCount === 1 ? '' : 's'} captured`,
    },
    {
      label: primaryDecision ? 'Risk window' : 'Workspace',
      value: primaryDecision ? primaryDecision.risk : workspaceBindingSummary.headline,
      detail: primaryDecision
        ? (task.waitingReason || `${task.currentOwner || 'supervisor'} paused before the next move.`)
        : `${workspaceBindingSummary.scopeLabel} · ${workspaceBindingSummary.pathLabel}`,
    },
    {
      label: primaryDecision ? 'Latest output' : 'Recent output',
      value: evidenceFacts.artifactCount > 0
        ? `${evidenceFacts.artifactCount} artifact${evidenceFacts.artifactCount === 1 ? '' : 's'}`
        : `${evidenceFacts.fileCount} file${evidenceFacts.fileCount === 1 ? '' : 's'}`,
      detail: evidenceFacts.artifactCount > 0
        ? `${evidenceFacts.fileCount} touched file${evidenceFacts.fileCount === 1 ? '' : 's'} in the current pass`
        : (task.lastProgressAt || task.updatedAt),
    },
  ] : [];

  const canRetry = !!task && canRetryWorkbenchTask(task.status);
  const canArchive = !!task && canArchiveWorkbenchTask(task.status);

  if (!task) {
    return (
      <section className="focus-card">
        <div className="focus-head">
          <strong>Focus</strong>
          <span className="focus-id">No task selected</span>
        </div>
        <div className="focus-title">Pick a task from the queue</div>
        <p className="focus-copy">
          The inbox view collapses each running workspace into one decision-ready surface. Choose a task to review its summary, recent evidence, and operator actions.
        </p>
      </section>
    );
  }

  return (
    <section className="focus-card">
      <div className="focus-head">
        <strong>Focus</strong>
        <span className="focus-id">{task.id.slice(0, 8).toUpperCase()}</span>
      </div>

      <div className="focus-title">
        {primaryDecision?.title || task.title}
      </div>

      <div className="focus-callout">
        <span className="focus-callout-dot" />
        {primaryDecision
          ? 'Execution has been compressed into a single operator decision.'
          : 'Execution is summarized here so you can steer without reading the full run log.'}
      </div>

      <div className="focus-chip-row">
        <span className="focus-chip">
          <span className={`focus-chip-dot is-${task.status === 'waiting_for_user' ? 'yellow' : task.status === 'completed' ? 'green' : 'blue'}`} />
          {task.status.replace(/_/g, ' ')}
        </span>
        {primaryDecision ? (
          <span className="focus-chip">
            <span className={`focus-chip-dot is-${primaryDecision.risk === 'high' ? 'red' : 'yellow'}`} />
            {primaryDecision.risk}
          </span>
        ) : null}
        {task.environmentPackSnapshot ? (
          <span className="focus-chip">{task.environmentPackSnapshot.id}</span>
        ) : null}
        <span className="focus-chip">
          <span className="focus-chip-dot is-green" />
          {task.activeSessionId ? `RUN ${task.activeSessionId.slice(0, 8)}` : `RUN ${task.id.slice(0, 8)}`}
        </span>
      </div>

      <p className="focus-copy">
        {primaryDecision?.summary || task.waitingReason || task.latestSummary || task.goal}
      </p>

      {operatorNoteSummary ? (
        <div className="focus-operator-note">
          <span className="focus-operator-note-label">Latest operator note</span>
          <strong>{operatorNoteSummary.replace(/^Operator note:\s*/, '')}</strong>
        </div>
      ) : null}

      <div className="focus-facts-grid">
        {focusFacts.map((fact) => (
          <div key={fact.label} className="focus-fact-card">
            <div className="focus-fact-label">{fact.label}</div>
            <strong>{fact.value}</strong>
            <div className="focus-fact-detail">{fact.detail}</div>
          </div>
        ))}
      </div>

      <div className="focus-control-grid">
        <section className="focus-control-panel">
          <div className="focus-control-kicker">Run</div>
          <div className="focus-control-title">Execution lane</div>
          <div className="focus-control-copy">
            {primaryDecision
              ? 'Choose how the current run should proceed.'
              : 'Restart, review, or hide this run from the main queue.'}
          </div>

          {primaryDecision ? (
            <div className="focus-option-row">
              {primaryDecision.options.map((option) => (
                <button
                  key={option.id}
                  type="button"
                  className={`focus-option-button ${option.id === primaryDecision.recommendedOptionId ? 'is-primary' : ''}`}
                  disabled={!onResolveDecision || resolvingDecisionId === primaryDecision.id}
                  onClick={async () => {
                    if (!onResolveDecision) {
                      return;
                    }
                    try {
                      setSaveMessage(null);
                      await onResolveDecision(task.id, primaryDecision.id, { optionId: option.id });
                    } catch (error) {
                      setSaveMessage((error as Error).message || 'Unable to resolve this decision.');
                    }
                  }}
                >
                  {resolvingDecisionId === primaryDecision.id ? 'Applying…' : option.label}
                </button>
              ))}
            </div>
          ) : (
            <div className="focus-option-row">
              <button
                type="button"
                className="focus-option-button is-primary"
                onClick={() => onRetryTask(task)}
                disabled={!canRetry || retrying}
              >
                {retrying ? 'Starting next pass…' : 'Run next pass'}
              </button>
              <button
                type="button"
                className="focus-option-button"
                onClick={() => onArchiveTask(task)}
                disabled={!canArchive || archiving}
              >
                {archiving ? 'Hiding…' : 'Hide from queue'}
              </button>
            </div>
          )}

          {previewArtifactUrl ? (
            <div className="focus-inline-action-row">
              <a
                href={previewArtifactUrl}
                target="_blank"
                rel="noreferrer"
                className="focus-link-button"
              >
                Preview artifact
              </a>
              <button
                type="button"
                className="console-secondary-button"
                onClick={() => {
                  document.getElementById('task-acceptance-panel')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
                }}
              >
                Jump to acceptance
              </button>
            </div>
          ) : null}
        </section>

        {task.environmentPackSnapshot ? (
          <section className="focus-control-panel">
            <div className="focus-control-kicker">Configure</div>
            <div className="focus-control-title">Runtime inputs</div>
            <div className="focus-control-copy">
              Change the tools, skills, and knowledge this task can use inside {task.environmentPackSnapshot.id}.
            </div>
            <div className="focus-inline-action-row">
              <button
                type="button"
                className="focus-link-button"
                onClick={() => {
                  document.getElementById('task-setup-panel')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
                }}
              >
                Tools, skills, knowledge
              </button>
            </div>
          </section>
        ) : null}

        <section className="focus-control-panel focus-control-panel-guide">
          <div className="focus-control-kicker">Guide</div>
          <div className="focus-control-title">Brief and guidance</div>
          <div className="focus-control-copy">
            Update the mission brief, add new constraints, or redirect the next pass without leaving the console.
          </div>

          <div className="focus-steering-body">
            <label htmlFor={titleInputId} className="task-launch-label">Task title</label>
            <input
              id={titleInputId}
              className="task-launch-field"
              value={draftTitle}
              onChange={(event) => {
                setDraftTitle(event.target.value);
                setSaveMessage(null);
              }}
            />

            <label htmlFor={goalInputId} className="task-launch-label">Task brief</label>
            <textarea
              id={goalInputId}
              className="task-launch-field task-launch-textarea"
              rows={4}
              value={draftGoal}
              onChange={(event) => {
                setDraftGoal(event.target.value);
                setSaveMessage(null);
              }}
            />

            <label htmlFor={adjustmentInputId} className="task-launch-label">Adjustment note</label>
            <textarea
              id={adjustmentInputId}
              className="task-launch-field task-launch-textarea"
              rows={3}
              value={adjustmentNote}
              onChange={(event) => {
                setAdjustmentNote(event.target.value);
                setSaveMessage(null);
              }}
              placeholder="Add scope constraints, acceptance bars, or review notes"
            />

            <div className="focus-steering-actions">
              <button
                type="button"
                className="task-launch-button"
                onClick={async () => {
                  try {
                    const result = await onApplyTaskAdjustment(
                      task,
                      buildWorkbenchSteeringUpdateInput(task, {
                        title: draftTitle,
                        goal: draftGoal,
                        adjustment: adjustmentNote,
                      }),
                    );
                    setAdjustmentNote('');
                    if (result.followUpTask) {
                      setSaveMessage('Guidance saved and the next pass is now running.');
                    } else if (task.status !== 'running' && result.task.status === 'running') {
                      setSaveMessage('Guidance saved and the task resumed.');
                    } else {
                      setSaveMessage('Guidance saved.');
                    }
                  } catch (error) {
                    setSaveMessage((error as Error).message || 'Unable to save task guidance.');
                  }
                }}
                disabled={savingAdjustment}
              >
                {savingAdjustment ? 'Saving…' : 'Save guidance'}
              </button>
              <button
                type="button"
                className="console-secondary-button"
                onClick={() => {
                  setDraftTitle(task.title);
                  setDraftGoal(task.goal);
                  setAdjustmentNote('');
                  setSaveMessage(null);
                }}
                disabled={savingAdjustment}
              >
                Reset
              </button>
              <button
                type="button"
                className="console-secondary-button"
                onClick={async () => {
                  try {
                    await onRevertLastAdjustment(task);
                    setSaveMessage('Latest guidance reverted.');
                  } catch (error) {
                    setSaveMessage((error as Error).message || 'Unable to revert guidance.');
                  }
                }}
                disabled={!task.lastAdjustment || revertingAdjustment || savingAdjustment}
              >
                {revertingAdjustment ? 'Reverting…' : 'Revert last guidance'}
              </button>
            </div>
          </div>
        </section>
      </div>

      {saveMessage ? <div className="focus-feedback">{saveMessage}</div> : null}
    </section>
  );
}
