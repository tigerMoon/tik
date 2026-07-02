import type { WorkspaceDecisionConfidence, WorkspaceDecisionPhase, WorkspaceDecisionRequest, WorkspaceProjectState, WorkspaceWorkflowPolicyProfile, WorkflowAgentRole, WorkflowSubtaskContract, WorkflowSkillName } from '@tik/shared';
export interface WorkspaceDecisionSynthesisInput {
    projectName: string;
    phase: WorkspaceDecisionPhase;
    blockerKind?: WorkspaceProjectState['blockerKind'];
    summary?: string;
    demand?: string;
    workflowContract?: WorkflowSubtaskContract;
    workflowRole?: WorkflowAgentRole;
    workflowSkillName?: WorkflowSkillName;
    specPath?: string;
    planPath?: string;
    workflowProfile?: WorkspaceWorkflowPolicyProfile;
    recentProjectEvents?: string[];
    recentWorkspaceEvents?: string[];
    projectKnownArtifacts?: string[];
    sessionNextAction?: string;
    specExcerpt?: string;
    planExcerpt?: string;
}
export declare function synthesizeWorkspaceDecision(input: WorkspaceDecisionSynthesisInput, now: string): WorkspaceDecisionRequest;
export declare function workspaceDecisionConfidenceRank(confidence: WorkspaceDecisionConfidence | undefined): number;
//# sourceMappingURL=workspace-decision-synthesizer.d.ts.map