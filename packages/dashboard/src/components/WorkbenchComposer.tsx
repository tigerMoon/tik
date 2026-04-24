import React, { useEffect, useMemo, useState } from 'react';
import type {
  CreateWorkbenchTaskInput,
  UpdateWorkbenchTaskBriefResult,
  WorkbenchDecisionResponse,
  WorkbenchTaskResponse,
} from '../api/client';
import { parseUniversalComposerIntent } from '../view-models/composer';

interface WorkbenchComposerProps {
  task: WorkbenchTaskResponse | null;
  tasks: WorkbenchTaskResponse[];
  decisions: WorkbenchDecisionResponse[];
  applying: boolean;
  onApplyNote: (task: WorkbenchTaskResponse, note: string) => Promise<UpdateWorkbenchTaskBriefResult>;
  onResolveDecision: (
    task: WorkbenchTaskResponse,
    decision: WorkbenchDecisionResponse,
    input: { optionId?: string; message?: string },
  ) => Promise<void>;
  onCreateTask: (
    title: string,
    goal: string,
    input?: CreateWorkbenchTaskInput,
  ) => Promise<void>;
  onOpenLauncher: () => void;
}

export function WorkbenchComposer({
  task,
  tasks,
  decisions,
  applying,
  onApplyNote,
  onResolveDecision,
  onCreateTask,
  onOpenLauncher,
}: WorkbenchComposerProps) {
  const [note, setNote] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    setNote('');
    setMessage(null);
  }, [task?.id]);

  const activeDecision = useMemo(
    () => decisions.find((decision) => decision.status === 'pending') || decisions[0] || null,
    [decisions],
  );
  const intent = useMemo(
    () => parseUniversalComposerIntent(note, { task, tasks, decisions }),
    [decisions, note, task, tasks],
  );
  const busy = applying || submitting;
  const activeTaskTag = task ? `@${task.id.slice(0, 8).toUpperCase()}` : null;
  const commandChips = useMemo(() => {
    const chips: Array<{ label: string; value: string }> = [];

    if (task) {
      chips.push({ label: activeTaskTag!, value: `${activeTaskTag} #note ` });
    }

    chips.push({ label: '#new', value: '#new: ' });

    if (task) {
      chips.push({ label: '#note', value: '#note: ' });
    }

    if (activeDecision) {
      chips.push({ label: '#approve', value: '#approve: ' });
      chips.push({ label: '#reject', value: '#reject: ' });
    }

    return chips;
  }, [activeDecision, activeTaskTag, task]);

  const helperCopy = !task
    ? 'Describe a mission to create a task, or use “新任务: 标题 | 目标” for explicit title control.'
    : activeDecision
      ? 'Use #approve / #reject for the active decision, #new to branch a mission, or @TASK #note to steer a specific task.'
      : 'Use #note to steer the current mission, #new to launch a new one, or @TASK #note to direct another task from the console.';
  const intentPreview = useMemo(() => {
    if (!note.trim() || !intent) {
      return null;
    }

    if (intent.kind === 'create_task') {
      return `Create task: ${intent.title}`;
    }

    if (intent.kind === 'resolve_decision') {
      const target = intent.targetTaskLabel || 'current task';
      return `${intent.optionId === 'approve' ? 'Approve' : 'Reject'} decision on ${target}`;
    }

    return `Apply note to ${intent.targetTaskLabel || 'current task'}`;
  }, [intent, note]);
  const buttonLabel = !note.trim()
    ? task
      ? 'Apply note'
      : 'New task'
    : intent?.kind === 'create_task'
      ? 'Create task'
      : intent?.kind === 'resolve_decision'
        ? (intent.optionId === 'approve' ? 'Approve' : 'Reject')
        : 'Apply note';

  return (
    <section className="workbench-composer">
      <div className="workbench-composer-label">Universal composer</div>
      <div className="workbench-composer-stack">
        <form
          className="workbench-composer-main"
          onSubmit={async (event) => {
            event.preventDefault();
            if (!note.trim()) {
              if (!task) {
                onOpenLauncher();
              }
              return;
            }

            if (!intent) {
              return;
            }

            setSubmitting(true);
              try {
              if (intent.kind === 'create_task') {
                await onCreateTask(intent.title, intent.goal, task?.environmentPackSnapshot
                  ? {
                    environmentPackId: task.environmentPackSnapshot.id,
                    selectedSkills: task.environmentPackSelection?.selectedSkills,
                    selectedKnowledgeIds: task.environmentPackSelection?.selectedKnowledgeIds,
                    workspaceBinding: task.workspaceBinding,
                  }
                  : undefined);
                setMessage(`Task launched: ${intent.title}`);
              } else if (intent.kind === 'resolve_decision') {
                if (intent.targetTaskId && intent.targetTaskId !== task?.id) {
                  throw new Error(`Select ${intent.targetTaskLabel || 'the target task'} before resolving its decision.`);
                }
                if (!task || !activeDecision) {
                  throw new Error('No active decision is available for this task.');
                }
                await onResolveDecision(task, activeDecision, {
                  optionId: intent.optionId,
                  message: intent.message,
                });
                setMessage(intent.optionId === 'approve' ? 'Decision approved.' : 'Decision rejected.');
              } else {
                const noteTarget = intent.targetTaskId
                  ? tasks.find((item) => item.id === intent.targetTaskId) || null
                  : task;

                if (!noteTarget) {
                  throw new Error('Select a task before applying an operator note.');
                }
                if (!intent.note.trim()) {
                  throw new Error('Add a note before applying a steering update.');
                }
                const result = await onApplyNote(noteTarget, intent.note);
                const launchedFollowUp = result.followUpTask;
                const resumedCurrentTask = !launchedFollowUp
                  && noteTarget.status !== 'running'
                  && result.task.status === 'running';
                if (launchedFollowUp) {
                  setMessage(
                    noteTarget.id === task?.id
                      ? 'Operator note applied and the next pass is now running.'
                      : `Operator note applied to ${noteTarget.title} and a new pass was launched.`,
                  );
                } else if (resumedCurrentTask) {
                  setMessage(
                    noteTarget.id === task?.id
                      ? 'Operator note applied and supervisor resumed the task.'
                      : `Operator note applied to ${noteTarget.title} and the task resumed.`,
                  );
                } else {
                  setMessage(
                    noteTarget.id === task?.id
                      ? 'Operator note applied.'
                      : `Operator note applied to ${noteTarget.title}.`,
                  );
                }
              }
              setNote('');
            } catch (error) {
              setMessage((error as Error).message || 'Unable to process composer command.');
            } finally {
              setSubmitting(false);
            }
          }}
        >
          <input
            className="workbench-composer-input"
            value={note}
            onChange={(event) => {
              setNote(event.target.value);
              setMessage(null);
            }}
            placeholder={task
              ? `@${task.id.slice(0, 8).toUpperCase()} #note / #approve / #reject / #new: title | goal`
              : 'Describe a mission or use #new: title | goal'}
          />
          <button
            type="submit"
            className="workbench-composer-button"
            disabled={busy || (!!task && !note.trim())}
          >
            {busy ? 'Applying…' : buttonLabel}
          </button>
        </form>
        {intentPreview ? <div className="workbench-composer-preview">{intentPreview}</div> : null}
        <div className="workbench-composer-helper">{helperCopy}</div>
        <div className="workbench-composer-chips">
          {commandChips.map((chip) => (
            <button
              key={chip.label}
              type="button"
              className="workbench-composer-chip"
              onClick={() => {
                setNote(chip.value);
                setMessage(null);
              }}
            >
              {chip.label}
            </button>
          ))}
        </div>
      </div>
      {message ? <div className="focus-feedback">{message}</div> : null}
    </section>
  );
}
