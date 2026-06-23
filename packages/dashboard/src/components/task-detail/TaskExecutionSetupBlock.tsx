import React, { useEffect, useMemo, useState } from 'react';
import type { EnvironmentPackManifest, EnvironmentPackSelection } from '@tik/shared';
import {
  type UpdateWorkbenchTaskConfigurationInput,
  type WorkbenchTaskResponse,
} from '../../api/client';

interface TaskExecutionSetupBlockProps {
  task: WorkbenchTaskResponse;
  pack: EnvironmentPackManifest | null;
  packs: EnvironmentPackManifest[];
  savingConfiguration: boolean;
  onSaveTaskConfiguration: (taskId: string, selection: UpdateWorkbenchTaskConfigurationInput) => Promise<void>;
}

export function TaskExecutionSetupBlock({
  task,
  pack,
  packs,
  savingConfiguration,
  onSaveTaskConfiguration,
}: TaskExecutionSetupBlockProps) {
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

  const [expanded, setExpanded] = useState(false);
  const [selectedPackId, setSelectedPackId] = useState<string | null>(
    task.environmentPackSnapshot?.id || pack?.id || availablePacks[0]?.id || null,
  );
  const [selectedSkills, setSelectedSkills] = useState<string[]>([]);
  const [selectedKnowledgeIds, setSelectedKnowledgeIds] = useState<string[]>([]);
  const [feedback, setFeedback] = useState<string | null>(null);

  const selectedPack = useMemo<EnvironmentPackManifest | null>(() => {
    if (!selectedPackId) {
      return pack;
    }
    return availablePacks.find((entry) => entry.id === selectedPackId) || pack || null;
  }, [availablePacks, pack, selectedPackId]);

  useEffect(() => {
    const taskPackId = task.environmentPackSnapshot?.id || pack?.id || availablePacks[0]?.id || null;
    setSelectedPackId(taskPackId);

    const taskPack = availablePacks.find((entry) => entry.id === taskPackId) || pack;
    const defaults: EnvironmentPackSelection | null = taskPack
      ? {
          selectedSkills: [...taskPack.skills],
          selectedKnowledgeIds: taskPack.knowledge.map((entry) => entry.id),
        }
      : null;

    setSelectedSkills(task.environmentPackSelection?.selectedSkills || defaults?.selectedSkills || []);
    setSelectedKnowledgeIds(task.environmentPackSelection?.selectedKnowledgeIds || defaults?.selectedKnowledgeIds || []);
    setFeedback(null);
  }, [availablePacks, pack, task.id, task.environmentPackSnapshot?.id, task.environmentPackSelection]);

  const taskPackId = task.environmentPackSnapshot?.id || null;
  const dirty = useMemo(() => (
    selectedPackId !== taskPackId
    || JSON.stringify(selectedSkills) !== JSON.stringify(task.environmentPackSelection?.selectedSkills || [])
    || JSON.stringify(selectedKnowledgeIds) !== JSON.stringify(task.environmentPackSelection?.selectedKnowledgeIds || [])
  ), [selectedPackId, selectedSkills, selectedKnowledgeIds, taskPackId, task.environmentPackSelection]);

  const summary = selectedPack
    ? `${selectedPack.id} · ${selectedSkills.length} skills · ${selectedKnowledgeIds.length} knowledge`
    : 'No environment pack bound';

  return (
    <section className="task-detail-setup">
      <div className="task-detail-block-head">
        <span className="task-detail-block-label">Configure</span>
        <button
          type="button"
          className="task-detail-block-toggle"
          onClick={() => setExpanded((current) => !current)}
        >
          {expanded ? 'Collapse' : 'Expand'}
        </button>
      </div>

      <div className="task-detail-setup-summary">
        <span>{summary}</span>
        {dirty ? <em className="task-detail-setup-dirty">unsaved changes</em> : null}
      </div>

      {expanded && selectedPack ? (
        <div className="task-detail-setup-body">
          <label className="task-launch-label">
            Environment pack
            <select
              className="task-launch-field"
              value={selectedPackId || ''}
              onChange={(event) => {
                const nextPack = availablePacks.find((entry) => entry.id === event.target.value) || null;
                setSelectedPackId(event.target.value || null);
                setFeedback(null);
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
          </label>

          <SelectionList
            title="Skills"
            items={selectedPack.skills.map((skill) => ({ id: skill, label: labelize(skill), subtitle: 'Skill' }))}
            selectedIds={selectedSkills}
            onToggle={(id) => {
              setFeedback(null);
              setSelectedSkills((current) => orderSelection(
                current.includes(id) ? current.filter((item) => item !== id) : [...current, id],
                selectedPack.skills,
              ));
            }}
          />

          <SelectionList
            title="Knowledge"
            items={selectedPack.knowledge.map((entry) => ({ id: entry.id, label: entry.label, subtitle: entry.kind }))}
            selectedIds={selectedKnowledgeIds}
            onToggle={(id) => {
              setFeedback(null);
              setSelectedKnowledgeIds((current) => orderSelection(
                current.includes(id) ? current.filter((item) => item !== id) : [...current, id],
                selectedPack.knowledge.map((entry) => entry.id),
              ));
            }}
          />

          <div className="task-detail-brief-actions">
            <button
              type="button"
              className="task-launch-button"
              disabled={!dirty || savingConfiguration}
              onClick={async () => {
                try {
                  await onSaveTaskConfiguration(task.id, {
                    environmentPackId: selectedPackId || undefined,
                    selectedSkills,
                    selectedKnowledgeIds,
                  });
                  setFeedback('Setup updated.');
                } catch (err) {
                  setFeedback((err as Error).message || 'Unable to save setup changes.');
                }
              }}
            >
              {savingConfiguration ? 'Saving…' : 'Save setup'}
            </button>
            <button
              type="button"
              className="console-secondary-button"
              disabled={savingConfiguration}
              onClick={() => {
                if (!selectedPack) return;
                setSelectedSkills([...selectedPack.skills]);
                setSelectedKnowledgeIds(selectedPack.knowledge.map((entry) => entry.id));
                setFeedback(null);
              }}
            >
              Reset to pack defaults
            </button>
          </div>
          {feedback ? <div className="task-detail-brief-feedback">{feedback}</div> : null}
        </div>
      ) : null}
    </section>
  );
}

function SelectionList({
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
    <div className="task-detail-setup-selection">
      <div className="task-detail-block-meta">{title}</div>
      <div className="task-detail-setup-selection-list">
        {items.map((item) => {
          const active = selectedIds.includes(item.id);
          return (
            <button
              key={item.id}
              type="button"
              className={`task-detail-setup-selection-item ${active ? 'is-active' : ''}`}
              onClick={() => onToggle(item.id)}
            >
              <div>
                <strong>{item.label}</strong>
                <span>{item.subtitle}</span>
              </div>
              <span className={`task-detail-setup-selection-indicator ${active ? 'is-active' : ''}`} aria-hidden />
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
