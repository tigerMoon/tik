/**
 * API Client
 *
 * Connects to Tik API server for tasks, events, and control.
 */
import type { AgentLoopMetadata, AgentLoopPayload, EnvironmentPackManifest, EnvironmentPackSelection, EnvironmentPackSnapshot, SkillManifestMutationInput, SkillManifestRegistryEntry, TaskWorkspaceBinding, WorkbenchArtifactRecord, WorkbenchArtifactVersion, WorkbenchTaskEvidenceSummary, WorkbenchTaskAdjustmentRecord, WorkbenchTaskAttemptRecord, WorkbenchTaskBlockerRecord, WorkbenchTaskCommentRecord, WorkbenchTaskRunRecord, WorkbenchTaskStatus } from '@tik/shared';
export type { WorkbenchArtifactRecord, WorkbenchArtifactVersion, WorkbenchTaskAttemptRecord, WorkbenchTaskRunRecord, } from '@tik/shared';
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
        workflowPolicy?: {
            profile?: string;
        };
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
    recent: Array<{
        type: string;
        shortIdentifier: string;
        message: string;
        createdAt: string;
    }>;
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
export declare function resolveApiBaseUrlForLocation(location?: ApiBaseLocation | null, explicitBaseUrl?: string | null): string;
export declare function resolveApiErrorMessage(payload: unknown, statusText: string, status: number): string;
export declare function fetchTasks(): Promise<Task[]>;
export declare function fetchTask(id: string): Promise<Task>;
export declare function submitTask(description: string, strategy?: string, mode?: 'single' | 'multi'): Promise<unknown>;
export declare function controlTask(id: string, command: unknown): Promise<void>;
export declare function controlWorkbenchTask(taskId: string, command: {
    type: 'pause' | 'resume' | 'stop';
    reason?: string;
}): Promise<WorkbenchTaskResponse>;
export declare function fetchWorkbenchTasks(): Promise<WorkbenchTaskResponse[]>;
export declare function createWorkbenchTask(title: string, goal: string, input?: CreateWorkbenchTaskInput): Promise<WorkbenchTaskResponse>;
export declare function createWorktreeReviewRound(input: CreateWorktreeReviewRoundInput): Promise<WorkbenchTaskResponse>;
export declare function updateTrackerTask(taskId: string, input: Partial<Pick<WorkbenchTaskResponse, 'title' | 'description' | 'goal' | 'status' | 'priority' | 'labels' | 'parentTaskId' | 'humanAssignee'>>): Promise<WorkbenchTaskResponse>;
export declare function transitionTrackerTask(taskId: string, to: WorkbenchTaskStatus, reason?: string): Promise<WorkbenchTaskResponse>;
export declare function addTrackerTaskComment(taskId: string, body: string): Promise<WorkbenchTaskResponse>;
export declare function setTrackerTaskLabels(taskId: string, input: {
    add?: string[];
    remove?: string[];
}): Promise<WorkbenchTaskResponse>;
export declare function setTrackerTaskDependencies(taskId: string, input: {
    add?: string[];
    remove?: string[];
}): Promise<WorkbenchTaskResponse>;
export declare function fetchTrackerState(): Promise<TrackerStateResponse>;
export declare function refreshTracker(): Promise<{
    queued: boolean;
    refreshedAt: string;
}>;
export declare function fetchWorkflowFile(): Promise<WorkflowFileResponse>;
export declare function saveWorkflowFile(content: string): Promise<WorkflowFileResponse & {
    saved: boolean;
}>;
export declare function updateWorkbenchTaskConfiguration(taskId: string, selection: UpdateWorkbenchTaskConfigurationInput): Promise<WorkbenchTaskResponse>;
export declare function updateWorkbenchTaskBrief(taskId: string, input: UpdateWorkbenchTaskBriefInput): Promise<UpdateWorkbenchTaskBriefResult>;
export declare function revertWorkbenchTaskBrief(taskId: string): Promise<WorkbenchTaskResponse>;
export declare function retryWorkbenchTask(taskId: string): Promise<WorkbenchTaskResponse>;
export declare function archiveWorkbenchTask(taskId: string): Promise<WorkbenchTaskResponse>;
export declare function fetchWorkbenchTimeline(taskId: string): Promise<WorkbenchTimelineResponseItem[]>;
export declare function fetchWorkbenchDecisions(taskId: string): Promise<WorkbenchDecisionResponse[]>;
export interface FetchWorkbenchArtifactsInput {
    taskId?: string;
    status?: string;
    kind?: string;
    tag?: string;
    workspaceId?: string;
    projectId?: string;
}
export declare function fetchWorkbenchArtifacts(input?: FetchWorkbenchArtifactsInput): Promise<WorkbenchArtifactRecord[]>;
export declare function fetchWorkbenchTaskArtifacts(taskId: string): Promise<WorkbenchArtifactRecord[]>;
export declare function fetchWorkbenchArtifact(artifactId: string): Promise<WorkbenchArtifactRecord>;
export declare function fetchWorkbenchArtifactVersions(artifactId: string): Promise<WorkbenchArtifactVersion[]>;
export declare function generateWorkbenchTaskArtifact(taskId: string, template?: string): Promise<WorkbenchArtifactRecord>;
export declare function acceptWorkbenchArtifact(artifactId: string): Promise<WorkbenchArtifactRecord>;
export declare function rejectWorkbenchArtifact(artifactId: string, reason: string): Promise<WorkbenchArtifactRecord>;
export declare function archiveWorkbenchArtifact(artifactId: string): Promise<WorkbenchArtifactRecord>;
export declare function resolveWorkbenchDecision(taskId: string, decisionId: string, body: ResolveWorkbenchDecisionInput): Promise<{
    task: WorkbenchTaskResponse;
    decision: WorkbenchDecisionResponse;
}>;
export declare function buildWorkbenchArtifactPreviewUrl(filePath: string): string;
export declare function buildWorkbenchArtifactVersionPreviewUrl(artifactId: string, versionId: string): string;
export declare function buildWorkbenchArtifactLinkPreviewUrl(input: {
    artifactId?: string;
    versionId?: string;
    filePath?: string;
}): string | null;
export declare function fetchEnvironmentPacks(): Promise<EnvironmentPacksResponse>;
export declare function fetchEnvironmentPackDashboard(): Promise<EnvironmentPackDashboardResponse>;
export declare function switchEnvironmentPack(packId: string): Promise<EnvironmentPackManifest>;
export declare function fetchSkillManifestRegistry(): Promise<SkillManifestRegistryResponse>;
export declare function saveSkillManifestDraft(skillId: string, input: SkillManifestMutationInput): Promise<SkillManifestRegistryEntry>;
export declare function publishSkillManifest(skillId: string, input: SkillManifestMutationInput): Promise<SkillManifestRegistryEntry>;
export declare function subscribeToEvents(taskId: string, handlers: EventSubscriptionHandlers): () => void;
export declare function subscribeToWorkbenchEvents(handlers: EventSubscriptionHandlers): () => void;
export declare function fetchWorkspaceStatus(rootPath?: string): Promise<WorkspaceStatusResponse>;
export declare function fetchWorkspaceReport(rootPath?: string): Promise<unknown>;
export declare function fetchWorkspaceBoard(rootPath?: string): Promise<unknown>;
export declare function fetchWorkspaceDecisions(rootPath?: string): Promise<WorkspaceDecisionsResponse>;
export declare function fetchWorkspaceWorktrees(rootPath?: string): Promise<WorkspaceWorktreesResponse>;
export declare function createWorkspaceWorktree(body: {
    projectName: string;
    sourceProjectPath?: string;
    laneId?: string;
    force?: boolean;
}, rootPath?: string): Promise<WorkspaceStatusResponse>;
export declare function useWorkspaceWorktree(body: {
    projectName: string;
    sourceProjectPath?: string;
    laneId?: string;
    force?: boolean;
}, rootPath?: string): Promise<WorkspaceStatusResponse>;
export declare function removeWorkspaceWorktree(body: {
    projectName: string;
    sourceProjectPath?: string;
    laneId?: string;
    force?: boolean;
}, rootPath?: string): Promise<WorkspaceStatusResponse>;
export declare function resolveWorkspaceDecision(decisionId: string, body: {
    optionId?: string;
    message?: string;
}, rootPath?: string): Promise<{
    apiVersion: string;
    schemaVersion: number;
    decision: WorkspaceDecision | null;
    state: WorkspaceStatusResponse['state'];
}>;
//# sourceMappingURL=client.d.ts.map