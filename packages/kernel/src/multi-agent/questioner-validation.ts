import { createHash } from 'node:crypto';
import type {
  EvaluationRun,
  QuestionerContextV1,
  QuestionerOutput,
  QuestionerOutputV2,
  QuestionerRun,
  SprintContract,
} from '@tik/shared';
import { stableHash, stableStringify } from './questioner-context.js';

export interface QuestionerValidationResult {
  accepted: boolean;
  code?: string;
  message?: string;
}

export function hashQuestionerToken(token: string): string {
  return `sha256:${createHash('sha256').update(token).digest('hex')}`;
}

export function validateQuestionerRunToken(
  run: QuestionerRun,
  token: string | undefined,
  now = new Date().toISOString(),
): QuestionerValidationResult {
  if (!token || hashQuestionerToken(token) !== run.tokenHash) {
    return reject('missing_evidence', 'Questioner run token is missing or invalid.');
  }
  if (Date.parse(run.tokenExpiresAt) <= Date.parse(now)) {
    return reject('invalid_transition', 'Questioner run token has expired.');
  }
  return { accepted: true };
}

export function computeQuestionerOutputHash(
  output: Omit<QuestionerOutputV2, 'attestation'> & {
    attestation: Omit<QuestionerOutputV2['attestation'], 'outputHash'> & { outputHash?: string };
  },
): string {
  return stableHash({
    ...output,
    attestation: {
      ...output.attestation,
      outputHash: '',
    },
    createdAt: undefined,
  });
}

export function validateQuestionerOutputV2(args: {
  run: QuestionerRun;
  output: QuestionerOutputV2;
  context: QuestionerContextV1;
  contract?: SprintContract;
  evaluation?: EvaluationRun;
  finalEvaluation?: EvaluationRun;
}): QuestionerValidationResult {
  const { run, output, context, contract, evaluation, finalEvaluation } = args;
  if (output.schemaVersion !== 'questioner-output.v2') {
    return reject('missing_evidence', 'Questioner output must use schemaVersion=questioner-output.v2.');
  }
  if (output.questionerRunId !== run.id || output.workflowId !== run.workflowId) {
    return reject('missing_evidence', 'Questioner output identity does not match the QuestionerRun.');
  }
  if (output.subtaskId !== run.subtaskId || output.intent !== run.intent) {
    return reject('missing_evidence', 'Questioner output intent/subtask does not match the QuestionerRun.');
  }
  if (output.source !== 'claude-plugin') {
    return reject('missing_evidence', 'Questioner output must come from the Claude plugin.');
  }
  if (output.actor.kind !== 'claude-code-questioner' || output.actor.invocationId !== run.invocationId) {
    return reject('missing_subagent_invocation', 'Questioner output actor does not match the run invocation.');
  }
  if (output.actor.pluginName !== 'agent-loop-claude-review' || output.actor.skillName !== 'question-tik-agent-loop') {
    return reject('missing_evidence', 'Questioner output actor must identify the Claude Questioner plugin skill.');
  }
  if (output.attestation.headSha !== run.headSha) {
    return reject('head_sha_mismatch', 'Questioner output head does not match the QuestionerRun head.');
  }
  if (output.attestation.contextArtifactRef !== run.contextArtifactRef || output.attestation.contextHash !== run.contextHash) {
    return reject('missing_evidence', 'Questioner output context attestation does not match the QuestionerRun.');
  }
  if (output.attestation.contextHash !== context.run.contextHash) {
    return reject('missing_evidence', 'Questioner output context hash does not match the stored context.');
  }
  if (run.expectedOutputArtifactRef && output.attestation.outputArtifactRef !== run.expectedOutputArtifactRef) {
    return reject('missing_evidence', 'Questioner output artifact ref does not match the expected output artifact.');
  }
  const expectedOutputHash = computeQuestionerOutputHash(output);
  if (output.attestation.outputHash !== expectedOutputHash) {
    return reject('missing_evidence', 'Questioner output hash does not match its canonical JSON payload.');
  }
  if (run.contractId && output.references.contractId !== run.contractId) {
    return reject('missing_contract', 'Questioner output contract reference does not match the QuestionerRun.');
  }
  if (run.evaluationRunId && output.references.evaluationRunId !== run.evaluationRunId) {
    return reject('missing_evaluation_result', 'Questioner output evaluation reference does not match the QuestionerRun.');
  }
  if (run.finalEvaluationRunId && output.references.finalEvaluationRunId !== run.finalEvaluationRunId) {
    return reject('missing_evaluation_result', 'Questioner output final evaluation reference does not match the QuestionerRun.');
  }
  if (evaluation && (output.references.evaluationRunId !== evaluation.id || output.attestation.headSha !== evaluation.headSha)) {
    return reject('head_sha_mismatch', 'Questioner output does not match the evaluation run.');
  }
  if (finalEvaluation && (output.references.finalEvaluationRunId !== finalEvaluation.id || output.attestation.headSha !== finalEvaluation.headSha)) {
    return reject('head_sha_mismatch', 'Questioner output does not match the final evaluation run.');
  }
  if (contract && output.references.contractId !== contract.id) {
    return reject('missing_contract', 'Questioner output does not match the SprintContract.');
  }
  const coverage = validateCoverageMatrix({
    context,
    output,
    contract,
  });
  if (!coverage.accepted) {
    return coverage;
  }
  const blocking = output.questions.filter((question) => question.priority === 'blocking' && question.status === 'open');
  if (
    (output.verdict === 'evidence_sufficient' || output.verdict === 'no_blocking_questions')
    && blocking.length > 0
  ) {
    return reject('blocking_question_unresolved', 'Sufficient Questioner verdict cannot contain open blocking questions.');
  }
  return { accepted: true };
}

export function validateCoverageMatrix(args: {
  context: QuestionerContextV1;
  output: Pick<QuestionerOutputV2, 'coverageMatrix' | 'verdict' | 'questions'>;
  contract?: SprintContract;
}): QuestionerValidationResult {
  if (!Array.isArray(args.output.coverageMatrix) || args.output.coverageMatrix.length === 0) {
    return reject('evaluation_evidence_insufficient', 'QuestionerOutputV2 must include a coverageMatrix.');
  }
  const requiredCriteria = requiredCriterionIds(args.context, args.contract);
  const coverageByCriterion = new Map(args.output.coverageMatrix.map((entry) => [entry.criterionId, entry]));
  const missing = requiredCriteria.filter((criterion) => coverageByCriterion.get(criterion.id)?.status !== 'covered');
  if (missing.length > 0) {
    const hasQuestionForMissing = args.output.questions.some((question) =>
      question.priority === 'blocking' || question.priority === 'evidence_needed'
    );
    if (!hasQuestionForMissing) {
      return reject(
        'evaluation_evidence_insufficient',
        'Questioner coverageMatrix must cover every required criterion or raise an evidence question.',
      );
    }
    if (args.output.verdict === 'evidence_sufficient' || args.output.verdict === 'no_blocking_questions') {
      return reject('evaluation_evidence_insufficient', 'Sufficient Questioner verdict requires every required criterion to be covered.');
    }
  }
  const weakCovered = args.output.coverageMatrix
    .filter((entry) => entry.required && entry.status === 'covered')
    .filter((entry) => entry.evidenceRefs.length === 0 || !entry.comment.trim());
  if (weakCovered.length > 0) {
    return reject('evaluation_evidence_insufficient', 'Covered required criteria need evidenceRefs and a comment.');
  }
  return { accepted: true };
}

export function normalizeQuestionerOutputV2(output: QuestionerOutputV2): QuestionerOutput {
  return {
    schemaVersion: 'questioner-output.v2',
    id: output.id,
    questionerRunId: output.questionerRunId,
    workflowId: output.workflowId,
    subtaskId: output.subtaskId,
    intent: output.intent,
    actor: output.actor,
    source: output.source,
    headSha: output.attestation.headSha,
    evaluationRunId: output.references.evaluationRunId,
    finalEvaluationRunId: output.references.finalEvaluationRunId,
    contractId: output.references.contractId,
    artifactRef: output.attestation.outputArtifactRef,
    attestation: output.attestation,
    references: output.references,
    coverageMatrix: output.coverageMatrix,
    verdict: output.verdict,
    questions: output.questions.map((question) => ({
      ...question,
      question: question.claim,
      whyItMatters: question.requestedEvidence || question.requestedFix || question.category,
      expectedAnswerType: question.category === 'missing_test' ? 'test_case' : 'evidence',
    })),
    risks: output.risks.map((risk) => ({
      ...risk,
      suggestedMitigation: risk.mitigation || '',
    })),
    missingTests: output.missingTests.map((missingTest) => ({
      ...missingTest,
      scenario: missingTest.testScenario,
    })),
    suggestedContractChanges: [],
    advisoryNotes: output.advisoryNotes,
    createdAt: output.createdAt || output.attestation.generatedAt,
  };
}

export function assertCanonicalContextHash(context: QuestionerContextV1): boolean {
  const expected = stableHash({
    ...context,
    run: {
      ...context.run,
      contextHash: '',
    },
  });
  return expected === context.run.contextHash;
}

export function canonicalOutputJson(output: QuestionerOutputV2): string {
  return stableStringify({
    ...output,
    attestation: {
      ...output.attestation,
      outputHash: '',
    },
    createdAt: undefined,
  });
}

function requiredCriterionIds(context: QuestionerContextV1, contract?: SprintContract): Array<{ id: string; text: string }> {
  const contractCriteria = contract?.acceptanceCriteria
    .filter((criterion) => criterion.priority === 'must')
    .map((criterion) => ({ id: criterion.id, text: criterion.statement })) || [];
  if (contractCriteria.length > 0) {
    return contractCriteria;
  }
  if (context.contract?.mustCriteria.length) {
    return context.contract.mustCriteria.map((criterion) => ({ id: criterion.id, text: criterion.statement }));
  }
  if (context.finalEvaluation?.globalCriteriaCoverage.length) {
    return context.finalEvaluation.globalCriteriaCoverage.map((criterion) => ({
      id: criterion.criterionId,
      text: criterion.evidence,
    }));
  }
  return context.workflow.globalAcceptanceCriteria.map((criterion, index) => ({
    id: `global-ac-${index + 1}`,
    text: criterion,
  }));
}

function reject(code: string, message: string): QuestionerValidationResult {
  return {
    accepted: false,
    code,
    message,
  };
}
