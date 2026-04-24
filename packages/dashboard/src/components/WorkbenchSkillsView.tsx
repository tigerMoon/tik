import React, { useEffect, useId, useMemo, useState } from 'react';
import type { EnvironmentPackManifest, SkillManifestRegistryEntry } from '@tik/shared';
import type { WorkbenchTaskResponse } from '../api/client';
import {
  buildSkillBindingsSnippet,
  buildSkillChecklist,
  buildSkillChangeItems,
  buildSkillCommandSnippet,
  buildSkillDependenciesSnippet,
  buildSkillImpactItems,
  buildSkillManifestRecords,
  buildSkillManifestSnippet,
  buildSkillPublishRecommendation,
  buildSkillTestHarnessSnippet,
  buildSkillVersionEntries,
  resolveSkillManifestPersistenceStatus,
  type SkillManifestRecord,
} from '../view-models/skills';

type SkillManifestTab = 'overview' | 'spec' | 'bindings' | 'tests';
type SkillManifestSection = 'overview' | 'contract' | 'dependencies' | 'bindings' | 'success' | 'tests' | 'versions';

interface WorkbenchSkillsViewProps {
  packs: EnvironmentPackManifest[];
  tasks: WorkbenchTaskResponse[];
  activePackId: string | null;
  activeTask: WorkbenchTaskResponse | null;
  registryEntries: SkillManifestRegistryEntry[];
  savingDraftSkillId?: string | null;
  publishingSkillId?: string | null;
  onSaveDraft: (skillId: string, notes: string, skill: SkillManifestRecord) => Promise<void>;
  onPublish: (skillId: string, notes: string, skill: SkillManifestRecord) => Promise<void>;
  onOpenTask: (taskId: string) => void;
}

const SECTION_ITEMS: Array<{ id: SkillManifestSection; label: string; tab: SkillManifestTab }> = [
  { id: 'overview', label: 'Overview', tab: 'overview' },
  { id: 'contract', label: 'Contract', tab: 'spec' },
  { id: 'dependencies', label: 'Dependencies', tab: 'overview' },
  { id: 'bindings', label: 'Bindings', tab: 'bindings' },
  { id: 'success', label: 'Success criteria', tab: 'tests' },
  { id: 'tests', label: 'Tests', tab: 'tests' },
  { id: 'versions', label: 'Versions', tab: 'overview' },
];

export function WorkbenchSkillsView({
  packs,
  tasks,
  activePackId,
  activeTask,
  registryEntries,
  savingDraftSkillId = null,
  publishingSkillId = null,
  onSaveDraft,
  onPublish,
  onOpenTask,
}: WorkbenchSkillsViewProps) {
  const noteInputId = useId();
  const [selectedSkillId, setSelectedSkillId] = useState<string | null>(null);
  const [manifestTab, setManifestTab] = useState<SkillManifestTab>('overview');
  const [selectedSection, setSelectedSection] = useState<SkillManifestSection>('overview');
  const [feedback, setFeedback] = useState<string | null>(null);
  const [draftNotesBySkill, setDraftNotesBySkill] = useState<Record<string, string>>({});
  const records = useMemo(
    () => buildSkillManifestRecords(packs, tasks, activePackId, registryEntries),
    [activePackId, packs, registryEntries, tasks],
  );

  useEffect(() => {
    if (records.length === 0) {
      setSelectedSkillId(null);
      return;
    }

    if (selectedSkillId && records.some((record) => record.id === selectedSkillId)) {
      return;
    }

    setSelectedSkillId(resolvePreferredSkillId(records, packs, activePackId, activeTask));
  }, [activePackId, activeTask, packs, records, selectedSkillId]);

  const selectedSkill = records.find((record) => record.id === selectedSkillId) || records[0] || null;

  useEffect(() => {
    if (!selectedSkill) {
      return;
    }

    setDraftNotesBySkill((current) => {
      if (current[selectedSkill.id] !== undefined) {
        return current;
      }

      return {
        ...current,
        [selectedSkill.id]: selectedSkill.registryEntry?.draft?.notes
          || selectedSkill.registryEntry?.published?.notes
          || buildDefaultSkillNotes(selectedSkill),
      };
    });
  }, [selectedSkill]);

  useEffect(() => {
    if (!selectedSkill) {
      return;
    }

    if (selectedSection === 'contract' && manifestTab !== 'spec') {
      setManifestTab('spec');
    }
    if (selectedSection === 'bindings' && manifestTab !== 'bindings') {
      setManifestTab('bindings');
    }
    if ((selectedSection === 'success' || selectedSection === 'tests') && manifestTab !== 'tests') {
      setManifestTab('tests');
    }
  }, [manifestTab, selectedSection, selectedSkill]);

  if (!selectedSkill) {
    return (
      <div className="skills-main">
        <section className="panel topbar">
          <div className="top-left">
            <h1>Skill Manifest</h1>
          </div>
        </section>
        <section className="card skills-empty-card">
          No skills are available in the current environment packs yet.
        </section>
      </div>
    );
  }

  const manifestSnippet = buildSkillManifestSnippet(selectedSkill);
  const dependenciesSnippet = buildSkillDependenciesSnippet(selectedSkill);
  const bindingsSnippet = buildSkillBindingsSnippet(selectedSkill);
  const testHarnessSnippet = buildSkillTestHarnessSnippet(selectedSkill);
  const checklist = buildSkillChecklist(selectedSkill);
  const currentNotes = draftNotesBySkill[selectedSkill.id]
    ?? selectedSkill.registryEntry?.draft?.notes
    ?? selectedSkill.registryEntry?.published?.notes
    ?? buildDefaultSkillNotes(selectedSkill);
  const changeItems = buildSkillChangeItems(selectedSkill, currentNotes);
  const impactItems = buildSkillImpactItems(selectedSkill);
  const versionEntries = buildSkillVersionEntries(selectedSkill);
  const commandSnippet = buildSkillCommandSnippet(selectedSkill);
  const latestTask = selectedSkill.relatedTasks[0] || null;
  const persistenceStatus = resolveSkillManifestPersistenceStatus(selectedSkill, currentNotes);
  const persistenceChip = resolvePersistenceChip(selectedSkill, persistenceStatus);
  const publishRecommendation = buildSkillPublishRecommendation(selectedSkill, currentNotes);
  const canSaveDraft = persistenceStatus === 'changes-unsaved';
  const canPublish = publishRecommendation.canPublish;
  const publishTone = resolvePublishTone(publishRecommendation.strategy);
  const publishActionLabel = publishingSkillId === selectedSkill.id
    ? 'Publishing…'
    : canPublish
      ? `Publish v${publishRecommendation.nextVersion}`
      : persistenceStatus === 'published'
        ? 'Published'
        : 'Publish';

  const handleSectionSelect = (section: SkillManifestSection, tab: SkillManifestTab) => {
    setSelectedSection(section);
    setManifestTab(tab);
  };

  const handleManifestCopy = async () => {
    if (!navigator?.clipboard?.writeText) {
      setFeedback('Clipboard is unavailable in this browser session. Use the command composer below to inspect the manifest.');
      return;
    }

    try {
      await navigator.clipboard.writeText(manifestSnippet);
      setFeedback(`Copied manifest draft for ${selectedSkill.id}.`);
    } catch (error) {
      setFeedback((error as Error).message);
    }
  };

  return (
    <div className="skills-main">
      <section className="panel topbar">
        <div className="top-left">
          <h1>Skill Manifest</h1>
          <div className="chips">
            <span className="chip">{selectedSkill.id}</span>
            <span className="chip">
              <span className="dot" style={{ background: selectedSkill.scope === 'shared' ? 'var(--wb-blue)' : 'var(--wb-green)' }} />
              {selectedSkill.scope}
            </span>
            <span className="chip">v{selectedSkill.version}</span>
            {publishRecommendation.canPublish && publishRecommendation.nextVersion !== selectedSkill.version ? (
              <span className="chip">
                next v{publishRecommendation.nextVersion}
              </span>
            ) : null}
            <span className="chip">
              <span className="dot" style={{ background: selectedSkill.selectedTaskCount > 0 ? 'var(--wb-yellow)' : 'var(--wb-blue)' }} />
              {selectedSkill.selectedTaskCount} selected task{selectedSkill.selectedTaskCount === 1 ? '' : 's'}
            </span>
            <span className="chip">
              <span className="dot" style={{ background: persistenceChip.color }} />
              {persistenceChip.label}
            </span>
          </div>
        </div>
        <div className="actions">
          <button
            type="button"
            className="btn"
            onClick={() => {
              setManifestTab('tests');
              setSelectedSection('tests');
              setFeedback(`Prepared the sample harness for ${selectedSkill.id}. Review bindings and recent tasks before promoting it.`);
            }}
          >
            Run test
          </button>
          <button
            type="button"
            className="btn"
            onClick={async () => {
              try {
                await onSaveDraft(selectedSkill.id, currentNotes, selectedSkill);
                setFeedback(`Draft saved for ${selectedSkill.id}.`);
              } catch (error) {
                setFeedback((error as Error).message);
              }
            }}
            disabled={!canSaveDraft || savingDraftSkillId === selectedSkill.id || publishingSkillId === selectedSkill.id}
          >
            {savingDraftSkillId === selectedSkill.id ? 'Saving…' : 'Save draft'}
          </button>
          <button
            type="button"
            className="btn"
            onClick={async () => {
              try {
                await onPublish(selectedSkill.id, currentNotes, selectedSkill);
                setFeedback(`Published ${selectedSkill.id}.`);
              } catch (error) {
                setFeedback((error as Error).message);
              }
            }}
            disabled={!canPublish || publishingSkillId === selectedSkill.id || savingDraftSkillId === selectedSkill.id}
          >
            {publishActionLabel}
          </button>
          <button
            type="button"
            className="btn primary"
            disabled={!latestTask}
            onClick={() => {
              if (!latestTask) {
                return;
              }
              onOpenTask(latestTask.id);
            }}
          >
            {latestTask ? 'Open task' : 'No task yet'}
          </button>
        </div>
      </section>

      <section className="skills-content">
        <section className="card skills-menu-card">
          <div>
            <div className="card-title">Skills · {records.length} <span className="small">manifest-backed capability registry</span></div>
            <div className="pack-list skills-skill-list">
              {records.map((record) => (
                <button
                  key={record.id}
                  type="button"
                  className={`pack skills-skill-item ${record.id === selectedSkill.id ? 'selected' : ''}`}
                  onClick={() => {
                    setSelectedSkillId(record.id);
                    setFeedback(null);
                  }}
                >
                  <div className="row">
                    <div className="pack-name">{record.id}</div>
                    <div className={`pill ${record.scope === 'shared' ? 'ready' : 'active'}`}>
                      {record.scope}
                    </div>
                  </div>
                  <div className="desc">{record.ownerPackName}</div>
                  <div className="small skills-skill-meta">
                    {record.bindings.length} bindings · {record.requiredTools.length} tools · {record.selectedTaskCount} live tasks
                  </div>
                </button>
              ))}
            </div>
          </div>

          <div className="card skills-subcard">
            <div className="card-title">Sections</div>
            <div className="menu">
              {SECTION_ITEMS.map((section) => (
                <button
                  key={section.id}
                  type="button"
                  className={`menu-item ${selectedSection === section.id ? 'active' : ''}`}
                  onClick={() => handleSectionSelect(section.id, section.tab)}
                >
                  {section.label}
                </button>
              ))}
            </div>
          </div>

          <div className="card skills-subcard">
            <div className="card-title">Version history</div>
            <div className="version-list">
              {versionEntries.map((entry) => (
                <div key={entry.id} className="vitem">
                  <strong>v{entry.version}</strong>
                  <div className="small">{entry.detail}</div>
                </div>
              ))}
            </div>
          </div>

          <div className="card skills-subcard">
            <div className="card-title">Promotion path</div>
            <div className="small skills-promotion-copy">
              {selectedSkill.scope === 'shared'
                ? `This skill is already shared across ${selectedSkill.packIds.length} packs and should be reviewed for compatibility before changing its contract.`
                : `This skill is environment-scoped to ${selectedSkill.ownerPackId}. Promote it only after portability and policy hooks are reviewed.`}
            </div>
            <div className="item skills-promotion-item">
              {selectedSkill.scope === 'shared'
                ? 'Review shared compatibility before publish'
                : 'Clone to shared scope after portability review'}
            </div>
          </div>
        </section>

        <section className="card skills-manifest-card">
          <div className="card-title">Editable manifest</div>

          <div className="tabs">
            {[
              { id: 'overview', label: 'Overview' },
              { id: 'spec', label: 'Spec' },
              { id: 'bindings', label: 'Bindings' },
              { id: 'tests', label: 'Tests' },
            ].map((tab) => (
              <button
                key={tab.id}
                type="button"
                className={`tab ${manifestTab === tab.id ? 'active' : ''}`}
                onClick={() => {
                  setManifestTab(tab.id as SkillManifestTab);
                  setSelectedSection(tab.id === 'spec'
                    ? 'contract'
                    : tab.id === 'bindings'
                      ? 'bindings'
                      : tab.id === 'tests'
                        ? 'tests'
                        : 'overview');
                }}
              >
                {tab.label}
              </button>
            ))}
          </div>

          <div className="meta-box">
            <div className="meta-grid">
              <div>
                <div className="k">id</div>
                <div className="v">{selectedSkill.id}</div>
              </div>
              <div>
                <div className="k">scope</div>
                <div className="v">{selectedSkill.scope}</div>
              </div>
              <div>
                <div className="k">version</div>
                <div className="v">{selectedSkill.version}</div>
              </div>
              <div>
                <div className="k">pack</div>
                <div className="v">{selectedSkill.ownerPackId}</div>
              </div>
            </div>
          </div>

          {manifestTab === 'overview' ? (
            <>
              <div className="codebox">
                <div className="code-title">Core spec</div>
                {manifestSnippet}
              </div>

              <div className="columns skills-columns">
                <div className="codebox skills-inline-codebox">
                  <div className="code-title">Dependencies</div>
                  {dependenciesSnippet}
                </div>
                <div className="codebox skills-inline-codebox">
                  <div className="code-title">Evaluation</div>
                  {buildEvaluationSnippet(selectedSkill)}
                </div>
              </div>
            </>
          ) : null}

          {manifestTab === 'spec' ? (
            <div className="codebox">
              <div className="code-title">Contract</div>
              {buildContractSnippet(selectedSkill)}
            </div>
          ) : null}

          {manifestTab === 'bindings' ? (
            <div className="codebox">
              <div className="code-title">Bindings</div>
              {bindingsSnippet}
            </div>
          ) : null}

          {manifestTab === 'tests' ? (
            <div className="codebox">
              <div className="code-title">Tests</div>
              {testHarnessSnippet}
              {'\n\n'}
              {buildSuccessSnippet(selectedSkill)}
            </div>
          ) : null}

          <div className="notes">
            <label htmlFor={noteInputId} className="skills-note-label">Manifest notes</label>
            <textarea
              id={noteInputId}
              className="skills-note-editor"
              value={currentNotes}
              onChange={(event) => {
                const nextValue = event.target.value;
                setDraftNotesBySkill((current) => ({
                  ...current,
                  [selectedSkill.id]: nextValue,
                }));
              }}
            />
            <div className="small skills-note-copy">
              Draft and publish actions persist these notes with the current manifest snapshot.
            </div>
          </div>
        </section>

        <section className="skills-right-card">
          <section className="card">
            <div className="card-title">Test harness</div>
            <div className="small skills-card-copy">Run this skill with sample context before promoting the manifest.</div>
            <div className="codebox skills-card-codebox">
              {testHarnessSnippet}
            </div>
            <div className="action-list">
              <button
                type="button"
                className="item skills-inline-button"
                onClick={() => {
                  setManifestTab('tests');
                  setSelectedSection('tests');
                  setFeedback(`Harness opened for ${selectedSkill.id}. Use the sample task and checks as your review baseline.`);
                }}
              >
                Run sample
              </button>
              <div className="item">
                Last observed · {selectedSkill.activeTaskCount} active · {selectedSkill.selectedTaskCount} selected
              </div>
            </div>
          </section>

          <section className="card">
            <div className="card-title">Change summary</div>
            <div className="queue">
              {changeItems.map((item) => (
                <div key={item.id} className={`qitem skills-change-item is-${item.tone}`}>
                  <strong>{item.title}</strong>
                  <div className="small">{item.detail}</div>
                </div>
              ))}
            </div>
          </section>

          <section className="card">
            <div className="card-title">Publish gate</div>
            <div className="queue">
              <div className={`qitem skills-change-item is-${publishTone}`}>
                <strong>{resolvePublishHeadline(publishRecommendation.strategy)}</strong>
                <div className="small">
                  Governed version: v{publishRecommendation.currentVersion} → v{publishRecommendation.nextVersion}
                </div>
                <div className="small skills-publish-rationale">{publishRecommendation.rationale}</div>
              </div>
            </div>
          </section>

          <section className="card">
            <div className="card-title">Impact before publish</div>
            <div className="queue">
              {impactItems.map((item) => (
                <div key={item.title} className="qitem">
                  <strong>{item.title}</strong>
                  <div className="small">{item.detail}</div>
                </div>
              ))}
            </div>
          </section>

          <section className="card">
            <div className="card-title">Review & publish</div>
            {checklist.map((item) => (
              <div key={item.label} className="check">
                <span className={`badge ${item.tone === 'green' ? 'is-green' : 'is-yellow'}`} />
                {item.label}
              </div>
            ))}
            <div className="action-list skills-review-actions">
              <button
                type="button"
                className="item skills-inline-button"
                onClick={() => {
                  void handleManifestCopy();
                }}
              >
                Copy manifest
              </button>
              <button
                type="button"
                className="item skills-inline-button"
                disabled={!latestTask}
                onClick={() => {
                  if (latestTask) {
                    onOpenTask(latestTask.id);
                  }
                }}
              >
                {latestTask ? 'Open latest task' : 'No recent task'}
              </button>
            </div>
          </section>

          <section className="card">
            <div className="card-title">Related tasks</div>
            <div className="action-list">
              {selectedSkill.relatedTasks.length > 0 ? selectedSkill.relatedTasks.map((task) => (
                <button
                  key={task.id}
                  type="button"
                  className="item skills-inline-button skills-related-task"
                  onClick={() => onOpenTask(task.id)}
                >
                  <strong>{task.title}</strong>
                  <span>{task.id.slice(0, 8).toUpperCase()} · {task.status.replace(/_/g, ' ')}</span>
                </button>
              )) : (
                <div className="item">No bound tasks selected this skill yet.</div>
              )}
            </div>
          </section>
        </section>
      </section>

      <section className="panel composer">
        <div className="small skills-composer-label">Universal composer</div>
        <div className="skills-composer-main">
          <div className="inputbox">{commandSnippet}</div>
          <div className="helper">Suggested: #run-test · #show-impact · #open-task · #copy-manifest</div>
        </div>
      </section>

      {feedback ? (
        <div className="environment-feedback">{feedback}</div>
      ) : null}
    </div>
  );
}

function buildContractSnippet(skill: SkillManifestRecord): string {
  return [
    `description: ${skill.label} skill manifest`,
    `goal: coordinate ${skill.bindings.length || 1} workflow binding${skill.bindings.length === 1 ? '' : 's'} with governed dependencies`,
    `entrypoint: skill://${skill.ownerPackId}/${skill.id}`,
    `owner_pack: ${skill.ownerPackId}`,
    '',
    'input_schema:',
    '  required: [task_brief, workspace_context]',
    'output_schema:',
    `  fields: [summary, bindings, required_tools, policy_hooks${skill.evaluators.length > 0 ? ', evaluators' : ''}]`,
  ].join('\n');
}

function buildEvaluationSnippet(skill: SkillManifestRecord): string {
  return [
    'success_criteria:',
    `  - owner pack present (${skill.ownerPackId})`,
    `  - ${skill.bindings.length > 0 ? 'workflow bindings observed' : 'binding review required'}`,
    `  - ${skill.selectedTaskCount > 0 ? 'live task selection observed' : 'seed with first live task selection'}`,
    '',
    'quality_thresholds:',
    `  bindings: ${skill.bindings.length > 0 ? 'pass' : 'warn'}`,
    `  usage: ${skill.selectedTaskCount > 0 ? 'pass' : 'warn'}`,
    `  scope: ${skill.scope === 'shared' ? 'shared-ready' : 'promotion-review'}`,
  ].join('\n');
}

function buildSuccessSnippet(skill: SkillManifestRecord): string {
  return [
    'success_criteria:',
    `  - bindings discovered: ${skill.bindings.length}`,
    `  - selected tasks observed: ${skill.selectedTaskCount}`,
    `  - policy hooks tracked: ${skill.policyHooks.length}`,
    `  - evaluators registered: ${skill.evaluators.length}`,
  ].join('\n');
}

function buildDefaultSkillNotes(skill: SkillManifestRecord): string {
  const scopeLine = skill.scope === 'shared'
    ? `Shared skill across ${skill.packIds.length} packs.`
    : `Environment-scoped to ${skill.ownerPackId}.`;
  const bindingLine = skill.bindings.length > 0
    ? `${skill.bindings.length} workflow binding${skill.bindings.length === 1 ? '' : 's'} currently reference this skill.`
    : 'No workflow bindings are currently declared.';

  return `${scopeLine} ${bindingLine}`;
}

function resolvePersistenceChip(
  skill: SkillManifestRecord,
  status: 'changes-unsaved' | 'draft-saved' | 'published',
): { label: string; color: string } {
  if (status === 'published') {
    return {
      label: skill.registryEntry?.published?.publishedAt ? 'published' : 'published',
      color: 'var(--wb-green)',
    };
  }

  if (status === 'draft-saved') {
    return {
      label: 'draft saved',
      color: 'var(--wb-blue)',
    };
  }

  return {
    label: 'draft changes unsaved',
    color: 'var(--wb-yellow)',
  };
}

function resolvePreferredSkillId(
  records: SkillManifestRecord[],
  packs: EnvironmentPackManifest[],
  activePackId: string | null,
  activeTask: WorkbenchTaskResponse | null,
): string {
  const availableIds = new Set(records.map((record) => record.id));
  const selectedTaskSkill = activeTask?.environmentPackSelection?.selectedSkills.find((skillId) => availableIds.has(skillId));
  if (selectedTaskSkill) {
    return selectedTaskSkill;
  }

  const taskPackSkills = packs.find((pack) => pack.id === activeTask?.environmentPackSnapshot?.id)?.skills || [];
  const taskPackSkill = taskPackSkills.find((skillId) => availableIds.has(skillId));
  if (taskPackSkill) {
    return taskPackSkill;
  }

  const activePackSkills = packs.find((pack) => pack.id === activePackId)?.skills || [];
  const activePackSkill = activePackSkills.find((skillId) => availableIds.has(skillId));
  if (activePackSkill) {
    return activePackSkill;
  }

  return records[0].id;
}

function resolvePublishHeadline(strategy: 'initial' | 'none' | 'patch' | 'minor' | 'major'): string {
  switch (strategy) {
    case 'initial':
      return 'Initial governed release';
    case 'none':
      return 'No publish required';
    case 'patch':
      return 'Patch version bump';
    case 'minor':
      return 'Minor version bump';
    case 'major':
      return 'Major version bump';
    default:
      return 'Publish review';
  }
}

function resolvePublishTone(strategy: 'initial' | 'none' | 'patch' | 'minor' | 'major'): 'blue' | 'green' | 'yellow' {
  switch (strategy) {
    case 'none':
      return 'green';
    case 'major':
      return 'yellow';
    default:
      return 'blue';
  }
}
