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
    case 'run_final_evaluation':
      return 'Start an isolated read-only Codex Evaluator session for final workflow evidence, then record its EvaluationResult.';
    case 'ask_claude_question_evaluation':
      return `Start an async Claude Questioner subagent to challenge the evaluation evidence for subtask ${decision.subtaskId}; the hook/callback records QuestionerOutputV2.`;
    case 'ask_claude_question_final_evidence':
      return 'Start an async Claude Questioner subagent to challenge final evidence; the hook/callback records QuestionerOutputV2 before workflow completion.';
    case 'fix_evaluation_findings':
      return `Fix Codex Evaluator or Claude Questioner findings for subtask ${decision.subtaskId}, then re-evaluate.`;
    case 'validate_subtask':
      return `Run the validation commands for subtask ${decision.subtaskId}, then record validation evidence.`;
    case 'complete_subtask':
      return `Complete subtask ${decision.subtaskId} only after contract, implementation evidence, Codex evaluation evidence, Claude Questioner approval, same-headSha, scope, and subagent-isolation guards pass.`;
    case 'complete_workflow':
      return 'Complete workflow only after all subtasks are done and final evaluation/questioner evidence passes Tik guards.';
    case 'request_human_review':
      return 'Create or surface a human review work item; Tik guardrails or policy require a person.';
    case 'abort_workflow':
      return 'Abort the workflow and preserve evidence for audit.';
    default:
      return `Handle workflow decision ${decision.action}.`;
  }
}
