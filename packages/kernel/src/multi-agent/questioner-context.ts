import { createHash } from 'node:crypto';
import type {
  EvaluationRun,
  MultiAgentWorkflowBundle,
  MultiAgentWorkflowEvidence,
  QuestionerContextV1,
  QuestionerIntent,
  QuestionerOutput,
  SprintContract,
  SubtaskSpec,
} from '@tik/shared';

export interface BuildQuestionerContextInput {
  workflowId: string;
  questionerRunId: string;
  invocationId: string;
  intent: QuestionerIntent;
  subtaskId?: string;
  contractId?: string;
  evaluationRunId?: string;
  finalEvaluationRunId?: string;
  headSha: string;
  submitUrl: string;
}

export function buildQuestionerContext(
  bundle: MultiAgentWorkflowBundle,
  input: BuildQuestionerContextInput,
): QuestionerContextV1 {
  const subtaskSpec = input.subtaskId
    ? bundle.taskGraph?.subtasks.find((candidate) => candidate.id === input.subtaskId)
    : undefined;
  const subtaskState = input.subtaskId ? bundle.subtasks[input.subtaskId] : undefined;
  const contract = input.contractId
    ? bundle.contracts.find((candidate) => candidate.id === input.contractId)
    : input.subtaskId
      ? latestAcceptedContract(bundle.contracts, input.subtaskId)
      : undefined;
  const implementation = input.subtaskId
    ? latestImplementationEvidence(bundle.evidence, input.subtaskId, input.headSha)
    : undefined;
  const evaluation = input.evaluationRunId
    ? bundle.evaluationRuns.find((candidate) => candidate.id === input.evaluationRunId)
    : undefined;
  const finalEvaluation = input.finalEvaluationRunId
    ? bundle.evaluationRuns.find((candidate) => candidate.id === input.finalEvaluationRunId)
    : undefined;
  const contextWithoutHash: QuestionerContextV1 = {
    schemaVersion: 'questioner-context.v1',
    run: {
      questionerRunId: input.questionerRunId,
      invocationId: input.invocationId,
      workflowId: input.workflowId,
      intent: input.intent,
      headSha: input.headSha,
      contextHash: '',
      submitUrl: input.submitUrl,
    },
    workflow: {
      goal: bundle.workflow.goal,
      policy: { ...(bundle.workflow.policy || {}) },
      globalAcceptanceCriteria: bundle.taskGraph?.globalAcceptanceCriteria || [],
    },
    subtask: subtaskSpec
      ? buildSubtaskBlock(subtaskSpec, subtaskState?.status || 'pending')
      : undefined,
    contract: contract ? buildContractBlock(contract) : undefined,
    implementationEvidence: implementation ? buildImplementationBlock(bundle, implementation) : undefined,
    evaluation: evaluation ? buildEvaluationBlock(bundle, evaluation) : undefined,
    finalEvaluation: finalEvaluation ? buildFinalEvaluationBlock(finalEvaluation) : undefined,
    diff: {
      headSha: input.headSha,
      files: implementation ? changedFilesFromEvidence(implementation) : [],
      excerpts: [],
    },
    relevantFiles: [],
    previousQuestionerOutputs: collectPreviousOpenQuestions(bundle.questionerOutputs, input),
    outputContract: {
      schemaVersion: 'questioner-output.v2',
      requiredFields: [
        'schemaVersion',
        'questionerRunId',
        'actor.invocationId',
        'attestation.contextHash',
        'attestation.outputHash',
        'coverageMatrix',
      ],
      allowedVerdicts: [
        'questions_blocking',
        'evidence_needed',
        'risk_found',
        'no_blocking_questions',
        'evidence_sufficient',
      ],
    },
  };

  const contextHash = stableHash(redactSensitiveContext(contextWithoutHash));
  return redactSensitiveContext({
    ...contextWithoutHash,
    run: {
      ...contextWithoutHash.run,
      contextHash,
    },
  });
}

export function stableHash(value: unknown): string {
  return `sha256:${createHash('sha256').update(stableStringify(value)).digest('hex')}`;
}

export function stableStringify(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

export function redactSensitiveContext<T>(value: T): T {
  return redactSensitiveObject(value) as T;
}

function buildSubtaskBlock(spec: SubtaskSpec, status: string): NonNullable<QuestionerContextV1['subtask']> {
  return {
    id: spec.id,
    title: spec.title,
    description: spec.goal,
    status,
    dependencies: spec.dependsOn || [],
  };
}

function buildContractBlock(contract: SprintContract): NonNullable<QuestionerContextV1['contract']> {
  return {
    id: contract.id,
    status: contract.status,
    mustCriteria: contract.acceptanceCriteria
      .filter((criterion) => criterion.priority === 'must')
      .map((criterion) => ({
        id: criterion.id,
        statement: criterion.statement,
        verificationMethod: criterion.verificationMethod,
      })),
    shouldCriteria: contract.acceptanceCriteria
      .filter((criterion) => criterion.priority !== 'must')
      .map((criterion) => ({
        id: criterion.id,
        statement: criterion.statement,
        verificationMethod: criterion.verificationMethod,
      })),
    outOfScope: contract.scope.blockedPaths || [],
    requiredEvidence: [
      ...contract.verificationPlan.commands.filter((command) => command.required).map((command) => command.id),
      ...(contract.verificationPlan.negativeChecks || []),
    ],
  };
}

function buildImplementationBlock(
  bundle: MultiAgentWorkflowBundle,
  evidence: MultiAgentWorkflowEvidence,
): NonNullable<QuestionerContextV1['implementationEvidence']> {
  const builder = bundle.invocations
    .filter((invocation) =>
      invocation.role === 'executor'
      && invocation.runner === 'codex'
      && (invocation.evidenceRefs || []).includes(evidence.id)
    )
    .sort((left, right) => String(right.completedAt || right.updatedAt).localeCompare(String(left.completedAt || left.updatedAt)))[0];
  return {
    id: evidence.id,
    builderInvocationId: builder?.id,
    headSha: evidence.headSha,
    summary: evidence.summary || evidence.title,
    changedFiles: changedFilesFromEvidence(evidence),
    commands: evidence.command
      ? [{ command: evidence.command, status: evidence.passed === undefined ? undefined : evidence.passed ? 'passed' : 'failed' }]
      : [],
    artifacts: evidence.artifactRef ? [{ ref: evidence.artifactRef, kind: evidence.kind, summary: evidence.summary }] : [],
  };
}

function buildEvaluationBlock(
  bundle: MultiAgentWorkflowBundle,
  evaluation: EvaluationRun,
): NonNullable<QuestionerContextV1['evaluation']> {
  const evaluatorInvocation = bundle.invocations
    .filter((invocation) =>
      invocation.role === 'evaluator'
      && invocation.runner === 'codex-evaluator'
      && invocation.evaluationRunId === evaluation.id
    )
    .sort((left, right) => String(right.completedAt || right.updatedAt).localeCompare(String(left.completedAt || left.updatedAt)))[0];
  return {
    id: evaluation.id,
    evaluatorInvocationId: evaluatorInvocation?.id,
    readonly: evaluation.readonlyPolicy.enforced && (evaluation.readonlyPolicy.violations || []).length === 0,
    headSha: evaluation.headSha,
    verdict: evaluation.result?.verdict,
    commands: evaluation.result?.commandResults || [],
    artifacts: evaluation.artifactRefs.map((ref) => ({ ref, kind: 'evaluation' })),
    coverage: evaluation.result?.criteriaResults || [],
    coverageGaps: evaluation.result?.coverageGaps || [],
    logs: [],
  };
}

function buildFinalEvaluationBlock(evaluation: EvaluationRun): NonNullable<QuestionerContextV1['finalEvaluation']> {
  return {
    id: evaluation.id,
    headSha: evaluation.headSha,
    verdict: evaluation.result?.verdict,
    globalCriteriaCoverage: evaluation.result?.criteriaResults || [],
    requiredEvidence: evaluation.artifactRefs.map((ref) => ({ ref, kind: 'evaluation' })),
    coverageGaps: evaluation.result?.coverageGaps || [],
  };
}

function collectPreviousOpenQuestions(
  outputs: QuestionerOutput[],
  input: BuildQuestionerContextInput,
): QuestionerContextV1['previousQuestionerOutputs'] {
  return outputs
    .filter((output) => output.intent === input.intent && output.id)
    .filter((output) => input.subtaskId === undefined || output.subtaskId === input.subtaskId)
    .slice(-5)
    .map((output) => ({
      id: output.id,
      intent: output.intent,
      verdict: output.verdict,
      unresolvedQuestions: (output.questions || [])
        .filter((question) => question.status === undefined || question.status === 'open')
        .map((question) => ({
          id: question.id,
          priority: question.priority,
          claim: question.claim || question.question || '',
        })),
    }));
}

function latestAcceptedContract(contracts: SprintContract[], subtaskId: string): SprintContract | undefined {
  return contracts
    .filter((contract) => contract.subtaskId === subtaskId && contract.status === 'accepted')
    .sort((left, right) => right.version - left.version || String(right.acceptedAt || '').localeCompare(String(left.acceptedAt || '')))[0];
}

function latestImplementationEvidence(
  evidence: MultiAgentWorkflowEvidence[],
  subtaskId: string,
  headSha: string,
): MultiAgentWorkflowEvidence | undefined {
  return evidence
    .filter((item) => item.subtaskId === subtaskId && (item.kind === 'implementation' || item.kind === 'fix'))
    .filter((item) => !item.headSha || item.headSha === headSha)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0]
    || evidence
      .filter((item) => item.subtaskId === subtaskId && (item.kind === 'implementation' || item.kind === 'fix'))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
}

function changedFilesFromEvidence(evidence: MultiAgentWorkflowEvidence): Array<{ path: string; changeType?: string }> {
  const payload = evidence.payload || {};
  const changedFiles = Array.isArray(payload.observedChangedFiles)
    ? payload.observedChangedFiles
    : Array.isArray(payload.changedFiles)
      ? payload.changedFiles
      : [];
  return changedFiles
    .map((entry) => {
      if (typeof entry === 'string') return { path: entry };
      if (entry && typeof entry === 'object' && 'path' in entry && typeof entry.path === 'string') {
        return {
          path: entry.path,
          changeType: 'changeType' in entry && typeof entry.changeType === 'string' ? entry.changeType : undefined,
        };
      }
      return undefined;
    })
    .filter((entry): entry is { path: string; changeType?: string } => Boolean(entry));
}

function stableStringKeyOrder(entries: [string, unknown][]): [string, unknown][] {
  return entries.sort(([left], [right]) => left.localeCompare(right));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortJson);
  }
  if (!value || typeof value !== 'object') {
    return value;
  }
  return Object.fromEntries(
    stableStringKeyOrder(Object.entries(value as Record<string, unknown>))
      .filter(([, entry]) => entry !== undefined)
      .map(([key, entry]) => [key, sortJson(entry)]),
  );
}

function redactSensitiveObject(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(redactSensitiveObject);
  }
  if (!value || typeof value !== 'object') {
    return value;
  }
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
    key,
    isSensitiveKey(key) ? '[redacted]' : redactSensitiveObject(entry),
  ]));
}

function isSensitiveKey(key: string): boolean {
  const normalized = key.toLowerCase();
  return normalized.includes('token')
    || normalized.includes('secret')
    || normalized.includes('password')
    || normalized.includes('credential');
}
