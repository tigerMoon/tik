/**
 * API Client
 *
 * Connects to Tik API server for tasks, events, and control.
 */

import type {
  EnvironmentPackManifest,
  EnvironmentPackSelection,
  EnvironmentPackSnapshot,
  SkillManifestMutationInput,
  SkillManifestRegistryEntry,
  TaskWorkspaceBinding,
  WorkbenchTaskEvidenceSummary,
  WorkbenchTaskAdjustmentRecord,
  WorkbenchTaskStatus,
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
  title: string;
  goal: string;
  status: WorkbenchTaskStatus;
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
  lastAdjustment?: WorkbenchTaskAdjustmentRecord;
  evidenceSummary?: WorkbenchTaskEvidenceSummary;
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
  workspaceBinding?: TaskWorkspaceBinding;
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
    const message = payload && typeof payload === 'object' && 'error' in payload
      ? String((payload as { error?: unknown }).error || res.statusText || `Request failed: ${res.status}`)
      : res.statusText || `Request failed: ${res.status}`;
    throw new Error(message);
  }
  return payload as T;
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
  const res = await fetch(`${BASE_URL}/workbench/tasks`);
  return (await readJsonOrThrow<{ tasks: WorkbenchTaskResponse[] }>(res)).tasks;
}

export async function createWorkbenchTask(
  title: string,
  goal: string,
  input?: CreateWorkbenchTaskInput,
): Promise<WorkbenchTaskResponse> {
  const res = await fetch(`${BASE_URL}/workbench/tasks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title, goal, ...input }),
  });
  return (await readJsonOrThrow<{ task: WorkbenchTaskResponse }>(res)).task;
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
