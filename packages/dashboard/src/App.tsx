import React, { useEffect, useMemo, useState } from 'react';
import {
  getWorkbenchLabelAction,
  getWorkbenchLabelActionDefinition,
  isWorkbenchTaskCodexDispatchable,
  isWorkbenchTaskMaintenance,
  isWorkbenchTerminalStatus,
  type EnvironmentPackSelection,
  type WorkbenchLabelAction,
} from '@tik/shared';
import {
  addTrackerTaskComment,
  acceptWorkbenchArtifact,
  archiveWorkbenchArtifact,
  archiveWorkbenchTask,
  controlWorkbenchTask,
  createWorkbenchTask,
  createWorktreeReviewRound,
  fetchWorkbenchArtifact,
  fetchWorkbenchArtifacts,
  fetchWorkbenchArtifactVersions,
  fetchEnvironmentPackDashboard,
  fetchEnvironmentPacks,
  fetchSkillManifestRegistry,
  fetchTrackerState,
  fetchWorkbenchTaskArtifacts,
  fetchWorkbenchDecisions,
  fetchWorkbenchTasks,
  fetchWorkbenchTimeline,
  fetchWorkflowFile,
  fetchWorkspaceStatus,
  generateWorkbenchTaskArtifact,
  publishSkillManifest,
  rejectWorkbenchArtifact,
  retryWorkbenchTask,
  refreshTracker,
  resolveWorkbenchDecision,
  revertWorkbenchTaskBrief,
  saveSkillManifestDraft,
  saveWorkflowFile,
  subscribeToWorkbenchEvents,
  switchEnvironmentPack,
  transitionTrackerTask,
  updateTrackerTask,
  updateWorkbenchTaskBrief,
  updateWorkbenchTaskConfiguration,
  type CreateWorkbenchTaskInput,
  type TrackerStateResponse,
  type UpdateWorkbenchTaskBriefResult,
  type WorkflowFileResponse,
  type WorkbenchTaskAttemptRecord,
  type WorkbenchArtifactRecord,
  type WorkbenchArtifactVersion,
  type WorkbenchTaskResponse,
  type WorkbenchTaskRunRecord,
} from './api/client';
import { ArtifactDetail } from './components/ArtifactDetail';
import { ArtifactGallery } from './components/ArtifactGallery';
import {
  countWorkbenchArtifactGroupsByStatus,
  groupWorkbenchArtifactsForReview,
} from './view-models/artifacts';
import { WorkbenchConsoleHeader } from './components/WorkbenchConsoleHeader';
import { WorkbenchEnvironmentView } from './components/WorkbenchEnvironmentView';
import { WorkbenchSkillsView } from './components/WorkbenchSkillsView';
import { WorkbenchTaskList } from './components/WorkbenchTaskList';
import { TaskDetailPanel } from './components/task-detail/TaskDetailPanel';
import {
  buildWorkbenchSteeringUpdateInput,
  buildWorkbenchAgentLoopSummary,
  filterWorkbenchTasksByQuery,
  filterWorkbenchTasksByLens,
  getNextActiveWorkbenchTaskId,
  groupWorkbenchTasks,
  resolveWorkbenchLane,
  sortWorkbenchTasks,
  type WorkbenchLens,
} from './view-models/workbench';
import {
  buildTaskBindingLabel,
  buildWorkspaceBindingOptions,
  buildWorkspaceHierarchy,
  filterTasksByWorkspaceScope,
  resolveWorkspaceBindingOption,
  type WorkspaceScopeKey,
} from './view-models/workspace-hierarchy';
import { buildSkillManifestMutationInput, buildSkillPublishMutationInput } from './view-models/skills';
import { useStore } from './hooks/store';

type WorkbenchSurface = 'workbench' | 'artifacts' | 'environments' | 'skills' | 'tracker';

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

function resetWorkbenchScroll(): void {
  if (typeof window === 'undefined') {
    return;
  }

  window.requestAnimationFrame(() => {
    document.querySelector('.inbox-content')?.scrollTo({ top: 0, left: 0 });
    const detailPanel = document.querySelector('.task-detail-panel');
    if (detailPanel) {
      detailPanel.scrollIntoView({ block: 'start', inline: 'nearest' });
      return;
    }
    window.scrollTo({ top: 0, left: 0 });
  });
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
  const [workbenchView, setWorkbenchView] = useState<'list' | 'detail'>('list');
  const [selectedScopeKey, setSelectedScopeKey] = useState<WorkspaceScopeKey>('workspace');
  const [autoFocusLane, setAutoFocusLane] = useState(true);
  const [launcherOpen, setLauncherOpen] = useState(false);
  const [publishingReviewRound, setPublishingReviewRound] = useState(false);
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
  const [workspaceStatus, setWorkspaceStatus] = useState<Awaited<ReturnType<typeof fetchWorkspaceStatus>> | null>(null);
  const [trackerState, setTrackerState] = useState<TrackerStateResponse | null>(null);
  const [workflowFile, setWorkflowFile] = useState<WorkflowFileResponse | null>(null);
  const [artifacts, setArtifacts] = useState<WorkbenchArtifactRecord[]>([]);
  const [taskArtifacts, setTaskArtifacts] = useState<WorkbenchArtifactRecord[]>([]);
  const [activeArtifactId, setActiveArtifactId] = useState<string | null>(null);
  const [activeArtifact, setActiveArtifact] = useState<WorkbenchArtifactRecord | null>(null);
  const [artifactVersions, setArtifactVersions] = useState<WorkbenchArtifactVersion[]>([]);
  const [refreshingArtifacts, setRefreshingArtifacts] = useState(false);
  const [artifactBusyAction, setArtifactBusyAction] = useState<'accept' | 'reject' | 'archive' | null>(null);
  const [taskArtifactBusyId, setTaskArtifactBusyId] = useState<string | null>(null);
  const [generatingTaskArtifact, setGeneratingTaskArtifact] = useState(false);
  const [savingSkillId, setSavingSkillId] = useState<string | null>(null);
  const [publishingSkillId, setPublishingSkillId] = useState<string | null>(null);
  const compact = useCompactLayout();

  const fallbackWorkspaceRoot = workspaceStatus?.rootPath
    || activeTaskId && tasks.find((task) => task.id === activeTaskId)?.workspaceBinding?.workspaceRoot
    || tasks.find((task) => task.workspaceBinding)?.workspaceBinding?.workspaceRoot
    || '';
  const workspaceHierarchy = buildWorkspaceHierarchy(tasks, workspaceStatus, fallbackWorkspaceRoot);
  const bindingOptions = buildWorkspaceBindingOptions(workspaceHierarchy);
  const activeBindingOption = resolveWorkspaceBindingOption(bindingOptions, selectedScopeKey);
  const scopedTasks = filterTasksByWorkspaceScope(tasks, selectedScopeKey);
  const filteredTasks = filterWorkbenchTasksByQuery(scopedTasks, searchQuery);
  const activeTask = filteredTasks.find((task) => task.id === activeTaskId)
    || null;
  const activeTaskPack = activeTask?.environmentPackSnapshot
    ? packs.find((pack) => pack.id === activeTask.environmentPackSnapshot?.id) || null
    : (packs.find((pack) => pack.id === activePackId) || null);
  const waitingCount = filteredTasks.filter((task) => task.status === 'waiting_for_user' || task.status === 'failed' || task.status === 'blocked' || task.status === 'cancelled').length;
  const highRiskCount = filteredTasks.filter((task) => (task.waitingReason || '').toLowerCase().includes('high-risk')).length;
  const groupedTasks = groupWorkbenchTasks(filteredTasks);
  const trackerSidebarCandidateCount = trackerState?.summary?.activeCandidates
    ?? tasks.filter(isTrackerDispatchCandidate).length;
  const trackerSidebarCount = trackerSidebarCandidateCount
    + (trackerState?.summary?.activeRuns || 0)
    + (trackerState?.summary?.staleRunning || 0)
    + (trackerState?.summary?.maintenance ?? tasks.filter(isTrackerMaintenanceTask).length)
    + Object.keys(trackerState?.retries || {}).length;
  const visibleTaskCount = filteredTasks.filter((task) => task.status !== 'archived').length;
  const archivedCount = groupedTasks.archived.length;
  const inactiveTaskIds = useMemo(
    () => tasks
      .filter((task) => task.status === 'cancelled' || task.status === 'archived')
      .map((task) => task.id),
    [tasks],
  );
  const artifactGroupCounts = useMemo(
    () => countWorkbenchArtifactGroupsByStatus(groupWorkbenchArtifactsForReview(artifacts, { inactiveTaskIds })),
    [artifacts, inactiveTaskIds],
  );
  const artifactNeedsReviewCount = artifactGroupCounts.needs_review;
  const liveStatusLabel = liveStatus === 'live'
    ? 'Live'
    : liveStatus === 'connecting'
      ? 'Connecting'
      : liveStatus === 'offline'
        ? 'Offline'
        : 'Idle';

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
      const [nextTasks, packState, nextWorkspaceStatus] = await Promise.all([
        fetchWorkbenchTasks(),
        fetchEnvironmentPacks(),
        fetchWorkspaceStatus().catch(() => null),
      ]);
      setTasks(nextTasks);
      setPacks(packState.packs, packState.activePackId);
      if (nextWorkspaceStatus) {
        setWorkspaceStatus(nextWorkspaceStatus);
      }
      setPacksSyncedAt(new Date().toISOString());

      const nextScopedTasks = filterTasksByWorkspaceScope(nextTasks, selectedScopeKey);
      const queriedTasks = filterWorkbenchTasksByQuery(nextScopedTasks, searchQuery);
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
    const [nextTasks, nextTimeline, nextDecisions, nextTaskArtifacts] = await Promise.all([
      fetchWorkbenchTasks(),
      fetchWorkbenchTimeline(taskId),
      fetchWorkbenchDecisions(taskId),
      fetchWorkbenchTaskArtifacts(taskId).catch(() => []),
    ]);
    setTasks(nextTasks);
    setTimeline(nextTimeline);
    setDecisions(nextDecisions);
    setTaskArtifacts(nextTaskArtifacts);
    setTimelineError(null);
  };

  const refreshArtifacts = async (options?: { silent?: boolean }) => {
    if (!options?.silent) {
      setRefreshingArtifacts(true);
    }
    try {
      const nextArtifacts = await fetchWorkbenchArtifacts();
      setArtifacts(nextArtifacts);
      const resolvedArtifactId = activeArtifactId && nextArtifacts.some((artifact) => artifact.id === activeArtifactId)
        ? activeArtifactId
        : nextArtifacts[0]?.id || null;
      if (resolvedArtifactId !== activeArtifactId) {
        setActiveArtifactId(resolvedArtifactId);
      }
      setTimelineError(null);
    } catch (error) {
      setTimelineError((error as Error).message);
    } finally {
      if (!options?.silent) {
        setRefreshingArtifacts(false);
      }
    }
  };

  const reloadArtifactDetails = async (artifactId: string) => {
    const [artifact, versions] = await Promise.all([
      fetchWorkbenchArtifact(artifactId),
      fetchWorkbenchArtifactVersions(artifactId),
    ]);
    setActiveArtifact(artifact);
    setArtifactVersions(versions);
  };

  const refreshTrackerState = async () => {
    try {
      setTrackerState(await fetchTrackerState());
    } catch (error) {
      setTimelineError((error as Error).message);
    }
  };

  const refreshWorkflowFile = async () => {
    try {
      setWorkflowFile(await fetchWorkflowFile());
    } catch (error) {
      setTimelineError((error as Error).message);
    }
  };

  const handleSaveWorkflowFile = async (content: string) => {
    const saved = await saveWorkflowFile(content);
    setWorkflowFile(saved);
  };

  const handleTaskMetadataChange = async (
    task: WorkbenchTaskResponse,
    input: Partial<Pick<WorkbenchTaskResponse, 'status' | 'priority' | 'labels' | 'parentTaskId' | 'humanAssignee'>>,
  ) => {
    const nextStatus = input.status;
    if (nextStatus && nextStatus !== task.status) {
      await transitionTrackerTask(task.id, nextStatus, `Updated from dashboard metadata.`);
    }
    const metadataInput = { ...input };
    delete metadataInput.status;
    if (Object.keys(metadataInput).length > 0) {
      await updateTrackerTask(task.id, metadataInput);
    }
    await reloadTaskDetails(task.id);
  };

  const handleAddTaskComment = async (task: WorkbenchTaskResponse, body: string) => {
    const updatedTask = await addTrackerTaskComment(task.id, body);
    setTasks(tasks.map((currentTask) => (
      currentTask.id === updatedTask.id ? updatedTask : currentTask
    )));
    await Promise.all([
      reloadTaskDetails(task.id),
      refreshTrackerState(),
    ]);
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
        setWorkbenchView('detail');
        resetWorkbenchScroll();
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
    setWorkbenchView('detail');
    resetWorkbenchScroll();
    setLauncherOpen(false);
    setTimelineError(null);
  };

  const handlePublishReviewRound = async () => {
    setPublishingReviewRound(true);
    try {
      const createdTask = await createWorktreeReviewRound({
        rootTaskId: activeBindingOption.kind === 'project'
          ? activeBindingOption.label
          : workspaceHierarchy.workspace.name,
        repo: activeBindingOption.kind === 'project'
          ? activeBindingOption.label
          : workspaceHierarchy.workspace.name,
        workspaceBinding: activeBindingOption.binding,
        reviewFocus: ['current worktree diff', 'blocking issues', 'regression risk'],
        createdBy: 'human',
      });
      const [nextTasks, nextTimeline, nextDecisions] = await Promise.all([
        fetchWorkbenchTasks(),
        fetchWorkbenchTimeline(createdTask.id),
        fetchWorkbenchDecisions(createdTask.id),
      ]);
      setAutoFocusLane(false);
      setSelectedLens('review-loop');
      setTasks(nextTasks);
      setActiveTask(createdTask.id);
      setWorkbenchView('detail');
      resetWorkbenchScroll();
      setTimeline(nextTimeline);
      setDecisions(nextDecisions);
      setTimelineError(null);
    } catch (error) {
      setTimelineError((error as Error).message);
      throw error;
    } finally {
      setPublishingReviewRound(false);
    }
  };

  const handleArtifactAccept = async (artifactId: string) => {
    setArtifactBusyAction('accept');
    setTaskArtifactBusyId(artifactId);
    try {
      const artifact = await acceptWorkbenchArtifact(artifactId);
      await Promise.all([
        refreshArtifacts({ silent: true }),
        reloadArtifactDetails(artifact.id),
        artifact.taskId === activeTaskId ? reloadTaskDetails(artifact.taskId) : Promise.resolve(),
      ]);
    } finally {
      setArtifactBusyAction(null);
      setTaskArtifactBusyId(null);
    }
  };

  const handleArtifactReject = async (artifactId: string, reason: string) => {
    setArtifactBusyAction('reject');
    setTaskArtifactBusyId(artifactId);
    try {
      const artifact = await rejectWorkbenchArtifact(artifactId, reason);
      await Promise.all([
        refreshArtifacts({ silent: true }),
        reloadArtifactDetails(artifact.id),
        artifact.taskId === activeTaskId ? reloadTaskDetails(artifact.taskId) : Promise.resolve(),
      ]);
    } finally {
      setArtifactBusyAction(null);
      setTaskArtifactBusyId(null);
    }
  };

  const handleArtifactArchive = async (artifactId: string) => {
    setArtifactBusyAction('archive');
    setTaskArtifactBusyId(artifactId);
    try {
      const artifact = await archiveWorkbenchArtifact(artifactId);
      await Promise.all([
        refreshArtifacts({ silent: true }),
        reloadArtifactDetails(artifact.id),
        artifact.taskId === activeTaskId ? reloadTaskDetails(artifact.taskId) : Promise.resolve(),
      ]);
    } finally {
      setArtifactBusyAction(null);
      setTaskArtifactBusyId(null);
    }
  };

  const handleGenerateTaskArtifact = async (taskId: string) => {
    setGeneratingTaskArtifact(true);
    try {
      const artifact = await generateWorkbenchTaskArtifact(taskId);
      setActiveArtifactId(artifact.id);
      await Promise.all([
        refreshArtifacts({ silent: true }),
        reloadTaskDetails(taskId),
        reloadArtifactDetails(artifact.id),
      ]);
    } finally {
      setGeneratingTaskArtifact(false);
    }
  };

  useEffect(() => {
    let cancelled = false;

    const loadTasks = async () => {
      try {
        const [nextTasks, packState, dashboard, registryResponse, workspaceStatusResponse, artifactsResponse] = await Promise.all([
          fetchWorkbenchTasks(),
          fetchEnvironmentPacks(),
          fetchEnvironmentPackDashboard().catch(() => null),
          fetchSkillManifestRegistry().catch(() => null),
          fetchWorkspaceStatus().catch(() => null),
          fetchWorkbenchArtifacts().catch(() => []),
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
        if (workspaceStatusResponse) {
          setWorkspaceStatus(workspaceStatusResponse);
        }
        setArtifacts(artifactsResponse);
        setActiveArtifactId((current) => current || artifactsResponse[0]?.id || null);
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

    if (!activeTaskId || !tasks.some((task) => task.id === activeTaskId)) {
      setTimeline([]);
      setDecisions([]);
      setTaskArtifacts([]);
      setTimelineError(null);
      return () => {
        cancelled = true;
      };
    }

    const loadTaskDetails = async () => {
      try {
        const [nextTimeline, nextDecisions, nextTaskArtifacts] = await Promise.all([
          fetchWorkbenchTimeline(activeTaskId),
          fetchWorkbenchDecisions(activeTaskId),
          fetchWorkbenchTaskArtifacts(activeTaskId).catch(() => []),
        ]);
        if (cancelled) {
          return;
        }
        setTimeline(nextTimeline);
        setDecisions(nextDecisions);
        setTaskArtifacts(nextTaskArtifacts);
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
  }, [activeTaskId, setDecisions, setTimeline, tasks]);

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
          if (activeSurface === 'tracker') {
            void Promise.all([
              refreshWorkbench({ silent: true }),
              refreshTrackerState(),
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
  }, [activeSurface, autoFocusLane, searchQuery, selectedLens, selectedScopeKey]);

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
      if (activeSurface === 'tracker') {
        void Promise.all([
          refreshWorkbench({ silent: true }),
          refreshTrackerState(),
        ]);
        return;
      }
      void refreshWorkbench({ silent: true });
    }, 4000);

    return () => {
      window.clearInterval(interval);
    };
  }, [activeSurface, activeTaskId, autoFocusLane, liveStatus, searchQuery, selectedLens, selectedScopeKey]);

  useEffect(() => {
    if (selectedScopeKey === 'workspace') {
      return;
    }
    if (!bindingOptions.some((option) => option.key === selectedScopeKey)) {
      setSelectedScopeKey('workspace');
    }
  }, [bindingOptions, selectedScopeKey]);

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

  useEffect(() => {
    if (activeSurface !== 'tracker') {
      return;
    }

    void Promise.all([refreshTrackerState(), refreshWorkflowFile()]);
  }, [activeSurface]);

  useEffect(() => {
    if (activeSurface !== 'artifacts') {
      return;
    }

    void refreshArtifacts();
  }, [activeSurface]);

  useEffect(() => {
    let cancelled = false;

    if (!activeArtifactId) {
      setActiveArtifact(null);
      setArtifactVersions([]);
      return () => {
        cancelled = true;
      };
    }

    const loadArtifactDetails = async () => {
      try {
        const [artifact, versions] = await Promise.all([
          fetchWorkbenchArtifact(activeArtifactId),
          fetchWorkbenchArtifactVersions(activeArtifactId),
        ]);
        if (cancelled) {
          return;
        }
        setActiveArtifact(artifact);
        setArtifactVersions(versions);
        setTimelineError(null);
      } catch (error) {
        if (!cancelled) {
          setTimelineError((error as Error).message);
        }
      }
    };

    void loadArtifactDetails();
    return () => {
      cancelled = true;
    };
  }, [activeArtifactId]);

  return (
    <div className={`inbox-shell ${compact ? 'is-compact' : ''}`}>
      <aside className="inbox-sidebar panel">
        <div className="brand">
          <div className="mark">T</div>
          <div>
            <strong>Tik</strong>
            <span>{workspaceHierarchy.workspace.name}</span>
          </div>
        </div>

        <button
          type="button"
          className="sidebar-compose-button"
          onClick={() => {
            setLauncherSeed(buildFocusedTaskLauncherSeed());
            setActiveSurface('workbench');
            setLauncherOpen(true);
          }}
        >
          <span>+</span>
          New task
        </button>

        <nav className="inbox-nav workspace-scope-nav">
          <div className="sidebar-section-label">Workspace</div>
          <button
            type="button"
            className={`inbox-nav-item workspace-scope-item ${activeSurface === 'workbench' && selectedScopeKey === 'workspace' ? 'is-active' : ''}`}
            onClick={() => {
              setActiveSurface('workbench');
              setWorkbenchView('list');
              setSelectedScopeKey('workspace');
              setAutoFocusLane(false);
            }}
          >
            <span className="workspace-scope-copy">
              <span className="workspace-scope-name">{workspaceHierarchy.workspace.name}</span>
              <span className="workspace-scope-detail">Workspace</span>
            </span>
            <span className="inbox-nav-count">{workspaceHierarchy.workspace.taskCount}</span>
          </button>
        </nav>

        <nav className="inbox-nav project-scope-nav">
          <div className="sidebar-section-label">Projects</div>
          {workspaceHierarchy.projects.length === 0 ? (
            <div className="sidebar-empty">No projects yet</div>
          ) : workspaceHierarchy.projects.map((project) => (
            <button
              key={project.key}
              type="button"
              className={`inbox-nav-item project-scope-item ${activeSurface === 'workbench' && selectedScopeKey === project.key ? 'is-active' : ''}`}
              onClick={() => {
                setActiveSurface('workbench');
                setWorkbenchView('list');
                setSelectedScopeKey(project.key);
                setAutoFocusLane(false);
              }}
            >
              <span className="workspace-scope-copy">
                <span className="workspace-scope-name">{project.name}</span>
                <span className="workspace-scope-detail">{project.activeTaskCount} active</span>
              </span>
              <span className="inbox-nav-count">{project.taskCount}</span>
            </button>
          ))}
        </nav>

        <nav className="inbox-nav views-nav">
          <div className="sidebar-section-label">Views</div>
          {[
            { label: 'Inbox', count: groupedTasks.attention.length, active: activeSurface === 'workbench' && selectedLens === 'inbox', onClick: () => { setActiveSurface('workbench'); setWorkbenchView('list'); setAutoFocusLane(false); setSelectedLens('inbox'); } },
            { label: 'Review loop', count: filterWorkbenchTasksByLens(filteredTasks, 'review-loop').length, active: activeSurface === 'workbench' && selectedLens === 'review-loop', onClick: () => { setActiveSurface('workbench'); setWorkbenchView('list'); setAutoFocusLane(false); setSelectedLens('review-loop'); } },
            { label: 'All tasks', count: visibleTaskCount, active: activeSurface === 'workbench' && selectedLens === 'all', onClick: () => { setActiveSurface('workbench'); setWorkbenchView('list'); setAutoFocusLane(false); setSelectedLens('all'); } },
            { label: 'Archive', count: archivedCount, active: activeSurface === 'workbench' && selectedLens === 'archived', onClick: () => { setActiveSurface('workbench'); setWorkbenchView('list'); setAutoFocusLane(false); setSelectedLens('archived'); } },
          ].map((item) => (
            <button
              key={item.label}
              type="button"
              className={`inbox-nav-item ${item.active ? 'is-active' : ''}`}
              onClick={item.onClick}
            >
              <span>{item.label}</span>
              <span className="inbox-nav-count">{item.count}</span>
            </button>
          ))}
        </nav>

        <nav className="inbox-nav sidebar-lower-nav">
          <div className="sidebar-section-label">Capabilities</div>
          {[
            { label: 'Artifacts', count: artifactNeedsReviewCount || artifactGroupCounts.all, active: activeSurface === 'artifacts', onClick: () => { setActiveSurface('artifacts'); setLauncherOpen(false); } },
            { label: 'Skills', count: skillRegistry.length, active: activeSurface === 'skills', onClick: () => { setActiveSurface('skills'); setLauncherOpen(false); } },
            { label: 'Environments', count: packs.length, active: activeSurface === 'environments', onClick: () => { setActiveSurface('environments'); setLauncherOpen(false); } },
            { label: 'Tracker', count: trackerSidebarCount, active: activeSurface === 'tracker', onClick: () => { setActiveSurface('tracker'); setLauncherOpen(false); } },
          ].map((item) => (
            <button
              key={item.label}
              type="button"
              className={`inbox-nav-item ${item.active ? 'is-active' : ''}`}
              onClick={item.onClick}
            >
              <span>{item.label}</span>
              <span className="inbox-nav-count">{item.count}</span>
            </button>
          ))}
        </nav>

        <div className="envbox">
          <div className="t">Current scope</div>
          <strong>{activeBindingOption.label}</strong>
          <dl className="sidebar-metrics">
            <div>
              <dt>Binding</dt>
              <dd>{activeBindingOption.kind}</dd>
            </div>
            <div>
              <dt>Feed</dt>
              <dd>
                <span className={`sidebar-live-dot is-${liveStatus}`} />
                {liveStatusLabel}
              </dd>
            </div>
            <div>
              <dt>Waiting</dt>
              <dd>{waitingCount}</dd>
            </div>
            <div>
              <dt>Risk</dt>
              <dd>{highRiskCount}</dd>
            </div>
          </dl>
        </div>
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
              setWorkbenchView('detail');
              resetWorkbenchScroll();
              setAutoFocusLane(false);
              setSelectedScopeKey('workspace');
              setSelectedLens('all');
              setLauncherOpen(false);
              setActiveTask(taskId);
            }}
          />
        ) : activeSurface === 'artifacts' ? (
          <section className="artifact-surface">
            <ArtifactGallery
              artifacts={artifacts}
              tasks={tasks}
              selectedArtifactId={activeArtifactId}
              loading={refreshingArtifacts}
              onSelectArtifact={(artifactId) => setActiveArtifactId(artifactId)}
              onOpenTask={(taskId) => {
                setActiveSurface('workbench');
                setWorkbenchView('detail');
                resetWorkbenchScroll();
                setAutoFocusLane(false);
                setSelectedScopeKey('workspace');
                setSelectedLens('all');
                setLauncherOpen(false);
                setActiveTask(taskId);
              }}
              onRefresh={() => refreshArtifacts()}
            />
            <ArtifactDetail
              artifact={activeArtifact}
              versions={artifactVersions}
              task={activeArtifact ? tasks.find((task) => task.id === activeArtifact.taskId) || null : null}
              loading={refreshingArtifacts}
              busyAction={artifactBusyAction}
              onAccept={handleArtifactAccept}
              onReject={handleArtifactReject}
              onArchive={handleArtifactArchive}
              onOpenTask={(taskId) => {
                setActiveSurface('workbench');
                setWorkbenchView('detail');
                resetWorkbenchScroll();
                setAutoFocusLane(false);
                setSelectedScopeKey('workspace');
                setSelectedLens('all');
                setLauncherOpen(false);
                setActiveTask(taskId);
              }}
            />
          </section>
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
              setWorkbenchView('detail');
              resetWorkbenchScroll();
              setAutoFocusLane(false);
              setSelectedScopeKey('workspace');
              setSelectedLens('all');
              setLauncherOpen(false);
              setActiveTask(taskId);
            }}
          />
        ) : activeSurface === 'tracker' ? (
          <TrackerSurface
            trackerState={trackerState}
            workflowFile={workflowFile}
            tasks={tasks}
            onOpenTask={(taskId) => {
              setActiveSurface('workbench');
              setWorkbenchView('detail');
              resetWorkbenchScroll();
              setAutoFocusLane(false);
              setSelectedScopeKey('workspace');
              setSelectedLens('all');
              setLauncherOpen(false);
              setActiveTask(taskId);
            }}
            onRefresh={async () => {
              await refreshTracker();
              await Promise.all([refreshTrackerState(), refreshWorkbench({ silent: true })]);
            }}
            onSaveWorkflow={handleSaveWorkflowFile}
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
              onPublishReviewRound={handlePublishReviewRound}
              publishingReviewRound={publishingReviewRound}
              onRefresh={() => refreshWorkbench()}
            />

            <section className={`inbox-content ${workbenchView === 'list' ? 'is-list-view' : 'is-detail-view'}`}>
              {workbenchView === 'list' || !activeTask ? (
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
                  bindingOptions={bindingOptions}
                  selectedBindingKey={selectedScopeKey}
                  onSelectTask={(taskId) => {
                    setActiveTask(taskId);
                    if (taskId) {
                      setWorkbenchView('detail');
                      resetWorkbenchScroll();
                      void reloadTaskDetails(taskId);
                    }
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
              ) : (
                <TaskDetailPanel
                  task={activeTask}
                  pack={activeTaskPack}
                  packs={packs}
                  timeline={timeline}
                  decisions={decisions}
                  artifacts={taskArtifacts}
                  resolvingDecisionId={resolvingDecisionId}
                  retrying={activeTask ? retryingTaskId === activeTask.id : false}
                  archiving={activeTask ? archivingTaskId === activeTask.id : false}
                  savingAdjustment={activeTask ? savingAdjustmentTaskId === activeTask.id : false}
                  revertingAdjustment={activeTask ? revertingAdjustmentTaskId === activeTask.id : false}
                  savingConfiguration={activeTask ? savingConfigurationTaskId === activeTask.id : false}
                  controllingTaskAction={activeTask && controllingTask?.taskId === activeTask.id ? controllingTask.action : null}
                  timelineError={timelineError}
                  onRetryTask={async (task) => {
                    setRetryingTaskId(task.id);
                    try {
                      const createdTask = await retryWorkbenchTask(task.id);
                      const nextTasks = await fetchWorkbenchTasks();
                      setAutoFocusLane(false);
                      setSelectedLens('today');
                      setTasks(nextTasks);
                      setActiveTask(createdTask.id);
                      setWorkbenchView('detail');
                      resetWorkbenchScroll();
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
                  onUpdateTaskMetadata={handleTaskMetadataChange}
                  onAddTaskComment={handleAddTaskComment}
                  onGenerateArtifact={handleGenerateTaskArtifact}
                  onAcceptArtifact={handleArtifactAccept}
                  onRejectArtifact={handleArtifactReject}
                  onOpenArtifact={(artifactId) => {
                    setActiveArtifactId(artifactId);
                    setActiveSurface('artifacts');
                    setLauncherOpen(false);
                  }}
                  generatingArtifact={generatingTaskArtifact}
                  busyArtifactId={taskArtifactBusyId}
                  onControlTask={async (taskId, action) => {
                    setControllingTask({ taskId, action });
                    try {
                      await controlWorkbenchTask(taskId, { type: action });
                      await reloadTaskDetails(taskId);
                    } catch (error) {
                      setTimelineError((error as Error).message);
                      throw error;
                    } finally {
                      setControllingTask(null);
                    }
                  }}
                />
              )}
            </section>
          </>
        )}
      </main>
    </div>
  );
}

function TrackerSurface({
  trackerState,
  workflowFile,
  tasks,
  onOpenTask,
  onRefresh,
  onSaveWorkflow,
}: {
  trackerState: TrackerStateResponse | null;
  workflowFile: WorkflowFileResponse | null;
  tasks: WorkbenchTaskResponse[];
  onOpenTask: (taskId: string) => void;
  onRefresh: () => Promise<void>;
  onSaveWorkflow: (content: string) => Promise<void>;
}) {
  const [refreshing, setRefreshing] = useState(false);
  const [savingWorkflow, setSavingWorkflow] = useState(false);
  const [workflowDraft, setWorkflowDraft] = useState('');
  const retryEntries = Object.values(trackerState?.retries || {})
    .sort((left, right) => left.dueAtMs - right.dueAtMs);
  const sortedTasks = sortWorkbenchTasks(tasks.filter((task) => task.status !== 'archived'));
  const allMaintenanceTasks = sortedTasks.filter(isTrackerMaintenanceTask);
  const allDispatchCandidates = sortedTasks.filter(isTrackerDispatchCandidate);
  const allActiveRunTasks = sortedTasks.filter((task) => (
    isTrackerActiveRunTask(task)
    && !isTrackerStaleTask(task)
    && !isTrackerMaintenanceTask(task)
  ));
  const allStaleTasks = sortedTasks.filter(isTrackerStaleTask);
  const allClaudeReviewTasks = sortedTasks.filter(isWaitingForClaudeReview);
  const allHumanReviewTasks = sortedTasks.filter(isWaitingForHumanReview);
  const allFailedTasks = sortedTasks.filter((task) => (
    task.status === 'failed'
    && !isWaitingForClaudeReview(task)
    && !isWaitingForHumanReview(task)
  ));
  const dispatchCandidates = allDispatchCandidates.slice(0, 8);
  const activeRunTasks = allActiveRunTasks.slice(0, 5);
  const maintenanceTasks = allMaintenanceTasks.slice(0, 5);
  const staleTasks = allStaleTasks.slice(0, 5);
  const claudeReviewTasks = allClaudeReviewTasks.slice(0, 4);
  const humanReviewTasks = allHumanReviewTasks.slice(0, 4);
  const failedTasks = allFailedTasks.slice(0, 4);
  const dispatchCandidateCount = trackerState?.summary?.activeCandidates
    ?? allDispatchCandidates.length;
  const activeRunCount = trackerState?.summary?.activeRuns
    ?? allActiveRunTasks.length;
  const maintenanceCount = trackerState?.summary?.maintenance
    ?? allMaintenanceTasks.length;
  const staleRunningCount = trackerState?.summary?.staleRunning
    ?? allStaleTasks.length;
  const watchLabel = trackerState ? (trackerState.watching ? 'running' : 'manual') : 'loading';
  const attentionCount = retryEntries.length
    + allStaleTasks.length
    + allHumanReviewTasks.length
    + allClaudeReviewTasks.length
    + allFailedTasks.length;
  const recentActivity = (trackerState?.recent || [])
    .slice()
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    .slice(0, 8);
  const listeners = trackerState?.listeners || [];

  useEffect(() => {
    setWorkflowDraft(workflowFile?.content || '');
  }, [workflowFile?.content]);

  const renderTaskRow = (
    task: WorkbenchTaskResponse,
    options: { detail?: string; meta?: string; tone?: 'blue' | 'green' | 'yellow' | 'red' | 'neutral' } = {},
  ) => {
    const taskKey = buildTrackerTaskKey(task);
    const agentLoopSummary = buildWorkbenchAgentLoopSummary(task.agentLoop);
    const openAttempt = getOpenTrackerAttempt(task);
    const openRun = getOpenTrackerRun(task);
    const phaseLabel = getTrackerPhaseLabel(task);
    const detail = options.detail
      || task.waitingReason
      || agentLoopSummary?.detail
      || task.latestSummary
      || openRun?.agentName
      || (openAttempt ? `attempt ${openAttempt.attemptNumber}` : 'ready');

    return (
      <button
        key={task.id}
        type="button"
        className={`tracker-task-row tone-${options.tone || trackerStatusTone(task.status)}`}
        onClick={() => onOpenTask(task.id)}
      >
        <span className="tracker-task-row-main">
          <span className="tracker-task-row-title">
            <span className="tracker-task-id">{taskKey}</span>
            <span>{task.title}</span>
          </span>
          <span className="tracker-task-row-meta">
            <span className={`tracker-status-pill tone-${trackerStatusTone(task.status)}`}>{humanizeTrackerStatus(task.status)}</span>
            {phaseLabel ? <span className="tracker-status-pill tone-blue">{phaseLabel}</span> : null}
            {task.priority ? <span className="tracker-status-pill tone-neutral">P{task.priority}</span> : null}
            <span>{buildTaskBindingLabel(task.workspaceBinding)}</span>
            <span>{options.meta || formatTrackerRelativeTime(task.lastProgressAt || task.updatedAt || task.createdAt)}</span>
          </span>
        </span>
        <span className="tracker-task-row-detail">{detail}</span>
      </button>
    );
  };

  return (
    <section className="tracker-surface">
      <div className="tracker-surface-header">
        <div>
          <div className="queue-card-kicker">Tracker</div>
          <h1>Tik task daemon</h1>
        </div>
        <button
          type="button"
          className="task-launch-button"
          disabled={refreshing}
          onClick={async () => {
            setRefreshing(true);
            try {
              await onRefresh();
            } finally {
              setRefreshing(false);
            }
          }}
        >
          {refreshing ? 'Refreshing...' : 'Refresh now'}
        </button>
      </div>

      <div className="tracker-status-strip" aria-label="Tracker status">
        <div className="tracker-status-item is-watch">
          <span className={`tracker-watch-dot ${trackerState?.watching ? 'is-live' : ''}`} />
          <span>Watch</span>
          <strong>{watchLabel}</strong>
        </div>
        <div className="tracker-status-item">
          <span>Queue</span>
          <strong>{dispatchCandidateCount}</strong>
        </div>
        <div className="tracker-status-item">
          <span>Running</span>
          <strong>{activeRunCount}</strong>
        </div>
        <div className="tracker-status-item">
          <span>Maintenance</span>
          <strong>{maintenanceCount}</strong>
        </div>
        <div className="tracker-status-item">
          <span>Stale</span>
          <strong>{staleRunningCount}</strong>
        </div>
        <div className="tracker-status-item">
          <span>Retries</span>
          <strong>{retryEntries.length}</strong>
        </div>
        <div className="tracker-status-item">
          <span>Attention</span>
          <strong>{attentionCount}</strong>
        </div>
      </div>

      <section className="focus-lower-card tracker-panel tracker-listeners-panel">
        <div className="tracker-panel-heading">
          <div>
            <div className="focus-lower-label">Background listeners</div>
            <strong>{listeners.filter((listener) => listener.status === 'running').length} running</strong>
          </div>
          <span>local processes</span>
        </div>
        <div className="tracker-listener-list">
          {listeners.length === 0 ? (
            <div className="tracker-empty-row">Listener state has not been reported yet.</div>
          ) : listeners.map((listener) => (
            <div key={listener.id} className={`tracker-listener-row tone-${trackerListenerTone(listener.status)}`}>
              <span className={`tracker-listener-dot tone-${trackerListenerTone(listener.status)}`} />
              <span className="tracker-listener-main">
                <strong>{listener.label}</strong>
                <span>{listener.detail}</span>
              </span>
              <span className={`tracker-status-pill tone-${trackerListenerTone(listener.status)}`}>
                {humanizeTrackerListenerStatus(listener.status)}
              </span>
            </div>
          ))}
        </div>
      </section>

      <div className="tracker-dashboard-grid">
        <section className="focus-lower-card tracker-panel tracker-panel-primary">
          <div className="tracker-panel-heading">
            <div>
              <div className="focus-lower-label">Dispatch queue</div>
              <strong>{dispatchCandidateCount} ready</strong>
            </div>
            <span>Codex lane</span>
          </div>
          <div className="tracker-task-list">
            {dispatchCandidates.length === 0 ? (
              <div className="tracker-empty-row">No Codex-ready task is waiting.</div>
            ) : dispatchCandidates.map((task) => renderTaskRow(task, {
              detail: task.agentLoop?.blockingIssues?.length
                ? `${task.agentLoop.blockingIssues.length} blocking issue${task.agentLoop.blockingIssues.length === 1 ? '' : 's'}`
                : undefined,
            }))}
          </div>
        </section>

        <section className="focus-lower-card tracker-panel">
          <div className="tracker-panel-heading">
            <div>
              <div className="focus-lower-label">Running and stale</div>
              <strong>{activeRunCount} active</strong>
            </div>
            <span>{staleRunningCount} stale</span>
          </div>
          <div className="tracker-task-list">
            {activeRunTasks.length === 0 && staleTasks.length === 0 ? (
              <div className="tracker-empty-row">No task is currently running.</div>
            ) : (
              <>
                {activeRunTasks.map((task) => renderTaskRow(task, {
                  meta: formatTrackerRelativeTime(getOpenTrackerRun(task)?.startedAt || getOpenTrackerAttempt(task)?.startedAt || task.updatedAt),
                  detail: getOpenTrackerRun(task)?.agentName
                    ? `${getOpenTrackerRun(task)?.agentName} run is open`
                    : 'kernel attempt is open',
                }))}
                {staleTasks.map((task) => renderTaskRow(task, {
                  tone: 'yellow',
                  detail: 'status is running but no open kernel attempt is attached',
                }))}
              </>
            )}
          </div>
        </section>

        <section className="focus-lower-card tracker-panel">
          <div className="tracker-panel-heading">
            <div>
              <div className="focus-lower-label">Maintenance</div>
              <strong>{maintenanceCount} item{maintenanceCount === 1 ? '' : 's'}</strong>
            </div>
            <span>manual/tool lane</span>
          </div>
          <div className="tracker-task-list">
            {maintenanceTasks.length === 0 ? (
              <div className="tracker-empty-row">No workspace maintenance task is waiting.</div>
            ) : maintenanceTasks.map((task) => renderTaskRow(task, {
              tone: 'neutral',
              detail: task.status === 'todo'
                ? 'not auto-dispatched; use workspace tools or add an explicit coding label'
                : task.latestSummary || 'workspace maintenance task',
            }))}
          </div>
        </section>

        <section className="focus-lower-card tracker-panel">
          <div className="tracker-panel-heading">
            <div>
              <div className="focus-lower-label">Attention</div>
              <strong>{attentionCount} item{attentionCount === 1 ? '' : 's'}</strong>
            </div>
            <span>Review loop</span>
          </div>
          <div className="tracker-attention-list">
            {attentionCount === 0 ? (
              <div className="tracker-empty-row">No retry, stale, or review handoff is pending.</div>
            ) : (
              <>
                {retryEntries.slice(0, 4).map((retry) => {
                  const task = tasks.find((candidate) => candidate.id === retry.taskId);
                  return (
                    <button
                      key={`retry-${retry.taskId}`}
                      type="button"
                      className="tracker-attention-row tone-yellow"
                      onClick={() => task ? onOpenTask(task.id) : undefined}
                    >
                      <span>
                        <strong>{retry.shortIdentifier}</strong>
                        <em>retry {formatTrackerDueTime(retry.dueAtMs)} · attempt {retry.attempt}</em>
                      </span>
                      <span>{retry.lastError || 'retry scheduled'}</span>
                    </button>
                  );
                })}
                {humanReviewTasks.map((task) => renderTaskRow(task, {
                  tone: 'yellow',
                  detail: 'waiting for /approve or /retry',
                }))}
                {claudeReviewTasks.map((task) => renderTaskRow(task, {
                  tone: 'blue',
                  detail: 'waiting for Claude Code plugin review result',
                }))}
                {staleTasks.map((task) => renderTaskRow(task, {
                  tone: 'yellow',
                  detail: task.agentLoop?.stale
                    ? `head changed from ${task.agentLoop.stale.expectedHeadSha.slice(0, 12)} to ${task.agentLoop.stale.actualHeadSha.slice(0, 12)}`
                    : 'running state needs reconciliation',
                }))}
                {failedTasks.map((task) => renderTaskRow(task, {
                  tone: 'red',
                  detail: task.attempts?.slice().reverse().find((attempt) => attempt.error)?.error || 'last attempt failed',
                }))}
              </>
            )}
          </div>
        </section>
      </div>

      <section className="focus-lower-card tracker-panel tracker-events-panel">
        <div className="tracker-panel-heading">
          <div>
            <div className="focus-lower-label">Recent daemon events</div>
            <strong>{recentActivity.length} shown</strong>
          </div>
          <span>{trackerState ? 'live state loaded' : 'loading state'}</span>
        </div>
        <div className="tracker-event-feed">
          {recentActivity.length === 0 ? (
            <div className="tracker-empty-row">No tracker event has been recorded yet.</div>
          ) : recentActivity.map((entry) => (
            <div key={`${entry.createdAt}-${entry.type}-${entry.shortIdentifier}`} className="tracker-event-row">
              <span>{formatTrackerRelativeTime(entry.createdAt)}</span>
              <strong>{entry.shortIdentifier}</strong>
              <em>{entry.type}</em>
              <p>{entry.message}</p>
            </div>
          ))}
        </div>
      </section>

      <details className="focus-lower-card tracker-workflow-editor">
        <summary className="tracker-workflow-summary">
          <span>
            <span className="focus-lower-label">Workflow</span>
            <strong>{workflowFile?.path || '.tik/WORKFLOW.md'}</strong>
          </span>
          <span>{workflowFile?.exists ? 'loaded' : 'new file'}</span>
        </summary>
        <div className="tracker-workflow-body">
          <div className="tracker-workflow-header">
            <div>
              <div className="focus-lower-label">Workflow prompt</div>
              <strong>{workflowFile?.path || '.tik/WORKFLOW.md'}</strong>
            </div>
            <button
              type="button"
              className="task-launch-button"
              disabled={savingWorkflow || !workflowDraft.trim()}
              onClick={async () => {
                setSavingWorkflow(true);
                try {
                  await onSaveWorkflow(workflowDraft);
                } finally {
                  setSavingWorkflow(false);
                }
              }}
            >
              {savingWorkflow ? 'Saving...' : 'Save workflow'}
            </button>
          </div>
          <textarea
            className="tracker-workflow-textarea"
            value={workflowDraft}
            onChange={(event) => setWorkflowDraft(event.target.value)}
            spellCheck={false}
          />
        </div>
      </details>
    </section>
  );
}

function isTrackerDispatchCandidate(task: WorkbenchTaskResponse): boolean {
  if (task.status !== 'todo' && task.status !== 'failed') {
    return false;
  }
  return isWorkbenchTaskCodexDispatchable(task);
}

function isTrackerMaintenanceTask(task: WorkbenchTaskResponse): boolean {
  if (!isWorkbenchTaskMaintenance(task)) {
    return false;
  }
  return !isWorkbenchTerminalStatus(task.status) || Boolean(getOpenTrackerAttempt(task)) || Boolean(getOpenTrackerRun(task));
}

function isTrackerActiveRunTask(task: WorkbenchTaskResponse): boolean {
  return task.status === 'running'
    || task.status === 'in_progress'
    || Boolean(getOpenTrackerAttempt(task))
    || Boolean(getOpenTrackerRun(task));
}

function isTrackerStaleTask(task: WorkbenchTaskResponse): boolean {
  if (isTrackerLoopStale(task)) {
    return true;
  }
  const activeStatus = task.status === 'running' || task.status === 'in_progress';
  return activeStatus && !getOpenTrackerAttempt(task) && !getOpenTrackerRun(task);
}

function isWaitingForClaudeReview(task: WorkbenchTaskResponse): boolean {
  if (isWorkbenchTerminalStatus(task.status)) {
    return false;
  }
  return task.agentLoop?.kind === 'claude_review'
    || task.agentLoop?.phase === 'needs_claude_review'
    || task.agentLoop?.phase === 'claude_reviewing'
    || hasTrackerLabelAction(task, 'claude_code_review');
}

function isWaitingForHumanReview(task: WorkbenchTaskResponse): boolean {
  if (isWorkbenchTerminalStatus(task.status)) {
    return false;
  }
  return task.agentLoop?.kind === 'human_review'
    || task.agentLoop?.phase === 'needs_human_review'
    || hasTrackerLabelAction(task, 'human_review')
    || task.status === 'waiting_for_user'
    || task.status === 'in_review';
}

function isTrackerLoopComplete(task: WorkbenchTaskResponse): boolean {
  return task.agentLoop?.phase === 'complete' || hasTrackerLabelAction(task, 'loop_complete');
}

function isTrackerLoopStale(task: WorkbenchTaskResponse): boolean {
  return task.agentLoop?.phase === 'stale' || Boolean(task.agentLoop?.stale);
}

function getOpenTrackerAttempt(task: WorkbenchTaskResponse): WorkbenchTaskAttemptRecord | null {
  return task.attempts?.find((attempt) => attempt.kernelTaskId && !attempt.finishedAt) || null;
}

function getOpenTrackerRun(task: WorkbenchTaskResponse): WorkbenchTaskRunRecord | null {
  return task.runs?.find((run) => run.status === 'running' || run.status === 'stopping') || null;
}

function buildTrackerTaskKey(task: WorkbenchTaskResponse): string {
  return task.identifier || task.shortIdentifier || `TIK-${task.id.slice(0, 8).toUpperCase()}`;
}

function getTrackerPhaseLabel(task: WorkbenchTaskResponse): string | null {
  const phase = task.agentLoop?.phase;
  if (phase) {
    switch (phase) {
      case 'needs_claude_review':
        return 'Claude review';
      case 'claude_reviewing':
        return 'Claude running';
      case 'needs_codex_fix':
        return 'Codex fix';
      case 'codex_fixing':
        return 'Codex running';
      case 'needs_human_review':
        return 'Human review';
      case 'stale':
        return 'Stale head';
      case 'complete':
        return 'Loop complete';
    }
  }

  const labelAction = getFirstTrackerLabelAction(task);
  if (labelAction && labelAction !== 'metadata') {
    return getWorkbenchLabelActionDefinition(labelAction).label;
  }
  return null;
}

function hasTrackerLabelAction(
  task: WorkbenchTaskResponse,
  action: WorkbenchLabelAction,
): boolean {
  return (task.labels || []).some((label) => getWorkbenchLabelAction(task.environmentPackSnapshot, label) === action);
}

function getFirstTrackerLabelAction(task: WorkbenchTaskResponse): WorkbenchLabelAction | null {
  for (const label of task.labels || []) {
    const action = getWorkbenchLabelAction(task.environmentPackSnapshot, label);
    if (action !== 'metadata') {
      return action;
    }
  }
  return null;
}

function humanizeTrackerStatus(status: WorkbenchTaskResponse['status']): string {
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
      return 'Failed';
    case 'blocked':
      return 'Blocked';
    case 'paused':
      return 'Paused';
    case 'cancelled':
      return 'Stopped';
    case 'archived':
      return 'Archived';
    case 'new':
    default:
      return 'New';
  }
}

function trackerStatusTone(status: WorkbenchTaskResponse['status']): 'green' | 'blue' | 'yellow' | 'red' | 'neutral' {
  switch (status) {
    case 'completed':
      return 'green';
    case 'failed':
    case 'cancelled':
      return 'red';
    case 'waiting_for_user':
    case 'in_review':
    case 'blocked':
    case 'paused':
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

function trackerListenerTone(status: NonNullable<TrackerStateResponse['listeners']>[number]['status']): 'green' | 'yellow' | 'red' | 'neutral' {
  switch (status) {
    case 'running':
      return 'green';
    case 'expected':
    case 'unknown':
      return 'yellow';
    case 'stopped':
      return 'red';
    default:
      return 'neutral';
  }
}

function humanizeTrackerListenerStatus(status: NonNullable<TrackerStateResponse['listeners']>[number]['status']): string {
  switch (status) {
    case 'running':
      return 'Running';
    case 'expected':
      return 'Expected';
    case 'stopped':
      return 'Stopped';
    case 'unknown':
    default:
      return 'Unknown';
  }
}

function formatTrackerRelativeTime(value?: string | null): string {
  if (!value) {
    return 'No activity';
  }

  const timestamp = new Date(value).getTime();
  if (Number.isNaN(timestamp)) {
    return value;
  }

  const diffMs = Math.max(0, Date.now() - timestamp);
  const diffMinutes = Math.floor(diffMs / 60000);
  if (diffMinutes < 1) {
    return 'now';
  }
  if (diffMinutes < 60) {
    return `${diffMinutes}m ago`;
  }

  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) {
    return `${diffHours}h ago`;
  }

  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 7) {
    return `${diffDays}d ago`;
  }

  return new Date(timestamp).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function formatTrackerDueTime(dueAtMs: number): string {
  const diffMs = dueAtMs - Date.now();
  const absMinutes = Math.max(0, Math.ceil(Math.abs(diffMs) / 60000));
  if (Math.abs(diffMs) < 30000) {
    return 'now';
  }
  if (diffMs > 0) {
    return `in ${absMinutes}m`;
  }
  return `${absMinutes}m overdue`;
}
