import { canArchiveWorkbenchTask, extractModifiedFilesFromEvidenceBody, isWorkbenchTerminalStatus } from '@tik/shared';
import type {
  AgentLoopMetadata,
  MultiAgentWorkflowBundle,
  MultiAgentWorkflowEvidence,
  QuestionerOutput,
  QuestionerRun,
  SprintContract,
  SubtaskRunState,
  TaskGraph,
  WorkflowDecision,
  WorkbenchArtifactRecord as SharedWorkbenchArtifactRecord,
  TaskWorkspaceBinding,
  WorkbenchTaskAdjustmentRecord,
  WorkbenchTaskCommentRecord,
  WorkbenchTaskEvidenceSummary,
  WorkbenchTaskStatus,
} from '@tik/shared';

export interface WorkbenchTaskSummary {
  id: string;
  identifier?: string;
  shortIdentifier?: string;
  title: string;
  status: WorkbenchTaskStatus;
  priority?: number | null;
  labels?: string[];
  latestSummary?: string;
  lastProgressAt?: string;
  createdAt?: string;
  updatedAt?: string;
  evidenceSummary?: WorkbenchTaskEvidenceSummary;
  workspaceBinding?: TaskWorkspaceBinding;
  agentLoop?: AgentLoopMetadata;
  lastAdjustment?: WorkbenchTaskAdjustmentRecord;
  comments?: WorkbenchTaskCommentRecord[];
}

export const DASHBOARD_AGENT_LOOP_APPROVE_COMMENT =
  '/approve\nApproved from the Dashboard human review banner.';

export function isAgentLoopHumanReviewReady(
  task: Pick<WorkbenchTaskSummary, 'status' | 'agentLoop'>,
): boolean {
  return task.status === 'in_review'
    && task.agentLoop?.kind === 'human_review'
    && task.agentLoop.phase === 'needs_human_review';
}

export function canArchiveWorkbenchTaskFromBanner(
  task: Pick<WorkbenchTaskSummary, 'status' | 'agentLoop'>,
): boolean {
  return canArchiveWorkbenchTask(task.status) || isAgentLoopHumanReviewReady(task);
}

export interface WorkbenchTimelineNode {
  id: string;
  kind: 'summary' | 'decision' | 'raw';
  actor: 'supervisor' | 'researcher' | 'coder' | 'reviewer' | 'user' | 'system';
  body: string;
  createdAt: string;
  evidenceIds?: string[];
  decisionId?: string;
}

export interface TimelineGroup<T extends WorkbenchTimelineNode = WorkbenchTimelineNode> {
  summary: T;
  rawItems: T[];
}

export type WorkbenchFeedLens = 'all' | 'operator' | 'agents' | 'evidence' | 'decisions';

export interface WorkbenchFeedMetrics {
  allCount: number;
  operatorCount: number;
  agentCount: number;
  evidenceCount: number;
  decisionCount: number;
}

export interface ParsedWorkbenchEvidence {
  toolName?: string;
  filesModified: string[];
  output: string;
  error?: string;
  previewableArtifacts: string[];
}

export interface WorkbenchArtifactRecord {
  path: string;
  createdAt: string;
  toolName?: string;
  outputExcerpt: string;
  errorExcerpt?: string;
}

export interface WorkbenchEvidenceDigest {
  rawEventCount: number;
  artifactCount: number;
  modifiedFileCount: number;
  toolNames: string[];
  previewableArtifacts: WorkbenchArtifactRecord[];
  modifiedFiles: string[];
  latestDiffExcerpt?: string;
  latestOutputExcerpt: string;
  latestErrorExcerpt?: string;
  latestToolName?: string;
  latestCreatedAt?: string;
}

export interface WorkbenchAcceptanceSummary {
  tone: 'green' | 'blue' | 'yellow';
  headline: string;
  detail: string;
}

export interface RunProofArtifactLink {
  artifactId: string;
  versionId: string;
  title: string;
}

export interface RunProofPanelModel {
  reviewArtifactId: string;
  title: string;
  summary: string;
  statusLabel: string;
  canDecide: boolean;
  changedFiles: string[];
  validationRefs: string[];
  links: {
    review?: RunProofArtifactLink;
    diff?: RunProofArtifactLink;
    transcript?: RunProofArtifactLink;
    validation?: RunProofArtifactLink;
  };
}

export interface TaskWorkflowMetric {
  label: string;
  value: string;
}

export interface TaskWorkflowRow {
  id: string;
  title: string;
  detail: string;
  meta?: string;
  tone?: 'neutral' | 'green' | 'yellow' | 'red' | 'blue';
}

export interface TaskWorkflowPanelModel {
  workflowId: string;
  title: string;
  statusLabel: string;
  rootTaskLabel: string;
  refLabel: string;
  headLabel: string;
  lastDecisionLabel: string;
  metrics: TaskWorkflowMetric[];
  plan: TaskWorkflowRow[];
  contracts: TaskWorkflowRow[];
  subtasks: TaskWorkflowRow[];
  evidence: TaskWorkflowRow[];
  decisions: TaskWorkflowRow[];
  runtime: TaskWorkflowRow[];
  hasDetails: boolean;
}

type TaskWorkflowPanelBundle = Omit<
  MultiAgentWorkflowBundle,
  'contracts' | 'decisions' | 'evidence' | 'evaluationRuns' | 'invocations' | 'questionerOutputs' | 'questionerRuns' | 'subtasks'
> & {
  contracts?: MultiAgentWorkflowBundle['contracts'];
  decisions?: MultiAgentWorkflowBundle['decisions'];
  evidence?: MultiAgentWorkflowBundle['evidence'];
  evaluationRuns?: MultiAgentWorkflowBundle['evaluationRuns'];
  invocations?: MultiAgentWorkflowBundle['invocations'];
  questionerOutputs?: MultiAgentWorkflowBundle['questionerOutputs'];
  questionerRuns?: MultiAgentWorkflowBundle['questionerRuns'];
  subtasks?: MultiAgentWorkflowBundle['subtasks'];
};

export interface WorkbenchQueueSignal {
  tone: 'green' | 'blue' | 'yellow' | 'red' | 'neutral';
  label: string;
  detail: string;
}

export interface WorkbenchAgentLoopSummary {
  label: string;
  detail: string;
  kindLabel: string;
  shortHeadSha: string;
  tone: 'green' | 'blue' | 'yellow' | 'neutral';
}

export interface WorkbenchLiveRunEntry {
  id: string;
  createdAt: string;
  tone: 'green' | 'blue' | 'yellow' | 'red' | 'neutral';
  label: string;
  text: string;
  detail?: string;
}

export interface WorkbenchOverviewMetrics {
  totalTasks: number;
  attentionCount: number;
  activeCount: number;
  backlogCount: number;
  completedCount: number;
  archivedCount: number;
}

export interface GroupedWorkbenchTasks<T extends WorkbenchTaskSummary = WorkbenchTaskSummary> {
  attention: T[];
  active: T[];
  backlog: T[];
  completed: T[];
  archived: T[];
}

export type WorkbenchLens = 'inbox' | 'today' | 'active' | 'review-loop' | 'all' | 'completed' | 'archived' | 'backlog';

export type WorkbenchProgressColumnId = 'backlog' | 'todo' | 'in_progress' | 'in_review';

export interface WorkbenchProgressColumn<T extends WorkbenchTaskSummary = WorkbenchTaskSummary> {
  id: WorkbenchProgressColumnId;
  label: string;
  tone: 'neutral' | 'blue' | 'yellow' | 'purple';
  tasks: T[];
}

export interface WorkbenchFocusSummary {
  lens: WorkbenchLens;
  headline: string;
  detail: string;
  primaryTaskId: string | null;
}

export interface WorkbenchSteeringUpdateInput {
  title: string;
  goal: string;
  adjustment?: string;
  launchFollowUp: boolean;
}

export function shouldLaunchWorkbenchFollowUp(status: WorkbenchTaskStatus): boolean {
  return isWorkbenchTerminalStatus(status);
}

export function buildWorkbenchSteeringUpdateInput<T extends {
  title: string;
  goal: string;
  status: WorkbenchTaskStatus;
}>(
  task: T,
  overrides: {
    title?: string;
    goal?: string;
    adjustment?: string;
  } = {},
): WorkbenchSteeringUpdateInput {
  const title = overrides.title?.trim() || task.title.trim();
  const goal = overrides.goal?.trim() || task.goal.trim();
  const adjustment = overrides.adjustment?.trim() || undefined;

  return {
    title,
    goal,
    adjustment,
    launchFollowUp: shouldLaunchWorkbenchFollowUp(task.status),
  };
}

export interface WorkbenchLaneResolution {
  lens: WorkbenchLens;
  taskId: string | null;
}

export interface TaskAdjustmentPreset {
  id: string;
  label: string;
  note: string;
}

export interface TaskAdjustmentPreview {
  dirty: boolean;
  changes: Array<{ label: string; detail: string }>;
  impacts: string[];
}

export interface WorkbenchWorkspaceBindingSummary {
  headline: string;
  detail: string;
  pathLabel: string;
  scopeLabel: string;
}

export interface WorkbenchRuntimeControlAction {
  id: 'pause' | 'resume' | 'stop';
  label: string;
  pendingLabel: string;
  danger?: boolean;
}

const LOW_SIGNAL_LEGACY_EVENTS = new Set([
  'session.message',
  'session.usage',
  'evaluation.started',
  'evaluation.completed',
  'evaluation.fitness',
  'evaluation.drift',
  'evaluation.entropy',
  'iteration.started',
  'iteration.completed',
  'plan.started',
  'context.built',
  'context.updated',
  'memory.recorded',
  'convergence.achieved',
  'convergence.failed',
]);

const STALE_TERMINAL_SUMMARY_BODIES = new Set([
  'Task completed and the latest outputs are ready for review.',
  'Task failed and needs recovery before it can continue.',
  'Operator stopped the task before completion.',
  'Task archived from the active work queue.',
  'Stale task archived after its runtime record went missing.',
]);

type SearchableWorkbenchTaskFields = Partial<Pick<WorkbenchTaskSummary, 'latestSummary' | 'agentLoop'>> & {
  goal?: string;
  currentOwner?: string;
  waitingReason?: string;
  workspaceBinding?: TaskWorkspaceBinding;
  lastAdjustment?: WorkbenchTaskAdjustmentRecord;
};

type AdjustableWorkbenchTask = WorkbenchTaskSummary & SearchableWorkbenchTaskFields;

export const TASK_ADJUSTMENT_PRESETS: TaskAdjustmentPreset[] = [
  {
    id: 'tighten-scope',
    label: 'Tighten Scope',
    note: 'Reduce the task to the smallest shippable slice and defer nice-to-have work.',
  },
  {
    id: 'push-artifact',
    label: 'Push For Artifact',
    note: 'Prioritize a concrete artifact that I can preview or accept directly in the workbench.',
  },
  {
    id: 'raise-bar',
    label: 'Raise Verification',
    note: 'Increase the verification bar and include stronger evidence before calling the task done.',
  },
  {
    id: 'reframe-review',
    label: 'Switch To Review',
    note: 'Treat the next pass as a review and refinement cycle instead of net-new implementation.',
  },
];

export function sortWorkbenchTasks<T extends WorkbenchTaskSummary>(tasks: T[]): T[] {
  return [...tasks].sort((left, right) => {
    const rightTimestamp = right.lastProgressAt || right.updatedAt || right.createdAt || '';
    const leftTimestamp = left.lastProgressAt || left.updatedAt || left.createdAt || '';
    return rightTimestamp.localeCompare(leftTimestamp);
  });
}

export function filterVisibleWorkbenchTasks<T extends WorkbenchTaskSummary>(
  tasks: T[],
  options: { showArchived?: boolean } = {},
): T[] {
  if (options.showArchived) {
    return tasks;
  }
  return tasks.filter((task) => task.status !== 'archived');
}

export function filterWorkbenchTasksByQuery<T extends WorkbenchTaskSummary & SearchableWorkbenchTaskFields>(
  tasks: T[],
  query: string,
): T[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) {
    return tasks;
  }

  return tasks.filter((task) => {
    const haystack = [
      task.id,
      task.title,
      task.status,
      task.latestSummary,
      task.goal,
      task.currentOwner,
      task.waitingReason,
      task.lastAdjustment?.note,
      task.workspaceBinding?.workspaceName,
      task.workspaceBinding?.projectName,
      task.workspaceBinding?.effectiveProjectPath,
      task.agentLoop?.kind,
      task.agentLoop?.idempotencyKey,
      task.agentLoop?.rootTaskId,
      task.agentLoop?.changeRequest.repo,
      task.agentLoop?.changeRequest.id,
      task.agentLoop?.changeRequest.headSha,
      task.agentLoop?.changeRequest.headRef,
      task.agentLoop?.changeRequest.baseRef,
      ...(task.agentLoop?.reviewFocus || []),
    ]
      .filter((value): value is string => typeof value === 'string' && value.length > 0)
      .join(' ')
      .toLowerCase();

    return haystack.includes(normalized);
  });
}

export function getNextActiveWorkbenchTaskId<T extends WorkbenchTaskSummary>(
  tasks: T[],
  currentTaskId: string | null,
  options: { showArchived?: boolean } = {},
): string | null {
  const visibleSorted = sortWorkbenchTasks(filterVisibleWorkbenchTasks(tasks, options));
  if (visibleSorted.length === 0) {
    return null;
  }

  if (!currentTaskId) {
    return visibleSorted[0]?.id || null;
  }

  const currentIndex = visibleSorted.findIndex((task) => task.id === currentTaskId);
  if (currentIndex === -1) {
    return visibleSorted[0]?.id || null;
  }

  return visibleSorted[currentIndex + 1]?.id
    || visibleSorted[currentIndex - 1]?.id
    || null;
}

export function groupWorkbenchTasks<T extends WorkbenchTaskSummary>(tasks: T[]): GroupedWorkbenchTasks<T> {
  const sorted = sortWorkbenchTasks(tasks);
  return {
    attention: sorted.filter((task) => task.status === 'waiting_for_user' || task.status === 'in_review' || task.status === 'failed' || task.status === 'blocked' || task.status === 'cancelled' || task.priority === 1),
    active: sorted.filter((task) => task.status === 'todo' || task.status === 'in_progress' || task.status === 'in_review' || task.status === 'running' || task.status === 'verifying'),
    backlog: sorted.filter((task) => task.status === 'backlog' || task.status === 'new' || task.status === 'paused'),
    completed: sorted.filter((task) => task.status === 'completed'),
    archived: sorted.filter((task) => task.status === 'archived'),
  };
}

export function resolveWorkbenchTaskProgressColumn(status: WorkbenchTaskStatus): WorkbenchProgressColumnId | null {
  switch (status) {
    case 'new':
    case 'backlog':
    case 'paused':
    case 'retry':
      return 'backlog';
    case 'todo':
    case 'blocked':
    case 'failed':
    case 'rejected':
      return 'todo';
    case 'in_progress':
    case 'running':
    case 'verifying':
      return 'in_progress';
    case 'in_review':
    case 'needs_review':
    case 'waiting_for_user':
    case 'accepted':
    case 'completed':
    case 'archived':
      return 'in_review';
    case 'cancelled':
      return null;
  }
}

export function buildWorkbenchTaskProgressColumns<T extends WorkbenchTaskSummary>(
  tasks: T[],
): WorkbenchProgressColumn<T>[] {
  const columns: WorkbenchProgressColumn<T>[] = [
    { id: 'backlog', label: 'Backlog', tone: 'neutral', tasks: [] },
    { id: 'todo', label: 'Todo', tone: 'blue', tasks: [] },
    { id: 'in_progress', label: 'In progress', tone: 'yellow', tasks: [] },
    { id: 'in_review', label: 'In review', tone: 'purple', tasks: [] },
  ];
  const byColumnId = new Map(columns.map((column) => [column.id, column]));

  for (const task of sortWorkbenchTasks(tasks)) {
    const columnId = resolveWorkbenchTaskProgressColumn(task.status);
    if (columnId) {
      byColumnId.get(columnId)?.tasks.push(task);
    }
  }

  return columns;
}

export function applyTaskAdjustmentPreset(
  currentNote: string,
  presetId: string,
): string {
  const preset = TASK_ADJUSTMENT_PRESETS.find((entry) => entry.id === presetId);
  if (!preset) {
    return currentNote;
  }

  const trimmed = currentNote.trim();
  if (trimmed.includes(preset.note)) {
    return currentNote;
  }

  return trimmed.length > 0
    ? `${trimmed}\n- ${preset.note}`
    : `- ${preset.note}`;
}

export function buildTaskAdjustmentPreview(
  task: AdjustableWorkbenchTask | null,
  draft: { title: string; goal: string; adjustmentNote?: string },
): TaskAdjustmentPreview {
  if (!task) {
    return {
      dirty: false,
      changes: [],
      impacts: ['Select a task to prepare an adjustment pass.'],
    };
  }

  const changes: Array<{ label: string; detail: string }> = [];
  const nextTitle = draft.title.trim();
  const nextGoal = draft.goal.trim();
  const nextAdjustment = draft.adjustmentNote?.trim() || '';

  if (nextTitle && nextTitle !== task.title) {
    changes.push({
      label: 'Mission title',
      detail: `Rename from "${task.title}" to "${nextTitle}".`,
    });
  }

  if (nextGoal && nextGoal !== (task.goal || '')) {
    changes.push({
      label: 'Task brief',
      detail: 'Update the requested deliverable, scope, or acceptance bar for the next supervisor pass.',
    });
  }

  if (nextAdjustment) {
    changes.push({
      label: 'Operator note',
      detail: nextAdjustment,
    });
  }

  return {
    dirty: changes.length > 0,
    changes,
    impacts: changes.length > 0
      ? [
          'Rewrite the active task brief for this mission.',
          'Append an operator adjustment entry to the task history.',
          'Sync the refreshed brief into the running supervisor context for future iterations.',
        ]
      : ['No pending task changes. Edit the brief or use a steering preset to shape the next pass.'],
  };
}

export function buildWorkbenchWorkspaceBindingSummary(
  binding: TaskWorkspaceBinding | null | undefined,
): WorkbenchWorkspaceBindingSummary {
  if (!binding) {
    return {
      headline: 'No workspace binding',
      detail: 'This task is not pinned to a workspace context yet.',
      pathLabel: 'Execution path unavailable',
      scopeLabel: 'Unbound',
    };
  }

  const headline = binding.projectName || binding.workspaceName;
  const scopeLabel = binding.laneId
    ? `Lane · ${binding.laneId}`
    : binding.projectName
      ? 'Project'
      : 'Workspace root';
  const detail = binding.projectName
    ? `${binding.workspaceName}${binding.worktreeKind && binding.worktreeKind !== 'root' ? ` · ${binding.worktreeKind}` : ''}`
    : 'Single-workspace root binding';

  return {
    headline,
    detail,
    pathLabel: compactWorkbenchPath(binding.effectiveProjectPath),
    scopeLabel,
  };
}

export function buildWorkbenchAgentLoopSummary(
  metadata: AgentLoopMetadata | null | undefined,
): WorkbenchAgentLoopSummary | null {
  if (!metadata) {
    return null;
  }

  const kindLabel = humanizeAgentLoopKind(metadata.kind);
  const shortHeadSha = (metadata.headSha || metadata.changeRequest.headSha || '').slice(0, 12);
  const round = metadata.kind === 'human_review'
    ? `R${metadata.round}`
    : `R${metadata.round}/${metadata.maxRounds}`;
  const repoRef = `${metadata.changeRequest.repo}#${metadata.changeRequest.id}`;
  const staleSuffix = metadata.stale ? ' · stale' : '';

  return {
    label: `${kindLabel} · ${round}`,
    detail: `${repoRef} · ${metadata.changeRequest.headRef} · ${shortHeadSha}${staleSuffix}`,
    kindLabel,
    shortHeadSha,
    tone: metadata.stale
      ? 'yellow'
      : metadata.kind === 'human_review'
        ? 'yellow'
        : metadata.kind === 'codex_fix'
          ? 'blue'
          : metadata.kind === 'codex_implement'
            ? 'green'
            : 'neutral',
  };
}

export function buildWorkbenchOverview<T extends WorkbenchTaskSummary>(tasks: T[]): WorkbenchOverviewMetrics {
  const grouped = groupWorkbenchTasks(tasks);
  return {
    totalTasks: tasks.length,
    attentionCount: grouped.attention.length,
    activeCount: grouped.active.length,
    backlogCount: grouped.backlog.length,
    completedCount: grouped.completed.length,
    archivedCount: grouped.archived.length,
  };
}

export function filterWorkbenchTasksByLens<T extends WorkbenchTaskSummary>(
  tasks: T[],
  lens: WorkbenchLens,
  options: { now?: Date } = {},
): T[] {
  const grouped = groupWorkbenchTasks(tasks);
  const now = options.now || new Date();
  const todayPrefix = now.toISOString().slice(0, 10);

  switch (lens) {
    case 'inbox':
      return grouped.attention;
    case 'today':
      return sortWorkbenchTasks(tasks.filter((task) => {
        if (task.status === 'archived') return false;
        const timestamp = task.lastProgressAt || task.updatedAt || task.createdAt;
        return typeof timestamp === 'string' && timestamp.startsWith(todayPrefix);
      }));
    case 'active':
      return grouped.active;
    case 'review-loop':
      return sortWorkbenchTasks(tasks.filter((task) => !isWorkbenchTerminalStatus(task.status) && Boolean(task.agentLoop)));
    case 'completed':
      return grouped.completed;
    case 'archived':
      return grouped.archived;
    case 'backlog':
      return grouped.backlog;
    case 'all':
    default:
      return sortWorkbenchTasks(filterVisibleWorkbenchTasks(tasks));
  }
}

export function buildWorkbenchFocusSummary<T extends WorkbenchTaskSummary>(
  tasks: T[],
  options: { now?: Date } = {},
): WorkbenchFocusSummary {
  const inbox = filterWorkbenchTasksByLens(tasks, 'inbox', options);
  if (inbox.length > 0) {
    return {
      lens: 'inbox',
      headline: 'Needs your attention',
      detail: `${inbox.length} task${inbox.length > 1 ? 's' : ''} need review or recovery. Start with ${inbox[0]?.title}.`,
      primaryTaskId: inbox[0]?.id || null,
    };
  }

  const today = filterWorkbenchTasksByLens(tasks, 'today', options);
  if (today.length > 0) {
    return {
      lens: 'today',
      headline: 'Today in motion',
      detail: `${today.length} active or recently touched task${today.length > 1 ? 's' : ''}. ${today[0]?.title} is the current best next stop.`,
      primaryTaskId: today[0]?.id || null,
    };
  }

  const completed = filterWorkbenchTasksByLens(tasks, 'completed', options);
  if (completed.length > 0) {
    return {
      lens: 'completed',
      headline: 'Recent outputs are ready',
      detail: `${completed.length} completed task${completed.length > 1 ? 's' : ''} are waiting for review, sharing, or archive.`,
      primaryTaskId: completed[0]?.id || null,
    };
  }

  return {
    lens: 'all',
    headline: 'Workbench is quiet',
    detail: 'No active tasks are in motion right now. Launch a new task to wake up the supervisor.',
    primaryTaskId: null,
  };
}

export function resolveWorkbenchLane<T extends WorkbenchTaskSummary>(
  tasks: T[],
  preferredLens: WorkbenchLens,
  options: { now?: Date } = {},
): WorkbenchLaneResolution {
  const preferredTasks = filterWorkbenchTasksByLens(tasks, preferredLens, options);
  if (preferredTasks.length > 0) {
    return {
      lens: preferredLens,
      taskId: preferredTasks[0]?.id || null,
    };
  }

  const focus = buildWorkbenchFocusSummary(tasks, options);
  if (focus.primaryTaskId) {
    return {
      lens: focus.lens,
      taskId: focus.primaryTaskId,
    };
  }

  const allTasks = filterWorkbenchTasksByLens(tasks, 'all', options);
  if (allTasks.length > 0) {
    return {
      lens: 'all',
      taskId: allTasks[0]?.id || null,
    };
  }

  const archivedTasks = filterWorkbenchTasksByLens(tasks, 'archived', options);
  if (archivedTasks.length > 0) {
    return {
      lens: 'archived',
      taskId: archivedTasks[0]?.id || null,
    };
  }

  return {
    lens: preferredLens,
    taskId: null,
  };
}

export function buildTimelineGroups<T extends WorkbenchTimelineNode>(items: T[]): TimelineGroup<T>[] {
  const normalizedItems = items.flatMap((item) => {
    if (item.kind !== 'summary') {
      return [item];
    }

    const body = normalizeWorkbenchSummaryText(item.body);
    if (!body) {
      return [];
    }

    return [{ ...item, body }];
  });
  const groups: TimelineGroup<T>[] = [];

  for (const item of normalizedItems) {
    if (item.kind === 'summary' || item.kind === 'decision') {
      groups.push({ summary: item, rawItems: [] });
      continue;
    }

    const lastGroup = groups.at(-1);
    if (lastGroup) {
      lastGroup.rawItems.push(item);
    }
  }

  return groups;
}

export function filterTimelineGroupsByLens<T extends WorkbenchTimelineNode>(
  groups: TimelineGroup<T>[],
  lens: WorkbenchFeedLens,
): TimelineGroup<T>[] {
  switch (lens) {
    case 'operator':
      return groups.filter((group) => group.summary.actor === 'user');
    case 'agents':
      return groups.filter((group) => group.summary.kind !== 'decision' && group.summary.actor !== 'user');
    case 'evidence':
      return groups.filter((group) => group.rawItems.length > 0);
    case 'decisions':
      return groups.filter((group) => group.summary.kind === 'decision');
    case 'all':
    default:
      return groups;
  }
}

export function filterStaleTimelineGroupsForTask<T extends WorkbenchTimelineNode>(
  groups: TimelineGroup<T>[],
  taskStatus: WorkbenchTaskStatus | null | undefined,
): TimelineGroup<T>[] {
  if (!taskStatus || taskStatus === 'completed' || taskStatus === 'failed' || taskStatus === 'cancelled' || taskStatus === 'archived') {
    return groups;
  }

  return groups.filter((group, index, list) => {
    if (group.summary.kind !== 'summary') {
      return true;
    }

    if (!STALE_TERMINAL_SUMMARY_BODIES.has(group.summary.body)) {
      return true;
    }

    return !list.slice(index + 1).some((laterGroup) => laterGroup.summary.kind !== 'decision');
  });
}

export function buildTimelineFeedMetrics<T extends WorkbenchTimelineNode>(
  groups: TimelineGroup<T>[],
): WorkbenchFeedMetrics {
  return {
    allCount: groups.length,
    operatorCount: filterTimelineGroupsByLens(groups, 'operator').length,
    agentCount: filterTimelineGroupsByLens(groups, 'agents').length,
    evidenceCount: filterTimelineGroupsByLens(groups, 'evidence').length,
    decisionCount: filterTimelineGroupsByLens(groups, 'decisions').length,
  };
}

export function getDefaultWorkbenchFeedLens<T extends WorkbenchTimelineNode>(
  groups: TimelineGroup<T>[],
  options: {
    taskStatus?: WorkbenchTaskStatus | null;
    hasPendingDecision?: boolean;
  } = {},
): WorkbenchFeedLens {
  const hasDecisions = options.hasPendingDecision || groups.some((group) => group.summary.kind === 'decision');
  const hasEvidence = groups.some((group) => group.rawItems.length > 0);

  if (hasDecisions || options.taskStatus === 'waiting_for_user') {
    return hasDecisions ? 'decisions' : 'agents';
  }

  if ((options.taskStatus === 'completed' || options.taskStatus === 'verifying') && hasEvidence) {
    return 'evidence';
  }

  if (
    options.taskStatus === 'running'
    || options.taskStatus === 'new'
    || options.taskStatus === 'paused'
    || options.taskStatus === 'blocked'
  ) {
    return 'agents';
  }

  return 'all';
}

export function parseWorkbenchEvidence(item: Pick<WorkbenchTimelineNode, 'body'> & Partial<WorkbenchTimelineNode>): ParsedWorkbenchEvidence {
  const toolName = item.body.match(/^Tool:\s*(.+)$/m)?.[1]?.trim();
  const output = extractNamedSection(item.body, 'Output');
  const error = extractNamedSection(item.body, 'Error');
  const filesModified = extractModifiedFilesFromEvidenceBody(item.body);

  return {
    toolName,
    filesModified,
    output,
    error,
    previewableArtifacts: filesModified.filter(isPreviewableArtifactPath),
  };
}

export function buildWorkbenchEvidenceDigest<T extends Pick<WorkbenchTimelineNode, 'body' | 'createdAt'>>(
  items: T[],
): WorkbenchEvidenceDigest {
  const sorted = [...items].sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  const toolNames: string[] = [];
  const previewableArtifacts = new Map<string, WorkbenchArtifactRecord>();
  const modifiedFiles: string[] = [];
  let latestDiffExcerpt: string | undefined;
  let latestOutputExcerpt = '';
  let latestErrorExcerpt: string | undefined;
  let latestToolName: string | undefined;
  let latestCreatedAt: string | undefined;

  for (const item of sorted) {
    const parsed = parseWorkbenchEvidence(item);
    if (parsed.toolName && !toolNames.includes(parsed.toolName)) {
      toolNames.push(parsed.toolName);
    }

    if (!latestOutputExcerpt && parsed.output) {
      latestOutputExcerpt = truncateWorkbenchEvidenceText(parsed.output);
      latestToolName = parsed.toolName;
      latestCreatedAt = item.createdAt;
    }

    if (!latestDiffExcerpt && parsed.output) {
      latestDiffExcerpt = extractWorkbenchDiffExcerpt(parsed.output);
    }

    if (!latestErrorExcerpt && parsed.error) {
      latestErrorExcerpt = truncateWorkbenchEvidenceText(parsed.error);
      latestToolName = latestToolName || parsed.toolName;
      latestCreatedAt = latestCreatedAt || item.createdAt;
    }

    parsed.filesModified.forEach((filePath) => {
      if (!modifiedFiles.includes(filePath)) {
        modifiedFiles.push(filePath);
      }
    });

    parsed.previewableArtifacts.forEach((artifactPath) => {
      if (!previewableArtifacts.has(artifactPath)) {
        previewableArtifacts.set(artifactPath, {
          path: artifactPath,
          createdAt: item.createdAt,
          toolName: parsed.toolName,
          outputExcerpt: truncateWorkbenchEvidenceText(parsed.output),
          errorExcerpt: parsed.error ? truncateWorkbenchEvidenceText(parsed.error) : undefined,
        });
      }
    });
  }

  return {
    rawEventCount: items.length,
    artifactCount: previewableArtifacts.size,
    modifiedFileCount: modifiedFiles.length,
    toolNames,
    previewableArtifacts: Array.from(previewableArtifacts.values()),
    modifiedFiles,
    latestDiffExcerpt,
    latestOutputExcerpt,
    latestErrorExcerpt,
    latestToolName,
    latestCreatedAt,
  };
}

export function buildWorkbenchAcceptanceDigest<T extends Pick<WorkbenchTimelineNode, 'body' | 'createdAt'>>(
  items: T[],
  artifacts: SharedWorkbenchArtifactRecord[] = [],
): WorkbenchEvidenceDigest {
  const rawDigest = buildWorkbenchEvidenceDigest(items);
  if (artifacts.length === 0) {
    return rawDigest;
  }

  const previewableArtifacts = [...rawDigest.previewableArtifacts];
  const previewableArtifactPaths = new Set(previewableArtifacts.map((artifact) => artifact.path));
  const modifiedFiles = [...rawDigest.modifiedFiles];
  const toolNames = [...rawDigest.toolNames];

  for (const artifact of artifacts) {
    if (!previewableArtifactPaths.has(artifact.safeRelativePath)) {
      previewableArtifactPaths.add(artifact.safeRelativePath);
      previewableArtifacts.push({
        path: artifact.safeRelativePath,
        createdAt: artifact.updatedAt || artifact.createdAt,
        toolName: artifact.producedBy?.tool || artifact.producedBy?.agent || artifact.producedBy?.provider,
        outputExcerpt: truncateWorkbenchEvidenceText(artifact.summary || artifact.description || artifact.title),
      });
    }

    artifact.changedFiles?.forEach((filePath) => {
      if (!modifiedFiles.includes(filePath)) {
        modifiedFiles.push(filePath);
      }
    });

    const producedBy = artifact.producedBy?.tool || artifact.producedBy?.agent || artifact.producedBy?.provider;
    if (producedBy && !toolNames.includes(producedBy)) {
      toolNames.push(producedBy);
    }
  }

  return {
    ...rawDigest,
    artifactCount: previewableArtifacts.length,
    modifiedFileCount: modifiedFiles.length,
    toolNames,
    previewableArtifacts,
    modifiedFiles,
    latestCreatedAt: rawDigest.latestCreatedAt || artifacts[0]?.updatedAt || artifacts[0]?.createdAt,
  };
}

export function buildWorkbenchAcceptanceSummary(
  taskStatus: WorkbenchTaskStatus | null | undefined,
  digest: WorkbenchEvidenceDigest,
  pendingDecisionCount = 0,
): WorkbenchAcceptanceSummary {
  if (pendingDecisionCount > 0 || taskStatus === 'waiting_for_user') {
    return {
      tone: 'yellow',
      headline: 'Operator review required',
      detail: digest.artifactCount > 0
        ? 'The task is paused for a decision. Review the latest artifact or evidence before approving the next move.'
        : 'The task is paused for a decision, but no previewable artifact is attached yet. Inspect the latest evidence before approving.',
    };
  }

  if (taskStatus === 'completed') {
    return digest.artifactCount > 0
      ? {
        tone: 'green',
        headline: 'Artifact ready for acceptance',
        detail: 'The task completed and left a previewable artifact in the workbench. Open it, review the evidence, then archive when satisfied.',
      }
      : {
        tone: 'blue',
        headline: 'Completed without previewable artifact',
        detail: 'The task finished, but acceptance still depends on reviewing changed files and the latest execution evidence.',
      };
  }

  if ((taskStatus === 'in_review' || taskStatus === 'needs_review' || taskStatus === 'verifying') && digest.artifactCount > 0) {
    return {
      tone: 'blue',
      headline: 'Review artifacts ready',
      detail: 'The task is in review with artifacts attached. Inspect the preview, changed files, and run evidence before accepting it.',
    };
  }

  if (taskStatus === 'failed' || taskStatus === 'blocked' || taskStatus === 'cancelled') {
    return {
      tone: 'yellow',
      headline: 'Recovery needed before acceptance',
      detail: digest.latestErrorExcerpt
        ? 'The latest evidence contains an error. Recover the task or steer it before treating the output as reviewable.'
        : 'This task is not currently in a reviewable state. Recover or redirect it before acceptance.',
    };
  }

  if (digest.artifactCount > 0) {
    return {
      tone: 'blue',
      headline: 'Artifact already visible',
      detail: 'Execution is still in motion, but there is already a previewable artifact you can inspect while the task continues.',
    };
  }

  if (digest.modifiedFileCount > 0) {
    return {
      tone: 'blue',
      headline: 'File output recorded',
      detail: 'The task has modified files, but there is no previewable artifact yet. Review the evidence stream or push for a concrete artifact.',
    };
  }

  if (digest.rawEventCount > 0) {
    return {
      tone: 'blue',
      headline: 'Evidence is accumulating',
      detail: 'The task has execution evidence, but not enough output yet to treat it as an acceptance candidate.',
    };
  }

  return {
    tone: 'blue',
    headline: 'No acceptance evidence yet',
    detail: 'The workbench has not recorded artifacts or raw execution evidence for this task yet.',
  };
}

export function buildRunProofPanelModel(
  taskStatus: WorkbenchTaskStatus,
  artifacts: SharedWorkbenchArtifactRecord[],
): RunProofPanelModel | null {
  const sorted = [...artifacts].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  const review = sorted.find((artifact) => artifact.kind === 'run_review' || artifact.tags?.includes('run-review'));
  if (!review) return null;

  const diff = sorted.find((artifact) => artifact.kind === 'diff');
  const transcript = sorted.find((artifact) => artifact.kind === 'transcript');
  const validation = sorted.find((artifact) => artifact.kind === 'validation_log');
  const canDecide = taskStatus === 'needs_review' && review.status === 'needs_review';

  return {
    reviewArtifactId: review.id,
    title: review.title,
    summary: review.summary || 'Run proof evidence is ready for review.',
    statusLabel: formatArtifactStatusLabel(review.status),
    canDecide,
    changedFiles: review.changedFiles || [],
    validationRefs: review.validationRefs || [],
    links: {
      review: toRunProofArtifactLink(review),
      diff: diff ? toRunProofArtifactLink(diff) : undefined,
      transcript: transcript ? toRunProofArtifactLink(transcript) : undefined,
      validation: validation ? toRunProofArtifactLink(validation) : undefined,
    },
  };
}

function toRunProofArtifactLink(artifact: SharedWorkbenchArtifactRecord): RunProofArtifactLink {
  return {
    artifactId: artifact.id,
    versionId: artifact.latestVersionId,
    title: artifact.title,
  };
}

function formatArtifactStatusLabel(status: SharedWorkbenchArtifactRecord['status']): string {
  const label = status.replace(/_/g, ' ');
  return label.charAt(0).toUpperCase() + label.slice(1);
}

function compareByTaskGraphOrder(taskGraph: TaskGraph | null | undefined, leftId: string, rightId: string): number {
  const order = new Map((taskGraph?.subtasks || []).map((subtask, index) => [subtask.id, index]));
  return (order.get(leftId) ?? Number.MAX_SAFE_INTEGER) - (order.get(rightId) ?? Number.MAX_SAFE_INTEGER)
    || leftId.localeCompare(rightId);
}

function buildPlanWorkflowRows(taskGraph: TaskGraph | null | undefined): TaskWorkflowRow[] {
  const graph = taskGraph;
  if (!graph) {
    return [];
  }

  const rows: TaskWorkflowRow[] = [{
    id: `task-graph:v${graph.version}`,
    title: `TaskGraph v${graph.version}`,
    detail: [
      `${graph.subtasks.length} subtasks`,
      `${graph.globalAcceptanceCriteria.length} global acceptance`,
      `${graph.finalValidationCommands.length} final checks`,
    ].join(' · '),
    meta: [
      `created by ${graph.createdBy}`,
      graph.risks.length ? `${graph.risks.length} risks` : 'no risks recorded',
    ].join(' · '),
    tone: graph.risks.length ? 'yellow' : 'blue',
  }];

  if (graph.globalAcceptanceCriteria.length > 0) {
    rows.push({
      id: 'task-graph:global-acceptance',
      title: 'Global acceptance',
      detail: formatWorkflowListPreview(graph.globalAcceptanceCriteria),
      meta: `${graph.globalAcceptanceCriteria.length} criteria`,
      tone: 'green',
    });
  }

  if (graph.finalValidationCommands.length > 0) {
    rows.push({
      id: 'task-graph:final-validation',
      title: 'Final validation',
      detail: formatWorkflowListPreview(graph.finalValidationCommands),
      meta: `${graph.finalValidationCommands.length} commands`,
      tone: 'blue',
    });
  }

  if (graph.risks.length > 0) {
    rows.push({
      id: 'task-graph:risks',
      title: 'Plan risks',
      detail: formatWorkflowListPreview(graph.risks),
      meta: `${graph.risks.length} risks`,
      tone: 'yellow',
    });
  }

  return rows;
}

function buildSubtaskWorkflowRow(taskGraph: TaskGraph | null | undefined, subtask: SubtaskRunState): TaskWorkflowRow {
  const spec = taskGraph?.subtasks.find((item) => item.id === subtask.subtaskId);
  const evidenceCount = subtask.evidenceRefs.length;
  const validationCount = subtask.validationRunIds.length;
  const reviewCount = subtask.reviewRoundIds.length;
  return {
    id: subtask.subtaskId,
    title: spec?.title || subtask.subtaskId,
    detail: [
      humanizeWorkflowStatus(subtask.status),
      evidenceCount ? `${evidenceCount} evidence` : 'no evidence',
      validationCount ? `${validationCount} validation` : undefined,
      reviewCount ? `${reviewCount} review` : undefined,
    ].filter(Boolean).join(' · '),
    meta: [
      spec?.allowedPaths.slice(0, 2).join(', '),
      compactSha(subtask.implementationHeadSha || subtask.lastValidatedHeadSha || subtask.lastReviewedHeadSha),
    ].filter(Boolean).join(' · '),
    tone: toneForSubtaskStatus(subtask.status),
  };
}

function buildContractWorkflowRow(contract: SprintContract): TaskWorkflowRow {
  const commandCount = contract.verificationPlan.commands.length;
  return {
    id: contract.id,
    title: `Contract ${contract.id}`,
    detail: [
      humanizeWorkflowStatus(contract.status),
      `v${contract.version}`,
      `${contract.acceptanceCriteria.length} criteria`,
      `${contract.deliverables.length} deliverables`,
      commandCount ? `${commandCount} commands` : 'no commands',
    ].join(' · '),
    meta: [
      contract.subtaskId,
      compactSha(contract.headShaAtAcceptance),
      contract.acceptedAt,
      contract.scope.allowedPaths.slice(0, 2).join(', '),
    ].filter(Boolean).join(' · '),
    tone: toneForContractStatus(contract.status),
  };
}

function buildEvidenceWorkflowRow(evidence: MultiAgentWorkflowEvidence): TaskWorkflowRow {
  const reviewSummary = summarizeReviewEvidence(evidence);
  return {
    id: evidence.id,
    title: evidence.title || evidence.id,
    detail: [
      evidence.kind,
      evidence.passed === undefined ? undefined : evidence.passed ? 'passed' : 'failed',
      evidence.command,
      reviewSummary,
    ].filter(Boolean).join(' · '),
    meta: [
      evidence.subtaskId || 'final workflow',
      compactSha(evidence.headSha),
      evidence.artifactRef,
      evidence.createdAt,
    ].filter(Boolean).join(' · '),
    tone: evidence.passed === undefined ? 'neutral' : toneForPassed(evidence.passed),
  };
}

function buildDecisionWorkflowRow(decision: WorkflowDecision): TaskWorkflowRow {
  return {
    id: decision.id,
    title: humanizeWorkflowStatus(decision.action),
    detail: [
      decision.reason,
      decision.evidenceRefs.length ? `${decision.evidenceRefs.length} evidence refs` : undefined,
      decision.confidence === undefined ? undefined : `${Math.round(decision.confidence * 100)}% confidence`,
    ].filter(Boolean).join(' · '),
    meta: [
      decision.subtaskId || 'workflow',
      decision.expectedTikMutation?.taskStatus ? `status ${decision.expectedTikMutation.taskStatus}` : undefined,
      decision.decidedAt,
    ].filter(Boolean).join(' · '),
    tone: decision.action.includes('fix') || decision.action.includes('human') ? 'yellow' : decision.action.includes('complete') ? 'green' : 'blue',
  };
}

function buildQuestionerWorkflowRow(output: QuestionerOutput): TaskWorkflowRow {
  return {
    id: `questioner:${output.id}`,
    title: `Questioner ${humanizeWorkflowStatus(output.intent)}`,
    detail: [
      humanizeWorkflowStatus(output.verdict),
      output.questions.length ? `${output.questions.length} questions` : undefined,
      output.risks.length ? `${output.risks.length} risks` : undefined,
      output.missingTests.length ? `${output.missingTests.length} missing tests` : undefined,
    ].filter(Boolean).join(' · '),
    meta: [
      output.subtaskId || 'workflow',
      output.actor.invocationId,
      compactSha(output.headSha),
      output.artifactRef,
    ].filter(Boolean).join(' · '),
    tone: output.verdict.includes('blocking') || output.verdict === 'risk_found' ? 'yellow' : 'blue',
  };
}

function buildQuestionerRunWorkflowRow(run: QuestionerRun): TaskWorkflowRow {
  return {
    id: `questioner-run:${run.id}`,
    title: `Questioner run ${humanizeWorkflowStatus(run.intent)}`,
    detail: [
      humanizeWorkflowStatus(run.status),
      run.contextHash,
      run.outputHash ? `output ${run.outputHash}` : undefined,
      run.rejectionReason,
    ].filter(Boolean).join(' · '),
    meta: [
      run.subtaskId || 'workflow',
      run.invocationId,
      compactSha(run.headSha),
      run.contextArtifactRef,
    ].filter(Boolean).join(' · '),
    tone: run.status === 'rejected' || run.status === 'expired' ? 'red' : toneForRuntimeStatus(run.status),
  };
}

function summarizeReviewEvidence(evidence: MultiAgentWorkflowEvidence): string | undefined {
  const result = evidence.payload?.result;
  if (!result || typeof result !== 'object') {
    return undefined;
  }
  const review = result as { verdict?: unknown; blockingIssues?: unknown };
  const verdict = typeof review.verdict === 'string' ? review.verdict : undefined;
  const blocking = Array.isArray(review.blockingIssues) ? review.blockingIssues.length : undefined;
  return [
    verdict ? `verdict ${verdict}` : undefined,
    blocking === undefined ? undefined : `${blocking} blocking`,
  ].filter(Boolean).join(' · ') || undefined;
}

function toneForSubtaskStatus(status: SubtaskRunState['status']): TaskWorkflowRow['tone'] {
  if (status === 'done' || status === 'approved' || status === 'review_approved' || status === 'validated' || status === 'evaluation_passed') {
    return 'green';
  }
  if (status === 'blocked' || status === 'needs_fix' || status === 'validation_failed' || status === 'evaluation_failed' || status === 'human_review_required') {
    return 'yellow';
  }
  return 'blue';
}

function toneForRuntimeStatus(status: string): TaskWorkflowRow['tone'] {
  if (status === 'completed' || status === 'passed') {
    return 'green';
  }
  if (status === 'failed' || status === 'cancelled') {
    return 'red';
  }
  if (status === 'inconclusive' || status === 'invalidated') {
    return 'yellow';
  }
  return 'blue';
}

function toneForContractStatus(status: SprintContract['status']): TaskWorkflowRow['tone'] {
  if (status === 'accepted') {
    return 'green';
  }
  if (status === 'rejected' || status === 'stale') {
    return 'yellow';
  }
  return 'blue';
}

function toneForPassed(passed: boolean): TaskWorkflowRow['tone'] {
  return passed ? 'green' : 'red';
}

function formatWorkflowListPreview(items: string[], maxItems = 3): string {
  const visible = items.slice(0, maxItems);
  const suffix = items.length > visible.length ? `; +${items.length - visible.length} more` : '';
  return `${visible.join('; ')}${suffix}`;
}

function compactSha(value?: string): string {
  return value ? value.slice(0, 12) : '';
}

function humanizeWorkflowStatus(value: string): string {
  const label = value.replace(/[_-]/g, ' ');
  return label.charAt(0).toUpperCase() + label.slice(1);
}

export function buildTaskWorkflowPanelModel(bundle: TaskWorkflowPanelBundle | null): TaskWorkflowPanelModel | null {
  if (!bundle) {
    return null;
  }

  const workflow = bundle.workflow;
  const contracts = Array.isArray(bundle.contracts) ? bundle.contracts : [];
  const decisions = Array.isArray(bundle.decisions) ? bundle.decisions : [];
  const evidence = Array.isArray(bundle.evidence) ? bundle.evidence : [];
  const evaluationRuns = Array.isArray(bundle.evaluationRuns) ? bundle.evaluationRuns : [];
  const invocations = Array.isArray(bundle.invocations) ? bundle.invocations : [];
  const questionerOutputs = Array.isArray(bundle.questionerOutputs) ? bundle.questionerOutputs : [];
  const questionerRuns = Array.isArray(bundle.questionerRuns) ? bundle.questionerRuns : [];
  const subtasks = bundle.subtasks && typeof bundle.subtasks === 'object' ? bundle.subtasks : {};
  const planRows = buildPlanWorkflowRows(bundle.taskGraph);
  const contractRows = contracts
    .slice()
    .sort((left, right) => right.version - left.version || left.subtaskId.localeCompare(right.subtaskId))
    .slice(0, 6)
    .map(buildContractWorkflowRow);
  const subtaskRows = Object.values(subtasks)
    .sort((left, right) => compareByTaskGraphOrder(bundle.taskGraph, left.subtaskId, right.subtaskId))
    .map((subtask) => buildSubtaskWorkflowRow(bundle.taskGraph, subtask));
  const evidenceRows = evidence
    .slice()
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    .slice(0, 6)
    .map(buildEvidenceWorkflowRow);
  const decisionRows = decisions
    .slice()
    .sort((left, right) => right.decidedAt.localeCompare(left.decidedAt))
    .slice(0, 6)
    .map(buildDecisionWorkflowRow);
  const runtimeRows = [
    ...evaluationRuns
      .slice()
      .sort((left, right) => (right.completedAt || right.startedAt).localeCompare(left.completedAt || left.startedAt))
      .slice(0, 3)
      .map((run) => ({
        id: `evaluation:${run.id}`,
        title: `Evaluation ${run.id}`,
        detail: `${humanizeWorkflowStatus(run.status)} · ${run.result?.verdict || 'no verdict'} · ${run.result?.runtimeFindings.length ?? 0} findings`,
        meta: [run.subtaskId, compactSha(run.headSha), run.completedAt || run.startedAt].filter(Boolean).join(' · '),
        tone: toneForPassed(run.status === 'passed'),
      }) satisfies TaskWorkflowRow),
    ...questionerOutputs
      .slice()
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, 3)
      .map(buildQuestionerWorkflowRow),
    ...questionerRuns
      .slice()
      .sort((left, right) => String(right.completedAt || right.startedAt || right.createdAt).localeCompare(String(left.completedAt || left.startedAt || left.createdAt)))
      .slice(0, 3)
      .map(buildQuestionerRunWorkflowRow),
    ...invocations
      .slice()
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .slice(0, 3)
      .map((invocation) => ({
        id: `invocation:${invocation.id}`,
        title: `${humanizeWorkflowStatus(invocation.role)} invocation`,
        detail: `${invocation.runner} · ${humanizeWorkflowStatus(invocation.status)}${invocation.hookAttested ? ' · hook attested' : ''}`,
        meta: [
          invocation.subtaskId,
          invocation.threadId || invocation.actualSubagentThreadId,
          invocation.error,
        ].filter(Boolean).join(' · '),
        tone: toneForRuntimeStatus(invocation.status),
      }) satisfies TaskWorkflowRow),
  ].slice(0, 8);

  return {
    workflowId: workflow.id,
    title: workflow.goal,
    statusLabel: humanizeWorkflowStatus(workflow.status),
    rootTaskLabel: workflow.rootTaskId,
    refLabel: [workflow.repo, workflow.baseRef && workflow.headRef ? `${workflow.baseRef} -> ${workflow.headRef}` : workflow.headRef || workflow.baseRef]
      .filter(Boolean)
      .join(' · ') || 'No ref recorded',
    headLabel: compactSha(workflow.currentHeadSha),
    lastDecisionLabel: workflow.lastDecisionId || 'No decision yet',
    metrics: [
      { label: 'Subtasks', value: String(Object.keys(subtasks).length) },
      { label: 'Evidence', value: String(evidence.length) },
      { label: 'Decisions', value: String(decisions.length) },
      { label: 'Contracts', value: String(contracts.length) },
      { label: 'Runtime', value: String(evaluationRuns.length + questionerRuns.length + questionerOutputs.length + invocations.length) },
    ],
    plan: planRows,
    contracts: contractRows,
    subtasks: subtaskRows,
    evidence: evidenceRows,
    decisions: decisionRows,
    runtime: runtimeRows,
    hasDetails: planRows.length + contractRows.length + subtaskRows.length + evidenceRows.length + decisionRows.length + runtimeRows.length > 0,
  };
}

export function buildWorkbenchQueueSignal(
  task: Pick<WorkbenchTaskSummary, 'status' | 'evidenceSummary'> & { waitingReason?: string },
): WorkbenchQueueSignal {
  const evidenceSummary = task.evidenceSummary;
  const artifactCount = evidenceSummary?.previewableArtifactCount ?? 0;
  const fileCount = evidenceSummary?.modifiedFileCount ?? 0;
  const rawEventCount = evidenceSummary?.rawEventCount ?? 0;
  const hasErrorEvidence = evidenceSummary?.hasErrorEvidence ?? false;

  if (hasErrorEvidence && task.status !== 'archived') {
    if (task.status === 'completed') {
      return {
        tone: 'yellow',
        label: 'Run had errors',
        detail: fileCount > 0
          ? `Completed with tool errors in evidence · ${formatCount(fileCount, 'file')} touched`
          : 'Completed with tool errors in evidence. Inspect Activity before accepting output.',
      };
    }

    if (task.status === 'failed' || task.status === 'blocked' || task.status === 'cancelled') {
      return {
        tone: 'red',
        label: 'Recover before review',
        detail: 'Latest evidence contains a tool error. Recover or redirect the task before accepting output.',
      };
    }

    return {
      tone: 'red',
      label: 'Tool error',
      detail: rawEventCount > 0
        ? `${formatCount(rawEventCount, 'evidence event')} recorded · latest run contains a tool error`
        : 'Latest run contains a tool error. Open Activity for details.',
    };
  }

  if (task.status === 'waiting_for_user') {
    return artifactCount > 0
      ? {
        tone: 'yellow',
        label: 'Needs review',
        detail: `${formatCount(artifactCount, 'artifact')} ready · ${formatCount(fileCount, 'file')} touched`,
      }
      : {
        tone: 'yellow',
        label: 'Decision pending',
        detail: rawEventCount > 0
          ? `${formatCount(rawEventCount, 'evidence event')} recorded · no previewable artifact yet`
          : (task.waitingReason || 'Supervisor is waiting for your next decision.'),
      };
  }

  if (task.status === 'completed') {
    return artifactCount > 0
      ? {
        tone: 'green',
        label: 'Artifact ready',
        detail: `${formatCount(artifactCount, 'artifact')} ready for acceptance · ${formatCount(fileCount, 'file')} touched`,
      }
      : {
        tone: 'blue',
        label: 'Review files',
        detail: fileCount > 0
          ? `${formatCount(fileCount, 'file')} touched · no previewable artifact yet`
          : 'Task completed, but the queue has no concrete artifact attached yet.',
      };
  }

  if (task.status === 'archived') {
    return artifactCount > 0
      ? {
        tone: 'green',
        label: 'Accepted',
        detail: `Archived after ${formatCount(artifactCount, 'artifact')} review · ${formatCount(fileCount, 'file')} touched`,
      }
      : {
        tone: 'blue',
        label: 'Archived',
        detail: fileCount > 0
          ? `Archived after file-only output · ${formatCount(fileCount, 'file')} touched`
          : 'Task moved out of the active console.',
      };
  }

  if (task.status === 'failed' || task.status === 'blocked' || task.status === 'cancelled') {
    return {
      tone: 'yellow',
      label: 'Recover before review',
      detail: evidenceSummary?.hasErrorEvidence
        ? 'Latest evidence contains an error. Recover or redirect the task before accepting output.'
        : 'This task is not currently reviewable. Recover or restart it before acceptance.',
    };
  }

  if (artifactCount > 0) {
    return {
      tone: 'blue',
      label: 'Preview live',
      detail: `${formatCount(artifactCount, 'artifact')} already visible while the task keeps running`,
    };
  }

  if (fileCount > 0) {
    return {
      tone: 'blue',
      label: 'Files changing',
      detail: `${formatCount(fileCount, 'file')} touched in the latest pass`,
    };
  }

  if (rawEventCount > 0) {
    return {
      tone: 'blue',
      label: 'Evidence streaming',
      detail: `${formatCount(rawEventCount, 'evidence event')} recorded so far`,
    };
  }

  return {
    tone: 'neutral',
    label: 'No artifact yet',
    detail: 'Supervisor is still shaping a concrete deliverable.',
  };
}

export function buildWorkbenchLiveRunEntries<T extends Pick<WorkbenchTimelineNode, 'id' | 'kind' | 'actor' | 'body' | 'createdAt'>>(
  items: T[],
  options: { limit?: number } = {},
): WorkbenchLiveRunEntry[] {
  const limit = options.limit ?? 12;

  return [...items]
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
    .flatMap<WorkbenchLiveRunEntry>((item): WorkbenchLiveRunEntry[] => {
      if (item.kind === 'raw') {
        const parsed = parseWorkbenchEvidence(item);
        const detailParts = [
          parsed.filesModified.length > 0
            ? parsed.filesModified.slice(0, 2).map((filePath) => compactWorkbenchPath(filePath)).join(' • ')
            : null,
          parsed.previewableArtifacts.length > 0
            ? `${formatCount(parsed.previewableArtifacts.length, 'preview')} ready`
            : null,
        ].filter((value): value is string => typeof value === 'string' && value.length > 0);
        const text = parsed.error
          ? truncateWorkbenchEvidenceText(parsed.error, 180)
          : parsed.output
            ? truncateWorkbenchEvidenceText(parsed.output, 180)
            : parsed.filesModified.length > 0
              ? `Touched ${formatCount(parsed.filesModified.length, 'file')}.`
              : truncateWorkbenchEvidenceText(item.body, 180);

        return [{
          id: item.id,
          createdAt: item.createdAt,
          tone: parsed.error ? 'red' : 'blue',
          label: parsed.toolName ? `$ ${parsed.toolName}` : 'Tool output',
          text,
          detail: detailParts.join(' · ') || undefined,
        }];
      }

      const normalized = item.kind === 'summary'
        ? normalizeWorkbenchSummaryText(item.body)
        : item.body.trim();
      if (!normalized) {
        return [];
      }

        return [{
          id: item.id,
          createdAt: item.createdAt,
          tone: inferWorkbenchLiveRunTone(normalized, item.kind, item.actor),
        label: item.kind === 'decision'
          ? 'Decision'
          : item.actor === 'user'
            ? 'Operator'
            : item.actor === 'system'
              ? 'System'
              : item.actor === 'coder'
                ? 'Coder'
                : item.actor === 'researcher'
                  ? 'Researcher'
                  : item.actor === 'reviewer'
                    ? 'Reviewer'
                    : 'Supervisor',
        text: truncateWorkbenchEvidenceText(normalized, 180),
        detail: undefined,
      }];
    })
    .slice(-limit);
}

export function buildWorkbenchOperatorNoteSummary(
  task: Pick<WorkbenchTaskSummary, 'lastAdjustment'>,
): string | null {
  const note = task.lastAdjustment?.note?.trim();
  return note ? `Operator note: ${note}` : null;
}

export function buildWorkbenchLatestCommentSummary(
  task: Pick<WorkbenchTaskSummary, 'comments'>,
): string | null {
  const latestHumanComment = [...(task.comments || [])]
    .reverse()
    .find((comment) => comment.authorKind === 'human' && comment.body.trim());
  const body = latestHumanComment?.body.trim();
  return body ? `Latest comment: ${body}` : null;
}

export function buildWorkbenchTaskVisibleSummary(
  task: Pick<WorkbenchTaskSummary, 'latestSummary' | 'lastAdjustment' | 'comments'> & {
    goal?: string;
    waitingReason?: string;
  },
): string | null {
  return buildWorkbenchOperatorNoteSummary(task)
    || buildWorkbenchLatestCommentSummary(task)
    || normalizeWorkbenchSummaryText(task.latestSummary)
    || task.waitingReason?.trim()
    || task.goal?.trim()
    || null;
}

export function getLatestPreviewableArtifact<T extends Pick<WorkbenchTimelineNode, 'body' | 'createdAt'>>(
  items: T[],
): string | null {
  const sorted = [...items].sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  for (const item of sorted) {
    const parsed = parseWorkbenchEvidence(item);
    if (parsed.previewableArtifacts[0]) {
      return parsed.previewableArtifacts[0];
    }
  }
  return null;
}

export function normalizeWorkbenchSummaryText(body: string | undefined): string | null {
  const trimmed = body?.trim();
  if (!trimmed) {
    return trimmed || null;
  }

  const legacyEventMatch = trimmed.match(/^Supervisor observed event ([a-z.]+)\.$/i);
  if (legacyEventMatch) {
    const eventType = legacyEventMatch[1];
    if (LOW_SIGNAL_LEGACY_EVENTS.has(eventType)) {
      return null;
    }

    switch (eventType) {
      case 'task.created':
        return 'Task entered the supervisor queue.';
      case 'task.completed':
        return 'Task completed and the latest outputs are ready for review.';
      case 'task.failed':
        return 'Task failed and needs recovery before it can continue.';
      case 'task.cancelled':
        return 'Operator stopped the task before completion.';
      case 'task.paused':
        return 'Operator paused the task and preserved the current runtime state.';
      case 'task.resumed':
        return 'Supervisor resumed task execution.';
      case 'plan.generated':
        return 'Supervisor drafted the next execution pass.';
      default:
        return trimmed;
    }
  }

  if (trimmed === 'Supervisor recorded successful tool output from write_file.' || trimmed === 'Supervisor recorded successful tool output from edit_file.') {
    return 'Supervisor updated the target files and produced a reviewable artifact.';
  }

  if (trimmed === 'Supervisor recorded successful tool output from read_file.') {
    return 'Supervisor inspected the current project files to ground the next pass.';
  }

  if (trimmed === 'Supervisor recorded successful tool output from bash.') {
    return 'Supervisor completed the shell step and recorded the result.';
  }

  if (trimmed === 'Supervisor is evaluating tool call risk for read_file.') {
    return 'Supervisor is inspecting the current files before making changes.';
  }

  if (trimmed === 'Supervisor is evaluating tool call risk for write_file.' || trimmed === 'Supervisor is evaluating tool call risk for edit_file.') {
    return 'Supervisor is preparing a concrete patch for the active task.';
  }

  if (trimmed === 'Supervisor is evaluating tool call risk for bash.') {
    return 'Supervisor is preparing a shell action that may need approval.';
  }

  return trimmed;
}

function extractNamedSection(body: string, sectionName: string): string {
  const match = body.match(new RegExp(`${escapeForRegex(sectionName)}:\\n([\\s\\S]*?)(?:\\n\\n[A-Z][^\\n]*:|$)`));
  return match?.[1]?.trim() || '';
}

function extractBulletSection(body: string, sectionName: string): string[] {
  const content = extractNamedSection(body, sectionName);
  if (!content) {
    return [];
  }

  return content
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('- '))
    .map((line) => line.slice(2).trim())
    .filter(Boolean);
}

function extractWorkbenchDiffExcerpt(output: string, maxLength = 6000): string | undefined {
  const candidates = [output, ...extractJsonStringValues(output)];
  for (const candidate of candidates) {
    const diffStart = candidate.indexOf('diff --git ');
    if (diffStart < 0) {
      continue;
    }

    const diff = candidate.slice(diffStart).trim();
    if (!diff) {
      continue;
    }

    return diff.length <= maxLength ? diff : `${diff.slice(0, maxLength - 1)}…`;
  }

  return undefined;
}

function extractJsonStringValues(value: string): string[] {
  const trimmed = value.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
    return [];
  }

  try {
    return collectJsonStringValues(JSON.parse(trimmed));
  } catch {
    return [];
  }
}

function collectJsonStringValues(value: unknown): string[] {
  if (typeof value === 'string') {
    return [value];
  }

  if (Array.isArray(value)) {
    return value.flatMap((item) => collectJsonStringValues(item));
  }

  if (value && typeof value === 'object') {
    return Object.values(value).flatMap((item) => collectJsonStringValues(item));
  }

  return [];
}

function escapeForRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isPreviewableArtifactPath(filePath: string): boolean {
  const lowered = filePath.toLowerCase();
  return (
    lowered.endsWith('.html')
    || lowered.endsWith('.htm')
    || lowered.endsWith('.md')
    || lowered.endsWith('.txt')
    || lowered.endsWith('.json')
    || lowered.endsWith('.svg')
  );
}

function truncateWorkbenchEvidenceText(value: string, maxLength = 220): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (!normalized) {
    return '';
  }

  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength - 1)}…`;
}

function inferWorkbenchLiveRunTone(
  value: string,
  kind: WorkbenchTimelineNode['kind'],
  actor: WorkbenchTimelineNode['actor'],
): WorkbenchLiveRunEntry['tone'] {
  const lowered = value.toLowerCase();

  if (lowered.includes('error') || lowered.includes('failed')) {
    return 'red';
  }

  if (kind === 'decision' || lowered.includes('waiting') || lowered.includes('approval')) {
    return 'yellow';
  }

  if (lowered.includes('completed') || lowered.includes('ready') || actor === 'user') {
    return 'green';
  }

  if (actor === 'system') {
    return 'neutral';
  }

  return 'blue';
}

function compactWorkbenchPath(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/');
  const segments = normalized.split('/').filter(Boolean);
  if (segments.length <= 4) {
    return normalized;
  }

  return `.../${segments.slice(-4).join('/')}`;
}

function formatCount(count: number, label: string): string {
  return `${count} ${label}${count === 1 ? '' : 's'}`;
}

function humanizeAgentLoopKind(kind: AgentLoopMetadata['kind']): string {
  switch (kind) {
    case 'claude_review':
      return 'Claude review';
    case 'codex_fix':
      return 'Codex fix';
    case 'human_review':
      return 'Human review';
    case 'codex_implement':
    default:
      return 'Codex implement';
  }
}

// ─── Task status banner spec ────────────────────────────────────────────────
//
// Drives the conditional banner at the top of the task detail panel. Returns
// `null` when the task is in a quiet state (running / queued / no decision)
// so the banner does not render and the activity block becomes the focal
// surface.

export type TaskStatusBannerTone = 'yellow' | 'red' | 'green' | 'neutral';

export type TaskStatusBannerActionKind = 'primary' | 'secondary' | 'danger';

export type TaskStatusBannerAction =
  | { id: 'retry'; label: string; kind: TaskStatusBannerActionKind }
  | { id: 'archive'; label: string; kind: TaskStatusBannerActionKind }
  | { id: 'approve-review'; label: string; kind: TaskStatusBannerActionKind }
  | { id: 'cancel'; label: string; kind: TaskStatusBannerActionKind }
  | { id: 'resume'; label: string; kind: TaskStatusBannerActionKind }
  | { id: 'open-review'; label: string; kind: TaskStatusBannerActionKind }
  | { id: 'stop'; label: string; kind: TaskStatusBannerActionKind }
  | { id: 'reopen'; label: string; kind: TaskStatusBannerActionKind }
  | { id: 'unblock'; label: string; kind: TaskStatusBannerActionKind }
  | { id: 'run-next-pass'; label: string; kind: TaskStatusBannerActionKind };

export interface TaskStatusBannerSpec {
  tone: TaskStatusBannerTone;
  icon: '⚠' | '✗' | '✓' | '○' | '⏸';
  headline: string;
  detail?: string;
  // Banner does not render its own action buttons when the decision block
  // is the source of truth; in that case `actions` stays empty.
  actions: TaskStatusBannerAction[];
  // Hint to the panel: the decision block is the authoritative action
  // surface, banner should not duplicate buttons.
  decisionDriven: boolean;
}

interface TaskStatusBannerInput {
  status: WorkbenchTaskStatus;
  waitingReason?: string;
  attempts?: Array<{ attemptNumber: number; outcome?: string; error?: string }>;
  blockedBy?: Array<{ state?: string | null }>;
  blockedByTaskIds?: string[];
  agentLoop?: AgentLoopMetadata;
}

export function buildTaskStatusBannerSpec(
  task: TaskStatusBannerInput | null,
  decisions: Array<{ title?: string; summary?: string }> = [],
): TaskStatusBannerSpec | null {
  if (!task) {
    return null;
  }

  // Decision pending — yellow banner, no buttons (decision block owns them).
  if (decisions.length > 0) {
    const decision = decisions[0];
    return {
      tone: 'yellow',
      icon: '⚠',
      headline: decision?.title?.trim() || 'Waiting on you',
      detail: decision?.summary?.trim() || 'Operator review required before the next move.',
      actions: [],
      decisionDriven: true,
    };
  }

  switch (task.status) {
    case 'running':
    case 'in_progress':
    case 'todo':
    case 'backlog':
    case 'verifying':
    case 'new':
      return null;

    case 'waiting_for_user':
      return {
        tone: 'yellow',
        icon: '⚠',
        headline: 'Waiting on you',
        detail: task.waitingReason?.trim() || 'Operator input is required before the task can continue.',
        actions: [
          { id: 'resume', label: 'Resume', kind: 'primary' },
          { id: 'stop', label: 'Stop', kind: 'danger' },
        ],
        decisionDriven: false,
      };

    case 'in_review':
      if (isAgentLoopHumanReviewReady(task)) {
        return {
          tone: 'yellow',
          icon: '⚠',
          headline: 'Human review',
          detail: task.waitingReason?.trim() || 'Agent-loop review is ready for human approval or archive.',
          actions: [
            { id: 'approve-review', label: 'Approve', kind: 'primary' },
            { id: 'archive', label: 'Archive', kind: 'secondary' },
            { id: 'open-review', label: 'Open review', kind: 'secondary' },
          ],
          decisionDriven: false,
        };
      }
      return {
        tone: 'yellow',
        icon: '⚠',
        headline: 'In review',
        detail: task.waitingReason?.trim() || 'Awaiting human review before the task can move forward.',
        actions: [
          { id: 'open-review', label: 'Open review', kind: 'primary' },
          { id: 'stop', label: 'Stop', kind: 'danger' },
        ],
        decisionDriven: false,
      };

    case 'paused':
      return {
        tone: 'neutral',
        icon: '⏸',
        headline: 'Paused',
        detail: task.waitingReason?.trim() || 'Task is paused. Resume to continue execution.',
        actions: [
          { id: 'resume', label: 'Resume', kind: 'primary' },
          { id: 'stop', label: 'Stop', kind: 'danger' },
        ],
        decisionDriven: false,
      };

    case 'failed': {
      const lastAttempt = task.attempts?.at(-1);
      const headline = lastAttempt
        ? `Failed on attempt ${lastAttempt.attemptNumber}`
        : 'Failed';
      return {
        tone: 'red',
        icon: '✗',
        headline,
        detail: lastAttempt?.error?.trim() || 'The latest attempt did not finish successfully.',
        actions: [
          { id: 'retry', label: 'Retry', kind: 'primary' },
          { id: 'cancel', label: 'Cancel', kind: 'secondary' },
        ],
        decisionDriven: false,
      };
    }

    case 'blocked': {
      const openBlockers = (task.blockedBy || []).filter((blocker) => {
        const state = blocker.state?.toLowerCase();
        return state !== 'done' && state !== 'closed' && state !== 'completed' && state !== 'terminal';
      }).length;
      const idCount = task.blockedByTaskIds?.length || 0;
      const blockerCount = openBlockers || idCount;
      return {
        tone: 'red',
        icon: '✗',
        headline: 'Blocked',
        detail: blockerCount > 0
          ? `${formatCount(blockerCount, 'open blocker')}.`
          : 'Marked blocked. Resolve dependencies before continuing.',
        actions: [
          { id: 'unblock', label: 'Mark unblocked', kind: 'primary' },
          { id: 'cancel', label: 'Cancel', kind: 'secondary' },
        ],
        decisionDriven: false,
      };
    }

    case 'completed': {
      const lastAttempt = task.attempts?.at(-1);
      const headline = lastAttempt
        ? `Completed on attempt ${lastAttempt.attemptNumber}`
        : 'Completed';
      return {
        tone: 'green',
        icon: '✓',
        headline,
        detail: 'Acceptance evidence is ready below. Archive when satisfied.',
        actions: [
          { id: 'run-next-pass', label: 'Run next pass', kind: 'primary' },
          { id: 'archive', label: 'Archive', kind: 'secondary' },
        ],
        decisionDriven: false,
      };
    }

    case 'cancelled':
      return {
        tone: 'neutral',
        icon: '○',
        headline: 'Cancelled',
        detail: 'Task was cancelled. Archive it to hide it from active work, or reopen it to bring it back.',
        actions: [
          { id: 'archive', label: 'Archive', kind: 'primary' },
          { id: 'reopen', label: 'Reopen', kind: 'secondary' },
        ],
        decisionDriven: false,
      };

    case 'archived':
      return {
        tone: 'neutral',
        icon: '○',
        headline: 'Archived',
        detail: 'Task is archived. Reopen to surface it in the active queue again.',
        actions: [{ id: 'reopen', label: 'Reopen', kind: 'primary' }],
        decisionDriven: false,
      };

    default:
      return null;
  }
}

// ─── Task status transitions (moved from WorkbenchOutputRail) ───────────────
//
// Single source of truth so multiple components can drive the same dropdown
// without duplicating the table.

const ALLOWED_METADATA_TRANSITIONS: Partial<Record<WorkbenchTaskStatus, WorkbenchTaskStatus[]>> = {
  new: ['new', 'todo', 'running', 'cancelled', 'archived'],
  backlog: ['backlog', 'todo', 'cancelled', 'archived'],
  todo: ['todo', 'in_progress', 'running', 'cancelled', 'blocked', 'archived'],
  in_progress: ['in_progress', 'failed', 'in_review', 'waiting_for_user', 'completed', 'blocked', 'cancelled'],
  in_review: ['in_review', 'in_progress', 'running', 'cancelled', 'blocked'],
  running: ['running', 'failed', 'waiting_for_user', 'in_review', 'completed', 'blocked', 'cancelled', 'paused'],
  waiting_for_user: ['waiting_for_user', 'running', 'in_progress', 'cancelled', 'blocked'],
  blocked: ['blocked', 'todo', 'cancelled', 'archived'],
  verifying: ['verifying', 'completed', 'failed', 'cancelled'],
  completed: ['completed', 'archived', 'todo'],
  failed: ['failed', 'todo', 'in_progress', 'running', 'archived'],
  cancelled: ['cancelled', 'archived', 'todo'],
  paused: ['paused', 'running', 'in_progress', 'cancelled', 'archived'],
  archived: ['archived', 'todo'],
};

export function allowedMetadataStatuses(status: WorkbenchTaskStatus): WorkbenchTaskStatus[] {
  return ALLOWED_METADATA_TRANSITIONS[status] || [status];
}

export function canPauseTask(status: WorkbenchTaskStatus): boolean {
  return status === 'in_progress'
    || status === 'running'
    || status === 'verifying';
}

export function canResumeTask(status: WorkbenchTaskStatus): boolean {
  return status === 'paused' || status === 'waiting_for_user';
}

export function canStopTask(status: WorkbenchTaskStatus): boolean {
  return status === 'in_progress'
    || status === 'running'
    || status === 'verifying'
    || status === 'waiting_for_user'
    || status === 'in_review'
    || status === 'paused';
}

export function buildWorkbenchRuntimeControlActions(status: WorkbenchTaskStatus): WorkbenchRuntimeControlAction[] {
  const actions: WorkbenchRuntimeControlAction[] = [];

  if (canPauseTask(status)) {
    actions.push({ id: 'pause', label: 'Pause', pendingLabel: 'Pausing...' });
  }

  if (canResumeTask(status)) {
    actions.push({ id: 'resume', label: 'Resume', pendingLabel: 'Resuming...' });
  }

  if (canStopTask(status)) {
    actions.push({ id: 'stop', label: 'Stop', pendingLabel: 'Stopping...', danger: true });
  }

  return actions;
}

export function getPreferredReviewArtifactId(
  artifacts: SharedWorkbenchArtifactRecord[],
): string | null {
  const sorted = [...artifacts].sort(compareArtifactsByUpdatedAtDesc);
  const review = sorted.find((artifact) => artifact.kind === 'run_review' || artifact.tags?.includes('run-review'));
  return (review || sorted[0])?.id || null;
}

function compareArtifactsByUpdatedAtDesc(
  left: Pick<SharedWorkbenchArtifactRecord, 'updatedAt' | 'createdAt' | 'id'>,
  right: Pick<SharedWorkbenchArtifactRecord, 'updatedAt' | 'createdAt' | 'id'>,
): number {
  const byUpdatedAt = right.updatedAt.localeCompare(left.updatedAt);
  if (byUpdatedAt !== 0) return byUpdatedAt;
  const byCreatedAt = right.createdAt.localeCompare(left.createdAt);
  if (byCreatedAt !== 0) return byCreatedAt;
  return left.id.localeCompare(right.id);
}
