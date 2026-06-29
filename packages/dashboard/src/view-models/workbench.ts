import { extractModifiedFilesFromEvidenceBody, isWorkbenchTerminalStatus } from '@tik/shared';
import type {
  AgentLoopMetadata,
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

export function resolveWorkbenchTaskProgressColumn(status: WorkbenchTaskStatus): WorkbenchProgressColumnId {
  switch (status) {
    case 'new':
    case 'backlog':
    case 'paused':
    case 'retry':
      return 'backlog';
    case 'todo':
    case 'blocked':
    case 'failed':
    case 'cancelled':
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
    byColumnId.get(resolveWorkbenchTaskProgressColumn(task.status))?.tasks.push(task);
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
      return sortWorkbenchTasks(tasks.filter((task) => task.status !== 'archived' && Boolean(task.agentLoop)));
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
  | { id: 'cancel'; label: string; kind: TaskStatusBannerActionKind }
  | { id: 'resume'; label: string; kind: TaskStatusBannerActionKind }
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
      return {
        tone: 'yellow',
        icon: '⚠',
        headline: 'In review',
        detail: task.waitingReason?.trim() || 'Awaiting human review before the task can move forward.',
        actions: [
          { id: 'resume', label: 'Resume', kind: 'primary' },
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
        detail: 'Task was cancelled. Reopen to bring it back into the queue.',
        actions: [{ id: 'reopen', label: 'Reopen', kind: 'primary' }],
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
  return status === 'paused' || status === 'in_review' || status === 'waiting_for_user';
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
