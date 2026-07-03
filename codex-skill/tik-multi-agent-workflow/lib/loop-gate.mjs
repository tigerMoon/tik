import { allSubtasksDone, chooseNextSubtask } from './task-graph.mjs';

export function decideNextAction(state) {
  const workflow = state.workflow;
  const graph = state.taskGraph;
  const subtasks = state.subtasks || {};

  if (!graph) {
    return {
      action: 'request_dynamic_plan',
      reason: 'Workflow has no TaskGraph yet.',
      evidenceRefs: [],
      inputs: {},
    };
  }

  if (usesCodexEvaluatorQuestionerGate(workflow)) {
    return decideNextV1Action(state, graph, subtasks);
  }

  if (allSubtasksDone(graph, subtasks)) {
    if (allDoneSubtasksHaveApprovedReview(state, graph)) {
      return {
        action: 'complete_workflow',
        reason: 'All subtasks are done and have approved Claude review evidence.',
        evidenceRefs: collectEvidenceRefs(subtasks),
        inputs: { taskGraphVersion: graph.version },
      };
    }
    return {
      action: 'request_final_review',
      reason: 'All subtasks are done; request final review before completing workflow.',
      evidenceRefs: collectEvidenceRefs(subtasks),
      inputs: { taskGraphVersion: graph.version },
    };
  }

  const needsFix = Object.values(subtasks).find((subtask) => subtask.status === 'needs_fix');
  if (needsFix) {
    return {
      action: 'fix_claude_blockers',
      subtaskId: needsFix.subtaskId,
      reason: 'Subtask is waiting for Codex to fix Claude blocking issues.',
      evidenceRefs: needsFix.evidenceRefs || [],
      inputs: { fixRound: needsFix.fixRound || 0 },
    };
  }

  const implemented = Object.values(subtasks).find((subtask) => subtask.status === 'implemented');
  if (implemented) {
    return {
      action: 'validate_subtask',
      subtaskId: implemented.subtaskId,
      reason: 'Subtask has implementation evidence and should be validated.',
      evidenceRefs: implemented.evidenceRefs || [],
      inputs: {},
    };
  }

  const validated = Object.values(subtasks).find((subtask) => subtask.status === 'validated' || subtask.status === 'approved');
  if (validated) {
    return {
      action: 'request_claude_review',
      subtaskId: validated.subtaskId,
      reason: 'Subtask has passed validation and should be reviewed by Claude through Tik.',
      evidenceRefs: validated.evidenceRefs || [],
      inputs: {},
    };
  }

  const validationFailed = Object.values(subtasks).find((subtask) => subtask.status === 'validation_failed');
  if (validationFailed) {
    return {
      action: 'execute_subtask',
      subtaskId: validationFailed.subtaskId,
      reason: 'Validation failed; current Codex session should inspect and fix the subtask.',
      evidenceRefs: validationFailed.evidenceRefs || [],
      inputs: { retry: true },
    };
  }

  const reviewing = Object.values(subtasks).find((subtask) => subtask.status === 'reviewing');
  if (reviewing) {
    return {
      action: 'request_re_review',
      subtaskId: reviewing.subtaskId,
      reason: 'Subtask is in review state; process or request the next Claude review round.',
      evidenceRefs: reviewing.evidenceRefs || [],
      inputs: {},
    };
  }

  const ready = chooseNextSubtask(graph, subtasks);
  if (ready) {
    return {
      action: 'execute_subtask',
      subtaskId: ready.id,
      reason: `Subtask ${ready.id} is ready and dependencies are done.`,
      evidenceRefs: [],
      inputs: { title: ready.title },
    };
  }

  return {
    action: 'request_human_review',
    reason: 'No schedulable subtask or automatic workflow action is available.',
    evidenceRefs: collectEvidenceRefs(subtasks),
    inputs: { workflowStatus: workflow?.status },
  };
}

function collectEvidenceRefs(subtasks) {
  return Array.from(new Set(Object.values(subtasks).flatMap((subtask) => subtask.evidenceRefs || [])));
}

function allDoneSubtasksHaveApprovedReview(state, graph) {
  const evidence = state.evidence || [];
  return graph.subtasks.every((subtask) =>
    evidence.some((item) => {
      const result = item.payload?.result;
      return item.kind === 'review'
        && item.subtaskId === subtask.id
        && result?.verdict === 'approve'
        && (!Array.isArray(result.blockingIssues) || result.blockingIssues.length === 0);
    })
  );
}

function decideNextV1Action(state, graph, subtasks) {
  if (allSubtasksDone(graph, subtasks)) {
    const finalEvaluation = latestEvaluation(state.evaluationRuns, '__final__');
    if (!finalEvaluation) {
      return {
        action: 'run_final_evaluation',
        reason: 'All subtasks are done; run final Codex evaluation before completing workflow.',
        evidenceRefs: collectEvidenceRefs(subtasks),
        inputs: { taskGraphVersion: graph.version },
      };
    }
    if (finalEvaluation.status === 'failed' || finalEvaluation.result?.verdict === 'fail') {
      return {
        action: 'request_human_review',
        reason: `Final Codex evaluation ${finalEvaluation.id} failed.`,
        evidenceRefs: collectEvidenceRefs(subtasks),
        inputs: { taskGraphVersion: graph.version, evaluationRunId: finalEvaluation.id },
      };
    }
    if (finalEvaluation.status === 'invalidated') {
      return {
        action: 'request_human_review',
        reason: `Final Codex evaluation ${finalEvaluation.id} violated readonly policy and was invalidated.`,
        evidenceRefs: collectEvidenceRefs(subtasks),
        inputs: { taskGraphVersion: graph.version, evaluationRunId: finalEvaluation.id },
      };
    }
    if (finalEvaluation.status === 'inconclusive' || finalEvaluation.result?.verdict === 'inconclusive') {
      return {
        action: 'run_final_evaluation',
        reason: `Final Codex evaluation ${finalEvaluation.id} was inconclusive; run a new final evaluator session.`,
        evidenceRefs: collectEvidenceRefs(subtasks),
        inputs: { taskGraphVersion: graph.version, evaluationRunId: finalEvaluation.id },
      };
    }
    const finalQuestioner = latestQuestionerOutput(state.questionerOutputs, undefined, 'question_final_evidence');
    if (state.workflow?.policy?.requireQuestionerAfterEvaluation && !finalQuestioner) {
      return {
        action: 'ask_claude_question_final_evidence',
        reason: `Final Codex evaluation ${finalEvaluation.id} passed; Claude Questioner should challenge final evidence.`,
        evidenceRefs: collectEvidenceRefs(subtasks),
        inputs: { taskGraphVersion: graph.version, evaluationRunId: finalEvaluation.id },
      };
    }
    if (finalQuestioner?.questions?.some((question) => question.priority === 'blocking')) {
      return {
        action: 'request_human_review',
        reason: `Final Claude Questioner output ${finalQuestioner.id} contains blocking questions.`,
        evidenceRefs: collectEvidenceRefs(subtasks),
        inputs: { taskGraphVersion: graph.version, evaluationRunId: finalEvaluation.id, questionerOutputId: finalQuestioner.id },
      };
    }
    return {
      action: 'complete_workflow',
      reason: 'All subtasks are done, final evaluation passed, and final Questioner has no blocking questions.',
      evidenceRefs: collectEvidenceRefs(subtasks),
      inputs: { taskGraphVersion: graph.version, evaluationRunId: finalEvaluation.id, questionerOutputId: finalQuestioner?.id },
    };
  }

  const needsFix = Object.values(subtasks).find((subtask) => subtask.status === 'needs_fix' || subtask.status === 'evaluation_failed');
  if (needsFix) {
    const invalidatedEvaluation = latestEvaluationWithStatus(state.evaluationRuns, needsFix.subtaskId, ['invalidated']);
    if (invalidatedEvaluation?.status === 'invalidated') {
      return {
        action: 'request_human_review',
        subtaskId: needsFix.subtaskId,
        reason: `Codex evaluation ${invalidatedEvaluation.id} violated readonly policy and was invalidated.`,
        evidenceRefs: needsFix.evidenceRefs || [],
        inputs: { fixRound: needsFix.fixRound || 0, evaluationRunId: invalidatedEvaluation.id },
      };
    }
    return {
      action: 'fix_evaluation_findings',
      subtaskId: needsFix.subtaskId,
      reason: 'Subtask needs Codex Builder to fix evaluator or questioner findings.',
      evidenceRefs: needsFix.evidenceRefs || [],
      inputs: {
        fixRound: needsFix.fixRound || 0,
        evaluationRunId: latestFailedEvaluation(state.evaluationRuns, needsFix.subtaskId)?.id,
      },
    };
  }

  const active = chooseNextV1Subtask(graph, subtasks);
  if (!active) {
    return {
      action: 'request_human_review',
      reason: 'No schedulable v1 subtask or automatic workflow action is available.',
      evidenceRefs: collectEvidenceRefs(subtasks),
      inputs: { workflowStatus: state.workflow?.status },
    };
  }

  const subtaskId = active.id;
  const subtaskState = subtasks[subtaskId] || { subtaskId, status: 'pending', evidenceRefs: [] };
  const contract = latestContract(state.contracts, subtaskId);

  if (!contract) {
    return {
      action: 'draft_contract',
      subtaskId,
      reason: `Subtask ${subtaskId} needs a SprintContract before Codex Builder starts.`,
      evidenceRefs: subtaskState.evidenceRefs || [],
      inputs: { title: active.title },
    };
  }

  if (contract.status !== 'accepted') {
    return {
      action: 'ask_claude_question_contract',
      subtaskId,
      reason: `SprintContract ${contract.id} is ${contract.status}; Claude Questioner should challenge it before acceptance.`,
      evidenceRefs: subtaskState.evidenceRefs || [],
      inputs: { contractId: contract.id },
    };
  }

  const implementation = latestEvidence(state.evidence, subtaskId, ['implementation', 'fix']);
  if (!implementation) {
    return {
      action: 'execute_subtask',
      subtaskId,
      reason: `Subtask ${subtaskId} has an accepted contract and is ready for Codex Builder.`,
      evidenceRefs: subtaskState.evidenceRefs || [],
      inputs: { title: active.title, contractId: contract.id },
    };
  }

  const evaluation = latestEvaluation(state.evaluationRuns, subtaskId);
  if (!evaluation) {
    return {
      action: 'run_codex_evaluator',
      subtaskId,
      reason: `Subtask ${subtaskId} has implementation evidence and needs isolated Codex evaluation.`,
      evidenceRefs: mergeRefs(subtaskState.evidenceRefs, [implementation.id]),
      inputs: { contractId: contract.id, implementationEvidenceId: implementation.id },
    };
  }

  if (evaluation.status === 'failed' || evaluation.result?.verdict === 'fail') {
    return {
      action: 'fix_evaluation_findings',
      subtaskId,
      reason: `Codex evaluation ${evaluation.id} failed; Builder must fix findings.`,
      evidenceRefs: mergeRefs(subtaskState.evidenceRefs, [implementation.id]),
      inputs: { contractId: contract.id, evaluationRunId: evaluation.id },
    };
  }

  if (evaluation.status === 'invalidated') {
    return {
      action: 'request_human_review',
      subtaskId,
      reason: `Codex evaluation ${evaluation.id} violated readonly policy and was invalidated.`,
      evidenceRefs: mergeRefs(subtaskState.evidenceRefs, [implementation.id]),
      inputs: { contractId: contract.id, evaluationRunId: evaluation.id },
    };
  }

  if (evaluation.status === 'inconclusive' || evaluation.result?.verdict === 'inconclusive') {
    return {
      action: 're_evaluate',
      subtaskId,
      reason: `Codex evaluation ${evaluation.id} was inconclusive; run a new evaluator session.`,
      evidenceRefs: mergeRefs(subtaskState.evidenceRefs, [implementation.id]),
      inputs: { contractId: contract.id, evaluationRunId: evaluation.id },
    };
  }

  const questioned = latestQuestionerOutput(state.questionerOutputs, subtaskId, 'question_evaluation');
  if (state.workflow?.policy?.requireQuestionerAfterEvaluation && !questioned) {
    return {
      action: 'ask_claude_question_evaluation',
      subtaskId,
      reason: `Codex evaluation ${evaluation.id} passed; Claude Questioner should challenge the evidence.`,
      evidenceRefs: mergeRefs(subtaskState.evidenceRefs, [implementation.id]),
      inputs: { contractId: contract.id, evaluationRunId: evaluation.id },
    };
  }

  if (questioned?.questions?.some((question) => question.priority === 'blocking')) {
    return {
      action: 'fix_evaluation_findings',
      subtaskId,
      reason: `Claude Questioner output ${questioned.id} contains blocking questions.`,
      evidenceRefs: mergeRefs(subtaskState.evidenceRefs, [implementation.id]),
      inputs: { contractId: contract.id, evaluationRunId: evaluation.id, questionerOutputId: questioned.id },
    };
  }

  return {
    action: 'complete_subtask',
    subtaskId,
    reason: `Subtask ${subtaskId} has accepted contract, implementation evidence, passing evaluation, and no blocking questioner output.`,
    evidenceRefs: mergeRefs(subtaskState.evidenceRefs, [implementation.id]),
    inputs: { contractId: contract.id, evaluationRunId: evaluation.id, questionerOutputId: questioned?.id },
  };
}

function chooseNextV1Subtask(graph, states) {
  if (!graph?.subtasks?.length) return null;
  return graph.subtasks.find((subtask) => {
    const state = states?.[subtask.id];
    const status = state?.status || 'pending';
    if (status === 'done' || status === 'blocked' || status === 'human_review_required') return false;
    return (subtask.dependsOn || []).every((dep) => states?.[dep]?.status === 'done');
  }) || null;
}

function usesCodexEvaluatorQuestionerGate(workflow) {
  const policy = workflow?.policy;
  return Boolean(
    policy?.requireAcceptedContract
      || policy?.requireEvaluationPassForComplete
      || policy?.requireQuestionerAfterEvaluation,
  );
}

function latestContract(contracts = [], subtaskId) {
  return contracts
    .filter((contract) => contract.subtaskId === subtaskId)
    .sort((left, right) => (right.version || 0) - (left.version || 0) || String(right.acceptedAt || '').localeCompare(String(left.acceptedAt || '')))[0];
}

function latestEvaluation(evaluationRuns = [], subtaskId) {
  return evaluationRuns
    .filter((run) => run.subtaskId === subtaskId)
    .sort((left, right) => String(right.startedAt || '').localeCompare(String(left.startedAt || '')))[0];
}

function latestEvaluationWithStatus(evaluationRuns = [], subtaskId, statuses = []) {
  const allowed = new Set(statuses);
  return evaluationRuns
    .filter((run) => run.subtaskId === subtaskId && allowed.has(run.status))
    .sort((left, right) => String(right.startedAt || '').localeCompare(String(left.startedAt || '')))[0];
}

function latestFailedEvaluation(evaluationRuns = [], subtaskId) {
  return evaluationRuns
    .filter((run) => run.subtaskId === subtaskId && (run.status === 'failed' || run.result?.verdict === 'fail'))
    .sort((left, right) => String(right.startedAt || '').localeCompare(String(left.startedAt || '')))[0];
}

function latestQuestionerOutput(outputs = [], subtaskId, intent) {
  return outputs
    .filter((output) => output.subtaskId === subtaskId && output.intent === intent)
    .sort((left, right) => String(right.createdAt || '').localeCompare(String(left.createdAt || '')))[0];
}

function latestEvidence(evidence = [], subtaskId, kinds) {
  return evidence
    .filter((item) => item.subtaskId === subtaskId && kinds.includes(item.kind))
    .sort((left, right) => String(right.createdAt || '').localeCompare(String(left.createdAt || '')))[0];
}

function mergeRefs(left = [], right = []) {
  return Array.from(new Set([...left, ...right].filter(Boolean)));
}
