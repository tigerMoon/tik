import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import { buildWorkbenchArtifactLinkPreviewUrl, } from '../api/client';
import { buildWorkbenchAgentLoopSummary, buildWorkbenchQueueSignal, buildWorkbenchTaskVisibleSummary, buildWorkbenchTaskProgressColumns, filterWorkbenchTasksByLens, } from '../view-models/workbench';
import { buildTaskBindingLabel, resolveWorkspaceBindingOption, } from '../view-models/workspace-hierarchy';
import { appendWorkbenchTaskGoalAttachments, buildWorkbenchTaskGoalImageMarkdown, buildWorkbenchTaskGoalMarkdownFileSection, isSupportedWorkbenchTaskGoalFile, isWorkbenchTaskGoalImage, isWorkbenchTaskGoalMarkdown, } from '../view-models/task-goal-attachments';
import { ChipMultiSelect } from './task-detail/ChipMultiSelect';
import { buildWorkbenchLabelSelectOptions, WorkbenchLabelGuide, } from './task-detail/WorkbenchLabelGuide';
import { buildWorkbenchTaskLaunchInput, emptyLaunchValidation, shouldInitializeWorkbenchTaskLaunchDraft, validateWorkbenchTaskLaunchDraft, } from './workbench-task-launch';
export function WorkbenchTaskList({ packs, activePackId, tasks, activeTask, activeTaskId, selectedLens, loading = false, launcherOpen, launcherSeedPackId, launcherSeedSelection, launcherSeedSource = 'active-pack', bindingOptions, selectedBindingKey, onSelectTask, onCreateTask, onToggleLauncher, }) {
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
    const [goalAttachments, setGoalAttachments] = useState([]);
    const [goalAttachmentError, setGoalAttachmentError] = useState(null);
    const [status, setStatus] = useState('backlog');
    const [priority, setPriority] = useState('');
    const [labels, setLabels] = useState([]);
    const [assignee, setAssignee] = useState('');
    const [selectedPackId, setSelectedPackId] = useState(resolvedLauncherSeedPackId);
    const [selectedTaskBindingKey, setSelectedTaskBindingKey] = useState(selectedBindingKey);
    const [submitting, setSubmitting] = useState(false);
    const [validation, setValidation] = useState(emptyLaunchValidation);
    const [launchError, setLaunchError] = useState(null);
    const wasLauncherOpenRef = useRef(false);
    const launchDialogTitleId = useId();
    const titleInputId = useId();
    const goalInputId = useId();
    const attachmentInputId = useId();
    const titleErrorId = useId();
    const goalErrorId = useId();
    const launchErrorId = useId();
    const packInputId = useId();
    const bindingInputId = useId();
    const attachmentInputRef = useRef(null);
    const lensTasks = useMemo(() => filterWorkbenchTasksByLens(tasks, selectedLens), [tasks, selectedLens]);
    const taskColumns = useMemo(() => buildWorkbenchTaskProgressColumns(lensTasks), [lensTasks]);
    const selectedPack = packs.find((pack) => pack.id === selectedPackId) || null;
    const selectedPackLabelOptions = useMemo(() => buildWorkbenchLabelSelectOptions(selectedPack), [selectedPack]);
    const selectedBindingOption = resolveWorkspaceBindingOption(bindingOptions, selectedTaskBindingKey);
    const inheritsFocusedSetup = !!activeTask
        && !!selectedPackId
        && selectedPackId === activeTask.environmentPackSnapshot?.id;
    useEffect(() => {
        const shouldInitialize = shouldInitializeWorkbenchTaskLaunchDraft({
            launcherOpen,
            wasLauncherOpen: wasLauncherOpenRef.current,
        });
        wasLauncherOpenRef.current = launcherOpen;
        if (!shouldInitialize)
            return;
        setSelectedPackId(resolvedLauncherSeedPackId);
        setSelectedTaskBindingKey(selectedBindingKey);
        setStatus('backlog');
        setValidation(emptyLaunchValidation);
        setLaunchError(null);
        setGoalAttachmentError(null);
    }, [launcherOpen, resolvedLauncherSeedPackId, selectedBindingKey]);
    const handleGoalFiles = async (files) => {
        const candidates = Array.from(files).filter(isSupportedWorkbenchTaskGoalFile);
        if (candidates.length === 0) {
            setGoalAttachmentError('Only image and Markdown files can be attached to the task goal.');
            return;
        }
        try {
            const nextAttachments = await Promise.all(candidates.map(readWorkbenchTaskGoalAttachment));
            setGoalAttachments((current) => [...current, ...nextAttachments]);
            setGoalAttachmentError(null);
            setLaunchError(null);
            if (validation.goalError) {
                setValidation(validateWorkbenchTaskLaunchDraft({
                    title,
                    goal,
                    attachmentCount: goalAttachments.length + nextAttachments.length,
                }));
            }
        }
        catch (error) {
            setGoalAttachmentError(error instanceof Error ? error.message : 'Unable to attach that file.');
        }
    };
    return (<>
      <section className="queue-card">
      <div className="queue-card-header">
        <div>
          <div className="queue-card-kicker">Tasks by progress</div>
          <div className="queue-card-title">{lensTasks.length} task{lensTasks.length === 1 ? '' : 's'}</div>
        </div>
      </div>

      <div className="task-rail-scroll queue-scroll">
        {lensTasks.length === 0 ? (<div className={`queue-empty ${loading ? 'is-loading' : ''}`}>
            <div className="queue-empty-title">{loading ? 'Syncing queue' : 'No tasks in this lane'}</div>
            <div className="queue-empty-copy">
              {loading
                ? 'Restoring tasks, decisions, and artifact signals from the workbench.'
                : 'Switch lanes or launch a new task to wake the inbox.'}
            </div>
            {loading ? (<div className="queue-loading-pill">Restoring operator console…</div>) : (<button type="button" className="queue-inline-button" onClick={() => onToggleLauncher(true)}>
                Launch task
              </button>)}
          </div>) : (<div className="task-board" aria-label="Tasks grouped by progress">
            {taskColumns.map((column) => (<section key={column.id} className={`task-board-column task-board-column-${column.id}`} aria-labelledby={`task-board-column-${column.id}`}>
                <div className="task-board-column-header">
                  <div className={`task-board-column-dot task-board-column-dot-${column.tone}`}/>
                  <h2 id={`task-board-column-${column.id}`} className="task-board-column-title">
                    {column.label}
                  </h2>
                  <span className="task-board-column-count">{column.tasks.length}</span>
                </div>

                {column.tasks.length === 0 ? (<div className="task-board-column-empty">No tasks</div>) : (<div className="task-rail-list queue-task-list">
                    {column.tasks.map((task) => (<TaskRailRow key={task.id} task={task} active={task.id === activeTaskId} onSelect={() => onSelectTask(task.id)}/>))}
                  </div>)}
              </section>))}
          </div>)}
      </div>

      </section>

      {launcherOpen ? (<div className="queue-launch-overlay" onClick={() => onToggleLauncher(false)}>
          <div className="task-launch-panel queue-launch-panel" role="dialog" aria-modal="true" aria-labelledby={launchDialogTitleId} onClick={(event) => event.stopPropagation()}>
            <div className="task-launch-panel-header">
              <div id={launchDialogTitleId} className="task-launch-title">Launch task</div>
              <button type="button" className="queue-inline-button" onClick={() => onToggleLauncher(false)}>
                Close
              </button>
            </div>

            <form onSubmit={async (event) => {
                event.preventDefault();
                const nextTitle = title.trim();
                const nextGoal = appendWorkbenchTaskGoalAttachments(goal, goalAttachments);
                if (submitting) {
                    return;
                }
                const nextValidation = validateWorkbenchTaskLaunchDraft({
                    title,
                    goal,
                    attachmentCount: goalAttachments.length,
                });
                setValidation(nextValidation);
                setLaunchError(null);
                if (!nextValidation.valid) {
                    return;
                }
                setSubmitting(true);
                try {
                    const launchInput = buildWorkbenchTaskLaunchInput({
                        title: nextTitle,
                        status,
                        labels,
                        selectedPack,
                    });
                    await onCreateTask(nextTitle, nextGoal, {
                        environmentPackId: selectedPackId || undefined,
                        selectedSkills: inheritsFocusedSetup ? resolvedLauncherSeedSelection?.selectedSkills : undefined,
                        selectedKnowledgeIds: inheritsFocusedSetup ? resolvedLauncherSeedSelection?.selectedKnowledgeIds : undefined,
                        status: launchInput.status,
                        priority: priority ? Number(priority) : null,
                        labels: launchInput.labels,
                        humanAssignee: assignee.trim() || null,
                        workspaceBinding: selectedBindingOption.binding,
                    });
                    setTitle('');
                    setGoal('');
                    setGoalAttachments([]);
                    setGoalAttachmentError(null);
                    setPriority('');
                    setLabels([]);
                    setAssignee('');
                    setValidation(emptyLaunchValidation);
                    onToggleLauncher(false);
                }
                catch (error) {
                    setLaunchError(error instanceof Error ? error.message : 'Failed to launch task.');
                }
                finally {
                    setSubmitting(false);
                }
            }} className="queue-launch-form">
              <label htmlFor={titleInputId} className="task-launch-label">Task title</label>
              <input id={titleInputId} value={title} onChange={(event) => {
                const nextTitle = event.target.value;
                setTitle(nextTitle);
                setLaunchError(null);
                if (validation.titleError) {
                    setValidation(validateWorkbenchTaskLaunchDraft({
                        title: nextTitle,
                        goal,
                        attachmentCount: goalAttachments.length,
                    }));
                }
            }} placeholder="What should the agents work on?" className="task-launch-field" aria-invalid={!!validation.titleError} aria-describedby={validation.titleError ? titleErrorId : undefined}/>
              {validation.titleError ? (<div id={titleErrorId} className="task-launch-error">
                  {validation.titleError}
                </div>) : null}

              <label htmlFor={goalInputId} className="task-launch-label">Task goal</label>
              <textarea id={goalInputId} value={goal} onChange={(event) => {
                const nextGoal = event.target.value;
                setGoal(nextGoal);
                setLaunchError(null);
                if (validation.goalError) {
                    setValidation(validateWorkbenchTaskLaunchDraft({
                        title,
                        goal: nextGoal,
                        attachmentCount: goalAttachments.length,
                    }));
                }
            }} onPaste={(event) => {
                const files = Array.from(event.clipboardData.files);
                if (files.length === 0) {
                    return;
                }
                event.preventDefault();
                void handleGoalFiles(files);
            }} onDrop={(event) => {
                const files = Array.from(event.dataTransfer.files);
                if (files.length === 0) {
                    return;
                }
                event.preventDefault();
                void handleGoalFiles(files);
            }} onDragOver={(event) => {
                if (event.dataTransfer.types.includes('Files')) {
                    event.preventDefault();
                }
            }} rows={3} placeholder="Describe the outcome you want to review in the console" className="task-launch-field task-launch-textarea" aria-invalid={!!validation.goalError} aria-describedby={validation.goalError ? goalErrorId : undefined}/>
              <div className="task-goal-attachment-actions">
                <button type="button" className="console-secondary-button task-goal-attachment-button" onClick={() => attachmentInputRef.current?.click()}>
                  Attach image or Markdown
                </button>
                <span>Paste or drop images and .md files into the goal.</span>
                <input ref={attachmentInputRef} id={attachmentInputId} type="file" accept="image/*,.md,.markdown,text/markdown" multiple className="task-goal-attachment-input" onChange={(event) => {
                const files = event.currentTarget.files;
                if (files) {
                    void handleGoalFiles(files);
                }
                event.currentTarget.value = '';
            }}/>
              </div>
              {goalAttachments.length > 0 ? (<div className="task-goal-attachment-list" aria-label="Attached task goal context">
                  {goalAttachments.map((attachment) => (<div key={attachment.id} className="task-goal-attachment-item">
                      <span>{attachment.kind === 'image' ? 'Image' : 'Markdown'} · {attachment.name}</span>
                      <button type="button" className="task-goal-attachment-remove" onClick={() => {
                        setGoalAttachments((current) => current.filter((item) => item.id !== attachment.id));
                        setGoalAttachmentError(null);
                    }}>
                        Remove
                      </button>
                    </div>))}
                </div>) : null}
              {goalAttachmentError ? (<div className="task-launch-error">{goalAttachmentError}</div>) : null}
              {validation.goalError ? (<div id={goalErrorId} className="task-launch-error">
                  {validation.goalError}
                </div>) : null}

              <label htmlFor={packInputId} className="task-launch-label">Environment pack</label>
              <select id={packInputId} value={selectedPackId || ''} onChange={(event) => setSelectedPackId(event.target.value || null)} className="task-launch-field">
                {packs.map((pack) => (<option key={pack.id} value={pack.id}>{pack.name}</option>))}
              </select>
              <div className="focus-setup-pack-copy">
                {inheritsFocusedSetup
                ? 'New task will inherit the current task workspace and setup inside this pack.'
                : (selectedPack
                    ? `${selectedPack.name} defaults will be bound to the new task.`
                    : 'Choose the pack to bind to the new task.')}
              </div>

              <label htmlFor={bindingInputId} className="task-launch-label">Task binding</label>
              <select id={bindingInputId} value={selectedTaskBindingKey} onChange={(event) => setSelectedTaskBindingKey(event.target.value)} className="task-launch-field">
                {bindingOptions.map((option) => (<option key={option.key} value={option.key}>
                    {option.kind === 'workspace' ? 'Workspace' : 'Project'} · {option.label}
                  </option>))}
              </select>
              <div className="task-binding-copy">
                Currently bound to {selectedBindingOption.kind} · {selectedBindingOption.label}
                <br />
                {selectedBindingOption.detail}
              </div>

              <div className="task-launch-grid">
                <label className="task-launch-label">
                  Status
                  <select value={status} onChange={(event) => setStatus(event.target.value)} className="task-launch-field">
                    <option value="backlog">Backlog</option>
                    <option value="todo">Todo</option>
                  </select>
                </label>
                <label className="task-launch-label">
                  Priority
                  <select value={priority} onChange={(event) => setPriority(event.target.value)} className="task-launch-field">
                    <option value="">None</option>
                    <option value="1">Urgent</option>
                    <option value="2">High</option>
                    <option value="3">Normal</option>
                    <option value="4">Low</option>
                  </select>
                </label>
              </div>

              <div className="task-launch-label">Labels</div>
              <ChipMultiSelect values={labels} options={selectedPackLabelOptions} placeholder="Add custom label, press Enter" disabled={submitting} onChange={setLabels}/>
              <WorkbenchLabelGuide environment={selectedPack}/>

              <label className="task-launch-label">
                Assignee
                <input value={assignee} onChange={(event) => setAssignee(event.target.value)} placeholder="human owner" className="task-launch-field"/>
              </label>

              <button type="submit" disabled={submitting} className="task-launch-button">
                {submitting ? 'Launching…' : 'Launch task'}
              </button>
              {launchError ? (<div id={launchErrorId} className="task-launch-error task-launch-error-banner" role="alert">
                  {launchError}
                </div>) : null}
            </form>
          </div>
        </div>) : null}
    </>);
}
async function readWorkbenchTaskGoalAttachment(file) {
    if (isWorkbenchTaskGoalImage(file)) {
        const dataUrl = await readFileAsDataUrl(file);
        return {
            id: buildGoalAttachmentId(file),
            kind: 'image',
            name: file.name || 'pasted-image',
            markdown: buildWorkbenchTaskGoalImageMarkdown({
                name: file.name || 'pasted-image',
                type: file.type || 'image/*',
                dataUrl,
            }),
        };
    }
    if (isWorkbenchTaskGoalMarkdown(file)) {
        const text = await file.text();
        return {
            id: buildGoalAttachmentId(file),
            kind: 'markdown',
            name: file.name || 'pasted-markdown.md',
            markdown: buildWorkbenchTaskGoalMarkdownFileSection({
                name: file.name || 'pasted-markdown.md',
                text,
            }),
        };
    }
    throw new Error('Only image and Markdown files can be attached to the task goal.');
}
function readFileAsDataUrl(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.addEventListener('load', () => {
            if (typeof reader.result === 'string') {
                resolve(reader.result);
                return;
            }
            reject(new Error('Unable to read image attachment.'));
        });
        reader.addEventListener('error', () => reject(new Error('Unable to read image attachment.')));
        reader.readAsDataURL(file);
    });
}
function buildGoalAttachmentId(file) {
    return `${file.name || 'clipboard'}-${file.size}-${file.lastModified}-${Math.random().toString(36).slice(2)}`;
}
function TaskRailRow({ task, active, onSelect, }) {
    const taskSummary = buildWorkbenchTaskVisibleSummary(task);
    const queueSignal = buildWorkbenchQueueSignal(task);
    const agentLoopSummary = buildWorkbenchAgentLoopSummary(task.agentLoop);
    const previewUrl = buildWorkbenchArtifactLinkPreviewUrl({
        artifactId: task.evidenceSummary?.latestArtifactId,
        versionId: task.evidenceSummary?.latestArtifactVersionId,
        filePath: task.evidenceSummary?.latestPreviewableArtifactPath,
    });
    const shortId = task.identifier || task.shortIdentifier || `TIK-${task.id.slice(0, 8).toUpperCase()}`;
    const updatedAt = formatRelativeDate(task.lastProgressAt || task.updatedAt || task.createdAt);
    return (<article className={`task-card queue-task-card ${active ? 'is-active' : ''}`} role="link" tabIndex={0} aria-label={`Open task ${task.title}`} onClick={onSelect} onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                onSelect();
            }
        }}>
      <div className="queue-task-body">
        <div className={`queue-status-dot status-${statusTone(task.status)}`}/>
        <div className="queue-task-main">
          <div className="queue-task-top">
            <div className="queue-task-title-line">
              <span className="queue-task-id">{shortId}</span>
              <span className="queue-task-title">{task.title}</span>
            </div>
            <span className="queue-task-updated">{updatedAt}</span>
          </div>

          <div className="queue-task-meta">
            <span className={`queue-status-badge status-${statusTone(task.status)}`}>{humanizeStatus(task.status)}</span>
            {task.priority ? <span className="queue-priority-dot">P{task.priority}</span> : null}
            {agentLoopSummary ? (<span className={`queue-signal-badge tone-${agentLoopSummary.tone}`}>{agentLoopSummary.label}</span>) : null}
            <span className={`queue-signal-badge tone-${queueSignal.tone}`}>{queueSignal.label}</span>
            <span className="queue-binding-chip">{buildTaskBindingLabel(task.workspaceBinding)}</span>
            <span className="queue-pack-chip">{task.environmentPackSnapshot?.id || 'default'}</span>
            {(task.humanAssignee || task.assignee || task.currentOwner) ? (<span className="queue-pack-chip">{task.humanAssignee || task.assignee || task.currentOwner}</span>) : null}
          </div>

          {task.labels?.length ? (<div className="queue-label-row">
              {task.labels.slice(0, 4).map((label) => <span key={label}>{label}</span>)}
            </div>) : null}

          {taskSummary ? (<div className="queue-task-summary">{taskSummary}</div>) : null}

          {agentLoopSummary ? (<div className="queue-task-evidence">{agentLoopSummary.detail}</div>) : null}

          <div className="queue-task-evidence">{queueSignal.detail}</div>
        </div>
      </div>

      <div className="queue-task-side">
        <div className="queue-task-actions">
          {previewUrl ? (<a href={previewUrl} target="_blank" rel="noreferrer" className="queue-task-action queue-task-preview" onClick={(event) => event.stopPropagation()}>
              Preview
            </a>) : null}
        </div>
      </div>
    </article>);
}
function humanizeStatus(status) {
    switch (status) {
        case 'waiting_for_user':
        case 'in_review':
            return 'Review';
        case 'running':
        case 'in_progress':
            return 'Running';
        case 'todo':
            return 'Todo';
        case 'backlog':
            return 'Backlog';
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
function formatRelativeDate(value) {
    if (!value) {
        return 'No activity';
    }
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
        return value;
    }
    const diffMs = Date.now() - date.getTime();
    const diffMinutes = Math.floor(diffMs / 60000);
    if (diffMinutes < 1) {
        return 'now';
    }
    if (diffMinutes < 60) {
        return `${diffMinutes}m`;
    }
    const diffHours = Math.floor(diffMinutes / 60);
    if (diffHours < 24) {
        return `${diffHours}h`;
    }
    const diffDays = Math.floor(diffHours / 24);
    if (diffDays < 7) {
        return `${diffDays}d`;
    }
    return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
function statusTone(status) {
    switch (status) {
        case 'completed':
            return 'green';
        case 'waiting_for_user':
        case 'in_review':
        case 'failed':
        case 'blocked':
        case 'cancelled':
            return 'yellow';
        case 'running':
        case 'in_progress':
        case 'todo':
        case 'verifying':
            return 'blue';
        default:
            return 'neutral';
    }
}
//# sourceMappingURL=WorkbenchTaskList.js.map