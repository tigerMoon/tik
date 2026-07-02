import type { WorkspaceDecisionRequest, WorkspaceProjectWorktreeState, WorkspaceResolution, WorkspaceSettings, WorkspaceWorktreePolicyConfig, WorkspaceWorkflowPolicyConfig, WorkspaceSplitDemands, WorkspaceState, WorkspacePhase, WorkflowSkillName, WorkflowSubtaskContract } from '@tik/shared';
type WorkspaceProjectState = NonNullable<WorkspaceState['projects']>[number] & {
    clarifyTaskId?: string;
    specTaskId?: string;
    planTaskId?: string;
    aceTaskId?: string;
    executionMode?: 'native' | 'fallback';
    workflowContract?: WorkflowSubtaskContract;
    workflowSkillName?: WorkflowSkillName;
    workflowSkillPath?: string;
    blockerKind?: 'NEED_HUMAN' | 'REPLAN' | 'EXECUTION_FAILED';
    recommendedCommand?: string;
};
type LocalWorkspaceState = Omit<WorkspaceState, 'workspaceFeedback' | 'summary'> & {
    workspaceFeedback?: {
        required: boolean;
        reason?: string;
        affectedProjects?: string[];
        nextPhase?: 'PARALLEL_CLARIFY' | 'PARALLEL_SPECIFY' | 'PARALLEL_PLAN' | 'PARALLEL_ACE';
        updatedAt: string;
    };
    summary?: {
        totalProjects: number;
        completedProjects: number;
        blockedProjects: number;
        failedProjects: number;
        clarifiedProjects?: number;
        pendingClarificationProjects?: number;
        needsHumanProjects: number;
        replanProjects: number;
        updatedAt: string;
    };
};
interface ResolveWorkspaceDecisionInput {
    decisionId: string;
    optionId?: string;
    message?: string;
}
interface BootstrapWorkspaceInput {
    resolution: WorkspaceResolution;
    demand: string;
    workflowPolicy?: WorkspaceWorkflowPolicyConfig;
}
interface WorkspaceStatusSnapshot {
    settings: WorkspaceSettings | null;
    state: LocalWorkspaceState | null;
    splitDemands: WorkspaceSplitDemands | null;
}
export declare class WorkspaceOrchestrator {
    private readonly mutationQueues;
    private readonly lockTimeoutMs;
    private readonly staleLockMs;
    bootstrap(input: BootstrapWorkspaceInput): Promise<WorkspaceStatusSnapshot>;
    getStatus(rootPath: string): Promise<WorkspaceStatusSnapshot>;
    markSpecifyResult(rootPath: string, projectName: string, specPath: string, summary: string, specTaskId?: string, executionMode?: 'native' | 'fallback'): Promise<WorkspaceStatusSnapshot>;
    markClarifyResult(rootPath: string, projectName: string, clarificationPath: string, summary: string, clarifyTaskId?: string, clarificationStatus?: WorkspaceProjectState['clarificationStatus']): Promise<WorkspaceStatusSnapshot>;
    markClarifyBlocked(rootPath: string, projectName: string, clarificationPath: string, summary: string, clarifyTaskId?: string, clarificationStatus?: WorkspaceProjectState['clarificationStatus'], decision?: WorkspaceDecisionRequest): Promise<WorkspaceStatusSnapshot>;
    markPlanResult(rootPath: string, projectName: string, planPath: string, summary: string, planTaskId?: string, executionMode?: 'native' | 'fallback'): Promise<WorkspaceStatusSnapshot>;
    markAceResult(rootPath: string, projectName: string, taskId: string, status: WorkspaceProjectState['status'], summary: string, executionMode?: 'native' | 'fallback'): Promise<WorkspaceStatusSnapshot>;
    markProjectInProgress(rootPath: string, projectName: string, phase: WorkspacePhase, summary?: string, taskId?: string, executionMode?: 'native' | 'fallback'): Promise<WorkspaceStatusSnapshot>;
    markProjectBlocked(rootPath: string, projectName: string, phase: WorkspacePhase, summary: string, taskId?: string): Promise<WorkspaceStatusSnapshot>;
    markProjectWorktreeReady(rootPath: string, projectName: string, input: {
        effectiveProjectPath: string;
        worktree: WorkspaceProjectWorktreeState;
    }): Promise<WorkspaceStatusSnapshot>;
    markProjectWorktreeFailed(rootPath: string, projectName: string, input: {
        effectiveProjectPath?: string;
        worktree: WorkspaceProjectWorktreeState;
        summary: string;
    }): Promise<WorkspaceStatusSnapshot>;
    markProjectWorktreeRemoved(rootPath: string, projectName: string, input: {
        sourceProjectPath: string;
        worktree: WorkspaceProjectWorktreeState;
    }): Promise<WorkspaceStatusSnapshot>;
    activateProjectWorktreeLane(rootPath: string, projectName: string, input: {
        effectiveProjectPath: string;
        worktree: WorkspaceProjectWorktreeState;
    }): Promise<WorkspaceStatusSnapshot>;
    recordFeedback(rootPath: string, reason: string, affectedProjects: string[], nextPhase?: 'PARALLEL_CLARIFY' | 'PARALLEL_SPECIFY' | 'PARALLEL_PLAN' | 'PARALLEL_ACE'): Promise<WorkspaceStatusSnapshot>;
    clearFeedback(rootPath: string, nextPhase: 'PARALLEL_CLARIFY' | 'PARALLEL_SPECIFY' | 'PARALLEL_PLAN' | 'PARALLEL_ACE'): Promise<WorkspaceStatusSnapshot>;
    resolveDecision(rootPath: string, input: ResolveWorkspaceDecisionInput): Promise<WorkspaceStatusSnapshot>;
    updateWorkflowPolicy(rootPath: string, workflowPolicy: WorkspaceWorkflowPolicyConfig): Promise<WorkspaceStatusSnapshot>;
    updateWorktreePolicy(rootPath: string, worktreePolicy: WorkspaceWorktreePolicyConfig): Promise<WorkspaceStatusSnapshot>;
    private withWorkspaceMutation;
    private getWorkspaceDir;
    private getWorkspaceLockPath;
    private buildSettings;
    private defaultWorkflowPolicy;
    private defaultWorktreePolicy;
    private buildSplitDemands;
    private buildState;
    private selectProjects;
    private analyzeProjectMention;
    private writeJson;
    private readJson;
    private updateProjectState;
    private computeCurrentPhase;
    private computeNotes;
    private deriveProjectControlPlane;
    private upsertProjectWorktreeLane;
    private reconcileDecisionRequests;
    private upsertDecisionRequest;
    private resolvePendingDecisions;
    private dismissStalePendingDecisions;
    private dismissResolvedProjectDecisions;
    private buildDecisionRequest;
    private buildDecisionSynthesisInput;
    private toDecisionPhase;
    private computeSummary;
    private readArtifactExcerpt;
    private withWorkspaceFileLock;
    private maybeClearStaleWorkspaceLock;
}
export {};
//# sourceMappingURL=workspace-orchestrator.d.ts.map