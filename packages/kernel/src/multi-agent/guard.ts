import * as path from 'node:path';
import type {
  EvaluationRun,
  FinalWorkflowContract,
  GuardResult,
  ImplementationEvidencePayload,
  MultiAgentWorkflowBundle,
  MultiAgentWorkflowEvidence,
  MultiAgentWorkflowRecord,
  QuestionerOutput,
  SprintContract,
  WorkflowDecision,
} from '@tik/shared';

export function evaluateWorkflowDecisionGuard(
  bundle: MultiAgentWorkflowBundle,
  decision: WorkflowDecision,
): GuardResult {
  if (decision.workflowId !== bundle.workflow.id) {
    return reject('invalid_transition', `Decision workflowId ${decision.workflowId} does not match workflow ${bundle.workflow.id}.`, {
      workflowId: bundle.workflow.id,
    });
  }

  if (decision.decidedBy !== 'codex-workflow' && decision.decidedBy !== 'codex-workflow-plugin') {
    return reject('invalid_transition', 'Only codex-workflow decisions can be recorded on multi-agent workflows.');
  }

  if (!Array.isArray(decision.evidenceRefs)) {
    return reject('invalid_transition', 'Decision evidenceRefs must be an array.');
  }

  if (bundle.workflow.status !== 'active') {
    return reject('invalid_transition', `Workflow ${bundle.workflow.id} is ${bundle.workflow.status}.`, {
      status: bundle.workflow.status,
    });
  }

  if (decision.subtaskId && bundle.taskGraph && !bundle.subtasks[decision.subtaskId]) {
    return reject('invalid_transition', `Unknown subtask ${decision.subtaskId}.`);
  }

  const plannedEvidenceRefs = plannedEvidenceRefsForDecision(bundle, decision);
  const missingEvidence = decision.evidenceRefs.filter((ref) => !hasEvidence(bundle.evidence, ref) && !plannedEvidenceRefs.has(ref));
  if (missingEvidence.length > 0) {
    return reject('missing_evidence', `Decision references missing evidence: ${missingEvidence.join(', ')}.`, {
      missingEvidence,
    });
  }

  const round = readNumberInput(decision.inputs, 'round');
  if (
    (decision.action === 'request_re_review' || decision.action === 'request_claude_review')
    && round !== undefined
    && round > bundle.workflow.maxRounds
  ) {
    return reject(
      'max_rounds_exceeded',
      `Review round ${round} exceeds maxRounds=${bundle.workflow.maxRounds}.`,
      { round, maxRounds: bundle.workflow.maxRounds },
    );
  }

  const decisionHeadSha = readStringInput(decision.inputs, 'currentHeadSha')
    || readStringInput(decision.inputs, 'headSha');
  if (bundle.workflow.currentHeadSha && decisionHeadSha && decisionHeadSha !== bundle.workflow.currentHeadSha) {
    return reject(
      'head_sha_mismatch',
      `Decision head sha ${decisionHeadSha} does not match workflow head sha ${bundle.workflow.currentHeadSha}.`,
      { expectedHeadSha: bundle.workflow.currentHeadSha, actualHeadSha: decisionHeadSha },
    );
  }

  const workspaceScope = validateWorkspaceBinding(bundle.workflow);
  if (!workspaceScope.accepted) {
    return workspaceScope;
  }

  const actionGuard = validateActionTransition(bundle, decision);
  if (!actionGuard.accepted) {
    return actionGuard;
  }

  return {
    accepted: true,
    code: 'ok',
  };
}

function hasEvidence(evidence: MultiAgentWorkflowEvidence[], evidenceId: string): boolean {
  return evidence.some((item) => item.id === evidenceId);
}

function validateActionTransition(
  bundle: MultiAgentWorkflowBundle,
  decision: WorkflowDecision,
): GuardResult {
  switch (decision.action) {
    case 'request_dynamic_plan':
      if (bundle.taskGraph) {
        return reject('invalid_transition', 'Workflow already has a TaskGraph.');
      }
      return accept();

    case 'execute_subtask':
      return guardCanExecuteSubtask(bundle, decision, [
        'pending',
        'ready',
        'contract_accepted',
        'validation_failed',
        'evaluation_failed',
        'needs_fix',
        'fixing',
        'blocked',
      ]);

    case 'ask_claude_question_requirement':
    case 'ask_claude_question_task_graph':
      return accept();

    case 'draft_contract':
      return requireSubtaskStatus(bundle, decision, ['pending', 'ready', 'contract_drafting', 'contract_questioning']);

    case 'ask_claude_question_contract': {
      const statusGuard = requireSubtaskStatus(bundle, decision, ['contract_drafting', 'contract_questioning']);
      if (!statusGuard.accepted) return statusGuard;
      return decision.subtaskId && latestContract(bundle, decision.subtaskId)
        ? accept()
        : reject('missing_contract', 'Questioning a contract requires a drafted SprintContract.');
    }

    case 'accept_contract': {
      const statusGuard = requireSubtaskStatus(bundle, decision, ['contract_drafting', 'contract_questioning']);
      if (!statusGuard.accepted) return statusGuard;
      const contract = decision.subtaskId ? latestContract(bundle, decision.subtaskId) : undefined;
      if (!contract) {
        return reject('missing_contract', 'Accepting a contract requires a drafted SprintContract.');
      }
      const questioner = latestQuestionerOutput(bundle, decision.subtaskId, 'question_contract');
      if (questioner && hasBlockingQuestions(questioner) && !bundle.workflow.policy?.allowHumanOverride) {
        return reject('blocking_question_unresolved', 'Contract has unresolved blocking Questioner output.', {
          questionerOutputId: questioner.id,
        });
      }
      return accept();
    }

    case 'record_implementation':
      return guardCanRecordImplementation(bundle, decision);

    case 'run_codex_evaluator':
    case 're_evaluate':
      return guardCanRunCodexEvaluator(bundle, decision);

    case 'ask_claude_question_evaluation':
      return guardCanQuestionEvaluation(bundle, decision);

    case 'fix_evaluation_findings':
      return guardCanFixEvaluationFindings(bundle, decision);

    case 'run_final_evaluation':
      if (!allSubtasksDone(bundle)) {
        return reject('invalid_transition', 'Final Codex evaluation requires all subtasks to be done.');
      }
      return accept();

    case 'ask_claude_question_final_evidence': {
      if (!allSubtasksDone(bundle)) {
        return reject('invalid_transition', 'Final evidence questioning requires all subtasks to be done.');
      }
      const evaluation = latestEvaluationRun(bundle, '__final__');
      if (!evaluation?.result) {
        return reject('missing_evaluation_result', 'Final evidence questioning requires a final Codex evaluation result.');
      }
      if (evaluation.status !== 'passed' || evaluation.result.verdict !== 'pass') {
        return reject('evaluation_not_passed', 'Final evidence questioning requires a passing final Codex evaluation result.', {
          evaluationRunId: evaluation.id,
          status: evaluation.status,
          verdict: evaluation.result.verdict,
        });
      }
      return accept();
    }

    case 'validate_subtask':
      if (hasPlannedReviewResult(decision)) {
        return requireSubtaskStatus(bundle, decision, [
          'implemented',
          'validating',
          'reviewing',
        ]);
      }
      return requireSubtaskStatus(bundle, decision, [
        'implemented',
        'validating',
      ]);

    case 'request_claude_review': {
      const statusGuard = requireSubtaskStatus(bundle, decision, ['validated', 'approved']);
      if (!statusGuard.accepted) return statusGuard;
      const validation = latestPassedValidationForSubtask(bundle, decision.subtaskId);
      if (!validation) {
        return reject('invalid_transition', 'Claude review requires passing validation evidence for the subtask.');
      }
      const headGuard = requireEvidenceHeadMatchesDecision(bundle, decision, validation, 'validation');
      if (!headGuard.accepted) return headGuard;
      return accept();
    }

    case 'fix_claude_blockers': {
      const statusGuard = requireSubtaskStatus(bundle, decision, ['needs_fix', 'reviewing']);
      if (!statusGuard.accepted) return statusGuard;
      const review = latestReviewEvidenceForSubtask(bundle, decision.subtaskId)
        || plannedReviewEvidenceForDecision(bundle, decision);
      if (!review || reviewBlockingIssueCount(review) === 0) {
        return reject('invalid_transition', 'Fixing Claude blockers requires review evidence with blocking findings.');
      }
      return accept();
    }

    case 'request_re_review': {
      const statusGuard = requireSubtaskStatus(bundle, decision, ['implemented', 'validated', 'fixing', 'reviewing']);
      if (!statusGuard.accepted) return statusGuard;
      const fix = latestEvidenceForSubtask(bundle, decision.subtaskId, 'fix');
      if (!fix && !hasTruthyInput(decision.inputs, 'fixRecorded')) {
        return reject('invalid_transition', 'Re-review requires recorded fix evidence.');
      }
      const validation = latestPassedValidationForSubtask(bundle, decision.subtaskId);
      if (!validation) {
        return reject('invalid_transition', 'Re-review requires passing validation evidence after the fix.');
      }
      const headGuard = requireEvidenceHeadMatchesDecision(bundle, decision, validation, 'validation');
      if (!headGuard.accepted) return headGuard;
      return accept();
    }

    case 'complete_subtask': {
      if (usesCodexEvaluatorQuestionerGate(bundle)) {
        return guardCompleteSubtaskV1(bundle, decision);
      }
      const statusGuard = requireSubtaskStatus(bundle, decision, ['review_approved', 'approved', 'reviewing']);
      if (!statusGuard.accepted) return statusGuard;
      const validation = latestPassedValidationForSubtask(bundle, decision.subtaskId);
      if (!validation) {
        return reject('invalid_transition', 'Completing a subtask requires passing validation evidence.');
      }
      const review = latestApprovedReviewForSubtask(bundle, decision.subtaskId)
        || plannedReviewEvidenceForDecision(bundle, decision);
      if (!review) {
        return reject('invalid_transition', 'Completing a subtask requires Claude approve review evidence.');
      }
      if (reviewBlockingIssueCount(review) > 0) {
        return reject('invalid_transition', 'Completing a subtask requires no unresolved Claude blocking findings.');
      }
      const validationHead = validation.headSha;
      const reviewHead = reviewHeadSha(review);
      if (validationHead && reviewHead && validationHead !== reviewHead) {
        return reject('head_sha_mismatch', 'Validation and Claude review evidence were recorded for different heads.', {
          validationHeadSha: validationHead,
          reviewHeadSha: reviewHead,
        });
      }
      const decisionHeadSha = readStringInput(decision.inputs, 'currentHeadSha')
        || readStringInput(decision.inputs, 'headSha');
      if (decisionHeadSha && validationHead && decisionHeadSha !== validationHead) {
        return reject('head_sha_mismatch', 'Subtask completion head does not match validation evidence head.', {
          expectedHeadSha: validationHead,
          actualHeadSha: decisionHeadSha,
        });
      }
      return accept();
    }

    case 'request_final_review':
      if (!allSubtasksDone(bundle)) {
        return reject('invalid_transition', 'Final review requires all subtasks to be done.');
      }
      return accept();

    case 'complete_workflow':
      if (!allSubtasksDone(bundle)) {
        return reject('invalid_transition', 'Completing a workflow requires all subtasks to be done.');
      }
      if (usesCodexEvaluatorQuestionerGate(bundle)) {
        return guardCompleteWorkflowV1(bundle, decision);
      }
      if (!hasApprovedFinalReview(bundle) && !allDoneSubtasksHaveApprovedReview(bundle) && !plannedFinalReviewApproved(decision)) {
        return reject('invalid_transition', 'Completing a workflow requires approved final review evidence.');
      }
      return accept();

    case 'abort_workflow':
    case 'request_replan':
    case 'skip_non_blocking_suggestions':
    case 'request_human_review':
      return accept();

    default:
      return reject('invalid_transition', `Unsupported workflow decision action: ${decision.action}.`);
  }
}

function requireSubtaskStatus(
  bundle: MultiAgentWorkflowBundle,
  decision: WorkflowDecision,
  allowed: string[],
): GuardResult {
  if (!decision.subtaskId) {
    return reject('invalid_transition', `Decision ${decision.action} requires subtaskId.`);
  }
  const subtask = bundle.subtasks[decision.subtaskId];
  if (!subtask) {
    return reject('invalid_transition', `Unknown subtask ${decision.subtaskId}.`);
  }
  if (!allowed.includes(subtask.status)) {
    return reject(
      'invalid_transition',
      `Decision ${decision.action} cannot run when subtask ${decision.subtaskId} is ${subtask.status}.`,
      { subtaskId: decision.subtaskId, status: subtask.status, allowed },
    );
  }
  return accept();
}

function guardCanExecuteSubtask(
  bundle: MultiAgentWorkflowBundle,
  decision: WorkflowDecision,
  allowed: string[],
): GuardResult {
  const statusGuard = requireSubtaskStatus(bundle, decision, allowed);
  if (!statusGuard.accepted) return statusGuard;
  if (!bundle.taskGraph || !decision.subtaskId) return accept();
  const contractGuard = requireAcceptedContractIfPolicyRequires(bundle, decision.subtaskId);
  if (!contractGuard.accepted) return contractGuard;
  const spec = bundle.taskGraph.subtasks.find((subtask) => subtask.id === decision.subtaskId);
  const missingDependencies = (spec?.dependsOn || [])
    .filter((dependencyId) => bundle.subtasks[dependencyId]?.status !== 'done');
  if (missingDependencies.length > 0) {
    return reject('invalid_transition', `Subtask ${decision.subtaskId} has unfinished dependencies: ${missingDependencies.join(', ')}.`, {
      subtaskId: decision.subtaskId,
      missingDependencies,
    });
  }
  return accept();
}

function guardCompleteSubtaskV1(
  bundle: MultiAgentWorkflowBundle,
  decision: WorkflowDecision,
): GuardResult {
  const statusGuard = requireSubtaskStatus(bundle, decision, [
    'evaluation_passed',
    'questioning_evidence',
    'reviewing',
    'review_approved',
    'approved',
  ]);
  if (!statusGuard.accepted) return statusGuard;
  const subtaskId = decision.subtaskId;
  if (!subtaskId) {
    return reject('invalid_transition', 'complete_subtask requires subtaskId.');
  }

  const contract = latestAcceptedContract(bundle, subtaskId);
  if (!contract) {
    return reject('missing_contract', `Subtask ${subtaskId} has no accepted SprintContract.`);
  }

  const implementation = latestImplementationEvidence(bundle, subtaskId);
  if (!implementation) {
    return reject('missing_implementation_evidence', `Subtask ${subtaskId} has no implementation evidence.`);
  }

  const evaluation = latestEvaluationRun(bundle, subtaskId);
  if (!evaluation?.result) {
    return reject('missing_evaluation_result', `Subtask ${subtaskId} has no Codex evaluation result.`);
  }
  if (evaluation.status === 'invalidated' || !evaluation.readonlyPolicy.enforced || (evaluation.readonlyPolicy.violations?.length || 0) > 0) {
    return reject('readonly_policy_violated', 'Codex evaluator readonly policy was not satisfied.', {
      evaluationRunId: evaluation.id,
      violations: evaluation.readonlyPolicy.violations || [],
    });
  }
  if (evaluation.status !== 'passed' || evaluation.result.verdict !== 'pass') {
    return reject('evaluation_not_passed', 'Completing a subtask requires a passing Codex evaluation result.', {
      evaluationRunId: evaluation.id,
      status: evaluation.status,
      verdict: evaluation.result.verdict,
    });
  }

  const evaluationEvidenceGuard = requireEvaluationCoversContract(evaluation, contract);
  if (!evaluationEvidenceGuard.accepted) return evaluationEvidenceGuard;

  const decisionHeadSha = readStringInput(decision.inputs, 'currentHeadSha')
    || readStringInput(decision.inputs, 'headSha')
    || bundle.workflow.currentHeadSha;
  if (bundle.workflow.policy?.requireSameHeadShaForEvidence !== false) {
    const expectedHead = decisionHeadSha || bundle.workflow.currentHeadSha;
    if (expectedHead && implementation.headSha && implementation.headSha !== expectedHead) {
      return reject('head_sha_mismatch', 'Implementation evidence head does not match workflow head.', {
        expectedHeadSha: expectedHead,
        implementationHeadSha: implementation.headSha,
      });
    }
    if (expectedHead && evaluation.result.headSha !== expectedHead) {
      return reject('head_sha_mismatch', 'Evaluation result head does not match workflow head.', {
        expectedHeadSha: expectedHead,
        evaluationHeadSha: evaluation.result.headSha,
      });
    }
    if (implementation.headSha && implementation.headSha !== evaluation.result.headSha) {
      return reject('head_sha_mismatch', 'Implementation and evaluation evidence were recorded for different heads.', {
        implementationHeadSha: implementation.headSha,
        evaluationHeadSha: evaluation.result.headSha,
      });
    }
  }

  const scopeGuard = requireImplementationWithinContractScope(implementation, contract);
  if (!scopeGuard.accepted) return scopeGuard;

  const subagentGuard = requireIsolatedCodexSubagents(bundle, subtaskId, implementation, evaluation);
  if (!subagentGuard.accepted) return subagentGuard;

  if (bundle.workflow.policy?.requireQuestionerAfterEvaluation) {
    const questioner = latestQuestionerOutput(bundle, subtaskId, 'question_evaluation');
    if (!questioner) {
      return reject('blocking_question_unresolved', 'Claude Questioner must inspect evaluation evidence before completion.');
    }
    const questionerGuard = requireQuestionerMatchesEvaluation(bundle, questioner, evaluation, contract);
    if (!questionerGuard.accepted) return questionerGuard;
    if (hasBlockingQuestions(questioner)) {
      return reject('blocking_question_unresolved', 'Claude Questioner has unresolved blocking questions.', {
        questionerOutputId: questioner.id,
      });
    }
  }

  return accept();
}

function requireIsolatedCodexSubagents(
  bundle: MultiAgentWorkflowBundle,
  subtaskId: string,
  implementation: MultiAgentWorkflowEvidence,
  evaluation: EvaluationRun,
): GuardResult {
  const builder = latestCompletedInvocation(bundle, subtaskId, (invocation) =>
    invocation.role === 'executor'
    && invocation.runner === 'codex'
    && (invocation.evidenceRefs || []).includes(implementation.id)
  );
  if (!builder) {
    return reject('missing_subagent_invocation', 'Subtask completion requires a completed Codex Builder subagent invocation linked to implementation evidence.', {
      subtaskId,
      evidenceId: implementation.id,
    });
  }

  const evaluator = latestCompletedInvocation(bundle, subtaskId, (invocation) =>
    invocation.role === 'evaluator'
    && invocation.runner === 'codex-evaluator'
    && invocation.evaluationRunId === evaluation.id
  );
  if (!evaluator) {
    return reject('missing_subagent_invocation', 'Subtask completion requires a completed Codex Evaluator subagent invocation linked to the evaluation run.', {
      subtaskId,
      evaluationRunId: evaluation.id,
    });
  }

  if (!isRuntimeAttestedInvocation(builder) || !isRuntimeAttestedInvocation(evaluator)) {
    return reject('missing_subagent_invocation', 'Builder and Evaluator invocations must be attested by the Codex subagent runtime.', {
      builderInvocationId: builder.id,
      evaluatorInvocationId: evaluator.id,
    });
  }

  const builderThreadId = builder.actualSubagentThreadId || builder.runtimeAttestation?.actualSubagentThreadId || builder.threadId;
  const evaluatorThreadId = evaluator.actualSubagentThreadId || evaluator.runtimeAttestation?.actualSubagentThreadId || evaluator.threadId;
  if (!builderThreadId || !evaluatorThreadId) {
    return reject('missing_subagent_invocation', 'Builder and Evaluator invocations must record actual Codex subagent thread ids.', {
      builderInvocationId: builder.id,
      evaluatorInvocationId: evaluator.id,
    });
  }
  if (builderThreadId === evaluatorThreadId) {
    return reject('subagent_thread_not_isolated', 'Builder and Evaluator must run in different Codex subagent threads.', {
      builderInvocationId: builder.id,
      evaluatorInvocationId: evaluator.id,
      threadId: builderThreadId,
    });
  }

  const builderParentThreadId = builder.parentThreadId || builder.runtimeAttestation?.parentThreadId;
  const evaluatorParentThreadId = evaluator.parentThreadId || evaluator.runtimeAttestation?.parentThreadId;
  const expectedParentThreadId = readWorkflowParentCodexThreadId(bundle.workflow);
  if (!builderParentThreadId || !evaluatorParentThreadId) {
    return reject('missing_subagent_invocation', 'Builder and Evaluator invocations must record Codex parent thread ids.', {
      builderInvocationId: builder.id,
      evaluatorInvocationId: evaluator.id,
    });
  }
  if (expectedParentThreadId && (builderParentThreadId !== expectedParentThreadId || evaluatorParentThreadId !== expectedParentThreadId)) {
    return reject('subagent_thread_not_isolated', 'Builder and Evaluator parent threads must match the workflow Codex parent thread.', {
      expectedParentThreadId,
      builderParentThreadId,
      evaluatorParentThreadId,
    });
  }
  if (!expectedParentThreadId && builderParentThreadId !== evaluatorParentThreadId) {
    return reject('subagent_thread_not_isolated', 'Builder and Evaluator must be spawned by the same Codex workflow parent thread.', {
      builderParentThreadId,
      evaluatorParentThreadId,
    });
  }

  if (builder.headSha && implementation.headSha && builder.headSha !== implementation.headSha) {
    return reject('head_sha_mismatch', 'Builder invocation head does not match implementation evidence head.', {
      builderHeadSha: builder.headSha,
      implementationHeadSha: implementation.headSha,
    });
  }
  if (evaluator.headSha && evaluation.result?.headSha && evaluator.headSha !== evaluation.result.headSha) {
    return reject('head_sha_mismatch', 'Evaluator invocation head does not match evaluation result head.', {
      evaluatorHeadSha: evaluator.headSha,
      evaluationHeadSha: evaluation.result.headSha,
    });
  }

  const readonlyPolicy = evaluator.readonlyPolicy;
  if (!readonlyPolicy?.enforced || (readonlyPolicy.violations?.length || 0) > 0) {
    return reject('readonly_policy_violated', 'Codex Evaluator subagent invocation did not satisfy readonly policy.', {
      evaluatorInvocationId: evaluator.id,
      violations: readonlyPolicy?.violations || [],
    });
  }

  return accept();
}

function guardCompleteWorkflowV1(
  bundle: MultiAgentWorkflowBundle,
  decision: WorkflowDecision,
): GuardResult {
  const evaluation = latestEvaluationRun(bundle, '__final__');
  if (!evaluation?.result) {
    return reject('missing_evaluation_result', 'Completing a v1 workflow requires a final Codex evaluation result.');
  }
  if (evaluation.status === 'invalidated' || !evaluation.readonlyPolicy.enforced || (evaluation.readonlyPolicy.violations?.length || 0) > 0) {
    return reject('readonly_policy_violated', 'Final Codex evaluation readonly policy was not satisfied.', {
      evaluationRunId: evaluation.id,
      violations: evaluation.readonlyPolicy.violations || [],
    });
  }
  if (evaluation.status !== 'passed' || evaluation.result.verdict !== 'pass') {
    return reject('evaluation_not_passed', 'Completing a workflow requires a passing final Codex evaluation result.', {
      evaluationRunId: evaluation.id,
      status: evaluation.status,
      verdict: evaluation.result.verdict,
    });
  }

  const decisionHeadSha = readStringInput(decision.inputs, 'currentHeadSha')
    || readStringInput(decision.inputs, 'headSha')
    || bundle.workflow.currentHeadSha;
  if (decisionHeadSha && evaluation.result.headSha && decisionHeadSha !== evaluation.result.headSha) {
    return reject('head_sha_mismatch', 'Final evaluation head does not match workflow completion head.', {
      expectedHeadSha: decisionHeadSha,
      evaluationHeadSha: evaluation.result.headSha,
    });
  }

  if (bundle.workflow.policy?.requireQuestionerAfterEvaluation) {
    const questioner = latestQuestionerOutput(bundle, undefined, 'question_final_evidence');
    if (!questioner) {
      return reject('blocking_question_unresolved', 'Claude Questioner must inspect final evidence before workflow completion.');
    }
    const questionerGuard = requireQuestionerMatchesFinalEvaluation(bundle, questioner, evaluation);
    if (!questionerGuard.accepted) return questionerGuard;
    if (hasBlockingQuestions(questioner)) {
      return reject('blocking_question_unresolved', 'Claude Questioner has unresolved final blocking questions.', {
        questionerOutputId: questioner.id,
      });
    }
  }

  const finalCoverageGuard = requireFinalEvaluationCoversWorkflowContract(evaluation, bundle);
  if (!finalCoverageGuard.accepted) return finalCoverageGuard;

  return accept();
}

function requireFinalEvaluationCoversWorkflowContract(
  evaluation: EvaluationRun,
  bundle: MultiAgentWorkflowBundle,
): GuardResult {
  const result = evaluation.result;
  if (!result) {
    return reject('missing_evaluation_result', 'Final evaluation result is required.');
  }
  const contract = buildFinalWorkflowContract(bundle);
  const resultsByCriterion = new Map(result.criteriaResults.map((criterionResult) => [criterionResult.criterionId, criterionResult]));
  const missingOrFailed = contract.globalAcceptanceCriteria
    .filter((criterion) => criterion.priority === 'must')
    .filter((criterion) => resultsByCriterion.get(criterion.id)?.status !== 'pass')
    .map((criterion) => criterion.id);
  if (missingOrFailed.length > 0) {
    return reject('evaluation_evidence_insufficient', 'Final evaluation must pass every global must acceptance criterion.', {
      evaluationRunId: evaluation.id,
      missingOrFailedCriteria: missingOrFailed,
    });
  }

  const missingCommands = contract.finalValidationCommands
    .filter((command) => !result.commandResults.some((commandResult) =>
      commandResult.status === 'passed'
      && (commandResult.command === command || commandResult.commandId === command)
    ));
  if (missingCommands.length > 0) {
    return reject('evaluation_evidence_insufficient', 'Final evaluation must include passed evidence for every final validation command.', {
      evaluationRunId: evaluation.id,
      missingCommands,
    });
  }

  const hasRequiredEvidence = contract.requiredEvidenceKinds.every((kind) => {
    if (kind === 'test') {
      return result.commandResults.some((command) => command.status === 'passed')
        || result.criteriaResults.some((criterion) => criterion.status === 'pass' && criterion.evidence.trim().length > 0)
        || evaluation.artifactRefs.length > 0;
    }
    if (kind === 'questioner') {
      return latestQuestionerOutput(bundle, undefined, 'question_final_evidence') !== undefined;
    }
    return true;
  });
  if (!hasRequiredEvidence) {
    return reject('evaluation_evidence_insufficient', 'Final evaluation is missing required workflow evidence kinds.', {
      evaluationRunId: evaluation.id,
      requiredEvidenceKinds: contract.requiredEvidenceKinds,
    });
  }

  if (result.coverageGaps.length > 0) {
    return reject('evaluation_evidence_insufficient', 'Final evaluation has unresolved coverage gaps.', {
      evaluationRunId: evaluation.id,
      coverageGaps: result.coverageGaps,
    });
  }

  return accept();
}

function buildFinalWorkflowContract(bundle: MultiAgentWorkflowBundle): FinalWorkflowContract {
  return {
    id: `${bundle.workflow.id}__final__`,
    workflowId: bundle.workflow.id,
    globalAcceptanceCriteria: normalizeGlobalAcceptanceCriteria(bundle.taskGraph?.globalAcceptanceCriteria || []),
    requiredEvidenceKinds: ['test', 'questioner'],
    finalValidationCommands: bundle.taskGraph?.finalValidationCommands || [],
  };
}

function normalizeGlobalAcceptanceCriteria(criteria: string[]): FinalWorkflowContract['globalAcceptanceCriteria'] {
  return criteria.map((criterion, index) => ({
    id: `global-ac-${index + 1}`,
    statement: criterion,
    priority: 'must',
  }));
}

function requireAcceptedContractIfPolicyRequires(
  bundle: MultiAgentWorkflowBundle,
  subtaskId: string,
): GuardResult {
  if (!bundle.workflow.policy?.requireAcceptedContract) {
    return accept();
  }
  const latest = latestContract(bundle, subtaskId);
  if (!latest) {
    return reject('missing_contract', `Subtask ${subtaskId} has no SprintContract.`);
  }
  if (latest.status !== 'accepted') {
    return reject('contract_not_accepted', `Latest SprintContract ${latest.id} is ${latest.status}.`, {
      contractId: latest.id,
      status: latest.status,
    });
  }
  return accept();
}

function latestPassedValidationForSubtask(
  bundle: MultiAgentWorkflowBundle,
  subtaskId: string | undefined,
): MultiAgentWorkflowEvidence | undefined {
  return latestEvidenceForSubtask(bundle, subtaskId, 'validation', (item) => item.passed === true);
}

function latestApprovedReviewForSubtask(
  bundle: MultiAgentWorkflowBundle,
  subtaskId: string | undefined,
): MultiAgentWorkflowEvidence | undefined {
  return latestEvidenceForSubtask(bundle, subtaskId, 'review', (item) => {
    const result = reviewResultPayload(item);
    return result?.verdict === 'approve' && reviewBlockingIssueCount(item) === 0;
  });
}

function latestReviewEvidenceForSubtask(
  bundle: MultiAgentWorkflowBundle,
  subtaskId: string | undefined,
): MultiAgentWorkflowEvidence | undefined {
  return latestEvidenceForSubtask(bundle, subtaskId, 'review');
}

function plannedReviewEvidenceForDecision(
  bundle: MultiAgentWorkflowBundle,
  decision: WorkflowDecision,
): MultiAgentWorkflowEvidence | undefined {
  const result = readRecordInput(decision.inputs, 'plannedReviewResult');
  if (!result) {
    return undefined;
  }
  const headSha = typeof result.headShaReviewed === 'string'
    ? result.headShaReviewed
    : typeof result.currentHeadSha === 'string'
      ? result.currentHeadSha
      : readStringInput(decision.inputs, 'currentHeadSha') || bundle.workflow.currentHeadSha;
  const id = readStringInput(decision.inputs, 'plannedReviewEvidenceId') || '__planned_review__';
  return {
    id,
    workflowId: bundle.workflow.id,
    subtaskId: decision.subtaskId,
    kind: 'review',
    title: 'Planned review evidence',
    headSha,
    payload: { result },
    createdAt: new Date(0).toISOString(),
  };
}

function plannedEvidenceRefsForDecision(
  bundle: MultiAgentWorkflowBundle,
  decision: WorkflowDecision,
): Set<string> {
  const refs = new Set<string>();
  if (
    ['complete_subtask', 'fix_claude_blockers', 'validate_subtask', 'request_human_review'].includes(decision.action)
  ) {
    const plannedReview = plannedReviewEvidenceForDecision(bundle, decision);
    if (plannedReview && decision.evidenceRefs.includes(plannedReview.id)) {
      refs.add(plannedReview.id);
    }
  }
  return refs;
}

function latestEvidenceForSubtask(
  bundle: MultiAgentWorkflowBundle,
  subtaskId: string | undefined,
  kind: MultiAgentWorkflowEvidence['kind'],
  predicate: (item: MultiAgentWorkflowEvidence) => boolean = () => true,
): MultiAgentWorkflowEvidence | undefined {
  return bundle.evidence
    .filter((item) => item.subtaskId === subtaskId && item.kind === kind && predicate(item))
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
}

function latestCompletedInvocation(
  bundle: MultiAgentWorkflowBundle,
  subtaskId: string,
  predicate: (item: MultiAgentWorkflowBundle['invocations'][number]) => boolean,
): MultiAgentWorkflowBundle['invocations'][number] | undefined {
  return bundle.invocations
    .filter((item) => item.subtaskId === subtaskId && item.status === 'completed' && predicate(item))
    .sort((left, right) => String(right.completedAt || right.updatedAt).localeCompare(String(left.completedAt || left.updatedAt)))[0];
}

function guardCanRecordImplementation(
  bundle: MultiAgentWorkflowBundle,
  decision: WorkflowDecision,
): GuardResult {
  const statusGuard = guardCanExecuteSubtask(bundle, decision, ['contract_accepted', 'building', 'executing']);
  if (!statusGuard.accepted) return statusGuard;
  if (decision.evidenceRefs.length > 0) {
    const implementation = latestImplementationEvidence(bundle, decision.subtaskId || '');
    if (!implementation) {
      return reject('missing_implementation_evidence', 'Recording implementation requires implementation evidence.');
    }
    const scopeGuard = latestAcceptedContract(bundle, decision.subtaskId || '')
      ? requireImplementationWithinContractScope(implementation, latestAcceptedContract(bundle, decision.subtaskId || '')!)
      : accept();
    if (!scopeGuard.accepted) return scopeGuard;
  }
  return accept();
}

function guardCanRunCodexEvaluator(
  bundle: MultiAgentWorkflowBundle,
  decision: WorkflowDecision,
): GuardResult {
  if (!decision.subtaskId) {
    return reject('invalid_transition', `${decision.action} requires subtaskId.`);
  }
  const contractGuard = requireAcceptedContractIfPolicyRequires(bundle, decision.subtaskId);
  if (!contractGuard.accepted) return contractGuard;
  const implementation = latestImplementationEvidence(bundle, decision.subtaskId);
  if (!implementation) {
    return reject('missing_implementation_evidence', 'Codex Evaluator requires implementation evidence.');
  }
  const statusGuard = requireSubtaskStatus(bundle, decision, [
    'implemented',
    'validated',
    'evaluation_failed',
    'needs_fix',
    'fixing',
  ]);
  if (!statusGuard.accepted) return statusGuard;
  const contract = latestAcceptedContract(bundle, decision.subtaskId);
  if (contract) {
    const scopeGuard = requireImplementationWithinContractScope(implementation, contract);
    if (!scopeGuard.accepted) return scopeGuard;
  }
  return requireEvidenceHeadMatchesDecision(bundle, decision, implementation, 'implementation');
}

function guardCanQuestionEvaluation(
  bundle: MultiAgentWorkflowBundle,
  decision: WorkflowDecision,
): GuardResult {
  const statusGuard = requireSubtaskStatus(bundle, decision, ['evaluation_passed', 'evaluation_failed', 'questioning_evidence']);
  if (!statusGuard.accepted) return statusGuard;
  const evaluation = latestEvaluationRun(bundle, decision.subtaskId || '');
  if (!evaluation?.result) {
    return reject('missing_evaluation_result', 'Questioning evaluation evidence requires a Codex evaluation result.');
  }
  return accept();
}

function guardCanFixEvaluationFindings(
  bundle: MultiAgentWorkflowBundle,
  decision: WorkflowDecision,
): GuardResult {
  const statusGuard = requireSubtaskStatus(bundle, decision, ['evaluation_failed', 'needs_fix', 'questioning_evidence']);
  if (!statusGuard.accepted) return statusGuard;
  const evaluation = failedEvaluationRunForDecision(bundle, decision);
  const questioner = latestQuestionerOutput(bundle, decision.subtaskId, 'question_evaluation');
  const hasBlockingQuestion = questioner ? hasBlockingQuestions(questioner) : false;
  if (!evaluation && !hasBlockingQuestion) {
    return reject('invalid_transition', 'Fixing evaluation findings requires failed evaluation evidence or blocking Questioner output.');
  }
  return accept();
}

function latestImplementationEvidence(
  bundle: MultiAgentWorkflowBundle,
  subtaskId: string,
): MultiAgentWorkflowEvidence | undefined {
  return latestEvidenceForSubtask(bundle, subtaskId, 'implementation')
    || latestEvidenceForSubtask(bundle, subtaskId, 'fix');
}

function latestContract(
  bundle: MultiAgentWorkflowBundle,
  subtaskId: string,
): SprintContract | undefined {
  return bundle.contracts
    .filter((contract) => contract.subtaskId === subtaskId)
    .sort((left, right) => right.version - left.version || latestContractTime(right).localeCompare(latestContractTime(left)))[0];
}

function latestAcceptedContract(
  bundle: MultiAgentWorkflowBundle,
  subtaskId: string,
): SprintContract | undefined {
  return bundle.contracts
    .filter((contract) => contract.subtaskId === subtaskId && contract.status === 'accepted')
    .sort((left, right) => right.version - left.version || latestContractTime(right).localeCompare(latestContractTime(left)))[0];
}

function latestContractTime(contract: SprintContract): string {
  return contract.acceptedAt || '';
}

function latestEvaluationRun(
  bundle: MultiAgentWorkflowBundle,
  subtaskId: string,
): EvaluationRun | undefined {
  return bundle.evaluationRuns
    .filter((run) => run.subtaskId === subtaskId)
    .sort((left, right) => right.startedAt.localeCompare(left.startedAt))[0];
}

function failedEvaluationRunForDecision(
  bundle: MultiAgentWorkflowBundle,
  decision: WorkflowDecision,
): EvaluationRun | undefined {
  const subtaskId = decision.subtaskId || '';
  const requestedEvaluationRunId = readStringInput(decision.inputs, 'evaluationRunId');
  if (requestedEvaluationRunId) {
    const requested = bundle.evaluationRuns.find((run) => run.subtaskId === subtaskId && run.id === requestedEvaluationRunId);
    if (isFailedEvaluationRun(requested)) {
      return requested;
    }
  }
  return bundle.evaluationRuns
    .filter((run) => run.subtaskId === subtaskId && isFailedEvaluationRun(run))
    .sort((left, right) => right.startedAt.localeCompare(left.startedAt))[0];
}

function isFailedEvaluationRun(run: EvaluationRun | undefined): run is EvaluationRun {
  return run?.result?.verdict === 'fail' || run?.status === 'failed';
}

function latestQuestionerOutput(
  bundle: MultiAgentWorkflowBundle,
  subtaskId: string | undefined,
  intent: QuestionerOutput['intent'],
): QuestionerOutput | undefined {
  return bundle.questionerOutputs
    .filter((output) => output.subtaskId === subtaskId && output.intent === intent)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
}

function hasBlockingQuestions(output: QuestionerOutput): boolean {
  return output.verdict === 'questions_blocking'
    || output.verdict === 'need_clarification'
    || output.questions.some((question) => question.priority === 'blocking');
}

function requireQuestionerMatchesEvaluation(
  bundle: MultiAgentWorkflowBundle,
  output: QuestionerOutput,
  evaluation: EvaluationRun,
  contract: SprintContract,
): GuardResult {
  if (output.source !== 'claude-plugin') {
    return reject('blocking_question_unresolved', 'Questioner output must come from the Claude plugin.', {
      questionerOutputId: output.id,
      source: output.source,
    });
  }
  if (output.verdict !== 'evidence_sufficient' && output.verdict !== 'no_blocking_questions') {
    return reject('blocking_question_unresolved', 'Questioner output must explicitly mark evidence sufficient.', {
      questionerOutputId: output.id,
      verdict: output.verdict,
    });
  }
  if (output.evaluationRunId !== evaluation.id) {
    return reject('blocking_question_unresolved', 'Questioner output does not match the latest evaluation run.', {
      questionerOutputId: output.id,
      expectedEvaluationRunId: evaluation.id,
      actualEvaluationRunId: output.evaluationRunId,
    });
  }
  if (output.contractId !== contract.id) {
    return reject('blocking_question_unresolved', 'Questioner output does not match the accepted SprintContract.', {
      questionerOutputId: output.id,
      expectedContractId: contract.id,
      actualContractId: output.contractId,
    });
  }
  if (output.headSha !== evaluation.headSha || output.headSha !== evaluation.result?.headSha) {
    return reject('head_sha_mismatch', 'Questioner output head does not match the evaluation head.', {
      questionerOutputId: output.id,
      questionerHeadSha: output.headSha,
      evaluationHeadSha: evaluation.headSha,
      resultHeadSha: evaluation.result?.headSha,
    });
  }
  if (!output.actor.invocationId || !output.artifactRef) {
    return reject('missing_evidence', 'Questioner output must include Claude invocation id and artifact ref.', {
      questionerOutputId: output.id,
    });
  }
  return requireCompletedQuestionerInvocation(bundle, output);
}

function requireQuestionerMatchesFinalEvaluation(
  bundle: MultiAgentWorkflowBundle,
  output: QuestionerOutput,
  evaluation: EvaluationRun,
): GuardResult {
  if (output.source !== 'claude-plugin') {
    return reject('blocking_question_unresolved', 'Final Questioner output must come from the Claude plugin.', {
      questionerOutputId: output.id,
      source: output.source,
    });
  }
  if (output.verdict !== 'evidence_sufficient' && output.verdict !== 'no_blocking_questions') {
    return reject('blocking_question_unresolved', 'Final Questioner output must explicitly mark evidence sufficient.', {
      questionerOutputId: output.id,
      verdict: output.verdict,
    });
  }
  const questionerEvaluationId = output.finalEvaluationRunId || output.evaluationRunId;
  if (questionerEvaluationId !== evaluation.id) {
    return reject('blocking_question_unresolved', 'Final Questioner output does not match the final evaluation run.', {
      questionerOutputId: output.id,
      expectedEvaluationRunId: evaluation.id,
      actualEvaluationRunId: questionerEvaluationId,
    });
  }
  if (output.headSha !== evaluation.headSha || output.headSha !== evaluation.result?.headSha) {
    return reject('head_sha_mismatch', 'Final Questioner output head does not match the final evaluation head.', {
      questionerOutputId: output.id,
      questionerHeadSha: output.headSha,
      evaluationHeadSha: evaluation.headSha,
      resultHeadSha: evaluation.result?.headSha,
    });
  }
  if (!output.actor.invocationId || !output.artifactRef) {
    return reject('missing_evidence', 'Final Questioner output must include Claude invocation id and artifact ref.', {
      questionerOutputId: output.id,
    });
  }
  return requireCompletedQuestionerInvocation(bundle, output);
}

function requireCompletedQuestionerInvocation(
  bundle: MultiAgentWorkflowBundle,
  output: QuestionerOutput,
): GuardResult {
  const invocation = bundle.invocations.find((candidate) => candidate.id === output.actor.invocationId);
  if (!invocation) {
    return reject('missing_subagent_invocation', 'Questioner output must reference a Tik-owned Claude Questioner invocation.', {
      questionerOutputId: output.id,
      invocationId: output.actor.invocationId,
    });
  }
  if (invocation.role !== 'questioner' || invocation.runner !== 'claude-code') {
    return reject('missing_subagent_invocation', 'Questioner invocation must be role=questioner and runner=claude-code.', {
      questionerOutputId: output.id,
      invocationId: invocation.id,
      role: invocation.role,
      runner: invocation.runner,
    });
  }
  if (invocation.status !== 'completed') {
    return reject('missing_subagent_invocation', 'Questioner invocation must be completed before its output can satisfy a guard.', {
      questionerOutputId: output.id,
      invocationId: invocation.id,
      status: invocation.status,
    });
  }
  const resultOutput = readQuestionerOutputFromInvocationResult(invocation.result);
  if (!resultOutput) {
    return reject('missing_evidence', 'Questioner invocation result must include questionerOutput.', {
      questionerOutputId: output.id,
      invocationId: invocation.id,
    });
  }
  const resultGuard = requireQuestionerOutputMatchesInvocationResult(output, resultOutput);
  if (!resultGuard.accepted) {
    return resultGuard;
  }
  return accept();
}

function readQuestionerOutputFromInvocationResult(result: Record<string, unknown> | undefined): Partial<QuestionerOutput> | null {
  if (!result || typeof result !== 'object') {
    return null;
  }
  const candidate = result.questionerOutput && typeof result.questionerOutput === 'object'
    ? result.questionerOutput
    : result;
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    return null;
  }
  return candidate as Partial<QuestionerOutput>;
}

function requireQuestionerOutputMatchesInvocationResult(
  output: QuestionerOutput,
  result: Partial<QuestionerOutput>,
): GuardResult {
  const fields: Array<keyof QuestionerOutput> = [
    'id',
    'subtaskId',
    'intent',
    'source',
    'headSha',
    'evaluationRunId',
    'finalEvaluationRunId',
    'contractId',
    'artifactRef',
    'verdict',
    'questions',
    'risks',
    'missingTests',
    'suggestedContractChanges',
  ];
  for (const field of fields) {
    if (!questionerFieldMatches(output[field], result[field])) {
      return reject('missing_evidence', `Questioner output ${String(field)} does not match the completed invocation result.`, {
        questionerOutputId: output.id,
        field,
      });
    }
  }
  const resultInvocationId = result.actor?.invocationId;
  if (resultInvocationId && resultInvocationId !== output.actor.invocationId) {
    return reject('missing_subagent_invocation', 'Questioner invocation result references a different invocation id.', {
      questionerOutputId: output.id,
      expectedInvocationId: output.actor.invocationId,
      actualInvocationId: resultInvocationId,
    });
  }
  return accept();
}

function questionerFieldMatches(left: unknown, right: unknown): boolean {
  if (left === undefined && right === undefined) {
    return true;
  }
  if (typeof left === 'object' || typeof right === 'object') {
    return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
  }
  return left === right;
}

function requireImplementationWithinContractScope(
  evidence: MultiAgentWorkflowEvidence,
  contract: SprintContract,
): GuardResult {
  const scopeCheck = readImplementationScopeCheck(evidence);
  if (scopeCheck && !scopeCheck.allowed) {
    return reject('worktree_out_of_scope', 'Tik observed implementation changes outside the contract scope.', {
      violations: scopeCheck.violations,
    });
  }
  const changedFiles = readChangedFiles(evidence);
  if (changedFiles.length === 0) {
    return reject('missing_implementation_evidence', 'Implementation evidence must include Tik-derived changed files for contract scope validation.');
  }
  const allowedPaths = contract.scope.allowedPaths || [];
  const blockedPaths = contract.scope.blockedPaths || [];
  const blocked = changedFiles.filter((file) => matchesAnyPath(file, blockedPaths));
  if (blocked.length > 0) {
    return reject('worktree_out_of_scope', 'Implementation touched contract blocked paths.', {
      blocked,
      blockedPaths,
    });
  }
  const outside = allowedPaths.length > 0
    ? changedFiles.filter((file) => !matchesAnyPath(file, allowedPaths))
    : [];
  if (outside.length > 0) {
    return reject('worktree_out_of_scope', 'Implementation changed files outside contract allowed paths.', {
      outside,
      allowedPaths,
    });
  }
  return accept();
}

function requireEvaluationCoversContract(
  evaluation: EvaluationRun,
  contract: SprintContract,
): GuardResult {
  const result = evaluation.result;
  if (!result) {
    return reject('missing_evaluation_result', 'Evaluation result is required.');
  }

  const mustCriteria = contract.acceptanceCriteria.filter((criterion) => criterion.priority === 'must');
  const resultsByCriterion = new Map(result.criteriaResults.map((criterionResult) => [criterionResult.criterionId, criterionResult]));
  const missingOrFailed = mustCriteria
    .filter((criterion) => resultsByCriterion.get(criterion.id)?.status !== 'pass')
    .map((criterion) => criterion.id);
  if (missingOrFailed.length > 0) {
    return reject('evaluation_evidence_insufficient', 'Evaluation result must pass every must acceptance criterion.', {
      evaluationRunId: evaluation.id,
      missingOrFailedCriteria: missingOrFailed,
    });
  }

  const hasCommandEvidence = result.commandResults.some((command) =>
    command.status === 'passed' || command.status === 'failed' || command.status === 'timeout'
  );
  const hasArtifactEvidence = result.criteriaResults.some((criterion) => (criterion.artifactRefs?.length || 0) > 0)
    || evaluation.artifactRefs.length > 0;
  const hasReproductionEvidence = result.criteriaResults.some((criterion) => (criterion.reproductionSteps?.length || 0) > 0)
    || result.runtimeFindings.some((finding) => finding.reproductionSteps.length > 0);
  if (!hasCommandEvidence && !hasArtifactEvidence && !hasReproductionEvidence) {
    return reject('evaluation_evidence_insufficient', 'Evaluation result must include command, artifact, or reproduction evidence.', {
      evaluationRunId: evaluation.id,
    });
  }

  if (result.coverageGaps.length > 0) {
    return reject('evaluation_evidence_insufficient', 'Evaluation result has unresolved coverage gaps.', {
      evaluationRunId: evaluation.id,
      coverageGaps: result.coverageGaps,
    });
  }

  return accept();
}

function isRuntimeAttestedInvocation(
  invocation: MultiAgentWorkflowBundle['invocations'][number],
): boolean {
  const attestation = invocation.runtimeAttestation;
  const actualThreadId = invocation.actualSubagentThreadId || attestation?.actualSubagentThreadId;
  return Boolean(
    invocation.hookAttested === true
      && attestation
      && attestation.source === 'codex-plugin-hook'
      && attestation.role === invocation.role
      && attestation.nonce
      && attestation.parentThreadId
      && actualThreadId
      && actualThreadId === attestation.actualSubagentThreadId,
  );
}

function readWorkflowParentCodexThreadId(workflow: MultiAgentWorkflowRecord): string | undefined {
  const value = workflow.metadata?.parentCodexThreadId;
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function readChangedFiles(evidence: MultiAgentWorkflowEvidence): string[] {
  const payload = evidence.payload as ImplementationEvidencePayload | undefined;
  const changedFiles = Array.isArray(payload?.observedChangedFiles)
    ? payload.observedChangedFiles
    : payload?.changedFiles;
  if (!Array.isArray(changedFiles)) {
    return [];
  }
  return changedFiles
    .map((entry) => {
      if (typeof entry === 'string') return entry;
      if (entry && typeof entry === 'object' && 'path' in entry && typeof entry.path === 'string') {
        return entry.path;
      }
      return undefined;
    })
    .filter((entry): entry is string => Boolean(entry))
    .map((entry) => entry.replace(/\\/g, '/').replace(/^\.\/+/, ''));
}

function readImplementationScopeCheck(evidence: MultiAgentWorkflowEvidence): ImplementationEvidencePayload['scopeCheck'] | undefined {
  const scopeCheck = (evidence.payload as ImplementationEvidencePayload | undefined)?.scopeCheck;
  if (!scopeCheck || typeof scopeCheck !== 'object') return undefined;
  return {
    allowed: scopeCheck.allowed === true,
    violations: Array.isArray(scopeCheck.violations)
      ? scopeCheck.violations.filter((entry): entry is string => typeof entry === 'string')
      : [],
  };
}

function matchesAnyPath(filePath: string, patterns: string[]): boolean {
  const normalizedFile = filePath.replace(/\\/g, '/').replace(/^\.\/+/, '');
  return patterns.some((pattern) => {
    const normalizedPattern = pattern.replace(/\\/g, '/').replace(/^\.\/+/, '');
    if (normalizedPattern.includes('*')) {
      return globPathToRegExp(normalizedPattern).test(normalizedFile);
    }
    return normalizedPattern.endsWith('/')
      ? normalizedFile === normalizedPattern.slice(0, -1) || normalizedFile.startsWith(normalizedPattern)
      : normalizedFile === normalizedPattern || normalizedFile.startsWith(`${normalizedPattern}/`);
  });
}

function globPathToRegExp(pattern: string): RegExp {
  const source = pattern
    .split(/(\*\*)/g)
    .map((part) => {
      if (part === '**') return '.*';
      return part
        .split('*')
        .map(escapeRegExp)
        .join('[^/]*');
    })
    .join('');
  return new RegExp(`^${source}$`);
}

function escapeRegExp(value: string): string {
  return value.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
}

function usesCodexEvaluatorQuestionerGate(bundle: MultiAgentWorkflowBundle): boolean {
  const policy = bundle.workflow.policy;
  return Boolean(
    policy?.requireAcceptedContract
      || policy?.requireEvaluationPassForComplete
      || policy?.requireQuestionerAfterEvaluation,
  );
}

function requireEvidenceHeadMatchesDecision(
  bundle: MultiAgentWorkflowBundle,
  decision: WorkflowDecision,
  evidence: MultiAgentWorkflowEvidence,
  label: string,
): GuardResult {
  const decisionHeadSha = readStringInput(decision.inputs, 'currentHeadSha')
    || readStringInput(decision.inputs, 'headSha')
    || bundle.workflow.currentHeadSha;
  if (decisionHeadSha && evidence.headSha && decisionHeadSha !== evidence.headSha) {
    return reject('head_sha_mismatch', `Decision head does not match ${label} evidence head.`, {
      expectedHeadSha: evidence.headSha,
      actualHeadSha: decisionHeadSha,
    });
  }
  return accept();
}

function reviewBlockingIssueCount(evidence: MultiAgentWorkflowEvidence): number {
  const result = reviewResultPayload(evidence);
  return Array.isArray(result?.blockingIssues) ? result.blockingIssues.length : 0;
}

function reviewHeadSha(evidence: MultiAgentWorkflowEvidence): string | undefined {
  const result = reviewResultPayload(evidence);
  return typeof result?.headShaReviewed === 'string'
    ? result.headShaReviewed
    : typeof result?.currentHeadSha === 'string'
      ? result.currentHeadSha
      : evidence.headSha;
}

function reviewResultPayload(evidence: MultiAgentWorkflowEvidence): Record<string, any> | undefined {
  const result = evidence.payload?.result;
  return result && typeof result === 'object' && !Array.isArray(result)
    ? result as Record<string, any>
    : undefined;
}

function allSubtasksDone(bundle: MultiAgentWorkflowBundle): boolean {
  const subtasks = bundle.taskGraph?.subtasks || [];
  return subtasks.length > 0 && subtasks.every((subtask) => bundle.subtasks[subtask.id]?.status === 'done');
}

function hasApprovedFinalReview(bundle: MultiAgentWorkflowBundle): boolean {
  return bundle.evidence.some((item) => {
    if (item.kind !== 'review' || item.subtaskId) return false;
    const result = reviewResultPayload(item);
    return result?.verdict === 'approve' && reviewBlockingIssueCount(item) === 0;
  });
}

function allDoneSubtasksHaveApprovedReview(bundle: MultiAgentWorkflowBundle): boolean {
  const subtasks = bundle.taskGraph?.subtasks || [];
  return subtasks.length > 0 && subtasks.every((subtask) =>
    bundle.subtasks[subtask.id]?.status === 'done'
    && latestApprovedReviewForSubtask(bundle, subtask.id) !== undefined
  );
}

function plannedFinalReviewApproved(decision: WorkflowDecision): boolean {
  const result = readRecordInput(decision.inputs, 'plannedFinalReviewResult')
    || readRecordInput(decision.inputs, 'plannedReviewResult');
  return result?.verdict === 'approve'
    && (!Array.isArray(result.blockingIssues) || result.blockingIssues.length === 0);
}

function hasPlannedReviewResult(decision: WorkflowDecision): boolean {
  return Boolean(readRecordInput(decision.inputs, 'plannedReviewResult'));
}

function hasTruthyInput(inputs: Record<string, unknown> | undefined, key: string): boolean {
  return inputs?.[key] === true || inputs?.[key] === 'true';
}

function accept(): GuardResult {
  return {
    accepted: true,
    code: 'ok',
  };
}

function validateWorkspaceBinding(workflow: MultiAgentWorkflowRecord): GuardResult {
  const binding = workflow.workspaceBinding;
  if (!binding?.workspaceRoot || !binding.effectiveProjectPath) {
    return { accepted: true, code: 'ok' };
  }

  const root = path.resolve(binding.workspaceRoot);
  const target = path.resolve(binding.effectiveProjectPath);
  const relative = path.relative(root, target);
  if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) {
    return { accepted: true, code: 'ok' };
  }

  return reject('worktree_out_of_scope', `Workflow worktree is outside workspace root: ${target}`, {
    workspaceRoot: root,
    effectiveProjectPath: target,
  });
}

function readStringInput(inputs: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = inputs?.[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function readNumberInput(inputs: Record<string, unknown> | undefined, key: string): number | undefined {
  const value = inputs?.[key];
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function readRecordInput(inputs: Record<string, unknown> | undefined, key: string): Record<string, any> | undefined {
  const value = inputs?.[key];
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, any>
    : undefined;
}

function reject(
  code: NonNullable<GuardResult['code']>,
  message: string,
  currentState?: unknown,
): GuardResult {
  return {
    accepted: false,
    code,
    message,
    currentState,
  };
}
