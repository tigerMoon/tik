import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
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
import { stableHash } from '@tik/shared';

const MAX_DIFF_FILES = 8;
const MAX_RELEVANT_FILES = 8;
const MAX_FILE_EXCERPT_CHARS = 1800;
const MAX_ARTIFACT_SUMMARY_CHARS = 1600;
const MAX_LOG_EXCERPT_CHARS = 2400;
const MAX_DIFF_EXCERPT_CHARS = 2600;

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

export async function buildQuestionerContext(
  bundle: MultiAgentWorkflowBundle,
  input: BuildQuestionerContextInput,
): Promise<QuestionerContextV1> {
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
  const projectPath = resolveProjectPath(bundle);
  const artifactRoot = resolveArtifactRoot(bundle, projectPath);
  const changedFiles = implementation ? changedFilesFromEvidence(implementation) : [];
  const contextArtifacts = await buildContextArtifacts({
    artifactRoot,
    implementation,
    evaluation,
    finalEvaluation,
  });
  const diffExcerpts = await buildDiffExcerpts(projectPath, input.headSha, changedFiles);
  const relevantFiles = await buildRelevantFiles(projectPath, {
    changedFiles,
    contract,
    evaluation,
    implementation,
  });
  const evaluationLogs = evaluation
    ? await buildEvaluationLogs(artifactRoot, evaluation)
    : [];
  const evaluationArtifacts = evaluation
    ? await summarizeArtifactRefs(artifactRoot, evaluation.artifactRefs, 'evaluation')
    : [];
  const finalEvaluationArtifacts = finalEvaluation
    ? await summarizeArtifactRefs(artifactRoot, finalEvaluation.artifactRefs, 'evaluation')
    : [];
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
    implementationEvidence: implementation ? buildImplementationBlock(bundle, implementation, contextArtifacts.implementation) : undefined,
    evaluation: evaluation ? buildEvaluationBlock(bundle, evaluation, [...evaluationArtifacts, ...contextArtifacts.evaluation], evaluationLogs) : undefined,
    finalEvaluation: finalEvaluation ? buildFinalEvaluationBlock(finalEvaluation, [...finalEvaluationArtifacts, ...contextArtifacts.finalEvaluation]) : undefined,
    diff: {
      headSha: input.headSha,
      files: changedFiles,
      excerpts: [
        ...diffExcerpts,
        ...buildStaleEvidenceExcerpts(bundle, input, implementation),
      ],
    },
    relevantFiles,
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
  artifacts: Array<{ ref: string; kind?: string; summary?: string }>,
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
    artifacts: evidence.artifactRef
      ? [
        { ref: evidence.artifactRef, kind: evidence.kind, summary: evidence.summary },
        ...artifacts.filter((artifact) => artifact.ref !== evidence.artifactRef),
      ]
      : artifacts,
  };
}

function buildEvaluationBlock(
  bundle: MultiAgentWorkflowBundle,
  evaluation: EvaluationRun,
  artifacts: Array<{ ref: string; kind?: string; summary?: string }>,
  logs: NonNullable<QuestionerContextV1['evaluation']>['logs'],
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
    artifacts,
    coverage: evaluation.result?.criteriaResults || [],
    coverageGaps: evaluation.result?.coverageGaps || [],
    logs,
  };
}

function buildFinalEvaluationBlock(
  evaluation: EvaluationRun,
  artifacts: Array<{ ref: string; kind?: string; summary?: string }>,
): NonNullable<QuestionerContextV1['finalEvaluation']> {
  return {
    id: evaluation.id,
    headSha: evaluation.headSha,
    verdict: evaluation.result?.verdict,
    globalCriteriaCoverage: evaluation.result?.criteriaResults || [],
    requiredEvidence: artifacts,
    coverageGaps: evaluation.result?.coverageGaps || [],
  };
}

async function buildContextArtifacts(input: {
  artifactRoot?: string;
  implementation?: MultiAgentWorkflowEvidence;
  evaluation?: EvaluationRun;
  finalEvaluation?: EvaluationRun;
}): Promise<{
  implementation: Array<{ ref: string; kind?: string; summary?: string }>;
  evaluation: Array<{ ref: string; kind?: string; summary?: string }>;
  finalEvaluation: Array<{ ref: string; kind?: string; summary?: string }>;
}> {
  const implementation = input.implementation?.artifactRef
    ? await summarizeArtifactRefs(input.artifactRoot, [input.implementation.artifactRef], input.implementation.kind)
    : [];
  return {
    implementation,
    evaluation: input.evaluation ? await summarizeCommandArtifactRefs(input.artifactRoot, input.evaluation) : [],
    finalEvaluation: input.finalEvaluation ? await summarizeCommandArtifactRefs(input.artifactRoot, input.finalEvaluation) : [],
  };
}

async function summarizeCommandArtifactRefs(
  artifactRoot: string | undefined,
  evaluation: EvaluationRun,
): Promise<Array<{ ref: string; kind?: string; summary?: string }>> {
  const commandRefs = (evaluation.result?.commandResults || [])
    .flatMap((command) => [command.stdoutArtifactId, command.stderrArtifactId])
    .filter((ref): ref is string => Boolean(ref));
  return summarizeArtifactRefs(artifactRoot, commandRefs, 'evaluation-log');
}

async function buildEvaluationLogs(
  artifactRoot: string | undefined,
  evaluation: EvaluationRun,
): Promise<NonNullable<QuestionerContextV1['evaluation']>['logs']> {
  const logs: NonNullable<QuestionerContextV1['evaluation']>['logs'] = [];
  for (const command of evaluation.result?.commandResults || []) {
    const refs = [
      { ref: command.stdoutArtifactId, label: 'stdout' },
      { ref: command.stderrArtifactId, label: 'stderr' },
    ].filter((entry): entry is { ref: string; label: string } => Boolean(entry.ref));
    for (const entry of refs) {
      const artifact = await readTextArtifact(artifactRoot, entry.ref, MAX_LOG_EXCERPT_CHARS);
      if (artifact) {
        logs.push({
          artifactRef: entry.ref,
          excerpt: [
            `$ ${command.command}`,
            `${entry.label} artifact sha256:${artifact.sha256}`,
            artifact.excerpt,
          ].join('\n'),
        });
      }
    }
    if (command.status !== 'passed' || /gap|missing|fail|error/i.test(command.summary || '')) {
      logs.push({
        excerpt: [
          `$ ${command.command}`,
          `status=${command.status}${command.exitCode === undefined ? '' : ` exitCode=${command.exitCode}`}`,
          command.summary || '(no summary)',
        ].join('\n'),
      });
    }
  }
  for (const gap of evaluation.result?.coverageGaps || []) {
    logs.push({
      excerpt: [
        gap.criterionId ? `coverage gap ${gap.criterionId}` : 'coverage gap',
        gap.description,
        gap.reason,
      ].filter(Boolean).join('\n'),
    });
  }
  return logs.slice(0, 8);
}

async function buildDiffExcerpts(
  projectPath: string | undefined,
  headSha: string,
  changedFiles: Array<{ path: string; changeType?: string }>,
): Promise<NonNullable<QuestionerContextV1['diff']>['excerpts']> {
  if (!projectPath) {
    return buildSyntheticDiffExcerpts(changedFiles, 'workspace path unavailable');
  }
  const excerpts: NonNullable<QuestionerContextV1['diff']>['excerpts'] = [];
  const stat = git(projectPath, ['diff', '--stat', `${headSha}^`, headSha]);
  if (stat) {
    excerpts.push({ path: '__git_diff_stat__', excerpt: truncateText(stat, MAX_DIFF_EXCERPT_CHARS) });
  }
  const nameStatus = git(projectPath, ['diff', '--name-status', `${headSha}^`, headSha]);
  if (nameStatus) {
    excerpts.push({ path: '__git_diff_name_status__', excerpt: truncateText(nameStatus, MAX_DIFF_EXCERPT_CHARS) });
  } else if (changedFiles.length > 0) {
    excerpts.push(...buildSyntheticDiffExcerpts(changedFiles, 'git diff name-status unavailable'));
  }
  for (const file of changedFiles.slice(0, MAX_DIFF_FILES)) {
    const normalized = normalizeRelativePath(file.path);
    const diff = git(projectPath, ['diff', '--no-ext-diff', '--unified=40', `${headSha}^`, headSha, '--', normalized]);
    if (diff) {
      excerpts.push({ path: normalized, excerpt: truncateText(diff, MAX_DIFF_EXCERPT_CHARS) });
    } else if (file.changeType === 'deleted') {
      excerpts.push({ path: normalized, excerpt: 'File was deleted; no working tree excerpt available.' });
    }
  }
  return excerpts.slice(0, MAX_DIFF_FILES + 2);
}

function buildSyntheticDiffExcerpts(
  changedFiles: Array<{ path: string; changeType?: string }>,
  reason: string,
): NonNullable<QuestionerContextV1['diff']>['excerpts'] {
  if (changedFiles.length === 0) {
    return [];
  }
  return [{
    path: '__changed_files__',
    excerpt: [
      reason,
      ...changedFiles.slice(0, MAX_DIFF_FILES).map((file) => `${file.changeType || 'modified'}\t${file.path}`),
    ].join('\n'),
  }];
}

function buildStaleEvidenceExcerpts(
  bundle: MultiAgentWorkflowBundle,
  input: BuildQuestionerContextInput,
  implementation: MultiAgentWorkflowEvidence | undefined,
): NonNullable<QuestionerContextV1['diff']>['excerpts'] {
  if (implementation || !input.subtaskId) {
    return [];
  }
  const stale = latestImplementationEvidenceAnyHead(bundle.evidence, input.subtaskId);
  if (!stale) {
    return [{
      path: '__coverage_gap__',
      excerpt: `No implementation/fix evidence exists for subtask ${input.subtaskId} at expected head ${input.headSha}.`,
    }];
  }
  return [{
    path: '__stale_implementation_evidence__',
    excerpt: [
      `No implementation/fix evidence matched expected head ${input.headSha}.`,
      `Latest evidence ${stale.id} was recorded at head ${stale.headSha || '(missing)'}.`,
      'Questioner must treat implementation evidence as stale until same-head evidence exists.',
    ].join('\n'),
  }];
}

async function buildRelevantFiles(
  projectPath: string | undefined,
  input: {
    changedFiles: Array<{ path: string; changeType?: string }>;
    contract?: SprintContract;
    evaluation?: EvaluationRun;
    implementation?: MultiAgentWorkflowEvidence;
  },
): Promise<QuestionerContextV1['relevantFiles']> {
  if (!projectPath) return [];
  const candidates = collectRelevantFileCandidates(input);
  const relevant: QuestionerContextV1['relevantFiles'] = [];
  for (const candidate of candidates) {
    if (relevant.length >= MAX_RELEVANT_FILES) break;
    const excerpt = await readWorkspaceFileExcerpt(projectPath, candidate.path);
    if (!excerpt) continue;
    relevant.push({
      path: normalizeRelativePath(candidate.path),
      sha256: `sha256:${excerpt.sha256}`,
      excerpt: excerpt.excerpt,
      reason: candidate.reason,
    });
  }
  return relevant;
}

function collectRelevantFileCandidates(input: {
  changedFiles: Array<{ path: string; changeType?: string }>;
  contract?: SprintContract;
  evaluation?: EvaluationRun;
  implementation?: MultiAgentWorkflowEvidence;
}): Array<{ path: string; reason: string }> {
  const candidates: Array<{ path: string; reason: string }> = [];
  for (const file of input.changedFiles) {
    candidates.push({
      path: file.path,
      reason: isTestPath(file.path) ? 'touched test file' : 'changed implementation file',
    });
  }
  for (const deliverable of input.contract?.deliverables || []) {
    for (const file of deliverable.expectedFiles || []) {
      candidates.push({ path: file, reason: `contract deliverable ${deliverable.id}` });
    }
  }
  for (const command of input.contract?.verificationPlan.commands || []) {
    for (const file of extractPathLikeTokens(command.command)) {
      candidates.push({ path: file, reason: `contract verification command ${command.id}` });
    }
  }
  for (const criterion of input.evaluation?.result?.criteriaResults || []) {
    for (const file of extractPathLikeTokens(criterion.evidence)) {
      candidates.push({ path: file, reason: `evaluator criterion ${criterion.criterionId}` });
    }
  }
  for (const finding of input.evaluation?.result?.runtimeFindings || []) {
    for (const file of finding.suspectedFiles || []) {
      candidates.push({ path: file.path, reason: `evaluator finding ${finding.id}` });
    }
  }
  for (const file of extractPathLikeTokens(String(input.implementation?.summary || ''))) {
    candidates.push({ path: file, reason: 'implementation summary reference' });
  }
  const seen = new Set<string>();
  return candidates
    .map((candidate) => ({ ...candidate, path: normalizeRelativePath(candidate.path) }))
    .filter((candidate) => {
      if (!candidate.path || seen.has(candidate.path)) return false;
      seen.add(candidate.path);
      return true;
    });
}

async function summarizeArtifactRefs(
  artifactRoot: string | undefined,
  refs: string[],
  kind?: string,
): Promise<Array<{ ref: string; kind?: string; summary?: string }>> {
  const artifacts: Array<{ ref: string; kind?: string; summary?: string }> = [];
  const seen = new Set<string>();
  for (const ref of refs) {
    if (!ref || seen.has(ref)) continue;
    seen.add(ref);
    const artifact = await readTextArtifact(artifactRoot, ref, MAX_ARTIFACT_SUMMARY_CHARS);
    artifacts.push({
      ref,
      kind,
      summary: artifact
        ? [
          `contentType=${artifact.contentType}`,
          `sha256:${artifact.sha256}`,
          artifact.excerpt,
        ].join('\n')
        : 'Artifact content unavailable to QuestionerContextBuilder.',
    });
  }
  return artifacts;
}

async function readWorkspaceFileExcerpt(
  projectPath: string,
  relativePath: string,
): Promise<{ sha256: string; excerpt: string } | undefined> {
  const safePath = resolveInside(projectPath, relativePath);
  if (!safePath || !isReadableTextPath(safePath)) return undefined;
  try {
    const stat = await fs.stat(safePath);
    if (!stat.isFile() || stat.size > 512 * 1024) return undefined;
    const buffer = await fs.readFile(safePath);
    if (isProbablyBinary(buffer)) return undefined;
    return {
      sha256: createHash('sha256').update(buffer).digest('hex'),
      excerpt: truncateText(buffer.toString('utf-8'), MAX_FILE_EXCERPT_CHARS),
    };
  } catch {
    return undefined;
  }
}

async function readTextArtifact(
  artifactRoot: string | undefined,
  artifactRef: string,
  maxChars: number,
): Promise<{ sha256: string; contentType: string; excerpt: string } | undefined> {
  if (!artifactRoot) return undefined;
  const safePath = resolveInside(artifactRoot, artifactRef);
  if (!safePath || !isReadableTextPath(safePath)) return undefined;
  try {
    const stat = await fs.stat(safePath);
    if (!stat.isFile() || stat.size > 1024 * 1024) return undefined;
    const buffer = await fs.readFile(safePath);
    if (isProbablyBinary(buffer)) return undefined;
    return {
      sha256: createHash('sha256').update(buffer).digest('hex'),
      contentType: contentTypeForPath(safePath),
      excerpt: truncateText(buffer.toString('utf-8'), maxChars),
    };
  } catch {
    return undefined;
  }
}

function resolveProjectPath(bundle: MultiAgentWorkflowBundle): string | undefined {
  const binding = bundle.workflow.workspaceBinding;
  return binding?.effectiveProjectPath || binding?.sourceProjectPath || binding?.workspaceRoot;
}

function resolveArtifactRoot(bundle: MultiAgentWorkflowBundle, projectPath: string | undefined): string | undefined {
  return bundle.workflow.workspaceBinding?.workspaceRoot || projectPath;
}

function resolveInside(root: string, candidate: string): string | undefined {
  const normalizedCandidate = normalizeRelativePath(candidate);
  if (!normalizedCandidate || normalizedCandidate.startsWith('..') || path.isAbsolute(normalizedCandidate)) {
    return undefined;
  }
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, normalizedCandidate);
  const relative = path.relative(resolvedRoot, resolved);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
    ? resolved
    : undefined;
}

function normalizeRelativePath(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\.\/+/, '').replace(/^\/+/, '');
}

function git(cwd: string, args: string[]): string {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf-8',
    maxBuffer: 1024 * 1024,
  });
  return result.status === 0 ? result.stdout.trim() : '';
}

function truncateText(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}\n[truncated ${value.length - maxChars} chars]`;
}

function isProbablyBinary(buffer: Buffer): boolean {
  return buffer.subarray(0, 1024).includes(0);
}

function isReadableTextPath(filePath: string): boolean {
  return !/\.(png|jpe?g|gif|webp|ico|pdf|zip|gz|tar|tgz|woff2?|ttf|otf|mp4|mov|mp3|wav)$/i.test(filePath);
}

function contentTypeForPath(filePath: string): string {
  if (filePath.endsWith('.json')) return 'application/json';
  if (filePath.endsWith('.md')) return 'text/markdown';
  if (filePath.endsWith('.html')) return 'text/html';
  return 'text/plain';
}

function isTestPath(filePath: string): boolean {
  return /(^|\/)(test|tests|__tests__)\/|\.test\.|\.spec\./.test(filePath);
}

function extractPathLikeTokens(value: string | undefined): string[] {
  if (!value) return [];
  const matches = value.match(/(?:^|\s)([A-Za-z0-9_.@/-]+\.(?:ts|tsx|js|jsx|mjs|cjs|json|md|css|scss|html|yml|yaml|toml|rs|go|py|java|kt|swift|sql))(?:\b|:\d+)/g) || [];
  return matches
    .map((match) => match.trim().replace(/:\d+$/, ''))
    .map(normalizeRelativePath);
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
    .filter((item) => item.headSha === headSha)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
}

function latestImplementationEvidenceAnyHead(
  evidence: MultiAgentWorkflowEvidence[],
  subtaskId: string,
): MultiAgentWorkflowEvidence | undefined {
  return evidence
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
