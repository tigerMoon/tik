import type { QuestionerIntent, WorkflowDecisionAction } from '@tik/shared';

export type WorkflowActionPhase =
  | 'planning'
  | 'contract'
  | 'contract_questioning'
  | 'building'
  | 'evaluation'
  | 'evaluation_questioning'
  | 'completion'
  | 'final_evaluation'
  | 'final_questioning'
  | 'workflow_completion'
  | 'review'
  | 'human_review'
  | 'abort';

export type WorkflowActionKind =
  | 'agent_invocation'
  | 'human_or_agent_action'
  | 'state_transition'
  | 'system_action';

export interface WorkflowActionDefinition {
  id: WorkflowDecisionAction;
  phase: WorkflowActionPhase;
  kind: WorkflowActionKind;
  title: string;
  runner?: 'codex' | 'codex-evaluator' | 'claude-code';
  role?: 'planner' | 'executor' | 'evaluator' | 'questioner' | 'reviewer' | 'final-reviewer';
  intent?: QuestionerIntent;
  produces?: string[];
  handler: string;
  strictOutput?: 'QuestionerOutputV2';
  runtimePolicy?: 'readonly' | 'readonly_tik_api_only';
}

export const tikV1Actions = {
  request_dynamic_plan: {
    id: 'request_dynamic_plan',
    phase: 'planning',
    kind: 'agent_invocation',
    title: 'Request Dynamic Plan',
    runner: 'claude-code',
    role: 'planner',
    produces: ['TaskGraph'],
    handler: 'planner.start',
    runtimePolicy: 'readonly_tik_api_only',
  },
  draft_contract: {
    id: 'draft_contract',
    phase: 'contract',
    kind: 'human_or_agent_action',
    title: 'Draft SprintContract',
    produces: ['SprintContract'],
    handler: 'contract.draft',
  },
  ask_claude_question_contract: {
    id: 'ask_claude_question_contract',
    phase: 'contract_questioning',
    kind: 'agent_invocation',
    title: 'Question SprintContract',
    runner: 'claude-code',
    role: 'questioner',
    intent: 'question_contract',
    produces: ['QuestionerRun'],
    handler: 'questioner.start',
    strictOutput: 'QuestionerOutputV2',
    runtimePolicy: 'readonly_tik_api_only',
  },
  accept_contract: {
    id: 'accept_contract',
    phase: 'contract',
    kind: 'state_transition',
    title: 'Accept SprintContract',
    handler: 'contract.accept',
  },
  execute_subtask: {
    id: 'execute_subtask',
    phase: 'building',
    kind: 'agent_invocation',
    title: 'Run Codex Builder',
    runner: 'codex',
    role: 'executor',
    produces: ['ImplementationEvidence'],
    handler: 'builder.start',
  },
  record_implementation: {
    id: 'record_implementation',
    phase: 'building',
    kind: 'state_transition',
    title: 'Record Implementation',
    produces: ['ImplementationEvidence'],
    handler: 'implementation.record',
  },
  run_codex_evaluator: {
    id: 'run_codex_evaluator',
    phase: 'evaluation',
    kind: 'agent_invocation',
    title: 'Run Codex Evaluator',
    runner: 'codex-evaluator',
    role: 'evaluator',
    produces: ['EvaluationRun'],
    handler: 'evaluation.start',
    runtimePolicy: 'readonly',
  },
  re_evaluate: {
    id: 're_evaluate',
    phase: 'evaluation',
    kind: 'agent_invocation',
    title: 'Re-run Codex Evaluator',
    runner: 'codex-evaluator',
    role: 'evaluator',
    produces: ['EvaluationRun'],
    handler: 'evaluation.start',
    runtimePolicy: 'readonly',
  },
  ask_claude_question_evaluation: {
    id: 'ask_claude_question_evaluation',
    phase: 'evaluation_questioning',
    kind: 'agent_invocation',
    title: 'Question Evaluation Evidence',
    runner: 'claude-code',
    role: 'questioner',
    intent: 'question_evaluation',
    produces: ['QuestionerRun'],
    handler: 'questioner.start',
    strictOutput: 'QuestionerOutputV2',
    runtimePolicy: 'readonly_tik_api_only',
  },
  fix_evaluation_findings: {
    id: 'fix_evaluation_findings',
    phase: 'building',
    kind: 'agent_invocation',
    title: 'Fix Evaluation Findings',
    runner: 'codex',
    role: 'executor',
    produces: ['ImplementationEvidence'],
    handler: 'builder.fix',
  },
  complete_subtask: {
    id: 'complete_subtask',
    phase: 'completion',
    kind: 'state_transition',
    title: 'Complete Subtask',
    handler: 'subtask.complete',
  },
  run_final_evaluation: {
    id: 'run_final_evaluation',
    phase: 'final_evaluation',
    kind: 'agent_invocation',
    title: 'Run Final Codex Evaluation',
    runner: 'codex-evaluator',
    role: 'evaluator',
    produces: ['EvaluationRun'],
    handler: 'evaluation.start_final',
    runtimePolicy: 'readonly',
  },
  ask_claude_question_final_evidence: {
    id: 'ask_claude_question_final_evidence',
    phase: 'final_questioning',
    kind: 'agent_invocation',
    title: 'Question Final Evidence',
    runner: 'claude-code',
    role: 'questioner',
    intent: 'question_final_evidence',
    produces: ['QuestionerRun'],
    handler: 'questioner.start',
    strictOutput: 'QuestionerOutputV2',
    runtimePolicy: 'readonly_tik_api_only',
  },
  complete_workflow: {
    id: 'complete_workflow',
    phase: 'workflow_completion',
    kind: 'state_transition',
    title: 'Complete Workflow',
    handler: 'workflow.complete',
  },
  request_claude_review: {
    id: 'request_claude_review',
    phase: 'review',
    kind: 'agent_invocation',
    title: 'Request Claude Review',
    runner: 'claude-code',
    role: 'reviewer',
    produces: ['ReviewEvidence'],
    handler: 'review.start',
    runtimePolicy: 'readonly_tik_api_only',
  },
  request_re_review: {
    id: 'request_re_review',
    phase: 'review',
    kind: 'agent_invocation',
    title: 'Request Claude Re-review',
    runner: 'claude-code',
    role: 'reviewer',
    produces: ['ReviewEvidence'],
    handler: 'review.start',
    runtimePolicy: 'readonly_tik_api_only',
  },
  request_final_review: {
    id: 'request_final_review',
    phase: 'review',
    kind: 'agent_invocation',
    title: 'Request Final Review',
    runner: 'claude-code',
    role: 'final-reviewer',
    produces: ['ReviewEvidence'],
    handler: 'review.start_final',
    runtimePolicy: 'readonly_tik_api_only',
  },
  fix_claude_blockers: {
    id: 'fix_claude_blockers',
    phase: 'building',
    kind: 'agent_invocation',
    title: 'Fix Claude Blockers',
    runner: 'codex',
    role: 'executor',
    produces: ['ImplementationEvidence'],
    handler: 'builder.fix_review',
  },
  validate_subtask: {
    id: 'validate_subtask',
    phase: 'evaluation',
    kind: 'system_action',
    title: 'Validate Subtask',
    produces: ['ValidationEvidence'],
    handler: 'validation.run',
  },
  request_human_review: {
    id: 'request_human_review',
    phase: 'human_review',
    kind: 'state_transition',
    title: 'Request Human Review',
    handler: 'human_review.request',
  },
  request_replan: {
    id: 'request_replan',
    phase: 'planning',
    kind: 'agent_invocation',
    title: 'Request Replan',
    runner: 'claude-code',
    role: 'planner',
    produces: ['TaskGraphPatch'],
    handler: 'planner.replan',
    runtimePolicy: 'readonly_tik_api_only',
  },
  skip_non_blocking_suggestions: {
    id: 'skip_non_blocking_suggestions',
    phase: 'review',
    kind: 'state_transition',
    title: 'Skip Non-blocking Suggestions',
    handler: 'review.skip_non_blocking',
  },
  ask_claude_question_requirement: {
    id: 'ask_claude_question_requirement',
    phase: 'planning',
    kind: 'agent_invocation',
    title: 'Question Requirements',
    runner: 'claude-code',
    role: 'questioner',
    intent: 'question_requirement',
    produces: ['QuestionerRun'],
    handler: 'questioner.start',
    strictOutput: 'QuestionerOutputV2',
    runtimePolicy: 'readonly_tik_api_only',
  },
  ask_claude_question_task_graph: {
    id: 'ask_claude_question_task_graph',
    phase: 'planning',
    kind: 'agent_invocation',
    title: 'Question TaskGraph',
    runner: 'claude-code',
    role: 'questioner',
    intent: 'question_task_graph',
    produces: ['QuestionerRun'],
    handler: 'questioner.start',
    strictOutput: 'QuestionerOutputV2',
    runtimePolicy: 'readonly_tik_api_only',
  },
  abort_workflow: {
    id: 'abort_workflow',
    phase: 'abort',
    kind: 'state_transition',
    title: 'Abort Workflow',
    handler: 'workflow.abort',
  },
} satisfies Partial<Record<WorkflowDecisionAction, WorkflowActionDefinition>>;

export function getWorkflowActionDefinition(action: WorkflowDecisionAction): WorkflowActionDefinition {
  const definition = tikV1Actions[action];
  if (!definition) {
    throw new Error(`Unsupported workflow action: ${action}`);
  }
  return definition;
}

