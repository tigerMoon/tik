import React, { useEffect, useState } from 'react';
import type { EnvironmentPackSelection } from '@tik/shared';
import {
  archiveWorkbenchTask,
  controlTask,
  createWorkbenchTask,
  fetchEnvironmentPackDashboard,
  fetchEnvironmentPacks,
  fetchSkillManifestRegistry,
  fetchWorkbenchDecisions,
  fetchWorkbenchTasks,
  fetchWorkbenchTimeline,
  publishSkillManifest,
  retryWorkbenchTask,
  resolveWorkbenchDecision,
  revertWorkbenchTaskBrief,
  saveSkillManifestDraft,
  subscribeToWorkbenchEvents,
  switchEnvironmentPack,
  updateWorkbenchTaskBrief,
  updateWorkbenchTaskConfiguration,
  type CreateWorkbenchTaskInput,
  type UpdateWorkbenchTaskBriefResult,
} from './api/client';
import { WorkbenchComposer } from './components/WorkbenchComposer';
import { WorkbenchConsoleHeader } from './components/WorkbenchConsoleHeader';
import { WorkbenchEnvironmentView } from './components/WorkbenchEnvironmentView';
import { WorkbenchOutputRail } from './components/WorkbenchOutputRail';
import { WorkbenchSkillsView } from './components/WorkbenchSkillsView';
import { WorkbenchTaskHeader } from './components/WorkbenchTaskHeader';
import { WorkbenchTaskList } from './components/WorkbenchTaskList';
import {
  buildWorkbenchSteeringUpdateInput,
  filterWorkbenchTasksByQuery,
  filterWorkbenchTasksByLens,
  getNextActiveWorkbenchTaskId,
  resolveWorkbenchLane,
  type WorkbenchLens,
} from './view-models/workbench';
import { buildSkillManifestMutationInput, buildSkillPublishMutationInput } from './view-models/skills';
import { useStore } from './hooks/store';

type WorkbenchSurface = 'workbench' | 'environments' | 'skills';

function useCompactLayout(): boolean {
  const [compact, setCompact] = useState(() => (typeof window !== 'undefined' ? window.innerWidth < 1100 : false));

  useEffect(() => {
    const onResize = () => {
      setCompact(window.innerWidth < 1100);
    };

    onResize();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  return compact;
}

export function App() {
  const {
    tasks,
    activeTaskId,
    timeline,
    decisions,
    packs,
    activePackId,
    setTasks,
    setActiveTask,
    setTimeline,
    setDecisions,
    setPacks,
  } = useStore();

  const [retryingTaskId, setRetryingTaskId] = useState<string | null>(null);
  const [archivingTaskId, setArchivingTaskId] = useState<string | null>(null);
  const [savingAdjustmentTaskId, setSavingAdjustmentTaskId] = useState<string | null>(null);
  const [revertingAdjustmentTaskId, setRevertingAdjustmentTaskId] = useState<string | null>(null);
  const [savingConfigurationTaskId, setSavingConfigurationTaskId] = useState<string | null>(null);
  const [controllingTask, setControllingTask] = useState<{ taskId: string; action: 'pause' | 'resume' | 'stop' } | null>(null);
  const [resolvingDecisionId, setResolvingDecisionId] = useState<string | null>(null);
  const [timelineError, setTimelineError] = useState<string | null>(null);
  const [refreshingWorkbench, setRefreshingWorkbench] = useState(false);
  const [selectedLens, setSelectedLens] = useState<WorkbenchLens>('inbox');
  const [activeSurface, setActiveSurface] = useState<WorkbenchSurface>('workbench');
  const [autoFocusLane, setAutoFocusLane] = useState(true);
  const [launcherOpen, setLauncherOpen] = useState(false);
  const [launcherSeed, setLauncherSeed] = useState<{
    packId: string | null;
    selection: EnvironmentPackSelection | null;
    source: 'focused-task' | 'active-pack';
  }>({ packId: null, selection: null, source: 'active-pack' });
  const [searchQuery] = useState('');
  const [liveStatus, setLiveStatus] = useState<'live' | 'connecting' | 'offline' | 'idle'>('idle');
  const [bootstrappingWorkbench, setBootstrappingWorkbench] = useState(true);
  const [packsSyncedAt, setPacksSyncedAt] = useState<string | null>(null);
  const [environmentDashboard, setEnvironmentDashboard] = useState<Awaited<ReturnType<typeof fetchEnvironmentPackDashboard>> | null>(null);
  const [skillRegistry, setSkillRegistry] = useState<Awaited<ReturnType<typeof fetchSkillManifestRegistry>>['skills']>([]);
  const [savingSkillId, setSavingSkillId] = useState<string | null>(null);
  const [publishingSkillId, setPublishingSkillId] = useState<string | null>(null);
  const compact = useCompactLayout();

  const filteredTasks = filterWorkbenchTasksByQuery(tasks, searchQuery);
  const activeTask = filteredTasks.find((task) => task.id === activeTaskId)
    || tasks.find((task) => task.id === activeTaskId)
    || null;
  const activeTaskPack = activeTask?.environmentPackSnapshot
    ? packs.find((pack) => pack.id === activeTask.environmentPackSnapshot?.id) || null
    : (packs.find((pack) => pack.id === activePackId) || null);
  const waitingCount = filteredTasks.filter((task) => task.status === 'waiting_for_user' || task.status === 'failed' || task.status === 'blocked' || task.status === 'cancelled').length;
  const highRiskCount = filteredTasks.filter((task) => (task.waitingReason || '').toLowerCase().includes('high-risk')).length;

  const buildFocusedTaskLauncherSeed = (): typeof launcherSeed => ({
    packId: activeTask?.environmentPackSnapshot?.id || activePackId,
    selection: activeTask?.environmentPackSelection
      ? {
        selectedSkills: [...activeTask.environmentPackSelection.selectedSkills],
        selectedKnowledgeIds: [...activeTask.environmentPackSelection.selectedKnowledgeIds],
      }
      : null,
    source: 'focused-task',
  });

  const buildActivePackLauncherSeed = (packId = activePackId): typeof launcherSeed => ({
    packId: packId || null,
    selection: null,
    source: 'active-pack',
  });

  const refreshWorkbench = async (options?: { silent?: boolean }) => {
    if (!options?.silent) {
      setRefreshingWorkbench(true);
    }
    try {
      const [nextTasks, packState] = await Promise.all([
        fetchWorkbenchTasks(),
        fetchEnvironmentPacks(),
      ]);
      setTasks(nextTasks);
      setPacks(packState.packs, packState.activePackId);
      setPacksSyncedAt(new Date().toISOString());

      const queriedTasks = filterWorkbenchTasksByQuery(nextTasks, searchQuery);
      const laneResolution = autoFocusLane
        ? resolveWorkbenchLane(queriedTasks, selectedLens)
        : {
            lens: selectedLens,
            taskId: filterWorkbenchTasksByLens(queriedTasks, selectedLens)[0]?.id || null,
          };
      const lensTasks = filterWorkbenchTasksByLens(queriedTasks, laneResolution.lens);
      const resolvedActiveTaskId = activeTaskId && lensTasks.some((task) => task.id === activeTaskId)
        ? activeTaskId
        : laneResolution.taskId;

      if (laneResolution.lens !== selectedLens) {
        setSelectedLens(laneResolution.lens);
      }

      if (resolvedActiveTaskId !== activeTaskId) {
        setActiveTask(resolvedActiveTaskId);
      }

      if (!resolvedActiveTaskId) {
        setTimeline([]);
        setDecisions([]);
        setTimelineError(null);
        return;
      }

      const [nextTimeline, nextDecisions] = await Promise.all([
        fetchWorkbenchTimeline(resolvedActiveTaskId),
        fetchWorkbenchDecisions(resolvedActiveTaskId),
      ]);
      setTimeline(nextTimeline);
      setDecisions(nextDecisions);
      setTimelineError(null);
    } catch (error) {
      setTimelineError((error as Error).message);
    } finally {
      if (!options?.silent) {
        setRefreshingWorkbench(false);
      }
    }
  };

  const refreshEnvironmentDashboard = async () => {
    try {
      const dashboard = await fetchEnvironmentPackDashboard();
      setEnvironmentDashboard(dashboard);
      setPacks(dashboard.packs, dashboard.activePackId);
      setPacksSyncedAt(dashboard.generatedAt);
    } catch (error) {
      setTimelineError((error as Error).message);
    }
  };

  const refreshSkillRegistry = async () => {
    try {
      const registry = await fetchSkillManifestRegistry();
      setSkillRegistry(registry.skills);
    } catch (error) {
      setTimelineError((error as Error).message);
    }
  };

  const reloadTaskDetails = async (taskId: string) => {
    const [nextTasks, nextTimeline, nextDecisions] = await Promise.all([
      fetchWorkbenchTasks(),
      fetchWorkbenchTimeline(taskId),
      fetchWorkbenchDecisions(taskId),
    ]);
    setTasks(nextTasks);
    setTimeline(nextTimeline);
    setDecisions(nextDecisions);
    setTimelineError(null);
  };

  const handleResolveDecision = async (
    taskId: string,
    decisionId: string,
    body: { optionId?: string; message?: string },
  ) => {
    setResolvingDecisionId(decisionId);
    try {
      await resolveWorkbenchDecision(taskId, decisionId, body);
      await reloadTaskDetails(taskId);
    } catch (error) {
      setTimelineError((error as Error).message);
      throw error;
    } finally {
      setResolvingDecisionId(null);
    }
  };

  const handleApplyAdjustment = async (
    taskId: string,
    input: { title: string; goal: string; adjustment?: string; launchFollowUp?: boolean },
  ): Promise<UpdateWorkbenchTaskBriefResult> => {
    setSavingAdjustmentTaskId(taskId);
    try {
      const result = await updateWorkbenchTaskBrief(taskId, input);
      if (result.followUpTask) {
        const [nextTasks, nextTimeline, nextDecisions] = await Promise.all([
          fetchWorkbenchTasks(),
          fetchWorkbenchTimeline(result.followUpTask.id),
          fetchWorkbenchDecisions(result.followUpTask.id),
        ]);
        setAutoFocusLane(false);
        setSelectedLens('today');
        setTasks(nextTasks);
        setActiveTask(result.followUpTask.id);
        setTimeline(nextTimeline);
        setDecisions(nextDecisions);
        setTimelineError(null);
        return result;
      }

      const [nextTasks, nextTimeline, nextDecisions] = await Promise.all([
        fetchWorkbenchTasks(),
        fetchWorkbenchTimeline(taskId),
        fetchWorkbenchDecisions(taskId),
      ]);
      if (selectedLens === 'inbox' && result.task.status === 'running') {
        setAutoFocusLane(false);
        setSelectedLens('today');
      }
      setTasks(nextTasks);
      setTimeline(nextTimeline);
      setDecisions(nextDecisions);
      setTimelineError(null);
      return result;
    } catch (error) {
      setTimelineError((error as Error).message);
      throw error;
    } finally {
      setSavingAdjustmentTaskId(null);
    }
  };

  const handleCreateTask = async (title: string, goal: string, input?: CreateWorkbenchTaskInput) => {
    const createdTask = await createWorkbenchTask(title, goal, input);
    const nextTasks = await fetchWorkbenchTasks();
    setAutoFocusLane(false);
    setSelectedLens('today');
    setTasks(nextTasks);
    setActiveTask(createdTask.id);
    setLauncherOpen(false);
    setTimelineError(null);
  };

  useEffect(() => {
    let cancelled = false;

    const loadTasks = async () => {
      try {
        const [nextTasks, packState, dashboard, registryResponse] = await Promise.all([
          fetchWorkbenchTasks(),
          fetchEnvironmentPacks(),
          fetchEnvironmentPackDashboard().catch(() => null),
          fetchSkillManifestRegistry().catch(() => null),
        ]);
        if (cancelled) {
          return;
        }

        setTasks(nextTasks);
        setPacks(packState.packs, packState.activePackId);
        setPacksSyncedAt(new Date().toISOString());
        if (dashboard) {
          setEnvironmentDashboard(dashboard);
          setPacksSyncedAt(dashboard.generatedAt);
        }
        if (registryResponse) {
          setSkillRegistry(registryResponse.skills);
        }
      } catch (error) {
        if (!cancelled) {
          setTimelineError((error as Error).message);
        }
      } finally {
        if (!cancelled) {
          setBootstrappingWorkbench(false);
        }
      }
    };

    void loadTasks();
    return () => {
      cancelled = true;
    };
  }, [setPacks, setTasks]);

  useEffect(() => {
    const laneResolution = autoFocusLane
      ? resolveWorkbenchLane(filteredTasks, selectedLens)
      : {
          lens: selectedLens,
          taskId: filterWorkbenchTasksByLens(filteredTasks, selectedLens)[0]?.id || null,
        };
    const lensTasks = filterWorkbenchTasksByLens(filteredTasks, laneResolution.lens);
    const activeTaskStillVisible = activeTaskId
      ? lensTasks.some((task) => task.id === activeTaskId)
      : false;

    if (activeTaskStillVisible) {
      return;
    }

    if (laneResolution.lens !== selectedLens) {
      setSelectedLens(laneResolution.lens);
    }

    const nextActiveTaskId = laneResolution.taskId;
    if (nextActiveTaskId !== activeTaskId) {
      setActiveTask(nextActiveTaskId);
    }
  }, [activeTaskId, autoFocusLane, filteredTasks, selectedLens, setActiveTask]);

  useEffect(() => {
    let cancelled = false;

    if (!activeTaskId) {
      setTimeline([]);
      setDecisions([]);
      setTimelineError(null);
      return () => {
        cancelled = true;
      };
    }

    const loadTaskDetails = async () => {
      try {
        const [nextTimeline, nextDecisions] = await Promise.all([
          fetchWorkbenchTimeline(activeTaskId),
          fetchWorkbenchDecisions(activeTaskId),
        ]);
        if (cancelled) {
          return;
        }
        setTimeline(nextTimeline);
        setDecisions(nextDecisions);
        setTimelineError(null);
      } catch (error) {
        if (!cancelled) {
          setTimelineError((error as Error).message);
        }
      }
    };

    void loadTaskDetails();
    return () => {
      cancelled = true;
    };
  }, [activeTaskId, setDecisions, setTimeline]);

  useEffect(() => {
    setLiveStatus('connecting');
    let refreshTimer: number | null = null;
    const unsubscribe = subscribeToWorkbenchEvents({
      onOpen: () => {
        setLiveStatus('live');
      },
      onError: () => {
        setLiveStatus('offline');
      },
      onEvent: () => {
        setLiveStatus('live');
        if (refreshTimer) {
          window.clearTimeout(refreshTimer);
        }
        refreshTimer = window.setTimeout(() => {
          if (activeSurface === 'environments') {
            void Promise.all([
              refreshWorkbench({ silent: true }),
              refreshEnvironmentDashboard(),
            ]);
            return;
          }
          if (activeSurface === 'skills') {
            void Promise.all([
              refreshWorkbench({ silent: true }),
              refreshSkillRegistry(),
            ]);
            return;
          }
          void refreshWorkbench({ silent: true });
        }, 120);
      },
    });

    return () => {
      if (refreshTimer) {
        window.clearTimeout(refreshTimer);
      }
      unsubscribe();
      setLiveStatus('idle');
    };
  }, [activeSurface, autoFocusLane, searchQuery, selectedLens]);

  useEffect(() => {
    if (liveStatus === 'live') {
      return;
    }

    const interval = window.setInterval(() => {
      if (activeSurface === 'environments') {
        void Promise.all([
          refreshWorkbench({ silent: true }),
          refreshEnvironmentDashboard(),
        ]);
        return;
      }
      if (activeSurface === 'skills') {
        void Promise.all([
          refreshWorkbench({ silent: true }),
          refreshSkillRegistry(),
        ]);
        return;
      }
      void refreshWorkbench({ silent: true });
    }, 4000);

    return () => {
      window.clearInterval(interval);
    };
  }, [activeSurface, activeTaskId, autoFocusLane, liveStatus, searchQuery, selectedLens]);

  useEffect(() => {
    if (activeSurface !== 'environments') {
      return;
    }

    void refreshEnvironmentDashboard();
  }, [activeSurface]);

  useEffect(() => {
    if (activeSurface !== 'skills') {
      return;
    }

    void refreshSkillRegistry();
  }, [activeSurface]);

  return (
    <div className={`inbox-shell ${compact ? 'is-compact' : ''}`}>
      <aside className="inbox-sidebar panel">
        <div className="brand">
          <div className="mark">K</div>
          <div>
            <strong>KIT Workbench</strong>
            <span>
              {activeSurface === 'environments'
                ? 'environment view'
                : activeSurface === 'skills'
                  ? 'skill manifest'
                  : 'inbox v2'}
            </span>
          </div>
        </div>

        <nav className="inbox-nav">
          {[
            { label: 'Inbox', active: activeSurface === 'workbench' && selectedLens === 'inbox', onClick: () => { setActiveSurface('workbench'); setAutoFocusLane(false); setSelectedLens('inbox'); } },
            { label: 'Tasks', active: activeSurface === 'workbench' && (selectedLens === 'all' || selectedLens === 'today'), onClick: () => { setActiveSurface('workbench'); setAutoFocusLane(false); setSelectedLens('all'); } },
            { label: 'Decisions', active: false, onClick: () => { setActiveSurface('workbench'); setAutoFocusLane(false); setSelectedLens('inbox'); } },
            { label: 'Runs', active: activeSurface === 'workbench' && selectedLens === 'completed', onClick: () => { setActiveSurface('workbench'); setAutoFocusLane(false); setSelectedLens('completed'); } },
            { label: 'Artifacts', active: activeSurface === 'workbench' && selectedLens === 'archived', onClick: () => { setActiveSurface('workbench'); setAutoFocusLane(false); setSelectedLens('archived'); } },
            { label: 'Skills', active: activeSurface === 'skills', onClick: () => { setActiveSurface('skills'); setLauncherOpen(false); } },
            { label: 'Environments', active: activeSurface === 'environments', onClick: () => { setActiveSurface('environments'); setLauncherOpen(false); } },
          ].map((item) => (
            <button
              key={item.label}
              type="button"
              className={`inbox-nav-item ${item.active ? 'is-active' : ''}`}
              onClick={item.onClick}
            >
              {item.label}
            </button>
          ))}
        </nav>

        {activeSurface === 'skills' ? (
          <div className="envbox">
            <div className="t">Manifest mindset</div>
            <strong>Skill is governed</strong>
            <p>
              spec / bindings / tests / versions
              <br />
              not just a prompt
            </p>
          </div>
        ) : activeSurface === 'environments' ? (
          <div className="envbox">
            <div className="t">Design rule</div>
            <strong>Environment ≠ Workspace</strong>
            <p>
              Environment = capability context
              <br />
              Workspace = execution container
            </p>
          </div>
        ) : (
          <div className="envbox">
            <div className="t">Current environment</div>
            <strong>{activeTaskPack?.id || activePackId || 'default'}</strong>
            <p>
              Inbox mode: single-workspace
              <br />
              1 task = 1 workspace
            </p>
          </div>
        )}
      </aside>

      <main className="inbox-main">
        {activeSurface === 'skills' ? (
          <WorkbenchSkillsView
            packs={packs}
            tasks={tasks}
            activePackId={activePackId}
            activeTask={activeTask}
            registryEntries={skillRegistry}
            savingDraftSkillId={savingSkillId}
            publishingSkillId={publishingSkillId}
            onSaveDraft={async (skillId, notes, skill) => {
              setSavingSkillId(skillId);
              try {
                await saveSkillManifestDraft(skillId, buildSkillManifestMutationInput(skill, notes));
                await refreshSkillRegistry();
              } finally {
                setSavingSkillId(null);
              }
            }}
            onPublish={async (skillId, notes, skill) => {
              setPublishingSkillId(skillId);
              try {
                await publishSkillManifest(skillId, buildSkillPublishMutationInput(skill, notes));
                await refreshSkillRegistry();
              } finally {
                setPublishingSkillId(null);
              }
            }}
            onOpenTask={(taskId) => {
              setActiveSurface('workbench');
              setAutoFocusLane(false);
              setSelectedLens('all');
              setLauncherOpen(false);
              setActiveTask(taskId);
            }}
          />
        ) : activeSurface === 'environments' ? (
          <WorkbenchEnvironmentView
            packs={packs}
            activePackId={activePackId}
            tasks={tasks}
            lastSyncedAt={packsSyncedAt}
            dashboard={environmentDashboard}
            onSwitchPack={async (packId) => {
              await switchEnvironmentPack(packId);
              await refreshEnvironmentDashboard();
            }}
            onUsePackForNewTask={async (packId) => {
              if (packId !== activePackId) {
                await switchEnvironmentPack(packId);
                await refreshEnvironmentDashboard();
              }
              setLauncherSeed(buildActivePackLauncherSeed(packId));
              setActiveSurface('workbench');
              setAutoFocusLane(false);
              setSelectedLens('today');
              setLauncherOpen(true);
            }}
            onOpenTask={(taskId) => {
              setActiveSurface('workbench');
              setAutoFocusLane(false);
              setSelectedLens('all');
              setLauncherOpen(false);
              setActiveTask(taskId);
            }}
          />
        ) : (
          <>
            <WorkbenchConsoleHeader
              packs={packs}
              activePackId={activePackId}
              activeTask={activeTask}
              waitingCount={waitingCount}
              highRiskCount={highRiskCount}
              selectedLens={selectedLens}
              bootstrapping={bootstrappingWorkbench}
              refreshing={refreshingWorkbench}
              liveStatus={liveStatus}
              onToggleFilter={() => {
                setAutoFocusLane(false);
                setSelectedLens((current) => (current === 'inbox' ? 'all' : 'inbox'));
              }}
              onNewTask={() => {
                const nextOpen = !launcherOpen;
                if (nextOpen) {
                  setLauncherSeed(buildFocusedTaskLauncherSeed());
                }
                setLauncherOpen(nextOpen);
              }}
              onRefresh={() => refreshWorkbench()}
            />

            <section className="inbox-content">
              <WorkbenchTaskList
                packs={packs}
                activePackId={activePackId}
                tasks={filteredTasks}
                activeTask={activeTask}
                activeTaskId={activeTaskId}
                selectedLens={selectedLens}
                loading={bootstrappingWorkbench && tasks.length === 0}
                launcherOpen={launcherOpen}
                launcherSeedPackId={launcherSeed.packId}
                launcherSeedSelection={launcherSeed.selection || null}
                launcherSeedSource={launcherSeed.source}
                onSelectTask={setActiveTask}
                onSelectLens={(lens) => {
                  setAutoFocusLane(false);
                  setSelectedLens(lens);
                }}
                onCreateTask={async (title, goal, input) => {
                  await handleCreateTask(title, goal, input);
                }}
                onToggleLauncher={(nextOpen) => {
                  if (nextOpen) {
                    setLauncherSeed(buildActivePackLauncherSeed());
                  }
                  setLauncherOpen(nextOpen);
                }}
              />

              <div className="inbox-focus-column">
                <WorkbenchTaskHeader
                  task={activeTask}
                  timeline={timeline}
                  decisions={decisions}
                  resolvingDecisionId={resolvingDecisionId}
                  retrying={activeTask ? retryingTaskId === activeTask.id : false}
                  archiving={activeTask ? archivingTaskId === activeTask.id : false}
                  savingAdjustment={activeTask ? savingAdjustmentTaskId === activeTask.id : false}
                  revertingAdjustment={activeTask ? revertingAdjustmentTaskId === activeTask.id : false}
                  onRetryTask={async (task) => {
                    setRetryingTaskId(task.id);
                    try {
                      const createdTask = await retryWorkbenchTask(task.id);
                      const nextTasks = await fetchWorkbenchTasks();
                      setAutoFocusLane(false);
                      setSelectedLens('today');
                      setTasks(nextTasks);
                      setActiveTask(createdTask.id);
                      setTimelineError(null);
                    } catch (error) {
                      setTimelineError((error as Error).message);
                    } finally {
                      setRetryingTaskId(null);
                    }
                  }}
                  onApplyTaskAdjustment={(task, input) => handleApplyAdjustment(task.id, input)}
                  onRevertLastAdjustment={async (task) => {
                    setRevertingAdjustmentTaskId(task.id);
                    try {
                      await revertWorkbenchTaskBrief(task.id);
                      await reloadTaskDetails(task.id);
                    } catch (error) {
                      setTimelineError((error as Error).message);
                      throw error;
                    } finally {
                      setRevertingAdjustmentTaskId(null);
                    }
                  }}
                  onArchiveTask={async (task) => {
                    setArchivingTaskId(task.id);
                    try {
                      await archiveWorkbenchTask(task.id);
                      const nextTasks = await fetchWorkbenchTasks();
                      const lensTasks = filterWorkbenchTasksByLens(
                        filterWorkbenchTasksByQuery(nextTasks, searchQuery),
                        selectedLens,
                      );
                      const nextActiveTaskId = lensTasks[0]?.id || getNextActiveWorkbenchTaskId(nextTasks, task.id);
                      setTasks(nextTasks);
                      setActiveTask(nextActiveTaskId);
                      setTimelineError(null);
                    } catch (error) {
                      setTimelineError((error as Error).message);
                    } finally {
                      setArchivingTaskId(null);
                    }
                  }}
                  onResolveDecision={handleResolveDecision}
                />

                {timelineError ? (
                  <div className="workbench-error-banner">{timelineError}</div>
                ) : null}

                <WorkbenchOutputRail
                  task={activeTask}
                  pack={activeTaskPack}
                  packs={packs}
                  timeline={timeline}
                  decisions={decisions}
                  savingConfiguration={activeTask ? savingConfigurationTaskId === activeTask.id : false}
                  controllingTaskAction={activeTask && controllingTask?.taskId === activeTask.id ? controllingTask.action : null}
                  onSaveTaskConfiguration={async (taskId, selection) => {
                    setSavingConfigurationTaskId(taskId);
                    try {
                      await updateWorkbenchTaskConfiguration(taskId, selection);
                      await reloadTaskDetails(taskId);
                      await refreshEnvironmentDashboard();
                    } catch (error) {
                      setTimelineError((error as Error).message);
                      throw error;
                    } finally {
                      setSavingConfigurationTaskId(null);
                    }
                  }}
                  onControlTask={async (taskId, action) => {
                    setControllingTask({ taskId, action });
                    try {
                      await controlTask(taskId, { type: action });
                      await reloadTaskDetails(taskId);
                    } catch (error) {
                      setTimelineError((error as Error).message);
                      throw error;
                    } finally {
                      setControllingTask(null);
                    }
                  }}
                />
              </div>
            </section>

            <WorkbenchComposer
              task={activeTask}
              tasks={tasks}
              decisions={decisions}
              applying={activeTask ? savingAdjustmentTaskId === activeTask.id : false}
              onApplyNote={(task, note) => handleApplyAdjustment(
                task.id,
                buildWorkbenchSteeringUpdateInput(task, { adjustment: note }),
              )}
              onResolveDecision={(task, decision, body) => handleResolveDecision(task.id, decision.id, body)}
              onCreateTask={handleCreateTask}
              onOpenLauncher={() => {
                setLauncherSeed(buildFocusedTaskLauncherSeed());
                setLauncherOpen(true);
              }}
            />
          </>
        )}
      </main>
    </div>
  );
}
