import type {
  EvaluationRun,
  GuardResult,
  MultiAgentWorkflowBundle,
  MultiAgentWorkflowEvidence,
  QuestionerIntent,
  QuestionerOutput,
  SprintContract,
  SubtaskRunState,
  TaskGraph,
  WorkflowDecision,
  WorkflowPolicy,
} from '@tik/shared';
import type { PredicateResult } from './predicate-result.js';
import { fail, pass } from './predicate-result.js';

export interface WorkflowDecisionContext {
  bundle: MultiAgentWorkflowBundle;
  workflow: MultiAgentWorkflowBundle['workflow'];
  taskGraph: TaskGraph | null;
  subtasks: Record<string, SubtaskRunState>;
  subtask?: SubtaskRunState;
  subtaskId?: string;
  policy: WorkflowPolicy | undefined;
  headSha?: string;
  now: string;
}

export interface QuestionerMatchInput {
  subtaskId?: string;
  intent: QuestionerIntent;
  contractId?: string;
  evaluationRunId?: string;
  finalEvaluationRunId?: string;
  headSha?: string;
}

export function createWorkflowDecisionContext(input: {
  bundle: MultiAgentWorkflowBundle;
  subtaskId?: string;
  headSha?: string;
  now?: string;
}): WorkflowDecisionContext {
  return {
    bundle: input.bundle,
    workflow: input.bundle.workflow,
    taskGraph: input.bundle.taskGraph,
    subtasks: input.bundle.subtasks || {},
    subtaskId: input.subtaskId,
    subtask: input.subtaskId ? input.bundle.subtasks[input.subtaskId] : undefined,
    policy: input.bundle.workflow.policy,
    headSha: input.headSha || input.bundle.workflow.currentHeadSha,
    now: input.now || new Date().toISOString(),
  };
}

export function toGuardResult(result: PredicateResult): GuardResult {
  return result.ok
    ? { accepted: true, code: 'ok' }
    : {
      accepted: false,
      code: result.code || 'invalid_transition',
      message: result.message,
      currentState: result.currentState ?? (result.refs ? { refs: result.refs } : undefined),
    };
}

export function usesCodexEvaluatorQuestionerGate(workflow: MultiAgentWorkflowBundle['workflow']): boolean {
  const policy = workflow.policy;
  return Boolean(
    policy?.requireAcceptedContract
      || policy?.requireEvaluationPassForComplete
      || policy?.requireQuestionerBeforeBuild
      || policy?.requireQuestionerAfterEvaluation,
  );
}

export function allSubtasksDone(ctx: WorkflowDecisionContext): PredicateResult {
  if (!ctx.taskGraph) {
    return fail('invalid_transition', 'Workflow has no TaskGraph.');
  }
  const missing = ctx.taskGraph.subtasks
    .filter((subtask) => ctx.subtasks[subtask.id]?.status !== 'done')
    .map((subtask) => subtask.id);
  return missing.length === 0
    ? pass(ctx.taskGraph.subtasks.map((subtask) => ({ kind: 'subtask', id: subtask.id })))
    : fail('invalid_transition', `Subtasks are not done: ${missing.join(', ')}.`, {
      currentState: { missingSubtaskIds: missing },
    });
}

export function hasAcceptedContract(ctx: WorkflowDecisionContext, subtaskId = requireSubtaskId(ctx)): PredicateResult {
  const contract = latestAcceptedContract(ctx.bundle, subtaskId);
  return contract
    ? pass([{ kind: 'contract', id: contract.id }])
    : fail('missing_contract', `Subtask ${subtaskId} has no accepted SprintContract.`, {
      refs: [{ kind: 'subtask', id: subtaskId }],
    });
}

export function hasDraftOrAcceptedContract(ctx: WorkflowDecisionContext, subtaskId = requireSubtaskId(ctx)): PredicateResult {
  const contract = latestContract(ctx.bundle, subtaskId);
  return contract
    ? pass([{ kind: 'contract', id: contract.id }])
    : fail('missing_contract', `Subtask ${subtaskId} has no SprintContract.`, {
      refs: [{ kind: 'subtask', id: subtaskId }],
    });
}

export function hasImplementationEvidenceAtHead(ctx: WorkflowDecisionContext, subtaskId = requireSubtaskId(ctx)): PredicateResult {
  const implementation = latestImplementationEvidence(ctx.bundle, subtaskId);
  if (!implementation) {
    return fail('missing_implementation_evidence', `Subtask ${subtaskId} has no implementation evidence.`, {
      refs: [{ kind: 'subtask', id: subtaskId }],
    });
  }
  const expectedHead = ctx.headSha || ctx.workflow.currentHeadSha;
  if (ctx.policy?.requireSameHeadShaForEvidence !== false && expectedHead && implementation.headSha && implementation.headSha !== expectedHead) {
    return fail('head_sha_mismatch', 'Implementation evidence head does not match workflow head.', {
      refs: [{ kind: 'evidence', id: implementation.id }],
      currentState: { expectedHeadSha: expectedHead, implementationHeadSha: implementation.headSha },
    });
  }
  return pass([{ kind: 'evidence', id: implementation.id }]);
}

export function hasReviewEvidenceAtHead(ctx: WorkflowDecisionContext, subtaskId = requireSubtaskId(ctx)): PredicateResult {
  const review = latestReviewEvidence(ctx.bundle, subtaskId);
  if (!review) {
    return fail('missing_evidence', `Review subtask ${subtaskId} has no readonly review evidence.`, {
      refs: [{ kind: 'subtask', id: subtaskId }],
    });
  }
  const expectedHead = ctx.headSha || ctx.workflow.currentHeadSha;
  if (ctx.policy?.requireSameHeadShaForEvidence !== false && expectedHead && review.headSha && review.headSha !== expectedHead) {
    return fail('head_sha_mismatch', 'Review evidence head does not match workflow head.', {
      refs: [{ kind: 'evidence', id: review.id }],
      currentState: { expectedHeadSha: expectedHead, reviewHeadSha: review.headSha },
    });
  }
  return pass([{ kind: 'evidence', id: review.id }]);
}

export function hasPassingEvaluationAtHead(ctx: WorkflowDecisionContext, subtaskId = requireSubtaskId(ctx)): PredicateResult {
  const evaluation = latestEvaluationRun(ctx.bundle, subtaskId);
  if (!evaluation?.result) {
    return fail('missing_evaluation_result', `Subtask ${subtaskId} has no Codex evaluation result.`, {
      refs: [{ kind: 'subtask', id: subtaskId }],
    });
  }
  if (evaluation.status === 'invalidated' || !evaluation.readonlyPolicy?.enforced || (evaluation.readonlyPolicy.violations?.length || 0) > 0) {
    return fail('readonly_policy_violated', 'Codex evaluator readonly policy was not satisfied.', {
      refs: [{ kind: 'evaluation', id: evaluation.id }],
      currentState: {
        evaluationRunId: evaluation.id,
        violations: evaluation.readonlyPolicy?.violations || [],
      },
    });
  }
  if (evaluation.status !== 'passed' || evaluation.result.verdict !== 'pass') {
    return fail('evaluation_not_passed', 'Completing a subtask requires a passing Codex evaluation result.', {
      refs: [{ kind: 'evaluation', id: evaluation.id }],
      currentState: {
        evaluationRunId: evaluation.id,
        status: evaluation.status,
        verdict: evaluation.result.verdict,
      },
    });
  }
  const expectedHead = ctx.headSha || ctx.workflow.currentHeadSha;
  const evaluationHeadSha = evaluation.result.headSha || evaluation.headSha;
  if (ctx.policy?.requireSameHeadShaForEvidence !== false && expectedHead && evaluationHeadSha && evaluationHeadSha !== expectedHead) {
    return fail('head_sha_mismatch', 'Evaluation result head does not match workflow head.', {
      refs: [{ kind: 'evaluation', id: evaluation.id }],
      currentState: { expectedHeadSha: expectedHead, evaluationHeadSha },
    });
  }
  return pass([{ kind: 'evaluation', id: evaluation.id }]);
}

export function hasSufficientQuestionerOutput(
  ctx: WorkflowDecisionContext,
  input: QuestionerMatchInput,
): PredicateResult {
  const output = latestMatchingQuestionerOutput(ctx.bundle, input);
  if (!output) {
    return fail('blocking_question_unresolved', 'Claude Questioner must provide validated strict output before this gate can pass.', {
      currentState: { input },
    });
  }
  const strict = requireStrictQuestionerOutput(ctx.bundle, output, {
    contractId: input.contractId,
    evaluationRunId: input.evaluationRunId,
    finalEvaluationRunId: input.finalEvaluationRunId,
    headSha: input.headSha,
  });
  if (!strict.ok) return strict;
  if (hasBlockingQuestions(ctx.bundle, output)) {
    return fail('blocking_question_unresolved', 'Claude Questioner has unresolved blocking or evidence-needed questions.', {
      refs: [{ kind: 'questioner_output', id: output.id }],
    });
  }
  if (output.verdict !== 'evidence_sufficient' && output.verdict !== 'no_blocking_questions') {
    return fail('blocking_question_unresolved', 'Questioner output must explicitly mark evidence sufficient.', {
      refs: [{ kind: 'questioner_output', id: output.id }],
      currentState: { verdict: output.verdict },
    });
  }
  return pass([
    ...(output.questionerRunId ? [{ kind: 'questioner_run' as const, id: output.questionerRunId }] : []),
    { kind: 'questioner_output', id: output.id },
  ]);
}

export function hasSufficientContractQuestionerOutput(
  ctx: WorkflowDecisionContext,
  subtaskId = requireSubtaskId(ctx),
): PredicateResult {
  const contract = latestContract(ctx.bundle, subtaskId);
  if (!contract) {
    return fail('missing_contract', `Subtask ${subtaskId} has no SprintContract.`);
  }
  return hasSufficientQuestionerOutput(ctx, {
    subtaskId,
    intent: 'question_contract',
    contractId: contract.id,
    headSha: contract.headShaAtAcceptance || ctx.headSha,
  });
}

export function hasSufficientEvaluationQuestionerOutput(
  ctx: WorkflowDecisionContext,
  subtaskId = requireSubtaskId(ctx),
): PredicateResult {
  const contract = latestAcceptedContract(ctx.bundle, subtaskId);
  if (ctx.workflow.mode !== 'review' && !contract) {
    return fail('missing_contract', `Subtask ${subtaskId} has no accepted SprintContract.`);
  }
  const evaluation = latestEvaluationRun(ctx.bundle, subtaskId);
  if (!evaluation?.result) {
    return fail('missing_evaluation_result', `Subtask ${subtaskId} has no Codex evaluation result.`);
  }
  return hasSufficientQuestionerOutput(ctx, {
    subtaskId,
    intent: 'question_evaluation',
    contractId: contract?.id,
    evaluationRunId: evaluation.id,
    headSha: evaluation.result.headSha || evaluation.headSha,
  });
}

export function hasSufficientFinalQuestionerOutput(ctx: WorkflowDecisionContext): PredicateResult {
  const evaluation = latestEvaluationRun(ctx.bundle, '__final__');
  if (!evaluation?.result) {
    return fail('missing_evaluation_result', 'Workflow has no final Codex evaluation result.');
  }
  return hasSufficientQuestionerOutput(ctx, {
    intent: 'question_final_evidence',
    finalEvaluationRunId: evaluation.id,
    headSha: evaluation.result.headSha || evaluation.headSha,
  });
}

export function allSubtaskGatesSatisfied(ctx: WorkflowDecisionContext, subtaskId = requireSubtaskId(ctx)): PredicateResult {
  if (ctx.workflow.mode === 'review') {
    const review = hasReviewEvidenceAtHead(ctx, subtaskId);
    if (!review.ok) return review;
    const evaluation = hasPassingEvaluationAtHead(ctx, subtaskId);
    if (!evaluation.ok) return evaluation;
    if (ctx.policy?.requireQuestionerAfterEvaluation) {
      const questioner = hasSufficientEvaluationQuestionerOutput(ctx, subtaskId);
      if (!questioner.ok) return questioner;
    }
    return pass([...(review.refs || []), ...(evaluation.refs || [])]);
  }
  const contract = hasAcceptedContract(ctx, subtaskId);
  if (!contract.ok) return contract;
  const implementation = hasImplementationEvidenceAtHead(ctx, subtaskId);
  if (!implementation.ok) return implementation;
  const evaluation = hasPassingEvaluationAtHead(ctx, subtaskId);
  if (!evaluation.ok) return evaluation;
  if (ctx.policy?.requireQuestionerAfterEvaluation) {
    const questioner = hasSufficientEvaluationQuestionerOutput(ctx, subtaskId);
    if (!questioner.ok) return questioner;
  }
  return pass([
    ...(contract.refs || []),
    ...(implementation.refs || []),
    ...(evaluation.refs || []),
  ]);
}

export function subtaskIsDone(ctx: WorkflowDecisionContext, subtaskId = requireSubtaskId(ctx)): PredicateResult {
  return ctx.subtasks[subtaskId]?.status === 'done'
    ? pass([{ kind: 'subtask', id: subtaskId }])
    : fail('invalid_transition', `Subtask ${subtaskId} is not done.`, {
      refs: [{ kind: 'subtask', id: subtaskId }],
      currentState: { status: ctx.subtasks[subtaskId]?.status },
    });
}

export function latestContract(bundle: MultiAgentWorkflowBundle, subtaskId: string): SprintContract | undefined {
  return (bundle.contracts || [])
    .filter((contract) => contract.subtaskId === subtaskId)
    .sort((left, right) => right.version - left.version || latestContractTime(right).localeCompare(latestContractTime(left)))[0];
}

export function latestAcceptedContract(bundle: MultiAgentWorkflowBundle, subtaskId: string): SprintContract | undefined {
  return (bundle.contracts || [])
    .filter((contract) => contract.subtaskId === subtaskId && contract.status === 'accepted')
    .sort((left, right) => right.version - left.version || latestContractTime(right).localeCompare(latestContractTime(left)))[0];
}

export function latestImplementationEvidence(bundle: MultiAgentWorkflowBundle, subtaskId: string): MultiAgentWorkflowEvidence | undefined {
  return latestEvidenceForSubtask(bundle, subtaskId, 'implementation')
    || latestEvidenceForSubtask(bundle, subtaskId, 'fix');
}

export function latestReviewEvidence(bundle: MultiAgentWorkflowBundle, subtaskId: string): MultiAgentWorkflowEvidence | undefined {
  return latestEvidenceForSubtask(bundle, subtaskId, 'review');
}

export function latestEvaluationRun(bundle: MultiAgentWorkflowBundle, subtaskId: string): EvaluationRun | undefined {
  return (bundle.evaluationRuns || [])
    .filter((run) => run.subtaskId === subtaskId)
    .sort((left, right) => safeIsoTime(right.startedAt).localeCompare(safeIsoTime(left.startedAt)))[0];
}

export function latestMatchingQuestionerOutput(
  bundle: MultiAgentWorkflowBundle,
  input: QuestionerMatchInput,
): QuestionerOutput | undefined {
  return (bundle.questionerOutputs || [])
    .filter((output) => output.subtaskId === input.subtaskId && output.intent === input.intent)
    .filter((output) => output.schemaVersion === 'questioner-output.v2')
    .filter((output) => input.contractId === undefined || output.references?.contractId === input.contractId || output.contractId === input.contractId)
    .filter((output) => input.evaluationRunId === undefined || output.references?.evaluationRunId === input.evaluationRunId || output.evaluationRunId === input.evaluationRunId)
    .filter((output) => input.finalEvaluationRunId === undefined || output.references?.finalEvaluationRunId === input.finalEvaluationRunId || output.finalEvaluationRunId === input.finalEvaluationRunId)
    .filter((output) => input.headSha === undefined || output.attestation?.headSha === input.headSha || output.headSha === input.headSha)
    .filter((output) => requireStrictQuestionerOutput(bundle, output, {
      contractId: input.contractId,
      evaluationRunId: input.evaluationRunId,
      finalEvaluationRunId: input.finalEvaluationRunId,
      headSha: input.headSha,
    }).ok)
    .sort((left, right) => safeIsoTime(right.createdAt).localeCompare(safeIsoTime(left.createdAt)))[0];
}

export function hasBlockingQuestions(bundle: MultiAgentWorkflowBundle, output: QuestionerOutput): boolean {
  const resolvedQuestionIds = new Set(
    (bundle.questionResolutions || [])
      .filter((resolution) => resolution.questionerOutputId === output.id)
      .filter((resolution) => resolution.status === 'resolved' || resolution.status === 'accepted_risk')
      .map((resolution) => resolution.questionId),
  );
  const unresolvedBlocking = (output.questions || [])
    .filter((question) => !resolvedQuestionIds.has(question.id))
    .filter((question) => question.priority === 'blocking' || question.priority === 'evidence_needed');
  if (unresolvedBlocking.length > 0) return true;
  if (
    output.verdict === 'questions_blocking'
    || output.verdict === 'need_clarification'
    || output.verdict === 'evidence_needed'
  ) {
    return (output.questions || []).length === 0;
  }
  return false;
}

export function requireStrictQuestionerOutput(
  bundle: MultiAgentWorkflowBundle,
  output: QuestionerOutput,
  input: {
    contractId?: string;
    evaluationRunId?: string;
    finalEvaluationRunId?: string;
    headSha?: string;
  },
): PredicateResult {
  if (output.schemaVersion !== 'questioner-output.v2') {
    return fail('missing_evidence', 'Questioner output must use strict schemaVersion=questioner-output.v2.', {
      refs: [{ kind: 'questioner_output', id: output.id }],
      currentState: { schemaVersion: output.schemaVersion },
    });
  }
  if (!output.questionerRunId || !output.attestation || !output.references) {
    return fail('missing_evidence', 'QuestionerOutputV2 must include questionerRunId, attestation, and references.', {
      refs: [{ kind: 'questioner_output', id: output.id }],
    });
  }
  const run = (bundle.questionerRuns || []).find((candidate) => candidate.id === output.questionerRunId);
  if (!run) {
    return fail('missing_evidence', 'QuestionerOutputV2 must reference a stored QuestionerRun.', {
      refs: [{ kind: 'questioner_output', id: output.id }],
      currentState: { questionerRunId: output.questionerRunId },
    });
  }
  if (run.status !== 'validated') {
    return fail('missing_evidence', 'QuestionerRun must be validated before satisfying a guard.', {
      refs: [{ kind: 'questioner_run', id: run.id }],
      currentState: { status: run.status },
    });
  }
  if (run.invocationId !== output.actor.invocationId) {
    return fail('missing_subagent_invocation', 'QuestionerRun invocation does not match output actor.', {
      refs: [{ kind: 'questioner_run', id: run.id }],
      currentState: { runInvocationId: run.invocationId, outputInvocationId: output.actor.invocationId },
    });
  }
  if (
    run.contextHash !== output.attestation.contextHash
    || run.contextArtifactRef !== output.attestation.contextArtifactRef
    || run.headSha !== output.attestation.headSha
  ) {
    return fail('missing_evidence', 'QuestionerOutputV2 attestation does not match its QuestionerRun.', {
      refs: [{ kind: 'questioner_run', id: run.id }, { kind: 'questioner_output', id: output.id }],
    });
  }
  if (run.outputHash && run.outputHash !== output.attestation.outputHash) {
    return fail('missing_evidence', 'QuestionerOutputV2 output hash does not match its QuestionerRun.', {
      refs: [{ kind: 'questioner_run', id: run.id }, { kind: 'questioner_output', id: output.id }],
    });
  }
  const invocation = (bundle.invocations || []).find((candidate) => candidate.id === output.actor.invocationId);
  if (!invocation || invocation.status !== 'completed') {
    return fail('missing_subagent_invocation', 'Questioner invocation must be completed before its output can satisfy a guard.', {
      refs: [{ kind: 'questioner_output', id: output.id }],
      currentState: { invocationId: output.actor.invocationId, status: invocation?.status },
    });
  }
  const readonlyAudit = run.readonlyAudit || invocation.readonlyPolicy;
  if (!readonlyAudit?.enforced) {
    return fail('readonly_policy_violated', 'QuestionerRun must include server-validated readonly audit evidence.', {
      refs: [{ kind: 'questioner_run', id: run.id }],
    });
  }
  if ((readonlyAudit.violations || []).length > 0) {
    return fail('readonly_policy_violated', 'Questioner readonly audit recorded forbidden writes.', {
      refs: [{ kind: 'questioner_run', id: run.id }],
      currentState: { violations: readonlyAudit.violations },
    });
  }
  if (input.contractId && output.references.contractId !== input.contractId) {
    return fail('blocking_question_unresolved', 'QuestionerOutputV2 contract reference does not match the SprintContract.', {
      refs: [{ kind: 'questioner_output', id: output.id }],
      currentState: { expectedContractId: input.contractId, actualContractId: output.references.contractId },
    });
  }
  if (input.evaluationRunId && output.references.evaluationRunId !== input.evaluationRunId) {
    return fail('blocking_question_unresolved', 'QuestionerOutputV2 evaluation reference does not match the evaluation run.', {
      refs: [{ kind: 'questioner_output', id: output.id }],
      currentState: { expectedEvaluationRunId: input.evaluationRunId, actualEvaluationRunId: output.references.evaluationRunId },
    });
  }
  if (input.finalEvaluationRunId && output.references.finalEvaluationRunId !== input.finalEvaluationRunId) {
    return fail('blocking_question_unresolved', 'QuestionerOutputV2 final evaluation reference does not match the final evaluation run.', {
      refs: [{ kind: 'questioner_output', id: output.id }],
      currentState: { expectedFinalEvaluationRunId: input.finalEvaluationRunId, actualFinalEvaluationRunId: output.references.finalEvaluationRunId },
    });
  }
  if (input.headSha && output.attestation.headSha !== input.headSha) {
    return fail('head_sha_mismatch', 'QuestionerOutputV2 head does not match the expected head.', {
      refs: [{ kind: 'questioner_output', id: output.id }],
      currentState: { expectedHeadSha: input.headSha, questionerHeadSha: output.attestation.headSha },
    });
  }
  const coverage = requireQuestionerCoverage(output);
  if (!coverage.ok) return coverage;
  return pass([
    { kind: 'questioner_run', id: run.id },
    { kind: 'questioner_output', id: output.id },
  ]);
}

export function requireQuestionerCoverage(output: QuestionerOutput): PredicateResult {
  if (!Array.isArray(output.coverageMatrix) || output.coverageMatrix.length === 0) {
    return fail('evaluation_evidence_insufficient', 'QuestionerOutputV2 must include a coverage matrix.', {
      refs: [{ kind: 'questioner_output', id: output.id }],
    });
  }
  const uncovered = output.coverageMatrix
    .filter((entry) => entry.required)
    .filter((entry) => entry.status !== 'covered' && entry.status !== 'not_applicable');
  if (uncovered.length > 0) {
    return fail('evaluation_evidence_insufficient', 'QuestionerOutputV2 has uncovered required criteria.', {
      refs: [{ kind: 'questioner_output', id: output.id }],
      currentState: { uncovered: uncovered.map((entry) => entry.criterionId) },
    });
  }
  const weakCovered = output.coverageMatrix
    .filter((entry) => entry.required && entry.status === 'covered')
    .filter((entry) => entry.evidenceRefs.length === 0 || !entry.comment.trim());
  if (weakCovered.length > 0) {
    return fail('evaluation_evidence_insufficient', 'QuestionerOutputV2 covered criteria must cite evidence.', {
      refs: [{ kind: 'questioner_output', id: output.id }],
      currentState: { weakCovered: weakCovered.map((entry) => entry.criterionId) },
    });
  }
  return pass([{ kind: 'questioner_output', id: output.id }]);
}

function latestEvidenceForSubtask(
  bundle: MultiAgentWorkflowBundle,
  subtaskId: string,
  kind: MultiAgentWorkflowEvidence['kind'],
): MultiAgentWorkflowEvidence | undefined {
  return (bundle.evidence || [])
    .filter((item) => item.subtaskId === subtaskId && item.kind === kind)
    .sort((left, right) => safeIsoTime(right.createdAt).localeCompare(safeIsoTime(left.createdAt)))[0];
}

function latestContractTime(contract: SprintContract): string {
  return contract.acceptedAt || '';
}

function requireSubtaskId(ctx: WorkflowDecisionContext): string {
  if (!ctx.subtaskId) {
    throw new Error('Predicate requires subtaskId.');
  }
  return ctx.subtaskId;
}

function safeIsoTime(value: string | undefined): string {
  return value || '';
}

export function readDecisionHeadSha(decision: WorkflowDecision, workflowHeadSha?: string): string | undefined {
  const inputs = decision.inputs || {};
  const currentHeadSha = inputs.currentHeadSha;
  const headSha = inputs.headSha;
  return typeof currentHeadSha === 'string'
    ? currentHeadSha
    : typeof headSha === 'string'
      ? headSha
      : workflowHeadSha;
}
