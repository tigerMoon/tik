import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { EnvironmentPackManifest, EnvironmentPackSelection } from '@tik/shared';
import {
  buildWorkbenchArtifactPreviewUrl,
  type UpdateWorkbenchTaskConfigurationInput,
  type WorkbenchDecisionResponse,
  type WorkbenchTaskResponse,
  type WorkbenchTimelineResponseItem,
} from '../api/client';
import {
  buildWorkbenchAcceptanceSummary,
  buildWorkbenchEvidenceDigest,
  buildWorkbenchLiveRunEntries,
  buildWorkbenchWorkspaceBindingSummary,
} from '../view-models/workbench';

interface WorkbenchOutputRailProps {
  task: WorkbenchTaskResponse | null;
  pack: EnvironmentPackManifest | null;
  packs: EnvironmentPackManifest[];
  timeline: WorkbenchTimelineResponseItem[];
  decisions: WorkbenchDecisionResponse[];
  savingConfiguration: boolean;
  controllingTaskAction?: 'pause' | 'resume' | 'stop' | null;
  onSaveTaskConfiguration: (taskId: string, selection: UpdateWorkbenchTaskConfigurationInput) => Promise<void>;
  onControlTask: (taskId: string, action: 'pause' | 'resume' | 'stop') => Promise<void>;
}

export function WorkbenchOutputRail({
  task,
  pack,
  packs,
  timeline,
  decisions,
  savingConfiguration,
  controllingTaskAction,
  onSaveTaskConfiguration,
  onControlTask,
}: WorkbenchOutputRailProps) {
  const rawItems = timeline.filter((item) => item.kind === 'raw');
  const evidenceDigest = useMemo(() => buildWorkbenchEvidenceDigest(rawItems), [rawItems]);
  const liveRunEntries = useMemo(() => buildWorkbenchLiveRunEntries(timeline), [timeline]);
  const acceptanceSummary = useMemo(
    () => buildWorkbenchAcceptanceSummary(task?.status, evidenceDigest, decisions.length),
    [decisions.length, evidenceDigest, task?.status],
  );
  const primaryArtifact = evidenceDigest.previewableArtifacts[0] || null;
  const primaryArtifactPreviewUrl = primaryArtifact
    ? buildWorkbenchArtifactPreviewUrl(primaryArtifact.path)
    : null;
  const availablePacks = useMemo(() => {
    const seen = new Set<string>();
    return packs.filter((entry) => {
      if (seen.has(entry.id)) {
        return false;
      }
      seen.add(entry.id);
      return true;
    });
  }, [packs]);

  const [selectedPackId, setSelectedPackId] = useState<string | null>(task?.environmentPackSnapshot?.id || pack?.id || availablePacks[0]?.id || null);
  const selectedPack = useMemo<EnvironmentPackManifest | null>(() => {
    if (!selectedPackId) {
      return pack;
    }

    return availablePacks.find((entry) => entry.id === selectedPackId) || pack || null;
  }, [availablePacks, pack, selectedPackId]);
  const packDefaults = useMemo<EnvironmentPackSelection | null>(() => {
    if (!selectedPack) {
      return null;
    }
    return {
      selectedSkills: [...selectedPack.skills],
      selectedKnowledgeIds: selectedPack.knowledge.map((entry) => entry.id),
    };
  }, [selectedPack]);

  const [selectedSkills, setSelectedSkills] = useState<string[]>([]);
  const [selectedKnowledgeIds, setSelectedKnowledgeIds] = useState<string[]>([]);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);

  useEffect(() => {
    const taskPackId = task?.environmentPackSnapshot?.id || pack?.id || availablePacks[0]?.id || null;
    setSelectedPackId(taskPackId);
    if (!task) {
      setSelectedSkills([]);
      setSelectedKnowledgeIds([]);
      setSaveMessage(null);
      return;
    }

    const taskPack = availablePacks.find((entry) => entry.id === taskPackId) || pack;
    const nextDefaults = taskPack
      ? {
          selectedSkills: [...taskPack.skills],
          selectedKnowledgeIds: taskPack.knowledge.map((entry) => entry.id),
        }
      : null;
    setSelectedSkills(task.environmentPackSelection?.selectedSkills || nextDefaults?.selectedSkills || []);
    setSelectedKnowledgeIds(task.environmentPackSelection?.selectedKnowledgeIds || nextDefaults?.selectedKnowledgeIds || []);
    setSaveMessage(null);
  }, [availablePacks, pack, task]);

  const taskPackId = task?.environmentPackSnapshot?.id || null;
  const taskPack = useMemo(
    () => (taskPackId ? availablePacks.find((entry) => entry.id === taskPackId) || pack : pack),
    [availablePacks, pack, taskPackId],
  );
  const currentTaskDefaults = useMemo<EnvironmentPackSelection | null>(() => {
    if (!taskPack) {
      return null;
    }
    return {
      selectedSkills: [...taskPack.skills],
      selectedKnowledgeIds: taskPack.knowledge.map((entry) => entry.id),
    };
  }, [taskPack]);
  const configurationDirty = !!task && (
    selectedPackId !== taskPackId
    || JSON.stringify(selectedSkills) !== JSON.stringify(task.environmentPackSelection?.selectedSkills || currentTaskDefaults?.selectedSkills || [])
    || JSON.stringify(selectedKnowledgeIds) !== JSON.stringify(task.environmentPackSelection?.selectedKnowledgeIds || currentTaskDefaults?.selectedKnowledgeIds || [])
  );
  const workspaceBindingSummary = useMemo(
    () => buildWorkbenchWorkspaceBindingSummary(task?.workspaceBinding),
    [task?.workspaceBinding],
  );
  const liveRunScrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const node = liveRunScrollRef.current;
    if (!node) {
      return;
    }
    node.scrollTop = node.scrollHeight;
  }, [liveRunEntries.length, task?.id]);

  const liveRunStatusTone = task?.status === 'failed' || task?.status === 'blocked' || task?.status === 'cancelled'
    ? 'red'
    : task?.status === 'waiting_for_user'
      ? 'yellow'
      : task?.status === 'completed'
        ? 'green'
        : task?.status === 'running' || task?.status === 'verifying'
          ? 'blue'
          : 'neutral';
  const liveRunHeadline = task
    ? task.waitingReason || task.latestSummary || task.goal
    : 'Select a task to stream the latest agent output.';

  return (
    <div className="output-rail-stack">
      <section className="focus-lower-card live-run-card">
        <div className="live-run-header">
          <div>
            <div className="focus-lower-label">Live run log</div>
            <div className="focus-lower-title">
              {task?.activeSessionId ? `run-${task.activeSessionId.slice(0, 8)}` : 'No active run selected'}
            </div>
          </div>
          <div className={`live-run-status tone-${liveRunStatusTone}`}>
            {task ? task.status.replace(/_/g, ' ') : 'idle'}
          </div>
        </div>

        <div className="live-run-current-line">
          <div className="live-run-current-label">Current line</div>
          <div className="live-run-current-text">{liveRunHeadline}</div>
        </div>

        <div className="live-run-terminal" ref={liveRunScrollRef}>
          {liveRunEntries.length === 0 ? (
            <div className="live-run-empty">
              No runtime output yet. As the supervisor plans, calls tools, or pauses for review, the latest lines will stream here.
            </div>
          ) : (
            liveRunEntries.map((entry) => (
              <div key={entry.id} className={`live-run-row tone-${entry.tone}`}>
                <div className="live-run-row-meta">
                  <span>{formatLogTimestamp(entry.createdAt)}</span>
                  <span className="live-run-row-label">{entry.label}</span>
                </div>
                <div className="live-run-row-text">{entry.text}</div>
                {entry.detail ? (
                  <div className="live-run-row-detail">{entry.detail}</div>
                ) : null}
              </div>
            ))
          )}
        </div>
      </section>

      <section className="focus-lower-grid">
        <section className="focus-lower-card" id="task-acceptance-panel">
          <div className="focus-lower-label">Workspace binding</div>
          <div className="focus-lower-title">{workspaceBindingSummary.headline}</div>
          <div className="focus-lower-copy">
            {task
              ? `${workspaceBindingSummary.detail} · ${task.currentOwner || 'supervisor'}`
              : 'Pick a task to inspect its workspace binding, active run, and operator controls.'}
          </div>

          {task ? (
            <>
              <div className="focus-lower-inline-card">
                <div>{workspaceBindingSummary.scopeLabel}</div>
                <div>{workspaceBindingSummary.pathLabel}</div>
              </div>

              <div className="focus-control-row">
                <button
                  type="button"
                  className="console-secondary-button"
                  onClick={() => onControlTask(task.id, 'pause')}
                  disabled={!canPauseTask(task) || controllingTaskAction !== null}
                >
                  {controllingTaskAction === 'pause' ? 'Pausing…' : 'Pause'}
                </button>
                <button
                  type="button"
                  className="console-secondary-button"
                  onClick={() => onControlTask(task.id, 'resume')}
                  disabled={!canResumeTask(task) || controllingTaskAction !== null}
                >
                  {controllingTaskAction === 'resume' ? 'Resuming…' : 'Resume'}
                </button>
                <button
                  type="button"
                  className="console-danger-button"
                  onClick={() => onControlTask(task.id, 'stop')}
                  disabled={!canStopTask(task) || controllingTaskAction !== null}
                >
                  {controllingTaskAction === 'stop' ? 'Stopping…' : 'Stop'}
                </button>
              </div>

              <div className="focus-lower-inline-card">
                <div>{task.activeSessionId ? `run-${task.activeSessionId.slice(0, 8)}` : 'No active run'}</div>
                <div>
                  {taskPack ? `${taskPack.name} · v${taskPack.version}` : 'No environment pack bound'}
                  {' · '}
                  {decisions.length} pending decision{decisions.length === 1 ? '' : 's'}
                </div>
              </div>
            </>
          ) : null}
        </section>

        <section className="focus-lower-card">
          <div className="focus-lower-label">Acceptance surface</div>
          <div className={`focus-lower-inline-card artifact-summary-card is-${acceptanceSummary.tone}`}>
            <div className="artifact-summary-headline">{acceptanceSummary.headline}</div>
            <div className="artifact-summary-detail">{acceptanceSummary.detail}</div>
          </div>

          {primaryArtifact && primaryArtifactPreviewUrl ? (
            <div className="artifact-stage-card">
              <div className="artifact-stage-header">
                <div>
                  <div className="artifact-stage-kicker">Interactive preview</div>
                  <div className="artifact-stage-title">{formatArtifactLabel(primaryArtifact.path)}</div>
                  <div className="artifact-preview-meta">
                    {primaryArtifact.toolName ? `${primaryArtifact.toolName} · ` : ''}
                    {primaryArtifact.createdAt}
                  </div>
                </div>
                <a
                  href={primaryArtifactPreviewUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="focus-link-button artifact-preview-link"
                >
                  Open full preview
                </a>
              </div>
              <iframe
                key={primaryArtifact.path}
                className="artifact-stage-frame"
                src={primaryArtifactPreviewUrl}
                title={`Artifact preview: ${formatArtifactLabel(primaryArtifact.path)}`}
                loading="lazy"
              />
            </div>
          ) : null}

          <div className="artifact-metrics-grid">
            <div className="artifact-metric-card">
              <div className="artifact-metric-label">Previewable artifacts</div>
              <strong>{evidenceDigest.artifactCount}</strong>
            </div>
            <div className="artifact-metric-card">
              <div className="artifact-metric-label">Touched files</div>
              <strong>{evidenceDigest.modifiedFileCount}</strong>
            </div>
            <div className="artifact-metric-card">
              <div className="artifact-metric-label">Tool events</div>
              <strong>{evidenceDigest.rawEventCount}</strong>
            </div>
          </div>

          {evidenceDigest.previewableArtifacts.length > 0 ? (
            <div className="artifact-list">
              {evidenceDigest.previewableArtifacts.slice(0, 3).map((artifact) => (
                <div key={artifact.path} className="artifact-item artifact-preview-card">
                  <div className="artifact-preview-header">
                    <div>
                      <div className="artifact-preview-title">{formatArtifactLabel(artifact.path)}</div>
                      <div className="artifact-preview-meta">
                        {artifact.toolName ? `${artifact.toolName} · ` : ''}
                        {artifact.createdAt}
                      </div>
                    </div>
                    <a
                      href={buildWorkbenchArtifactPreviewUrl(artifact.path)}
                      target="_blank"
                      rel="noreferrer"
                      className="focus-link-button artifact-preview-link"
                    >
                      Preview
                    </a>
                  </div>
                  <div className="artifact-preview-path">{artifact.path}</div>
                  {artifact.outputExcerpt ? (
                    <div className="artifact-preview-excerpt">{artifact.outputExcerpt}</div>
                  ) : null}
                </div>
              ))}
            </div>
          ) : (
            <div className="artifact-item is-empty">No previewable artifact yet. Use task steering to push for a concrete artifact.</div>
          )}

          {evidenceDigest.latestOutputExcerpt || evidenceDigest.latestErrorExcerpt ? (
            <div className="artifact-output-box">
              <div className="artifact-output-label">
                Latest {evidenceDigest.latestErrorExcerpt ? 'error' : 'output'}
                {evidenceDigest.latestToolName ? ` · ${evidenceDigest.latestToolName}` : ''}
              </div>
              <div className="artifact-output-text">
                {evidenceDigest.latestErrorExcerpt || evidenceDigest.latestOutputExcerpt}
              </div>
            </div>
          ) : null}

          <div className="artifact-list">
            {evidenceDigest.modifiedFiles.slice(0, 5).map((filePath) => (
              <div key={filePath} className="artifact-item">
                {filePath}
              </div>
            ))}
            {evidenceDigest.modifiedFiles.length === 0 ? (
              <div className="artifact-item is-empty">No file outputs recorded for this task yet.</div>
            ) : null}
          </div>
        </section>
      </section>

      {task && selectedPack ? (
        <section className="focus-setup-card" id="task-setup-panel">
          <div className="focus-setup-header">
            <div>
              <div className="focus-lower-label">Execution setup</div>
              <div className="focus-lower-title">Adjust how this task runs inside {selectedPack.name}</div>
            </div>
            <div className="focus-chip-row">
              <span className="focus-chip">{selectedPack.id}</span>
              <span className="focus-chip">{selectedSkills.length}/{selectedPack.skills.length} skills</span>
              <span className="focus-chip">{selectedKnowledgeIds.length}/{selectedPack.knowledge.length} knowledge</span>
            </div>
          </div>

          <div className="focus-lower-copy focus-setup-copy">
            This changes the current task process only. It does not edit the environment pack itself.
          </div>

          <div className="focus-setup-pack-picker">
            <label htmlFor="task-setup-pack" className="task-launch-label">Environment pack</label>
            <select
              id="task-setup-pack"
              className="task-launch-field"
              value={selectedPackId || ''}
              onChange={(event) => {
                const nextPack = availablePacks.find((entry) => entry.id === event.target.value) || null;
                setSelectedPackId(event.target.value || null);
                setSaveMessage(nextPack ? `Draft switched to ${nextPack.name}.` : null);
                if (nextPack) {
                  setSelectedSkills([...nextPack.skills]);
                  setSelectedKnowledgeIds(nextPack.knowledge.map((entry) => entry.id));
                } else {
                  setSelectedSkills([]);
                  setSelectedKnowledgeIds([]);
                }
              }}
            >
              {availablePacks.map((entry) => (
                <option key={entry.id} value={entry.id}>{entry.name}</option>
              ))}
            </select>
            <div className="focus-setup-pack-copy">
              {selectedPack.description}
            </div>
          </div>

          <div className={`focus-setup-state ${configurationDirty ? 'is-dirty' : 'is-clean'}`}>
            {configurationDirty
              ? 'Unsaved setup changes are ready to apply to the current task.'
              : 'This task is currently using its saved environment setup.'}
          </div>

          <div className="focus-setup-summary-grid">
            <div className="focus-lower-inline-card">
              <div className="focus-selection-title">Skills in use</div>
              <div className="focus-setup-summary-copy">
                {selectedSkills.length > 0 ? selectedSkills.map(labelize).join(', ') : 'No skills selected'}
              </div>
            </div>
            <div className="focus-lower-inline-card">
              <div className="focus-selection-title">Knowledge in use</div>
              <div className="focus-setup-summary-copy">
                {selectedKnowledgeIds.length > 0
                  ? selectedPack.knowledge
                    .filter((entry) => selectedKnowledgeIds.includes(entry.id))
                    .map((entry) => entry.label)
                    .join(', ')
                  : 'No knowledge sources selected'}
              </div>
            </div>
          </div>

          <div className="focus-setup-grid">
            <TaskSelectionList
              title="Skills"
              items={selectedPack.skills.map((skill) => ({ id: skill, label: labelize(skill), subtitle: 'Skill' }))}
              selectedIds={selectedSkills}
              onToggle={(skill) => {
                setSaveMessage(null);
                setSelectedSkills((current) => orderSelection(
                  current.includes(skill)
                    ? current.filter((item) => item !== skill)
                    : [...current, skill],
                  selectedPack.skills,
                ));
              }}
            />

            <TaskSelectionList
              title="Knowledge"
              items={selectedPack.knowledge.map((entry) => ({ id: entry.id, label: entry.label, subtitle: entry.kind }))}
              selectedIds={selectedKnowledgeIds}
              onToggle={(knowledgeId) => {
                setSaveMessage(null);
                setSelectedKnowledgeIds((current) => orderSelection(
                  current.includes(knowledgeId)
                    ? current.filter((item) => item !== knowledgeId)
                    : [...current, knowledgeId],
                  selectedPack.knowledge.map((entry) => entry.id),
                ));
              }}
            />
          </div>

          <div className="focus-steering-actions">
            <button
              type="button"
              className="task-launch-button"
              onClick={async () => {
                try {
                  await onSaveTaskConfiguration(task.id, {
                    environmentPackId: selectedPackId || undefined,
                    selectedSkills,
                    selectedKnowledgeIds,
                  });
                  setSaveMessage('Setup updated.');
                } catch (error) {
                  setSaveMessage((error as Error).message || 'Unable to save setup changes.');
                }
              }}
              disabled={!configurationDirty || savingConfiguration}
            >
              {savingConfiguration ? 'Saving…' : 'Save setup'}
            </button>
            <button
              type="button"
              className="console-secondary-button"
              onClick={() => {
                if (!packDefaults) {
                  return;
                }
                setSelectedPackId(selectedPack.id);
                setSelectedSkills(packDefaults.selectedSkills);
                setSelectedKnowledgeIds(packDefaults.selectedKnowledgeIds);
                setSaveMessage(null);
              }}
            >
              Reset to pack defaults
            </button>
          </div>

          {saveMessage ? <div className="focus-feedback">{saveMessage}</div> : null}
        </section>
      ) : null}
    </div>
  );
}

function formatLogTimestamp(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return '--:--:--';
  }

  return date.toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}

function TaskSelectionList({
  title,
  items,
  selectedIds,
  onToggle,
}: {
  title: string;
  items: Array<{ id: string; label: string; subtitle: string }>;
  selectedIds: string[];
  onToggle: (id: string) => void;
}) {
  return (
    <div className="focus-selection-block">
      <div className="focus-selection-title">{title}</div>
      <div className="focus-selection-list">
        {items.map((item) => {
          const active = selectedIds.includes(item.id);
          return (
            <button
              key={item.id}
              type="button"
              className={`focus-selection-item ${active ? 'is-active' : ''}`}
              onClick={() => onToggle(item.id)}
            >
              <div>
                <div className="focus-selection-label">{item.label}</div>
                <div className="focus-selection-subtitle">{item.subtitle}</div>
              </div>
              <div className={`focus-selection-indicator ${active ? 'is-active' : ''}`} />
            </button>
          );
        })}
      </div>
    </div>
  );
}

function labelize(id: string): string {
  return id
    .split(/[-_]/g)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function orderSelection(selection: string[], canonical: string[]): string[] {
  return canonical.filter((item) => selection.includes(item));
}

function canPauseTask(task: WorkbenchTaskResponse): boolean {
  return task.status === 'new' || task.status === 'running' || task.status === 'verifying' || task.status === 'waiting_for_user';
}

function canResumeTask(task: WorkbenchTaskResponse): boolean {
  return task.status === 'paused';
}

function canStopTask(task: WorkbenchTaskResponse): boolean {
  return task.status === 'new'
    || task.status === 'running'
    || task.status === 'verifying'
    || task.status === 'waiting_for_user'
    || task.status === 'paused';
}

function formatArtifactLabel(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/');
  return normalized.split('/').filter(Boolean).pop() || filePath;
}
