import type { WorkflowExecutablePhase, WorkflowSubtaskSpec, WorkspaceWorkflowPolicyConfig, WorkspaceWorkflowPolicyProfile } from '@tik/shared';
import type { CompletionEvidence } from './workspace-completion-evidence.js';
export type WorkspacePhaseArtifactState = 'ready' | 'missing' | 'invalid';
export interface NativeRescueDecisionInput {
    phase: WorkflowSubtaskSpec['phase'];
    artifactState: WorkspacePhaseArtifactState;
    timedOut: boolean;
    delegatedStatus?: string;
}
export interface FeedbackEscalationDecisionInput {
    phase: WorkflowExecutablePhase;
    retryCount: number;
}
type WorkspaceWorkflowPolicy = {
    profile: WorkspaceWorkflowPolicyProfile;
    phaseBudgetsMs: Record<WorkflowExecutablePhase, number>;
    maxFeedbackRetriesPerPhase: Record<WorkflowExecutablePhase, number>;
    enableNativeArtifactRescue: boolean;
    enableAceEvidencePromotion: boolean;
};
export declare const WORKSPACE_POLICY_PROFILES: Record<WorkspaceWorkflowPolicyProfile, WorkspaceWorkflowPolicy>;
export declare const DEFAULT_WORKSPACE_POLICY: WorkspaceWorkflowPolicy;
export declare function resolveWorkspaceWorkflowPolicy(config?: WorkspaceWorkflowPolicyConfig): WorkspaceWorkflowPolicy;
export declare class WorkspacePolicyEngine {
    private readonly config;
    constructor(config?: WorkspaceWorkflowPolicyConfig);
    getConfig(): WorkspaceWorkflowPolicy;
    getPhaseBudgetMs(phase: WorkflowExecutablePhase): number;
    shouldRunNativeArtifactRescue(input: NativeRescueDecisionInput): boolean;
    shouldPromoteArtifactToNative(input: {
        reused: boolean;
        materializedDuringRun: boolean;
    }): boolean;
    shouldPromoteAceTimeoutToCompleted(evidence: CompletionEvidence | null): boolean;
    shouldEscalateFeedback(input: FeedbackEscalationDecisionInput): boolean;
    formatArtifactModeLabel(input: {
        reused: boolean;
        executionMode?: 'native' | 'fallback';
    }): string;
}
export {};
//# sourceMappingURL=workspace-policy-engine.d.ts.map