import { allSubtasksDone } from './task-graph.mjs';

// Offline/debug fallback for CLI use when Kernel /next-action is unavailable.
// Kernel workflow-engine/planner.ts is canonical; keep mirror fixtures aligned.
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

  return workflow?.mode === 'review'
    ? decideNextReviewAction(state, graph, subtasks)
    : decideNextV1Action(state, graph, subtasks);
}

function collectEvidenceRefs(subtasks) {
  return Array.from(new Set(Object.values(subtasks).flatMap((subtask) => subtask.evidenceRefs || [])));
}

function decideNextReviewAction(state, graph, subtasks) {
  if (allSubtasksDone(graph, subtasks)) {
    const synthesis = (state.evidence || [])
      .filter((item) => item.kind === 'synthesis')
      .sort((left, right) => String(right.createdAt || '').localeCompare(String(left.createdAt || '')))[0];
    return synthesis
      ? {
        action: 'complete_workflow',
        reason: 'Readonly review evidence has been evaluated, questioned, and synthesized.',
        evidenceRefs: mergeRefs(collectEvidenceRefs(subtasks), [synthesis.id]),
        inputs: { taskGraphVersion: graph.version, synthesisEvidenceId: synthesis.id },
      }
      : {
        action: 'synthesize_review',
        reason: 'Readonly reviewers, focused evaluators, and Questioner checks are complete; synthesize the findings.',
        evidenceRefs: collectEvidenceRefs(subtasks),
        inputs: { taskGraphVersion: graph.version },
      };
  }
  const active = chooseNextV1Subtask(graph, subtasks);
  if (!active) {
    return {
      action: 'request_human_review',
      reason: 'No schedulable readonly review subtask is available.',
      evidenceRefs: collectEvidenceRefs(subtasks),
      inputs: { workflowStatus: state.workflow?.status },
    };
  }
  const subtaskId = active.id;
  const subtaskState = subtasks[subtaskId] || { subtaskId, status: 'pending', evidenceRefs: [] };
  const review = latestEvidence(state.evidence, subtaskId, ['review']);
  if (!review) {
    return {
      action: 'run_readonly_reviewer',
      subtaskId,
      reason: `Review shard ${subtaskId} is ready for a pinned-HEAD readonly Codex reviewer.`,
      evidenceRefs: subtaskState.evidenceRefs || [],
      inputs: { title: active.title },
    };
  }
  const evaluation = latestEvaluation(state.evaluationRuns, subtaskId);
  if (!evaluation) {
    return {
      action: 'run_codex_evaluator',
      subtaskId,
      reason: `Review shard ${subtaskId} has candidates; run a focused evaluator over those candidates only.`,
      evidenceRefs: mergeRefs(subtaskState.evidenceRefs, [review.id]),
      inputs: { reviewEvidenceId: review.id },
    };
  }
  if (evaluation.status === 'invalidated') {
    return {
      action: 'request_human_review',
      subtaskId,
      reason: `Review evaluator ${evaluation.id} violated readonly policy.`,
      evidenceRefs: mergeRefs(subtaskState.evidenceRefs, [review.id]),
      inputs: { evaluationRunId: evaluation.id },
    };
  }
  if (!evaluation.result || evaluation.status !== 'passed' || evaluation.result.verdict !== 'pass') {
    return {
      action: 're_evaluate',
      subtaskId,
      reason: `Review evaluator ${evaluation.id} did not produce a passing candidate verification result.`,
      evidenceRefs: mergeRefs(subtaskState.evidenceRefs, [review.id]),
      inputs: { evaluationRunId: evaluation.id, reviewEvidenceId: review.id },
    };
  }
  const questioned = latestMatchingQuestionerOutput(state, {
    subtaskId,
    intent: 'question_evaluation',
    evaluationRunId: evaluation.id,
    headSha: evaluation.result?.headSha || evaluation.headSha,
  });
  if (state.workflow?.policy?.requireQuestionerAfterEvaluation && !questioned) {
    return {
      action: 'ask_claude_question_evaluation',
      subtaskId,
      reason: `Focused evaluation ${evaluation.id} passed; Claude Questioner should challenge the remaining candidates.`,
      evidenceRefs: mergeRefs(subtaskState.evidenceRefs, [review.id]),
      inputs: { evaluationRunId: evaluation.id, reviewEvidenceId: review.id },
    };
  }
  if (hasBlockingQuestionerFindings(questioned)) {
    return {
      action: 'request_human_review',
      subtaskId,
      reason: `Questioner output ${questioned.id} contains unresolved review questions.`,
      evidenceRefs: mergeRefs(subtaskState.evidenceRefs, [review.id]),
      inputs: { evaluationRunId: evaluation.id, questionerOutputId: questioned.id },
    };
  }
  return {
    action: 'complete_subtask',
    subtaskId,
    reason: `Review shard ${subtaskId} has readonly review evidence, focused evaluation, and no blocking Questioner output.`,
    evidenceRefs: mergeRefs(subtaskState.evidenceRefs, [review.id]),
    inputs: { evaluationRunId: evaluation.id, reviewEvidenceId: review.id, questionerOutputId: questioned?.id },
  };
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
    const finalQuestioner = latestMatchingQuestionerOutput(state, {
      subtaskId: undefined,
      intent: 'question_final_evidence',
      finalEvaluationRunId: finalEvaluation.id,
      headSha: finalEvaluation.result?.headSha || finalEvaluation.headSha,
    });
    if (state.workflow?.policy?.requireQuestionerAfterEvaluation && !finalQuestioner) {
      return {
        action: 'ask_claude_question_final_evidence',
        reason: `Final Codex evaluation ${finalEvaluation.id} passed; Claude Questioner should challenge final evidence.`,
        evidenceRefs: collectEvidenceRefs(subtasks),
        inputs: { taskGraphVersion: graph.version, evaluationRunId: finalEvaluation.id },
      };
    }
    if (hasBlockingQuestionerFindings(finalQuestioner)) {
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
    // Once fix_evaluation_findings has been recorded and the subtask is in
    // needs_fix, the sanctioned next step is a fresh Codex Builder run.
    // Recommend execute_subtask directly rather than looping back to another
    // fix_evaluation_findings (or falling through to the per-subtask path
    // that would also loop back on the pre-fix failed evaluation).
    // See parallel fix in packages/kernel/src/multi-agent/workflow-engine/planner.ts.
    const alreadyDecidedFix = needsFix.status === 'needs_fix'
      && (state.decisions || []).some((dec) =>
        dec.action === 'fix_evaluation_findings' && dec.subtaskId === needsFix.subtaskId);
    if (alreadyDecidedFix) {
      return {
        action: 'execute_subtask',
        subtaskId: needsFix.subtaskId,
        reason: `Subtask ${needsFix.subtaskId} recorded fix_evaluation_findings; run Codex Builder to record corrective evidence.`,
        evidenceRefs: needsFix.evidenceRefs || [],
        inputs: { fixRound: needsFix.fixRound || 0 },
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
    const questionedContract = latestMatchingQuestionerOutput(state, {
      subtaskId,
      intent: 'question_contract',
      contractId: contract.id,
      headSha: contract.headShaAtAcceptance || state.workflow?.currentHeadSha,
    });
    if (state.workflow?.policy?.requireQuestionerBeforeBuild && !questionedContract) {
      return {
        action: 'ask_claude_question_contract',
        subtaskId,
        reason: `SprintContract ${contract.id} is ${contract.status}; Claude Questioner must challenge it before acceptance.`,
        evidenceRefs: subtaskState.evidenceRefs || [],
        inputs: { contractId: contract.id },
      };
    }
    if (hasBlockingQuestionerFindings(questionedContract)) {
      return {
        action: 'draft_contract',
        subtaskId,
        reason: `Contract Questioner output ${questionedContract.id} contains blocking questions; revise the SprintContract.`,
        evidenceRefs: subtaskState.evidenceRefs || [],
        inputs: { contractId: contract.id, questionerOutputId: questionedContract.id },
      };
    }
    if (state.workflow?.policy?.requireQuestionerBeforeBuild && questionedContract) {
      return {
        action: 'accept_contract',
        subtaskId,
        reason: `SprintContract ${contract.id} has a validated Questioner challenge and can be accepted.`,
        evidenceRefs: subtaskState.evidenceRefs || [],
        inputs: { contractId: contract.id, questionerOutputId: questionedContract.id },
      };
    }
    if (state.workflow?.policy?.requireQuestionerBeforeBuild) {
      return {
        action: 'ask_claude_question_contract',
        subtaskId,
        reason: `SprintContract ${contract.id} is ${contract.status}; Claude Questioner should challenge it before acceptance.`,
        evidenceRefs: subtaskState.evidenceRefs || [],
        inputs: { contractId: contract.id },
      };
    }
    return {
      action: 'accept_contract',
      subtaskId,
      reason: `SprintContract ${contract.id} is drafted and the workflow does not require a pre-build Questioner challenge.`,
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

  const questioned = latestMatchingQuestionerOutput(state, {
    subtaskId,
    intent: 'question_evaluation',
    contractId: contract.id,
    evaluationRunId: evaluation.id,
    headSha: evaluation.result?.headSha || evaluation.headSha,
  });
  if (state.workflow?.policy?.requireQuestionerAfterEvaluation && !questioned) {
    return {
      action: 'ask_claude_question_evaluation',
      subtaskId,
      reason: `Codex evaluation ${evaluation.id} passed; Claude Questioner should challenge the evidence.`,
      evidenceRefs: mergeRefs(subtaskState.evidenceRefs, [implementation.id]),
      inputs: { contractId: contract.id, evaluationRunId: evaluation.id },
    };
  }

  if (hasBlockingQuestionerFindings(questioned)) {
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

function latestMatchingQuestionerOutput(state, input) {
  return (state.questionerOutputs || [])
    .filter((output) => output.subtaskId === input.subtaskId && output.intent === input.intent)
    .filter((output) => output.schemaVersion === 'questioner-output.v2')
    .filter((output) => input.contractId === undefined || output.references?.contractId === input.contractId || output.contractId === input.contractId)
    .filter((output) => input.evaluationRunId === undefined || output.references?.evaluationRunId === input.evaluationRunId || output.evaluationRunId === input.evaluationRunId)
    .filter((output) => input.finalEvaluationRunId === undefined || output.references?.finalEvaluationRunId === input.finalEvaluationRunId || output.finalEvaluationRunId === input.finalEvaluationRunId)
    .filter((output) => input.headSha === undefined || output.attestation?.headSha === input.headSha || output.headSha === input.headSha)
    .filter((output) => {
      const invocation = output.actor?.invocationId
        ? (state.invocations || []).find((candidate) => candidate.id === output.actor.invocationId)
        : undefined;
      if (!invocation || invocation.status !== 'completed') return false;
      const run = output.questionerRunId
        ? (state.questionerRuns || []).find((candidate) => candidate.id === output.questionerRunId)
        : undefined;
      if (!run || run.status !== 'validated') return false;
      if (run.invocationId !== invocation.id) return false;
      if (run.contextHash !== output.attestation?.contextHash) return false;
      if (run.contextArtifactRef !== output.attestation?.contextArtifactRef) return false;
      if (run.outputHash && run.outputHash !== output.attestation?.outputHash) return false;
      return hasSufficientQuestionerCoverage(output);
    })
    .sort((left, right) => String(right.createdAt || '').localeCompare(String(left.createdAt || '')))[0];
}

function hasSufficientQuestionerCoverage(output) {
  if (!Array.isArray(output.coverageMatrix) || output.coverageMatrix.length === 0) return false;
  return output.coverageMatrix
    .filter((entry) => entry.required)
    .every((entry) => entry.status === 'covered' && entry.evidenceRefs?.length > 0 && String(entry.comment || '').trim().length > 0);
}

function hasBlockingQuestionerFindings(output) {
  return Boolean(
    output
      && (
        output.verdict === 'questions_blocking'
        || output.verdict === 'need_clarification'
        || output.verdict === 'evidence_needed'
        || (output.questions || []).some((question) => question.priority === 'blocking' || question.priority === 'evidence_needed')
      ),
  );
}

function latestEvidence(evidence = [], subtaskId, kinds) {
  return evidence
    .filter((item) => item.subtaskId === subtaskId && kinds.includes(item.kind))
    .sort((left, right) => String(right.createdAt || '').localeCompare(String(left.createdAt || '')))[0];
}

function mergeRefs(left = [], right = []) {
  return Array.from(new Set([...left, ...right].filter(Boolean)));
}
