import type { AgentLoopPayload, CreateWorkbenchTaskInput, IEventBus, ReviewResult, WorkbenchArtifactRecord, WorkbenchArtifactVersion, WorkbenchDecisionRecord, WorkbenchTaskAttemptRecord, WorkbenchTaskCommentRecord, WorkbenchTaskRecord, WorkbenchTaskRunRecord, WorkbenchTaskStatus, WorkbenchTimelineItem } from '@tik/shared';
import type { AppendArtifactVersionInput, ArtifactFilter, ArtifactPreviewPayload, ArtifactRegistry, CreateArtifactInput } from '../artifacts/artifact-registry.js';
import { type ArtifactTemplateName } from '../artifacts/artifact-templates.js';
import { WorkbenchStore } from './workbench-store.js';
interface WorkbenchServiceOptions {
    rootPath: string;
    eventBus: IEventBus;
    store: WorkbenchStore;
    artifacts?: ArtifactRegistry;
    stopTask?: (taskId: string, reason: string) => void;
}
export declare class WorkbenchTaskError extends Error {
    readonly code: string;
    constructor(code: string, message: string);
}
type WorkbenchTaskTransitionActor = 'human' | 'agent' | 'daemon' | 'system';
export declare class WorkbenchService {
    private readonly options;
    private readonly eventBus;
    private readonly store;
    private readonly artifacts?;
    private readonly stopTask?;
    private eventQueue;
    constructor(options: WorkbenchServiceOptions);
    createTask(input: CreateWorkbenchTaskInput, taskId?: string): Promise<WorkbenchTaskRecord>;
    appendTaskRun(taskId: string, run: WorkbenchTaskRunRecord): Promise<WorkbenchTaskRecord | null>;
    transitionTask(taskId: string, to: WorkbenchTaskStatus, input?: {
        reason?: string;
        actor?: WorkbenchTaskTransitionActor;
    }): Promise<WorkbenchTaskRecord | null>;
    appendAttempt(taskId: string, input: Partial<WorkbenchTaskAttemptRecord>): Promise<WorkbenchTaskAttemptRecord>;
    finishAttempt(taskId: string, attemptNumber: number, outcome: NonNullable<WorkbenchTaskAttemptRecord['outcome']>, error?: string): Promise<WorkbenchTaskRecord | null>;
    addComment(taskId: string, input: Omit<WorkbenchTaskCommentRecord, 'id' | 'createdAt'> & {
        id?: string;
        createdAt?: string;
    }): Promise<WorkbenchTaskRecord | null>;
    setLabels(taskId: string, input: {
        add?: string[];
        remove?: string[];
    }): Promise<WorkbenchTaskRecord | null>;
    updateTaskTrackerMetadata(taskId: string, input: {
        title?: string;
        description?: string | null;
        goal?: string;
        status?: WorkbenchTaskStatus;
        priority?: number | null;
        labels?: string[];
        parentTaskId?: string | null;
        humanAssignee?: string | null;
        assignee?: string | null;
        createdBy?: string | null;
        sourceUrl?: string | null;
        workspaceBinding?: WorkbenchTaskRecord['workspaceBinding'];
    }): Promise<WorkbenchTaskRecord | null>;
    setTaskDependencies(taskId: string, input: {
        add?: string[];
        remove?: string[];
    }): Promise<WorkbenchTaskRecord | null>;
    createAgentLoopWorkItem(input: AgentLoopPayload): Promise<WorkbenchTaskRecord>;
    createReviewRound(input: Omit<AgentLoopPayload, 'kind'>): Promise<WorkbenchTaskRecord>;
    createFixWorkItem(input: Omit<AgentLoopPayload, 'kind'>): Promise<WorkbenchTaskRecord>;
    createHumanReviewWorkItem(input: Omit<AgentLoopPayload, 'kind'>): Promise<WorkbenchTaskRecord>;
    markAgentLoopStale(taskId: string, input: {
        expectedHeadSha: string;
        actualHeadSha: string;
    }): Promise<WorkbenchTaskRecord | null>;
    completeAgentLoopReview(taskId: string, reviewResult: ReviewResult): Promise<{
        task: WorkbenchTaskRecord;
        reviewTask: WorkbenchTaskRecord;
        nextTask?: WorkbenchTaskRecord;
    }>;
    advanceReviewLoopAfterRuntime(taskId: string, input: {
        runner: 'codex' | 'claude-code';
        status: 'completed' | 'failed' | 'cancelled';
        stdout?: string;
        runId?: string;
    }): Promise<WorkbenchTaskRecord | null>;
    listTasks(): Promise<WorkbenchTaskRecord[]>;
    readTask(taskId: string): Promise<WorkbenchTaskRecord | null>;
    readTimeline(taskId: string): Promise<WorkbenchTimelineItem[]>;
    listArtifacts(filter?: ArtifactFilter): Promise<WorkbenchArtifactRecord[]>;
    readArtifact(id: string): Promise<WorkbenchArtifactRecord | null>;
    listArtifactVersions(id: string): Promise<WorkbenchArtifactVersion[]>;
    readArtifactPreview(artifactId: string, versionId?: string): Promise<ArtifactPreviewPayload | null>;
    createArtifact(input: CreateArtifactInput): Promise<WorkbenchArtifactRecord>;
    generateArtifactForTask(taskId: string, template?: ArtifactTemplateName): Promise<WorkbenchArtifactRecord>;
    appendArtifactVersion(input: AppendArtifactVersionInput): Promise<WorkbenchArtifactRecord>;
    acceptArtifact(id: string, actor?: string): Promise<WorkbenchArtifactRecord>;
    rejectArtifact(id: string, reason: string, actor?: string): Promise<WorkbenchArtifactRecord>;
    archiveArtifact(id: string, actor?: string): Promise<WorkbenchArtifactRecord>;
    readPendingDecisions(taskId: string): Promise<WorkbenchDecisionRecord[]>;
    readDecision(decisionId: string): Promise<WorkbenchDecisionRecord | null>;
    requestToolApproval(taskId: string, toolName: string): Promise<WorkbenchDecisionRecord | null>;
    waitForDecisionResolution(decisionId: string, options?: {
        pollMs?: number;
        timeoutMs?: number;
    }): Promise<{
        decision: WorkbenchDecisionRecord;
        approved: boolean;
    }>;
    resolveDecision(taskId: string, decisionId: string, input: {
        optionId?: string;
        message?: string;
    }): Promise<{
        task: WorkbenchTaskRecord;
        decision: WorkbenchDecisionRecord;
        approved: boolean;
    }>;
    canRetryTask(taskId: string): Promise<boolean>;
    updateTaskConfiguration(taskId: string, selection: NonNullable<WorkbenchTaskRecord['environmentPackSelection']>, environmentPackSnapshot?: WorkbenchTaskRecord['environmentPackSnapshot']): Promise<WorkbenchTaskRecord | null>;
    updateTaskBrief(taskId: string, input: {
        title: string;
        goal: string;
        adjustment?: string;
    }): Promise<WorkbenchTaskRecord | null>;
    revertLastTaskAdjustment(taskId: string): Promise<WorkbenchTaskRecord | null>;
    archiveTask(taskId: string, options?: {
        force?: boolean;
    }): Promise<WorkbenchTaskRecord | null>;
    private canArchiveAgentLoopHumanReview;
    private drainEventQueue;
    private projectTaskState;
    private handleEvent;
    private shouldIgnoreEventForTask;
    private resolveWaitingDecision;
    private resolveDecisionStatus;
    private shouldForceResolveWaitingDecision;
    private resolveTaskForEvent;
    private findTaskByKernelTaskId;
    private mapTaskStatus;
    private projectAttemptFromEvent;
    private extractEventError;
    private stopActiveAttemptIfNeeded;
    private cleanupInactiveTaskStateIfNeeded;
    private buildAgentLoopMetadata;
    private resolveAgentLoopPayloadForRootTask;
    private buildAgentLoopIdempotencyKey;
    private findTaskByAgentLoopIdempotencyKey;
    private findTaskByIdOrIdentifier;
    private applyAgentLoopHumanReviewCommand;
    private statusForAgentLoopRetryPhase;
    private advanceAfterClaudeReviewRuntime;
    private advanceAfterCodexFixRuntime;
    private labelsForAgentLoopPhase;
    private phaseForAgentLoopKind;
    private summaryForAgentLoopPhase;
    private timelineBodyForAgentLoopPhase;
    private applyAgentLoopLabels;
    private buildAgentLoopTitle;
    private buildAgentLoopDescription;
    private buildAgentLoopGoal;
    private formatBlockingIssues;
    private normalizeReviewResult;
    private buildReviewTimelineBody;
    private buildReviewResultComment;
    private createFixTaskFromReview;
    private createHumanReviewTaskFromReview;
    private reparentTask;
    private buildHighRiskDecision;
    private summarizeEvent;
    private shouldSuppressTimelineSummary;
    private buildRawTimelineItem;
    private formatToolEvidenceBody;
    private stringifyPayloadOutput;
    private buildTaskEvidenceSummary;
    private parseTaskEvidence;
    private extractNamedSection;
    private escapeForRegex;
    private isPreviewableArtifactPath;
    private registerPreviewableArtifacts;
    private appendArtifactTimelineItem;
    private moveTaskToArtifactReview;
    private completeTaskAfterArtifactAcceptance;
    private reopenTaskAfterArtifactRejection;
    private hasPendingReviewArtifact;
    private buildArtifactProvenance;
    private isValidationToolEvidence;
    private extensionForPath;
    private artifactKindForPath;
    private contentTypeForPath;
    private mapTransitionActor;
    private assertTaskExists;
    private assertNoDependencyCycle;
}
export {};
//# sourceMappingURL=workbench-service.d.ts.map