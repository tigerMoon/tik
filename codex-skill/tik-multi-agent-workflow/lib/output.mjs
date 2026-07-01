export function printJson(value) {
  console.log(JSON.stringify(value, null, 2));
}

export function instructionForDecision(decision, state) {
  switch (decision.action) {
    case 'request_dynamic_plan':
      return `Request a Claude dynamic plan for workflow ${decision.workflowId}, then store the TaskGraph with accept-plan.`;
    case 'execute_subtask': {
      const subtask = state?.taskGraph?.subtasks?.find((item) => item.id === decision.subtaskId);
      return `Implement subtask ${decision.subtaskId}${subtask?.title ? ` (${subtask.title})` : ''} in the current Codex session, then run execute/validate.`;
    }
    case 'draft_contract':
      return `Draft a SprintContract for subtask ${decision.subtaskId}, then ask Claude Questioner to challenge it before acceptance.`;
    case 'ask_claude_question_contract':
      return `Ask Claude Questioner to challenge the SprintContract for subtask ${decision.subtaskId}, then accept or revise the contract.`;
    case 'run_codex_evaluator':
    case 're_evaluate':
      return `Start an isolated read-only Codex Evaluator session for subtask ${decision.subtaskId}, then record its EvaluationResult.`;
    case 'ask_claude_question_evaluation':
      return `Ask Claude Questioner to challenge the evaluation evidence for subtask ${decision.subtaskId}.`;
    case 'fix_evaluation_findings':
      return `Fix Codex Evaluator or Claude Questioner findings for subtask ${decision.subtaskId}, then re-evaluate.`;
    case 'validate_subtask':
      return `Run the validation commands for subtask ${decision.subtaskId}, then record validation evidence.`;
    case 'request_claude_review':
    case 'request_re_review':
      return `Request a Tik-owned Claude review for subtask ${decision.subtaskId}.`;
    case 'fix_claude_blockers':
      return `Fix Claude blocking issues for subtask ${decision.subtaskId} in the current Codex session, then record fix evidence and request re-review.`;
    case 'request_final_review':
      return 'Request final Claude review for the workflow before completion.';
    case 'complete_subtask':
      return `Mark subtask ${decision.subtaskId} done after validation and review approval.`;
    case 'complete_workflow':
      return 'Workflow can be completed after final validation and review approval.';
    case 'request_human_review':
      return 'Create or surface a human review work item; Tik guardrails or policy require a person.';
    case 'abort_workflow':
      return 'Abort the workflow and preserve evidence for audit.';
    default:
      return `Handle workflow decision ${decision.action}.`;
  }
}
