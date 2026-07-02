import type { WorkflowAgentRole, WorkflowSkillName, WorkflowSkillSourceKind, WorkspacePhase, WorkflowSubtaskContract } from '@tik/shared';
export interface WorkflowSkillRouteBinding {
    phase: Extract<WorkspacePhase, 'PARALLEL_CLARIFY' | 'PARALLEL_SPECIFY' | 'PARALLEL_PLAN' | 'PARALLEL_ACE'>;
    contract: WorkflowSubtaskContract;
    role: WorkflowAgentRole;
    skillName: WorkflowSkillName;
    skillSourceKind: WorkflowSkillSourceKind;
    skillPath: string;
    completionPromise: string;
    expectedOutput: string;
    summaryGoal: string;
}
export declare function getWorkflowSkillRouteByPhase(phase: WorkflowSkillRouteBinding['phase']): WorkflowSkillRouteBinding;
export declare function getWorkflowSkillRouteByContract(contract: WorkflowSubtaskContract): WorkflowSkillRouteBinding;
//# sourceMappingURL=workflow-skill-routes.d.ts.map