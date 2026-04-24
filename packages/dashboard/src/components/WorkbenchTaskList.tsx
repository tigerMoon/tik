import React, { useEffect, useId, useMemo, useState } from 'react';
import type { EnvironmentPackManifest, EnvironmentPackSelection } from '@tik/shared';
import {
  buildWorkbenchArtifactPreviewUrl,
  type CreateWorkbenchTaskInput,
  type WorkbenchTaskResponse,
} from '../api/client';
import type { WorkbenchLens } from '../view-models/workbench';
import {
  buildWorkbenchQueueSignal,
  buildWorkbenchTaskVisibleSummary,
  filterWorkbenchTasksByLens,
  groupWorkbenchTasks,
} from '../view-models/workbench';

interface WorkbenchTaskListProps {
  packs: EnvironmentPackManifest[];
  activePackId: string | null;
  tasks: WorkbenchTaskResponse[];
  activeTask: WorkbenchTaskResponse | null;
  activeTaskId: string | null;
  selectedLens: WorkbenchLens;
  loading?: boolean;
  launcherOpen: boolean;
  launcherSeedPackId?: string | null;
  launcherSeedSelection?: EnvironmentPackSelection | null;
  launcherSeedSource?: 'focused-task' | 'active-pack';
  onSelectTask: (taskId: string) => void;
  onSelectLens: (lens: WorkbenchLens) => void;
  onCreateTask: (
    title: string,
    goal: string,
    input?: CreateWorkbenchTaskInput,
  ) => Promise<void>;
  onToggleLauncher: (open: boolean) => void;
}

export function WorkbenchTaskList({
  packs,
  activePackId,
  tasks,
  activeTask,
  activeTaskId,
  selectedLens,
  loading = false,
  launcherOpen,
  launcherSeedPackId,
  launcherSeedSelection,
  launcherSeedSource = 'active-pack',
  onSelectTask,
  onSelectLens,
  onCreateTask,
  onToggleLauncher,
}: WorkbenchTaskListProps) {
  const focusedTaskPackId = activeTask?.environmentPackSnapshot?.id || null;
  const focusedTaskSelection = activeTask?.environmentPackSelection || null;
  const resolvedLauncherSeedPackId = launcherSeedSource === 'focused-task'
    ? launcherSeedPackId || focusedTaskPackId || activePackId || packs[0]?.id || null
    : launcherSeedPackId || activePackId || packs[0]?.id || null;
  const resolvedLauncherSeedSelection = launcherSeedSource === 'focused-task'
    ? launcherSeedSelection || focusedTaskSelection
    : launcherSeedSelection;
  const [title, setTitle] = useState('');
  const [goal, setGoal] = useState('');
  const [selectedPackId, setSelectedPackId] = useState<string | null>(resolvedLauncherSeedPackId);
  const [submitting, setSubmitting] = useState(false);
  const launchDialogTitleId = useId();
  const titleInputId = useId();
  const goalInputId = useId();
  const packInputId = useId();
  const grouped = useMemo(() => groupWorkbenchTasks(tasks), [tasks]);
  const lensTasks = useMemo(() => filterWorkbenchTasksByLens(tasks, selectedLens), [tasks, selectedLens]);
  const todayCount = useMemo(() => filterWorkbenchTasksByLens(tasks, 'today').length, [tasks]);
  const archivedCount = grouped.archived.length;
  const selectedPack = packs.find((pack) => pack.id === selectedPackId) || null;
  const inheritsFocusedSetup = !!activeTask
    && !!selectedPackId
    && selectedPackId === activeTask.environmentPackSnapshot?.id;

  useEffect(() => {
    if (!launcherOpen) {
      return;
    }

    setSelectedPackId(resolvedLauncherSeedPackId);
  }, [launcherOpen, resolvedLauncherSeedPackId]);

  return (
    <>
      <section className="queue-card">
      <div className="queue-card-header">
        <div>
          <div className="queue-card-kicker">Queue · {lensTasks.length}</div>
          <div className="queue-card-title">sorted by waiting-on-you</div>
        </div>
      </div>

      <div className="task-rail-filters">
        {[
          { lens: 'inbox' as const, label: `Inbox ${grouped.attention.length}` },
          { lens: 'today' as const, label: `Today ${todayCount}` },
          { lens: 'all' as const, label: `All ${tasks.filter((task) => task.status !== 'archived').length}` },
          { lens: 'completed' as const, label: `Completed ${grouped.completed.length}` },
          ...(archivedCount > 0 ? [{ lens: 'archived' as const, label: `Archived ${archivedCount}` }] : []),
        ].map((entry) => (
          <button
            key={entry.lens}
            type="button"
            className={`task-rail-filter ${selectedLens === entry.lens ? 'is-active' : ''}`}
            onClick={() => onSelectLens(entry.lens)}
          >
            {entry.label}
          </button>
        ))}
      </div>

      <div className="task-rail-scroll queue-scroll">
        {lensTasks.length === 0 ? (
          <div className={`queue-empty ${loading ? 'is-loading' : ''}`}>
            <div className="queue-empty-title">{loading ? 'Syncing queue' : 'No tasks in this lane'}</div>
            <div className="queue-empty-copy">
              {loading
                ? 'Restoring tasks, decisions, and artifact signals from the workbench.'
                : 'Switch lanes or launch a new task to wake the inbox.'}
            </div>
            {loading ? (
              <div className="queue-loading-pill">Restoring operator console…</div>
            ) : (
              <button
                type="button"
                className="queue-inline-button"
                onClick={() => onToggleLauncher(true)}
              >
                Launch task
              </button>
            )}
          </div>
        ) : (
          <div className="task-rail-list queue-task-list">
            {lensTasks.map((task) => (
              <TaskRailCard
                key={task.id}
                task={task}
                active={task.id === activeTaskId}
                onSelect={() => onSelectTask(task.id)}
              />
            ))}
          </div>
        )}
      </div>

      </section>

      {launcherOpen ? (
        <div
          className="queue-launch-overlay"
          onClick={() => onToggleLauncher(false)}
        >
          <div
            className="task-launch-panel queue-launch-panel"
            role="dialog"
            aria-modal="true"
            aria-labelledby={launchDialogTitleId}
            onClick={(event) => event.stopPropagation()}
          >
            <div className="task-launch-panel-header">
              <div id={launchDialogTitleId} className="task-launch-title">Launch task</div>
              <button
                type="button"
                className="queue-inline-button"
                onClick={() => onToggleLauncher(false)}
              >
                Close
              </button>
            </div>

            <form
              onSubmit={async (event) => {
                event.preventDefault();
                const nextTitle = title.trim();
                const nextGoal = goal.trim();
                if (!nextTitle || !nextGoal || submitting) {
                  return;
                }
                setSubmitting(true);
                try {
                  await onCreateTask(nextTitle, nextGoal, {
                    environmentPackId: selectedPackId || undefined,
                    selectedSkills: inheritsFocusedSetup ? resolvedLauncherSeedSelection?.selectedSkills : undefined,
                    selectedKnowledgeIds: inheritsFocusedSetup ? resolvedLauncherSeedSelection?.selectedKnowledgeIds : undefined,
                    workspaceBinding: activeTask?.workspaceBinding,
                  });
                  setTitle('');
                  setGoal('');
                  onToggleLauncher(false);
                } finally {
                  setSubmitting(false);
                }
              }}
              className="queue-launch-form"
            >
              <label htmlFor={titleInputId} className="task-launch-label">Task title</label>
              <input
                id={titleInputId}
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                placeholder="What should the agents work on?"
                className="task-launch-field"
              />

              <label htmlFor={goalInputId} className="task-launch-label">Task goal</label>
              <textarea
                id={goalInputId}
                value={goal}
                onChange={(event) => setGoal(event.target.value)}
                rows={3}
                placeholder="Describe the outcome you want to review in the console"
                className="task-launch-field task-launch-textarea"
              />

              <label htmlFor={packInputId} className="task-launch-label">Environment pack</label>
              <select
                id={packInputId}
                value={selectedPackId || ''}
                onChange={(event) => setSelectedPackId(event.target.value || null)}
                className="task-launch-field"
              >
                {packs.map((pack) => (
                  <option key={pack.id} value={pack.id}>{pack.name}</option>
                ))}
              </select>
              <div className="focus-setup-pack-copy">
                {inheritsFocusedSetup
                  ? 'New task will inherit the current task workspace and setup inside this pack.'
                  : (selectedPack
                    ? `${selectedPack.name} defaults will be bound to the new task.`
                    : 'Choose the pack to bind to the new task.')}
              </div>

              <button type="submit" disabled={submitting} className="task-launch-button">
                {submitting ? 'Launching…' : 'Launch task'}
              </button>
            </form>
          </div>
        </div>
      ) : null}
    </>
  );
}

function TaskRailCard({
  task,
  active,
  onSelect,
}: {
  task: WorkbenchTaskResponse;
  active: boolean;
  onSelect: () => void;
}) {
  const taskSummary = buildWorkbenchTaskVisibleSummary(task);
  const queueSignal = buildWorkbenchQueueSignal(task);
  const previewableArtifactPath = task.evidenceSummary?.latestPreviewableArtifactPath;

  return (
    <article className={`task-card queue-task-card ${active ? 'is-active' : ''}`}>
      <div className="queue-task-top">
        <div>
          <div className="queue-task-id">{task.id.slice(0, 8).toUpperCase()}</div>
          <div className="queue-task-title">{task.title}</div>
        </div>
        <div className="queue-task-actions">
          {previewableArtifactPath ? (
            <a
              href={buildWorkbenchArtifactPreviewUrl(previewableArtifactPath)}
              target="_blank"
              rel="noreferrer"
              className="queue-task-action queue-task-preview"
            >
              Preview
            </a>
          ) : null}
          <button
            type="button"
            onClick={onSelect}
            className="queue-task-action queue-task-open"
          >
            Open
          </button>
        </div>
      </div>

      <button
        type="button"
        onClick={onSelect}
        className="queue-task-body"
      >
        <div className="queue-task-meta">
          <span className={`queue-status-badge status-${statusTone(task.status)}`}>{humanizeStatus(task.status)}</span>
          <span className={`queue-signal-badge tone-${queueSignal.tone}`}>{queueSignal.label}</span>
          <span className="queue-pack-chip">{task.environmentPackSnapshot?.id || 'default'}</span>
        </div>

        {taskSummary ? (
          <div className="queue-task-summary">{taskSummary}</div>
        ) : null}

        <div className="queue-task-evidence">{queueSignal.detail}</div>
      </button>
    </article>
  );
}

function humanizeStatus(status: WorkbenchTaskResponse['status']): string {
  switch (status) {
    case 'waiting_for_user':
      return 'Review';
    case 'running':
      return 'Running';
    case 'verifying':
      return 'Verify';
    case 'completed':
      return 'Done';
    case 'failed':
      return 'Recover';
    case 'blocked':
      return 'Blocked';
    case 'paused':
      return 'Paused';
    case 'cancelled':
      return 'Stopped';
    case 'archived':
      return 'Archived';
    default:
      return 'Plan';
  }
}

function statusTone(status: WorkbenchTaskResponse['status']): 'green' | 'blue' | 'yellow' | 'neutral' {
  switch (status) {
    case 'completed':
      return 'green';
    case 'waiting_for_user':
    case 'failed':
    case 'blocked':
    case 'cancelled':
      return 'yellow';
    case 'running':
    case 'verifying':
      return 'blue';
    default:
      return 'neutral';
  }
}
