import type { AgentLoopMetadata, WorkbenchArtifactRecord as SharedWorkbenchArtifactRecord, TaskWorkspaceBinding, WorkbenchTaskAdjustmentRecord, WorkbenchTaskCommentRecord, WorkbenchTaskEvidenceSummary, WorkbenchTaskStatus } from '@tik/shared';
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
export declare const DASHBOARD_AGENT_LOOP_APPROVE_COMMENT = "/approve\nApproved from the Dashboard human review banner.";
export declare function isAgentLoopHumanReviewReady(task: Pick<WorkbenchTaskSummary, 'status' | 'agentLoop'>): boolean;
export declare function canArchiveWorkbenchTaskFromBanner(task: Pick<WorkbenchTaskSummary, 'status' | 'agentLoop'>): boolean;
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
export declare function shouldLaunchWorkbenchFollowUp(status: WorkbenchTaskStatus): boolean;
export declare function buildWorkbenchSteeringUpdateInput<T extends {
    title: string;
    goal: string;
    status: WorkbenchTaskStatus;
}>(task: T, overrides?: {
    title?: string;
    goal?: string;
    adjustment?: string;
}): WorkbenchSteeringUpdateInput;
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
    changes: Array<{
        label: string;
        detail: string;
    }>;
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
type SearchableWorkbenchTaskFields = Partial<Pick<WorkbenchTaskSummary, 'latestSummary' | 'agentLoop'>> & {
    goal?: string;
    currentOwner?: string;
    waitingReason?: string;
    workspaceBinding?: TaskWorkspaceBinding;
    lastAdjustment?: WorkbenchTaskAdjustmentRecord;
};
type AdjustableWorkbenchTask = WorkbenchTaskSummary & SearchableWorkbenchTaskFields;
export declare const TASK_ADJUSTMENT_PRESETS: TaskAdjustmentPreset[];
export declare function sortWorkbenchTasks<T extends WorkbenchTaskSummary>(tasks: T[]): T[];
export declare function filterVisibleWorkbenchTasks<T extends WorkbenchTaskSummary>(tasks: T[], options?: {
    showArchived?: boolean;
}): T[];
export declare function filterWorkbenchTasksByQuery<T extends WorkbenchTaskSummary & SearchableWorkbenchTaskFields>(tasks: T[], query: string): T[];
export declare function getNextActiveWorkbenchTaskId<T extends WorkbenchTaskSummary>(tasks: T[], currentTaskId: string | null, options?: {
    showArchived?: boolean;
}): string | null;
export declare function groupWorkbenchTasks<T extends WorkbenchTaskSummary>(tasks: T[]): GroupedWorkbenchTasks<T>;
export declare function resolveWorkbenchTaskProgressColumn(status: WorkbenchTaskStatus): WorkbenchProgressColumnId | null;
export declare function buildWorkbenchTaskProgressColumns<T extends WorkbenchTaskSummary>(tasks: T[]): WorkbenchProgressColumn<T>[];
export declare function applyTaskAdjustmentPreset(currentNote: string, presetId: string): string;
export declare function buildTaskAdjustmentPreview(task: AdjustableWorkbenchTask | null, draft: {
    title: string;
    goal: string;
    adjustmentNote?: string;
}): TaskAdjustmentPreview;
export declare function buildWorkbenchWorkspaceBindingSummary(binding: TaskWorkspaceBinding | null | undefined): WorkbenchWorkspaceBindingSummary;
export declare function buildWorkbenchAgentLoopSummary(metadata: AgentLoopMetadata | null | undefined): WorkbenchAgentLoopSummary | null;
export declare function buildWorkbenchOverview<T extends WorkbenchTaskSummary>(tasks: T[]): WorkbenchOverviewMetrics;
export declare function filterWorkbenchTasksByLens<T extends WorkbenchTaskSummary>(tasks: T[], lens: WorkbenchLens, options?: {
    now?: Date;
}): T[];
export declare function buildWorkbenchFocusSummary<T extends WorkbenchTaskSummary>(tasks: T[], options?: {
    now?: Date;
}): WorkbenchFocusSummary;
export declare function resolveWorkbenchLane<T extends WorkbenchTaskSummary>(tasks: T[], preferredLens: WorkbenchLens, options?: {
    now?: Date;
}): WorkbenchLaneResolution;
export declare function buildTimelineGroups<T extends WorkbenchTimelineNode>(items: T[]): TimelineGroup<T>[];
export declare function filterTimelineGroupsByLens<T extends WorkbenchTimelineNode>(groups: TimelineGroup<T>[], lens: WorkbenchFeedLens): TimelineGroup<T>[];
export declare function filterStaleTimelineGroupsForTask<T extends WorkbenchTimelineNode>(groups: TimelineGroup<T>[], taskStatus: WorkbenchTaskStatus | null | undefined): TimelineGroup<T>[];
export declare function buildTimelineFeedMetrics<T extends WorkbenchTimelineNode>(groups: TimelineGroup<T>[]): WorkbenchFeedMetrics;
export declare function getDefaultWorkbenchFeedLens<T extends WorkbenchTimelineNode>(groups: TimelineGroup<T>[], options?: {
    taskStatus?: WorkbenchTaskStatus | null;
    hasPendingDecision?: boolean;
}): WorkbenchFeedLens;
export declare function parseWorkbenchEvidence(item: Pick<WorkbenchTimelineNode, 'body'> & Partial<WorkbenchTimelineNode>): ParsedWorkbenchEvidence;
export declare function buildWorkbenchEvidenceDigest<T extends Pick<WorkbenchTimelineNode, 'body' | 'createdAt'>>(items: T[]): WorkbenchEvidenceDigest;
export declare function buildWorkbenchAcceptanceDigest<T extends Pick<WorkbenchTimelineNode, 'body' | 'createdAt'>>(items: T[], artifacts?: SharedWorkbenchArtifactRecord[]): WorkbenchEvidenceDigest;
export declare function buildWorkbenchAcceptanceSummary(taskStatus: WorkbenchTaskStatus | null | undefined, digest: WorkbenchEvidenceDigest, pendingDecisionCount?: number): WorkbenchAcceptanceSummary;
export declare function buildRunProofPanelModel(taskStatus: WorkbenchTaskStatus, artifacts: SharedWorkbenchArtifactRecord[]): RunProofPanelModel | null;
export declare function buildWorkbenchQueueSignal(task: Pick<WorkbenchTaskSummary, 'status' | 'evidenceSummary'> & {
    waitingReason?: string;
}): WorkbenchQueueSignal;
export declare function buildWorkbenchLiveRunEntries<T extends Pick<WorkbenchTimelineNode, 'id' | 'kind' | 'actor' | 'body' | 'createdAt'>>(items: T[], options?: {
    limit?: number;
}): WorkbenchLiveRunEntry[];
export declare function buildWorkbenchOperatorNoteSummary(task: Pick<WorkbenchTaskSummary, 'lastAdjustment'>): string | null;
export declare function buildWorkbenchLatestCommentSummary(task: Pick<WorkbenchTaskSummary, 'comments'>): string | null;
export declare function buildWorkbenchTaskVisibleSummary(task: Pick<WorkbenchTaskSummary, 'latestSummary' | 'lastAdjustment' | 'comments'> & {
    goal?: string;
    waitingReason?: string;
}): string | null;
export declare function getLatestPreviewableArtifact<T extends Pick<WorkbenchTimelineNode, 'body' | 'createdAt'>>(items: T[]): string | null;
export declare function normalizeWorkbenchSummaryText(body: string | undefined): string | null;
export type TaskStatusBannerTone = 'yellow' | 'red' | 'green' | 'neutral';
export type TaskStatusBannerActionKind = 'primary' | 'secondary' | 'danger';
export type TaskStatusBannerAction = {
    id: 'retry';
    label: string;
    kind: TaskStatusBannerActionKind;
} | {
    id: 'archive';
    label: string;
    kind: TaskStatusBannerActionKind;
} | {
    id: 'approve-review';
    label: string;
    kind: TaskStatusBannerActionKind;
} | {
    id: 'cancel';
    label: string;
    kind: TaskStatusBannerActionKind;
} | {
    id: 'resume';
    label: string;
    kind: TaskStatusBannerActionKind;
} | {
    id: 'open-review';
    label: string;
    kind: TaskStatusBannerActionKind;
} | {
    id: 'stop';
    label: string;
    kind: TaskStatusBannerActionKind;
} | {
    id: 'reopen';
    label: string;
    kind: TaskStatusBannerActionKind;
} | {
    id: 'unblock';
    label: string;
    kind: TaskStatusBannerActionKind;
} | {
    id: 'run-next-pass';
    label: string;
    kind: TaskStatusBannerActionKind;
};
export interface TaskStatusBannerSpec {
    tone: TaskStatusBannerTone;
    icon: '⚠' | '✗' | '✓' | '○' | '⏸';
    headline: string;
    detail?: string;
    actions: TaskStatusBannerAction[];
    decisionDriven: boolean;
}
interface TaskStatusBannerInput {
    status: WorkbenchTaskStatus;
    waitingReason?: string;
    attempts?: Array<{
        attemptNumber: number;
        outcome?: string;
        error?: string;
    }>;
    blockedBy?: Array<{
        state?: string | null;
    }>;
    blockedByTaskIds?: string[];
    agentLoop?: AgentLoopMetadata;
}
export declare function buildTaskStatusBannerSpec(task: TaskStatusBannerInput | null, decisions?: Array<{
    title?: string;
    summary?: string;
}>): TaskStatusBannerSpec | null;
export declare function allowedMetadataStatuses(status: WorkbenchTaskStatus): WorkbenchTaskStatus[];
export declare function canPauseTask(status: WorkbenchTaskStatus): boolean;
export declare function canResumeTask(status: WorkbenchTaskStatus): boolean;
export declare function canStopTask(status: WorkbenchTaskStatus): boolean;
export declare function buildWorkbenchRuntimeControlActions(status: WorkbenchTaskStatus): WorkbenchRuntimeControlAction[];
export declare function getPreferredReviewArtifactId(artifacts: SharedWorkbenchArtifactRecord[]): string | null;
export {};
//# sourceMappingURL=workbench.d.ts.map