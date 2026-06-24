/**
 * API Client
 *
 * Connects to Tik API server for tasks, events, and control.
 */

import type {
  AgentLoopMetadata,
  AgentLoopPayload,
  EnvironmentPackManifest,
  EnvironmentPackSelection,
  EnvironmentPackSnapshot,
  SkillManifestMutationInput,
  SkillManifestRegistryEntry,
  TaskWorkspaceBinding,
  WorkbenchArtifactRecord,
  WorkbenchArtifactVersion,
  WorkbenchTaskEvidenceSummary,
  WorkbenchTaskAdjustmentRecord,
  WorkbenchTaskAttemptRecord,
  WorkbenchTaskBlockerRecord,
  WorkbenchTaskCommentRecord,
  WorkbenchTaskRunRecord,
  WorkbenchTaskStatus,
} from '@tik/shared';

export type {
  WorkbenchArtifactRecord,
  WorkbenchArtifactVersion,
  WorkbenchTaskAttemptRecord,
  WorkbenchTaskRunRecord,
} from '@tik/shared';

export interface AgentEvent {
  id: string;
  type: string;
  taskId: string;
  payload: unknown;
  timestamp: number;
}

export interface Task {
  id: string;
  description: string;
  status: string;
  iterations: unknown[];
  maxIterations: number;
  strategy: string;
}

export interface WorkspaceMemorySnapshot {
  session: {
    rootPath: string;
    demand?: string;
    currentPhase?: string;
    workflowProfile?: string;
    completedProjects: string[];
    blockedProjects: string[];
    failedProjects: string[];
    recentEvents: string[];
    nextAction?: string;
    updatedAt: string;
  };
  projects: Array<{
    projectName: string;
    projectPath: string;
    phase?: string;
    status?: string;
    workflowRole?: string;
    workflowContract?: string;
    workflowSkillName?: string;
    executionMode?: 'native' | 'fallback';
    knownArtifacts: string[];
    recentEvents: string[];
    summary?: string;
    blockerKind?: string;
    recommendedCommand?: string;
    updatedAt: string;
  }>;
}

export interface WorkspaceStatusResponse {
  apiVersion: string;
  schemaVersion: number;
  rootPath: string;
  settings: {
    workspaceName: string;
    workspaceRoot?: string;
    workspaceFile?: string;
    projects?: Array<{
      name: string;
      path: string;
    }>;
    workflowPolicy?: { profile?: string };
  } | null;
  state: {
    currentPhase?: string;
    demand?: string;
  } | null;
  projection: {
    totalEvents: number;
    recentDisplay?: Array<{
      phase: string;
      kind: string;
      projectName?: string;
      message: string;
      count: number;
      firstTimestamp: string;
      lastTimestamp: string;
    }>;
  };
  memory: WorkspaceMemorySnapshot;
  worktrees: WorkspaceWorktreesResponse['worktrees'];
}

export interface WorkspaceManagedWorktree {
  projectName: string;
  sourceProjectPath: string;
  effectiveProjectPath: string;
  laneId?: string;
  active: boolean;
  kind: 'git-worktree' | 'source' | 'copy';
  dirtyFileCount?: number;
  dirtyFiles?: string[];
  warnings: string[];
  safeToActivate: boolean;
  safeToRemove: boolean;
  projectPhase?: string;
  projectStatus?: string;
  worktree?: {
    enabled: boolean;
    status: string;
    kind?: 'git-worktree' | 'source' | 'copy';
    laneId?: string;
    sourceBranch?: string;
    worktreeBranch?: string;
    worktreePath?: string;
    createdAt?: string;
    updatedAt: string;
    retainedAfterCompletion?: boolean;
    lastError?: string;
  };
}

export interface WorkspaceWorktreesResponse {
  apiVersion: string;
  schemaVersion: number;
  worktrees: {
    mode: string;
    root: string;
    nonGitStrategy: 'block' | 'source' | 'copy';
    entries: WorkspaceManagedWorktree[];
  };
}

export interface WorkspaceDecisionOption {
  id: string;
  label: string;
  description?: string;
  recommended?: boolean;
  nextPhase?: string;
  artifactPath?: string;
  artifactField?: 'specPath' | 'planPath';
}

export interface WorkspaceDecision {
  id: string;
  status: 'pending' | 'resolved' | 'dismissed';
  kind: 'clarification' | 'approach_choice' | 'phase_reroute' | 'approval';
  phase: 'PARALLEL_SPECIFY' | 'PARALLEL_PLAN' | 'PARALLEL_ACE';
  projectName?: string;
  title: string;
  prompt: string;
  options?: WorkspaceDecisionOption[];
  recommendedOptionId?: string;
  allowFreeform?: boolean;
  confidence?: 'low' | 'medium' | 'high';
  rationale?: string;
  signals?: string[];
  sourceSummary?: string;
  createdAt: string;
  updatedAt: string;
}

export interface WorkspaceDecisionsResponse {
  apiVersion: string;
  schemaVersion: number;
  decisions: WorkspaceDecision[];
  pending: WorkspaceDecision[];
}

export interface WorkbenchTaskResponse {
  id: string;
  identifier?: string;
  shortIdentifier?: string;
  title: string;
  description?: string | null;
  goal: string;
  status: WorkbenchTaskStatus;
  state?: string;
  priority?: number | null;
  labels?: string[];
  blockedBy?: WorkbenchTaskBlockerRecord[];
  blockedByTaskIds?: string[];
  parentTaskId?: string | null;
  assignee?: string | null;
  humanAssignee?: string | null;
  createdBy?: string | null;
  sourceUrl?: string | null;
  comments?: WorkbenchTaskCommentRecord[];
  attempts?: WorkbenchTaskAttemptRecord[];
  createdAt: string;
  updatedAt: string;
  activeSessionId?: string;
  currentOwner?: string;
  latestSummary?: string;
  waitingReason?: string;
  waitingDecisionId?: string;
  lastProgressAt?: string;
  environmentPackSnapshot?: EnvironmentPackSnapshot;
  environmentPackSelection?: EnvironmentPackSelection;
  workspaceBinding?: TaskWorkspaceBinding;
  agentLoop?: AgentLoopMetadata;
  lastAdjustment?: WorkbenchTaskAdjustmentRecord;
  evidenceSummary?: WorkbenchTaskEvidenceSummary;
  runs?: WorkbenchTaskRunRecord[];
}

export interface WorkbenchTimelineResponseItem {
  id: string;
  kind: 'summary' | 'decision' | 'raw';
  actor: 'supervisor' | 'researcher' | 'coder' | 'reviewer' | 'user' | 'system';
  body: string;
  createdAt: string;
  evidenceIds?: string[];
  decisionId?: string;
}

export interface WorkbenchDecisionOption {
  id: string;
  label: string;
  description?: string;
  recommended?: boolean;
}

export interface WorkbenchDecisionResponse {
  id: string;
  taskId: string;
  title: string;
  summary: string;
  risk: 'low' | 'medium' | 'high';
  status: 'pending' | 'resolved' | 'dismissed';
  recommendedOptionId?: string;
  options: WorkbenchDecisionOption[];
  createdAt: string;
  updatedAt: string;
}

export interface ResolveWorkbenchDecisionInput {
  optionId?: string;
  message?: string;
}

export interface EventSubscriptionHandlers {
  onEvent: (event: AgentEvent) => void;
  onOpen?: () => void;
  onError?: () => void;
}

export interface EnvironmentPacksResponse {
  packs: EnvironmentPackManifest[];
  activePackId: string | null;
}

export interface EnvironmentPromotionQueueItem {
  id: string;
  kind: string;
  detail: string;
}

export interface EnvironmentPackTaskPreview {
  id: string;
  title: string;
  status: WorkbenchTaskStatus;
  updatedAt: string;
}

export interface EnvironmentPackDashboardSummary {
  packId: string;
  manifestPath: string;
  status: 'active' | 'ready';
  boundTaskCount: number;
  activeTaskCount: number;
  waitingTaskCount: number;
  latestBoundTasks: EnvironmentPackTaskPreview[];
  mountedNamespaces: string[];
  promotionQueue: EnvironmentPromotionQueueItem[];
}

export interface EnvironmentPackDashboardResponse {
  packs: EnvironmentPackManifest[];
  activePackId: string | null;
  generatedAt: string;
  summaries: EnvironmentPackDashboardSummary[];
}

export interface SkillManifestRegistryResponse {
  skills: SkillManifestRegistryEntry[];
  generatedAt: string;
}

export interface UpdateWorkbenchTaskBriefInput {
  title?: string;
  goal?: string;
  adjustment?: string;
  launchFollowUp?: boolean;
}

export interface UpdateWorkbenchTaskBriefResult {
  task: WorkbenchTaskResponse;
  followUpTask?: WorkbenchTaskResponse;
}

export interface CreateWorkbenchTaskInput extends Partial<EnvironmentPackSelection> {
  environmentPackId?: string;
  status?: WorkbenchTaskStatus;
  priority?: number | null;
  labels?: string[];
  parentTaskId?: string | null;
  humanAssignee?: string | null;
  workspaceBinding?: TaskWorkspaceBinding;
}

export interface CreateWorktreeReviewRoundInput {
  rootTaskId?: string;
  round?: number;
  maxRounds?: number;
  repo?: string;
  title?: string;
  baseRef?: string;
  headRef?: string;
  headSha?: string;
  idempotencyKey?: string;
  workspaceBinding?: TaskWorkspaceBinding;
  allowedScope?: string[];
  acceptanceCriteria?: string[];
  reviewFocus?: string[];
  createdBy?: AgentLoopPayload['createdBy'];
}

export interface TrackerStateResponse {
  watching: boolean;
  retries: Record<string, {
    taskId: string;
    shortIdentifier: string;
    attempt: number;
    dueAtMs: number;
    lastError: string;
    updatedAt: string;
  }>;
  summary?: {
    activeCandidates: number;
    activeRuns: number;
    maintenance?: number;
    staleRunning: number;
  };
  listeners?: Array<{
    id: string;
    label: string;
    status: 'running' | 'stopped' | 'expected' | 'unknown';
    detail: string;
    pid?: number;
    port?: number;
    session?: string;
  }>;
  recent: Array<{ type: string; shortIdentifier: string; message: string; createdAt: string }>;
}

export interface WorkflowFileResponse {
  path: string;
  exists: boolean;
  content: string;
}

export interface UpdateWorkbenchTaskConfigurationInput extends EnvironmentPackSelection {
  environmentPackId?: string;
}

interface ApiBaseLocation {
  protocol: string;
  hostname: string;
  port: string;
  origin: string;
}

const LOCAL_API_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1']);

function normalizeApiBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '');
}

export function resolveApiBaseUrlForLocation(
  location?: ApiBaseLocation | null,
  explicitBaseUrl?: string | null,
): string {
  const normalizedExplicitBaseUrl = explicitBaseUrl?.trim();
  if (normalizedExplicitBaseUrl) {
    return normalizeApiBaseUrl(normalizedExplicitBaseUrl);
  }

  if (!location) {
    return '/api';
  }

  if (location.port === '3300') {
    return '/api';
  }

  if (LOCAL_API_HOSTNAMES.has(location.hostname)) {
    return `${location.protocol}//${location.hostname}:3300/api`;
  }

  return `${location.origin}/api`;
}

function resolveApiBaseUrl(): string {
  const explicitBaseUrl = typeof import.meta !== 'undefined'
    ? (import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env?.VITE_API_BASE_URL
    : undefined;
  return typeof window === 'undefined'
    ? resolveApiBaseUrlForLocation(null, explicitBaseUrl)
    : resolveApiBaseUrlForLocation(window.location, explicitBaseUrl);
}

const BASE_URL = resolveApiBaseUrl();

async function readJsonOrThrow<T>(res: Response): Promise<T> {
  const payload = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(resolveApiErrorMessage(payload, res.statusText, res.status));
  }
  return payload as T;
}

export function resolveApiErrorMessage(payload: unknown, statusText: string, status: number): string {
  if (payload && typeof payload === 'object') {
    const record = payload as { error?: unknown; message?: unknown };
    if (record.error && typeof record.error === 'object') {
      const error = record.error as { message?: unknown; code?: unknown };
      if (typeof error.message === 'string' && error.message.trim()) {
        return error.message;
      }
      if (typeof error.code === 'string' && error.code.trim()) {
        return error.code;
      }
    }
    if (typeof record.message === 'string' && record.message.trim()) {
      return record.message;
    }
    if (typeof record.error === 'string' && record.error.trim()) {
      return record.error;
    }
  }

  return statusText || `Request failed: ${status}`;
}

export async function fetchTasks(): Promise<Task[]> {
  const res = await fetch(`${BASE_URL}/tasks`);
  return readJsonOrThrow<Task[]>(res);
}

export async function fetchTask(id: string): Promise<Task> {
  const res = await fetch(`${BASE_URL}/tasks/${id}`);
  return readJsonOrThrow<Task>(res);
}

export async function submitTask(
  description: string,
  strategy = 'incremental',
  mode: 'single' | 'multi' = 'single',
): Promise<unknown> {
  const res = await fetch(`${BASE_URL}/tasks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ description, strategy, mode }),
  });
  return readJsonOrThrow(res);
}

export async function controlTask(id: string, command: unknown): Promise<void> {
  const res = await fetch(`${BASE_URL}/tasks/${id}/control`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(command),
  });
  await readJsonOrThrow(res);
}

export async function fetchWorkbenchTasks(): Promise<WorkbenchTaskResponse[]> {
  const res = await fetch(`${BASE_URL}/v1/tasks`);
  return (await readJsonOrThrow<{ tasks: WorkbenchTaskResponse[] }>(res)).tasks;
}

export async function createWorkbenchTask(
  title: string,
  goal: string,
  input?: CreateWorkbenchTaskInput,
): Promise<WorkbenchTaskResponse> {
  const res = await fetch(`${BASE_URL}/v1/tasks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title, goal, ...input }),
  });
  return (await readJsonOrThrow<{ task: WorkbenchTaskResponse }>(res)).task;
}

export async function createWorktreeReviewRound(
  input: CreateWorktreeReviewRoundInput,
): Promise<WorkbenchTaskResponse> {
  const res = await fetch(`${BASE_URL}/v1/agent-loop/worktree-review-rounds`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  return (await readJsonOrThrow<{ task: WorkbenchTaskResponse }>(res)).task;
}

export async function updateTrackerTask(
  taskId: string,
  input: Partial<Pick<WorkbenchTaskResponse, 'title' | 'description' | 'goal' | 'status' | 'priority' | 'labels' | 'parentTaskId' | 'humanAssignee'>>,
): Promise<WorkbenchTaskResponse> {
  const res = await fetch(`${BASE_URL}/v1/tasks/${encodeURIComponent(taskId)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  return (await readJsonOrThrow<{ task: WorkbenchTaskResponse }>(res)).task;
}

export async function transitionTrackerTask(
  taskId: string,
  to: WorkbenchTaskStatus,
  reason?: string,
): Promise<WorkbenchTaskResponse> {
  const res = await fetch(`${BASE_URL}/v1/tasks/${encodeURIComponent(taskId)}/transitions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ to, reason }),
  });
  return (await readJsonOrThrow<{ task: WorkbenchTaskResponse }>(res)).task;
}

export async function addTrackerTaskComment(
  taskId: string,
  body: string,
): Promise<WorkbenchTaskResponse> {
  const res = await fetch(`${BASE_URL}/v1/tasks/${encodeURIComponent(taskId)}/comments`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ body }),
  });
  return (await readJsonOrThrow<{ task: WorkbenchTaskResponse }>(res)).task;
}

export async function setTrackerTaskLabels(
  taskId: string,
  input: { add?: string[]; remove?: string[] },
): Promise<WorkbenchTaskResponse> {
  const res = await fetch(`${BASE_URL}/v1/tasks/${encodeURIComponent(taskId)}/labels`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  return (await readJsonOrThrow<{ task: WorkbenchTaskResponse }>(res)).task;
}

export async function setTrackerTaskDependencies(
  taskId: string,
  input: { add?: string[]; remove?: string[] },
): Promise<WorkbenchTaskResponse> {
  const res = await fetch(`${BASE_URL}/v1/tasks/${encodeURIComponent(taskId)}/dependencies`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  return (await readJsonOrThrow<{ task: WorkbenchTaskResponse }>(res)).task;
}

export async function fetchTrackerState(): Promise<TrackerStateResponse> {
  const res = await fetch(`${BASE_URL}/v1/tracker/state`);
  return readJsonOrThrow<TrackerStateResponse>(res);
}

export async function refreshTracker(): Promise<{ queued: boolean; refreshedAt: string }> {
  const res = await fetch(`${BASE_URL}/v1/tracker/refresh`, { method: 'POST' });
  return readJsonOrThrow(res);
}

export async function fetchWorkflowFile(): Promise<WorkflowFileResponse> {
  const res = await fetch(`${BASE_URL}/v1/workflow`);
  return readJsonOrThrow<WorkflowFileResponse>(res);
}

export async function saveWorkflowFile(content: string): Promise<WorkflowFileResponse & { saved: boolean }> {
  const res = await fetch(`${BASE_URL}/v1/workflow`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content }),
  });
  return readJsonOrThrow<WorkflowFileResponse & { saved: boolean }>(res);
}

export async function updateWorkbenchTaskConfiguration(
  taskId: string,
  selection: UpdateWorkbenchTaskConfigurationInput,
): Promise<WorkbenchTaskResponse> {
  const res = await fetch(`${BASE_URL}/workbench/tasks/${encodeURIComponent(taskId)}/configuration`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(selection),
  });
  return (await readJsonOrThrow<{ task: WorkbenchTaskResponse }>(res)).task;
}

export async function updateWorkbenchTaskBrief(
  taskId: string,
  input: UpdateWorkbenchTaskBriefInput,
): Promise<UpdateWorkbenchTaskBriefResult> {
  const res = await fetch(`${BASE_URL}/workbench/tasks/${encodeURIComponent(taskId)}/brief`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  return readJsonOrThrow<UpdateWorkbenchTaskBriefResult>(res);
}

export async function revertWorkbenchTaskBrief(taskId: string): Promise<WorkbenchTaskResponse> {
  const res = await fetch(`${BASE_URL}/workbench/tasks/${encodeURIComponent(taskId)}/brief/revert`, {
    method: 'POST',
  });
  return (await readJsonOrThrow<{ task: WorkbenchTaskResponse }>(res)).task;
}

export async function retryWorkbenchTask(taskId: string): Promise<WorkbenchTaskResponse> {
  const res = await fetch(`${BASE_URL}/workbench/tasks/${encodeURIComponent(taskId)}/retry`, {
    method: 'POST',
  });
  return (await readJsonOrThrow<{ task: WorkbenchTaskResponse }>(res)).task;
}

export async function archiveWorkbenchTask(taskId: string): Promise<WorkbenchTaskResponse> {
  const res = await fetch(`${BASE_URL}/workbench/tasks/${encodeURIComponent(taskId)}/archive`, {
    method: 'POST',
  });
  return (await readJsonOrThrow<{ task: WorkbenchTaskResponse }>(res)).task;
}

export async function fetchWorkbenchTimeline(taskId: string): Promise<WorkbenchTimelineResponseItem[]> {
  const res = await fetch(`${BASE_URL}/workbench/tasks/${encodeURIComponent(taskId)}/timeline`);
  return (await readJsonOrThrow<{ timeline: WorkbenchTimelineResponseItem[] }>(res)).timeline;
}

export async function fetchWorkbenchDecisions(taskId: string): Promise<WorkbenchDecisionResponse[]> {
  const res = await fetch(`${BASE_URL}/workbench/tasks/${encodeURIComponent(taskId)}/decisions`);
  return (await readJsonOrThrow<{ decisions: WorkbenchDecisionResponse[] }>(res)).decisions;
}

export interface FetchWorkbenchArtifactsInput {
  taskId?: string;
  status?: string;
  kind?: string;
  tag?: string;
  workspaceId?: string;
  projectId?: string;
}

export async function fetchWorkbenchArtifacts(input: FetchWorkbenchArtifactsInput = {}): Promise<WorkbenchArtifactRecord[]> {
  const query = new URLSearchParams();
  Object.entries(input).forEach(([key, value]) => {
    if (value) {
      query.set(key, value);
    }
  });
  const res = await fetch(`${BASE_URL}/workbench/artifacts${query.size ? `?${query}` : ''}`);
  return (await readJsonOrThrow<{ artifacts: WorkbenchArtifactRecord[] }>(res)).artifacts;
}

export async function fetchWorkbenchTaskArtifacts(taskId: string): Promise<WorkbenchArtifactRecord[]> {
  const res = await fetch(`${BASE_URL}/workbench/tasks/${encodeURIComponent(taskId)}/artifacts`);
  return (await readJsonOrThrow<{ artifacts: WorkbenchArtifactRecord[] }>(res)).artifacts;
}

export async function fetchWorkbenchArtifact(artifactId: string): Promise<WorkbenchArtifactRecord> {
  const res = await fetch(`${BASE_URL}/workbench/artifacts/${encodeURIComponent(artifactId)}`);
  return (await readJsonOrThrow<{ artifact: WorkbenchArtifactRecord }>(res)).artifact;
}

export async function fetchWorkbenchArtifactVersions(artifactId: string): Promise<WorkbenchArtifactVersion[]> {
  const res = await fetch(`${BASE_URL}/workbench/artifacts/${encodeURIComponent(artifactId)}/versions`);
  return (await readJsonOrThrow<{ versions: WorkbenchArtifactVersion[] }>(res)).versions;
}

export async function generateWorkbenchTaskArtifact(taskId: string, template = 'task-review'): Promise<WorkbenchArtifactRecord> {
  const res = await fetch(`${BASE_URL}/workbench/tasks/${encodeURIComponent(taskId)}/artifacts/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ template }),
  });
  return (await readJsonOrThrow<{ artifact: WorkbenchArtifactRecord }>(res)).artifact;
}

export async function acceptWorkbenchArtifact(artifactId: string): Promise<WorkbenchArtifactRecord> {
  const res = await fetch(`${BASE_URL}/workbench/artifacts/${encodeURIComponent(artifactId)}/accept`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ actor: 'dashboard' }),
  });
  return (await readJsonOrThrow<{ artifact: WorkbenchArtifactRecord }>(res)).artifact;
}

export async function rejectWorkbenchArtifact(artifactId: string, reason: string): Promise<WorkbenchArtifactRecord> {
  const res = await fetch(`${BASE_URL}/workbench/artifacts/${encodeURIComponent(artifactId)}/reject`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ actor: 'dashboard', reason }),
  });
  return (await readJsonOrThrow<{ artifact: WorkbenchArtifactRecord }>(res)).artifact;
}

export async function archiveWorkbenchArtifact(artifactId: string): Promise<WorkbenchArtifactRecord> {
  const res = await fetch(`${BASE_URL}/workbench/artifacts/${encodeURIComponent(artifactId)}/archive`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ actor: 'dashboard' }),
  });
  return (await readJsonOrThrow<{ artifact: WorkbenchArtifactRecord }>(res)).artifact;
}

export async function resolveWorkbenchDecision(
  taskId: string,
  decisionId: string,
  body: ResolveWorkbenchDecisionInput,
): Promise<{ task: WorkbenchTaskResponse; decision: WorkbenchDecisionResponse }> {
  const res = await fetch(
    `${BASE_URL}/workbench/tasks/${encodeURIComponent(taskId)}/decisions/${encodeURIComponent(decisionId)}/resolve`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
  );
  return readJsonOrThrow(res);
}

export function buildWorkbenchArtifactPreviewUrl(filePath: string): string {
  return `${BASE_URL}/workbench/artifacts/preview?path=${encodeURIComponent(filePath)}`;
}

export function buildWorkbenchArtifactVersionPreviewUrl(artifactId: string, versionId: string): string {
  return `${BASE_URL}/workbench/artifacts/${encodeURIComponent(artifactId)}/versions/${encodeURIComponent(versionId)}/preview`;
}

export function buildWorkbenchArtifactLinkPreviewUrl(input: {
  artifactId?: string;
  versionId?: string;
  filePath?: string;
}): string | null {
  if (input.artifactId && input.versionId) {
    return buildWorkbenchArtifactVersionPreviewUrl(input.artifactId, input.versionId);
  }
  return input.filePath ? buildWorkbenchArtifactPreviewUrl(input.filePath) : null;
}

export async function fetchEnvironmentPacks(): Promise<EnvironmentPacksResponse> {
  const res = await fetch(`${BASE_URL}/environment-packs`);
  return readJsonOrThrow<EnvironmentPacksResponse>(res);
}

export async function fetchEnvironmentPackDashboard(): Promise<EnvironmentPackDashboardResponse> {
  const res = await fetch(`${BASE_URL}/environment-packs/dashboard`);
  return readJsonOrThrow<EnvironmentPackDashboardResponse>(res);
}

export async function switchEnvironmentPack(packId: string): Promise<EnvironmentPackManifest> {
  const res = await fetch(`${BASE_URL}/environment-packs/active`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ packId }),
  });
  return (await readJsonOrThrow<{ activePack: EnvironmentPackManifest }>(res)).activePack;
}

export async function fetchSkillManifestRegistry(): Promise<SkillManifestRegistryResponse> {
  const res = await fetch(`${BASE_URL}/skills/registry`);
  return readJsonOrThrow<SkillManifestRegistryResponse>(res);
}

export async function saveSkillManifestDraft(
  skillId: string,
  input: SkillManifestMutationInput,
): Promise<SkillManifestRegistryEntry> {
  const res = await fetch(`${BASE_URL}/skills/${encodeURIComponent(skillId)}/draft`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  return (await readJsonOrThrow<{ skill: SkillManifestRegistryEntry }>(res)).skill;
}

export async function publishSkillManifest(
  skillId: string,
  input: SkillManifestMutationInput,
): Promise<SkillManifestRegistryEntry> {
  const res = await fetch(`${BASE_URL}/skills/${encodeURIComponent(skillId)}/publish`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  return (await readJsonOrThrow<{ skill: SkillManifestRegistryEntry }>(res)).skill;
}

export function subscribeToEvents(taskId: string, handlers: EventSubscriptionHandlers): () => void {
  const es = new EventSource(`${BASE_URL}/tasks/${taskId}/events`);

  es.onopen = () => {
    handlers.onOpen?.();
  };

  es.onmessage = (msg) => {
    try {
      const event = JSON.parse(msg.data) as AgentEvent;
      handlers.onEvent(event);
    } catch { /* skip */ }
  };

  es.onerror = () => {
    handlers.onError?.();
  };

  return () => es.close();
}

export function subscribeToWorkbenchEvents(handlers: EventSubscriptionHandlers): () => void {
  const es = new EventSource(`${BASE_URL}/workbench/events`);

  es.onopen = () => {
    handlers.onOpen?.();
  };

  es.onmessage = (msg) => {
    try {
      const event = JSON.parse(msg.data) as AgentEvent;
      handlers.onEvent(event);
    } catch { /* skip */ }
  };

  es.onerror = () => {
    handlers.onError?.();
  };

  return () => es.close();
}

export async function fetchWorkspaceStatus(rootPath?: string): Promise<WorkspaceStatusResponse> {
  const search = rootPath ? `?rootPath=${encodeURIComponent(rootPath)}` : '';
  const res = await fetch(`${BASE_URL}/workspace/status${search}`);
  return readJsonOrThrow<WorkspaceStatusResponse>(res);
}

export async function fetchWorkspaceReport(rootPath?: string): Promise<unknown> {
  const search = rootPath ? `?rootPath=${encodeURIComponent(rootPath)}` : '';
  const res = await fetch(`${BASE_URL}/workspace/report${search}`);
  return readJsonOrThrow(res);
}

export async function fetchWorkspaceBoard(rootPath?: string): Promise<unknown> {
  const search = rootPath ? `?rootPath=${encodeURIComponent(rootPath)}` : '';
  const res = await fetch(`${BASE_URL}/workspace/board${search}`);
  return readJsonOrThrow(res);
}

export async function fetchWorkspaceDecisions(rootPath?: string): Promise<WorkspaceDecisionsResponse> {
  const search = rootPath ? `?rootPath=${encodeURIComponent(rootPath)}` : '';
  const res = await fetch(`${BASE_URL}/workspace/decisions${search}`);
  return readJsonOrThrow<WorkspaceDecisionsResponse>(res);
}

export async function fetchWorkspaceWorktrees(rootPath?: string): Promise<WorkspaceWorktreesResponse> {
  const search = rootPath ? `?rootPath=${encodeURIComponent(rootPath)}` : '';
  const res = await fetch(`${BASE_URL}/workspace/worktrees${search}`);
  return readJsonOrThrow<WorkspaceWorktreesResponse>(res);
}

export async function createWorkspaceWorktree(
  body: { projectName: string; sourceProjectPath?: string; laneId?: string; force?: boolean },
  rootPath?: string,
): Promise<WorkspaceStatusResponse> {
  const search = rootPath ? `?rootPath=${encodeURIComponent(rootPath)}` : '';
  const res = await fetch(`${BASE_URL}/workspace/worktrees/create${search}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return readJsonOrThrow<WorkspaceStatusResponse>(res);
}

export async function useWorkspaceWorktree(
  body: { projectName: string; sourceProjectPath?: string; laneId?: string; force?: boolean },
  rootPath?: string,
): Promise<WorkspaceStatusResponse> {
  const search = rootPath ? `?rootPath=${encodeURIComponent(rootPath)}` : '';
  const res = await fetch(`${BASE_URL}/workspace/worktrees/use${search}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return readJsonOrThrow<WorkspaceStatusResponse>(res);
}

export async function removeWorkspaceWorktree(
  body: { projectName: string; sourceProjectPath?: string; laneId?: string; force?: boolean },
  rootPath?: string,
): Promise<WorkspaceStatusResponse> {
  const search = rootPath ? `?rootPath=${encodeURIComponent(rootPath)}` : '';
  const res = await fetch(`${BASE_URL}/workspace/worktrees/remove${search}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return readJsonOrThrow<WorkspaceStatusResponse>(res);
}

export async function resolveWorkspaceDecision(
  decisionId: string,
  body: { optionId?: string; message?: string },
  rootPath?: string,
): Promise<{ apiVersion: string; schemaVersion: number; decision: WorkspaceDecision | null; state: WorkspaceStatusResponse['state'] }> {
  const search = rootPath ? `?rootPath=${encodeURIComponent(rootPath)}` : '';
  const res = await fetch(`${BASE_URL}/workspace/decisions/${encodeURIComponent(decisionId)}/resolve${search}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return readJsonOrThrow(res);
}
