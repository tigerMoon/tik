import React, { useEffect, useMemo, useState } from 'react';
import type { EnvironmentPackManifest, EnvironmentPackWorkflowCoverage } from '@tik/shared';
import type {
  EnvironmentPackDashboardResponse,
  EnvironmentPackDashboardSummary,
  WorkbenchTaskResponse,
} from '../api/client';
import {
  buildEnvironmentActivationSummary,
  buildEnvironmentCommandSnippet,
  buildEnvironmentPromotionQueue,
  buildEnvironmentWorkflowCoverage,
  countEnvironmentPromotionItems,
  formatRelativeSyncTime,
  getEnvironmentPackStatusBadge,
} from '../view-models/environment';

interface WorkbenchEnvironmentViewProps {
  packs: EnvironmentPackManifest[];
  activePackId: string | null;
  tasks: WorkbenchTaskResponse[];
  lastSyncedAt: string | null;
  dashboard?: EnvironmentPackDashboardResponse | null;
  onSwitchPack: (packId: string) => Promise<void>;
  onUsePackForNewTask: (packId: string) => Promise<void>;
  onOpenTask: (taskId: string) => void;
}

export function WorkbenchEnvironmentView({
  packs,
  activePackId,
  tasks,
  lastSyncedAt,
  dashboard,
  onSwitchPack,
  onUsePackForNewTask,
  onOpenTask,
}: WorkbenchEnvironmentViewProps) {
  const [selectedPackId, setSelectedPackId] = useState<string | null>(activePackId || packs[0]?.id || null);
  const [busyAction, setBusyAction] = useState<'switch' | 'new-task' | null>(null);
  const [manifestOpen, setManifestOpen] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);

  useEffect(() => {
    if (packs.length === 0) {
      setSelectedPackId(null);
      return;
    }

    if (selectedPackId && packs.some((pack) => pack.id === selectedPackId)) {
      return;
    }

    setSelectedPackId(activePackId || packs[0]?.id || null);
  }, [activePackId, packs, selectedPackId]);

  const selectedPack = packs.find((pack) => pack.id === selectedPackId) || null;
  const dashboardSummary = useMemo<EnvironmentPackDashboardSummary | null>(
    () => (selectedPack ? dashboard?.summaries.find((summary) => summary.packId === selectedPack.id) || null : null),
    [dashboard?.summaries, selectedPack],
  );
  const promotionQueue = dashboardSummary?.promotionQueue
    || (selectedPack ? buildEnvironmentPromotionQueue(selectedPack) : []);
  const workflowCoverage = useMemo(
    () => (selectedPack ? buildEnvironmentWorkflowCoverage(selectedPack) : []),
    [selectedPack],
  );
  const totalPromotionCount = dashboard
    ? dashboard.summaries.reduce((total, summary) => total + summary.promotionQueue.length, 0)
    : countEnvironmentPromotionItems(packs);
  const activation = selectedPack
    ? buildEnvironmentActivationSummary(selectedPack, tasks, activePackId, dashboard?.generatedAt || lastSyncedAt)
    : null;
  const commandSnippet = selectedPack
    ? buildEnvironmentCommandSnippet(selectedPack, promotionQueue.length)
    : '@env/<pack-id> #open-manifest';
  const boundTasks = useMemo(
    () => dashboardSummary?.latestBoundTasks || tasks
      .filter((task) => task.environmentPackSnapshot?.id === selectedPack?.id)
      .slice()
      .sort((left, right) => (right.lastProgressAt || right.updatedAt).localeCompare(left.lastProgressAt || left.updatedAt))
      .slice(0, 4),
    [dashboardSummary?.latestBoundTasks, selectedPack?.id, tasks],
  );

  if (!selectedPack) {
    return (
      <div className="environment-main">
        <section className="panel topbar">
          <div className="top-left">
            <h1>Environments</h1>
          </div>
        </section>
        <section className="environment-empty-card card">
          No environment packs were found for this workspace.
        </section>
      </div>
    );
  }

  return (
    <div className="environment-main">
      <section className="panel topbar">
        <div className="top-left">
          <h1>Environments</h1>
          <div className="chips">
            <span className="chip"><span className="dot" style={{ background: 'var(--wb-blue)' }} />{packs.length} packs</span>
            <span className="chip"><span className="dot" style={{ background: 'var(--wb-green)' }} />{activePackId ? '1 active' : '0 active'}</span>
            <span className="chip"><span className="dot" style={{ background: 'var(--wb-yellow)' }} />promotion queue {totalPromotionCount}</span>
          </div>
        </div>
        <div className="actions">
          <button
            type="button"
            className="btn"
            onClick={() => {
              setManifestOpen((current) => !current);
              setFeedback(currentlyOpenMessage(manifestOpen, selectedPack.id));
            }}
          >
            {manifestOpen ? 'Hide manifest' : 'Open manifest'}
          </button>
          <button
            type="button"
            className="btn primary"
            disabled={busyAction !== null || selectedPack.id === activePackId}
            onClick={async () => {
              setBusyAction('switch');
              try {
                await onSwitchPack(selectedPack.id);
                setFeedback(`${selectedPack.name} is now the active environment.`);
              } catch (error) {
                setFeedback((error as Error).message);
              } finally {
                setBusyAction(null);
              }
            }}
          >
            {selectedPack.id === activePackId ? 'Active pack' : 'Switch pack'}
          </button>
        </div>
      </section>

      <section className="environment-content">
        <section className="card environment-pack-column">
          <div className="card-title">Packs · {packs.length} <span className="small">choose capability context</span></div>
          <div className="pack-list">
            {packs.map((pack) => {
              const badge = getEnvironmentPackStatusBadge(pack, activePackId);
              return (
                <button
                  key={pack.id}
                  type="button"
                  className={`pack ${pack.id === selectedPack.id ? 'selected' : ''}`}
                  onClick={() => setSelectedPackId(pack.id)}
                >
                  <div className="row">
                    <div className="pack-name">{pack.id}</div>
                    <div className={`pill ${badge.tone}`}>{badge.label}</div>
                  </div>
                  <div className="desc">{pack.description}</div>
                  <div className="small environment-pack-meta">
                    {pack.tools.length} tools · {pack.skills.length} skills · {pack.policies.length} policies
                  </div>
                </button>
              );
            })}
          </div>
        </section>

        <div className="environment-center-column">
          <section className="card selected-head">
            <div className="card-title">Selected pack</div>
            <div className="name">{selectedPack.id}</div>
            <div className="chips" style={{ marginTop: 14 }}>
              <span className="chip"><span className="dot" style={{ background: selectedPack.id === activePackId ? 'var(--wb-green)' : 'var(--wb-blue)' }} />{selectedPack.id === activePackId ? 'Active' : 'Ready'}</span>
              <span className="chip">v{selectedPack.version}</span>
              <span className="chip">{selectedPack.workflowBindings.length} workflows</span>
              <span className="chip">{selectedPack.evaluators.length} evaluators</span>
              <span className="chip"><span className="dot" style={{ background: 'var(--wb-blue)' }} />single-workspace tasks</span>
            </div>
            <p>{selectedPack.description}</p>
            <div className="inline-bar">
              {selectedPack.workflowBindings.length > 0
                ? selectedPack.workflowBindings.map((binding) => binding.workflow).join(' · ')
                : 'No workflow bindings declared'}
            </div>
          </section>

          <section className="module-grid">
            <EnvironmentItemCard title={`Tools · ${selectedPack.tools.length}`} items={selectedPack.tools} />
            <EnvironmentItemCard title={`Skills · ${selectedPack.skills.length}`} items={selectedPack.skills} />
            <EnvironmentItemCard title={`Knowledge · ${selectedPack.knowledge.length}`} items={selectedPack.knowledge.map((entry) => `${entry.label} · ${entry.kind}`)} />
            <EnvironmentItemCard title={`Policies · ${selectedPack.policies.length}`} items={selectedPack.policies} />
            <EnvironmentCoverageCard coverage={workflowCoverage} />
            <EnvironmentWorkflowCard bindings={selectedPack.workflowBindings} />
            <EnvironmentItemCard title={`Evaluators · ${selectedPack.evaluators.length}`} items={selectedPack.evaluators} />
          </section>
        </div>

        <div className="stack">
          <section className="card">
            <div className="card-title">Activation</div>
            <div className="environment-activation-state">{activation?.statusLabel}</div>
            <div className="kv">
              <div>
                <div className="k">Tasks using this pack</div>
                <div className="v">{dashboardSummary?.boundTaskCount ?? activation?.boundTaskCount ?? 0} bound tasks</div>
              </div>
              <div>
                <div className="k">Last sync</div>
                <div className="v">{activation?.lastSyncLabel || 'Not synced yet'}</div>
              </div>
            </div>
            <div className="kv">
              <div>
                <div className="k">Active tasks</div>
                <div className="v">{dashboardSummary?.activeTaskCount ?? activation?.activeTaskCount ?? 0} active tasks</div>
              </div>
              <div>
                <div className="k">Waiting on operator</div>
                <div className="v">{dashboardSummary?.waitingTaskCount ?? activation?.waitingTaskCount ?? 0} tasks</div>
              </div>
            </div>
            <div className="kv">
              <div style={{ gridColumn: '1 / span 2' }}>
                <div className="k">Mounted namespaces</div>
                <div className="v">{dashboardSummary?.mountedNamespaces.join(', ') || activation?.mountedNamespaces.join(', ') || `env/${selectedPack.id}/*`}</div>
              </div>
            </div>
            <div className="environment-bound-task-list">
              {boundTasks.length > 0 ? boundTasks.map((task) => (
                <button
                  key={task.id}
                  type="button"
                  className="environment-bound-task environment-bound-task-button"
                  onClick={() => onOpenTask(task.id)}
                >
                  <div className="environment-bound-task-copy">
                    <strong>{task.title}</strong>
                    <span>{task.id.slice(0, 8).toUpperCase()} · {formatRelativeSyncTime(getEnvironmentTaskTimestamp(task))}</span>
                  </div>
                  <span className="environment-bound-task-status">{humanizeEnvironmentTaskStatus(task.status)}</span>
                </button>
              )) : (
                <div className="environment-bound-task is-empty">No current tasks are bound to this pack.</div>
              )}
            </div>
            <div className="item">Mounted namespaces reflect the active environment registry and the latest bound task activity.</div>
          </section>

          <section className="card" id="environment-promotion-queue">
            <div className="card-title">Promotion queue</div>
            <div className="small environment-section-copy">
              {promotionQueue.length > 0
                ? `${promotionQueue.length} environment review item${promotionQueue.length === 1 ? '' : 's'} waiting attention`
                : 'No environment promotion items are waiting right now.'}
            </div>
            <div className="queue">
              {promotionQueue.length > 0 ? promotionQueue.map((item) => (
                <div key={item.id} className="qitem">
                  <strong>{item.kind}</strong>
                  <div className="small">{item.detail}</div>
                </div>
              )) : (
                <div className="qitem">
                  <strong>healthy</strong>
                  <div className="small">This pack does not expose any workflow-to-skill gaps in the current manifest.</div>
                </div>
              )}
            </div>
          </section>

          <section className="card">
            <div className="card-title">Quick actions</div>
            <div className="action-list">
              <button
                type="button"
                className="item environment-action-button"
                onClick={async () => {
                  setBusyAction('switch');
                  try {
                    await onSwitchPack(selectedPack.id);
                    setFeedback(`${selectedPack.name} is now the active environment.`);
                  } catch (error) {
                    setFeedback((error as Error).message);
                  } finally {
                    setBusyAction(null);
                  }
                }}
                disabled={busyAction !== null || selectedPack.id === activePackId}
              >
                {selectedPack.id === activePackId ? `Using ${selectedPack.id}` : `Switch to ${selectedPack.id}`}
              </button>
              <button
                type="button"
                className="item environment-action-button"
                onClick={() => {
                  setManifestOpen(true);
                  setFeedback(`Manifest panel opened for ${selectedPack.id}.`);
                }}
              >
                Open pack manifest
              </button>
              <button
                type="button"
                className="item environment-action-button"
                onClick={() => {
                  document.getElementById('environment-promotion-queue')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
                  setFeedback('Scrolled to the promotion queue.');
                }}
              >
                Review promotion queue
              </button>
              <button
                type="button"
                className="item environment-action-button"
                onClick={async () => {
                  setBusyAction('new-task');
                  try {
                    await onUsePackForNewTask(selectedPack.id);
                    setFeedback(`Ready to launch a new task with ${selectedPack.id}.`);
                  } catch (error) {
                    setFeedback((error as Error).message);
                  } finally {
                    setBusyAction(null);
                  }
                }}
                disabled={busyAction !== null}
              >
                Launch task in this environment
              </button>
              <button
                type="button"
                className="item environment-action-button"
                onClick={() => {
                  document.getElementById('environment-workflow-bindings')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
                  setFeedback('Scrolled to workflow bindings.');
                }}
              >
                View workflow bindings
              </button>
            </div>
          </section>
        </div>
      </section>

      <section className="panel composer">
        <div className="small" style={{ color: 'var(--wb-muted)' }}>Universal composer</div>
        <div className="environment-composer-row">
          <div className="inputbox environment-composer-input">{commandSnippet}</div>
          <button
            type="button"
            className="btn"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(commandSnippet);
                setFeedback('Environment command snippet copied.');
              } catch {
                setFeedback('Unable to copy the command snippet in this browser.');
              }
            }}
          >
            Copy snippet
          </button>
        </div>
      </section>

      {manifestOpen ? (
        <section className="card environment-manifest-card">
          <div className="environment-manifest-header">
            <div>
              <div className="card-title">Pack manifest</div>
              <div className="small">{selectedPack.id}/pack.json</div>
              {dashboardSummary?.manifestPath ? (
                <div className="small">{dashboardSummary.manifestPath}</div>
              ) : null}
            </div>
            <button
              type="button"
              className="btn"
              onClick={() => setManifestOpen(false)}
            >
              Close
            </button>
          </div>
          <pre className="environment-manifest-pre">{JSON.stringify(selectedPack, null, 2)}</pre>
        </section>
      ) : null}

      {feedback ? <div className="environment-feedback">{feedback}</div> : null}
    </div>
  );
}

function EnvironmentItemCard({
  title,
  items,
}: {
  title: string;
  items: string[];
}) {
  return (
    <div className="item-card">
      <div className="item-title">{title}</div>
      <div className="item-list">
        {items.length > 0 ? items.map((item) => (
          <div key={item} className="item">{item}</div>
        )) : (
          <div className="item">No entries</div>
        )}
      </div>
    </div>
  );
}

function EnvironmentWorkflowCard({
  bindings,
}: {
  bindings: EnvironmentPackManifest['workflowBindings'];
}) {
  return (
    <div className="item-card" id="environment-workflow-bindings">
      <div className="item-title">Workflow bindings · {bindings.length}</div>
      <div className="environment-workflow-list">
        {bindings.length > 0 ? bindings.map((binding) => (
          <div key={binding.workflow} className="environment-workflow-item">
            <strong>{binding.workflow}</strong>
            <div className="small">
              {Object.entries(binding.phases)
                .map(([phase, skills]) => `${phase}: ${skills.join(', ') || 'none'}`)
                .join(' · ')}
            </div>
          </div>
        )) : (
          <div className="item">No workflow bindings</div>
        )}
      </div>
    </div>
  );
}

function EnvironmentCoverageCard({
  coverage,
}: {
  coverage: EnvironmentPackWorkflowCoverage[];
}) {
  const totalPhaseCount = coverage.reduce((total, workflow) => total + workflow.totalPhaseCount, 0);
  const coveredPhaseCount = coverage.reduce((total, workflow) => total + workflow.coveredPhaseCount, 0);

  return (
    <div className="item-card">
      <div className="item-title">Capability coverage · {coveredPhaseCount}/{totalPhaseCount}</div>
      <div className="environment-coverage-list">
        {coverage.length > 0 ? coverage.map((workflow) => (
          <div key={workflow.workflow} className="environment-coverage-item">
            <div className="environment-coverage-header">
              <strong>{workflow.workflow}</strong>
              <span>{workflow.coveredPhaseCount}/{workflow.totalPhaseCount} phases covered</span>
            </div>
            <div className="environment-coverage-phase-list">
              {workflow.phases.map((phase) => (
                <div key={`${workflow.workflow}:${phase.phase}`} className="environment-coverage-phase">
                  <div className="environment-coverage-phase-top">
                    <span className={`environment-phase-pill ${phase.covered ? 'is-covered' : 'is-missing'}`}>{phase.phase}</span>
                    <span>{phase.covered ? 'covered' : `${phase.missingCapabilities.length} missing`}</span>
                  </div>
                  <div className="small">
                    {phase.requirements.length > 0
                      ? phase.requirements
                        .map((requirement) => `${requirement.capability} · ${requirement.source}`)
                        .join(' · ')
                      : 'No requirements declared'}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )) : (
          <div className="item">No workflow bindings declared</div>
        )}
      </div>
    </div>
  );
}

function currentlyOpenMessage(isOpen: boolean, packId: string): string {
  return isOpen
    ? 'Manifest panel hidden.'
    : `Manifest panel opened for ${packId}.`;
}

function getEnvironmentTaskTimestamp(
  task: Pick<WorkbenchTaskResponse, 'updatedAt' | 'lastProgressAt'> | { updatedAt: string },
): string {
  return 'lastProgressAt' in task ? task.lastProgressAt || task.updatedAt : task.updatedAt;
}

function humanizeEnvironmentTaskStatus(status: WorkbenchTaskResponse['status']): string {
  switch (status) {
    case 'waiting_for_user':
      return 'Waiting';
    case 'running':
      return 'Running';
    case 'verifying':
      return 'Verifying';
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
    default:
      return 'Planning';
  }
}
