import type { WorkflowAgentRole, WorkflowExecutablePhase, WorkflowSkillName, WorkflowSubtaskContract } from '@tik/shared';
export interface WorkspaceWorkflowPhaseSpec {
    phase: WorkflowExecutablePhase;
    contract: WorkflowSubtaskContract;
    role: WorkflowAgentRole;
    skillName: WorkflowSkillName;
    completionPromise: string;
    expectedOutput: string;
    summaryGoal: string;
    requiredArtifacts: string[];
    nextPhase: WorkflowExecutablePhase | 'COMPLETED';
}
export declare const WORKSPACE_WORKFLOW_SPEC: Record<WorkflowExecutablePhase, WorkspaceWorkflowPhaseSpec>;
export declare function getWorkspaceWorkflowPhaseSpec(phase: WorkflowExecutablePhase): WorkspaceWorkflowPhaseSpec;
export declare function getWorkspaceWorkflowPhaseSpecByContract(contract: WorkflowSubtaskContract): WorkspaceWorkflowPhaseSpec;
//# sourceMappingURL=workspace-workflow-spec.d.ts.map