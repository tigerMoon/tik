import type { WorkflowDecisionAction } from '@tik/shared';
import type { WorkflowActionPhase } from './action-registry.js';

export interface TikV1WorkflowStage {
  id: string;
  phase: WorkflowActionPhase;
  action: WorkflowDecisionAction;
  completePredicate: string;
}

export const tikV1Workflow = {
  id: 'tik.multi_agent.v1',
  version: 1,
  phases: [
    'planning',
    'contract',
    'contract_questioning',
    'building',
    'evaluation',
    'evaluation_questioning',
    'completion',
    'final_evaluation',
    'final_questioning',
    'workflow_completion',
  ] satisfies WorkflowActionPhase[],
  stages: [
    { id: 'draft_contract', phase: 'contract', action: 'draft_contract', completePredicate: 'hasAcceptedContract' },
    { id: 'question_contract', phase: 'contract_questioning', action: 'ask_claude_question_contract', completePredicate: 'hasSufficientContractQuestionerOutput' },
    { id: 'build_subtask', phase: 'building', action: 'execute_subtask', completePredicate: 'hasImplementationEvidenceAtHead' },
    { id: 'evaluate_subtask', phase: 'evaluation', action: 'run_codex_evaluator', completePredicate: 'hasPassingEvaluationAtHead' },
    { id: 'question_evaluation', phase: 'evaluation_questioning', action: 'ask_claude_question_evaluation', completePredicate: 'hasSufficientEvaluationQuestionerOutput' },
    { id: 'complete_subtask', phase: 'completion', action: 'complete_subtask', completePredicate: 'subtaskIsDone' },
    { id: 'final_evaluation', phase: 'final_evaluation', action: 'run_final_evaluation', completePredicate: 'hasPassingFinalEvaluation' },
    { id: 'final_questioning', phase: 'final_questioning', action: 'ask_claude_question_final_evidence', completePredicate: 'hasSufficientFinalQuestionerOutput' },
    { id: 'complete_workflow', phase: 'workflow_completion', action: 'complete_workflow', completePredicate: 'workflowIsCompleted' },
  ] satisfies TikV1WorkflowStage[],
};

