import type {
  WorkflowAgentRole,
  WorkflowExecutablePhase,
  WorkflowSkillName,
  WorkflowSubtaskContract,
} from '@tik/shared';

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

export const WORKSPACE_WORKFLOW_SPEC: Record<WorkflowExecutablePhase, WorkspaceWorkflowPhaseSpec> = {
  PARALLEL_CLARIFY: {
    phase: 'PARALLEL_CLARIFY',
    contract: 'CLARIFY_SUBTASK',
    role: 'planner',
    skillName: 'superpowers-clarify',
    completionPromise: 'CLARIFY_COMPLETE',
    expectedOutput: '.workspace/clarifications/{project}/clarify-{attempt}.md plus pending decisions or a safe skip decision',
    summaryGoal: 'clarify project scope, constraints, and decision boundaries before specification when ambiguity is material',
    requiredArtifacts: [],
    nextPhase: 'PARALLEL_SPECIFY',
  },
  PARALLEL_SPECIFY: {
    phase: 'PARALLEL_SPECIFY',
    contract: 'SPECIFY_SUBTASK',
    role: 'planner',
    skillName: 'sdd-specify',
    completionPromise: 'SPECIFY_COMPLETE',
    expectedOutput: '.specify/specs/{feature}/spec.md',
    summaryGoal: 'generate or confirm a concrete project spec',
    requiredArtifacts: ['spec.md'],
    nextPhase: 'PARALLEL_PLAN',
  },
  PARALLEL_PLAN: {
    phase: 'PARALLEL_PLAN',
    contract: 'PLAN_SUBTASK',
    role: 'reviewer',
    skillName: 'sdd-plan',
    completionPromise: 'PLAN_COMPLETE',
    expectedOutput: '.specify/specs/{feature}/plan.md',
    summaryGoal: 'generate or repair a real executable project plan',
    requiredArtifacts: ['plan.md'],
    nextPhase: 'PARALLEL_ACE',
  },
  PARALLEL_ACE: {
    phase: 'PARALLEL_ACE',
    contract: 'ACE_SUBTASK',
    role: 'executor',
    skillName: 'ace-sdd-workflow',
    completionPromise: 'SDD_WORKFLOW_COMPLETE',
    expectedOutput: 'project-local implementation convergence or clear blocker',
    summaryGoal: 'execute the project-local ACE workflow to convergence or blocker',
    requiredArtifacts: [],
    nextPhase: 'COMPLETED',
  },
};

export function getWorkspaceWorkflowPhaseSpec(
  phase: WorkflowExecutablePhase,
): WorkspaceWorkflowPhaseSpec {
  return WORKSPACE_WORKFLOW_SPEC[phase];
}

export function getWorkspaceWorkflowPhaseSpecByContract(
  contract: WorkflowSubtaskContract,
): WorkspaceWorkflowPhaseSpec {
  const spec = Object.values(WORKSPACE_WORKFLOW_SPEC).find((entry) => entry.contract === contract);
  if (!spec) {
    throw new Error(`Unknown workflow contract: ${contract}`);
  }
  return spec;
}
