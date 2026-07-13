import { createHash } from 'node:crypto';
import type {
  AgentInvocationRecord,
  MultiAgentWorkflowBundle,
  NativeAgentContextBundle,
} from '@tik/shared';
import type { CreateAgentInvocationInput } from './workflow-store.js';

const ROLE_TOKEN_BUDGETS: Record<AgentInvocationRecord['role'], number> = {
  planner: 12_000,
  executor: 24_000,
  reviewer: 16_000,
  evaluator: 24_000,
  questioner: 12_000,
};

export function buildNativeAgentContextBundle(
  bundle: MultiAgentWorkflowBundle,
  invocation: CreateAgentInvocationInput,
): NativeAgentContextBundle {
  const maxTokens = ROLE_TOKEN_BUDGETS[invocation.role];
  const contract = bundle.contracts
    .filter((item) => item.subtaskId === invocation.subtaskId && item.status === 'accepted')
    .sort((left, right) => right.version - left.version)[0];
  const implementation = bundle.evidence
    .filter((item) => item.subtaskId === invocation.subtaskId && (item.kind === 'implementation' || item.kind === 'fix'))
    .filter((item) => !invocation.headSha || item.headSha === invocation.headSha)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
  const evaluation = bundle.evaluationRuns
    .filter((item) => item.subtaskId === invocation.subtaskId && (!invocation.headSha || item.headSha === invocation.headSha))
    .sort((left, right) => right.startedAt.localeCompare(left.startedAt))[0];
  const changedFiles = readChangedFiles(implementation?.payload).slice(0, 200);
  const artifactIndex = Array.from(new Set([
    ...bundle.evidence.map((item) => item.artifactRef).filter((item): item is string => Boolean(item)),
    ...(evaluation?.artifactRefs || []),
    ...(evaluation?.result?.commandResults || []).flatMap((command) => [
      command.stdoutArtifactId,
      command.stderrArtifactId,
      ...(command.testReports || []).map((report) => report.artifactId),
    ]).filter((item): item is string => Boolean(item)),
  ])).sort().slice(0, 100);
  const context: NativeAgentContextBundle = {
    schemaVersion: 'native-agent-context.v1',
    workflowId: bundle.workflow.id,
    role: invocation.role,
    subtaskId: invocation.subtaskId,
    headSha: invocation.headSha || bundle.workflow.currentHeadSha || '',
    goal: truncate(bundle.workflow.goal, 2_000),
    contract: contract ? {
      id: contract.id,
      goal: truncate(contract.goal, 1_000),
      mustCriteria: contract.acceptanceCriteria
        .filter((criterion) => criterion.priority === 'must')
        .map((criterion) => ({ id: criterion.id, statement: truncate(criterion.statement, 1_000) })),
      allowedPaths: [...contract.scope.allowedPaths].sort(),
      blockedPaths: [...contract.scope.blockedPaths].sort(),
    } : undefined,
    implementation: implementation ? {
      evidenceId: implementation.id,
      summary: truncate(implementation.summary || implementation.title, 2_000),
      changedFiles,
    } : undefined,
    evaluation: evaluation ? {
      runId: evaluation.id,
      verdict: evaluation.result?.verdict,
      failedCommands: (evaluation.result?.commandResults || [])
        .filter((command) => command.status !== 'passed')
        .map((command) => command.commandId),
      coverageGaps: (evaluation.result?.coverageGaps || [])
        .map((gap) => truncate(`${gap.criterionId || 'all'}: ${gap.description}`, 500))
        .slice(0, 20),
    } : undefined,
    taskInput: sanitizeTaskInput(invocation.input),
    allowedPaths: [...(invocation.allowedPaths || [])].sort(),
    validationCommands: [...(invocation.validationCommands || [])],
    artifactIndex,
    instructions: [
      'Use only this context bundle, the target commit diff, and files directly relevant to the listed criteria.',
      'Do not read full workflow history, unrelated invocation transcripts, or invoke workflow-driving skills.',
      'Return the required structured output once the scoped evidence is sufficient.',
    ],
    budget: {
      estimatedTokens: 0,
      maxTokens,
      truncated: changedFiles.length >= 200 || artifactIndex.length >= 100,
    },
    contextHash: '',
  };
  context.budget.estimatedTokens = estimateContextTokens(context);
  context.contextHash = hashContext(context);
  return context;
}

export function renderNativeContextPrompt(
  context: NativeAgentContextBundle,
  outputContract: string,
): string {
  return [
    `You are the Tik-owned ${context.role} for workflow ${context.workflowId}.`,
    'This is a clean native thread. Do not reconstruct or load the parent conversation.',
    'ContextBundle:',
    JSON.stringify(context),
    outputContract,
  ].join('\n');
}

export function estimateContextTokens(value: unknown): number {
  return Math.ceil(Buffer.byteLength(typeof value === 'string' ? value : JSON.stringify(value), 'utf-8') / 4);
}

export function assertContextBudget(context: NativeAgentContextBundle, prompt?: string): void {
  const promptTokens = prompt ? estimateContextTokens(prompt) : context.budget.estimatedTokens;
  if (context.budget.estimatedTokens > context.budget.maxTokens || promptTokens > context.budget.maxTokens) {
    throw new Error(
      `context_budget_exceeded: estimated ${Math.max(context.budget.estimatedTokens, promptTokens)} tokens, budget ${context.budget.maxTokens}.`,
    );
  }
}

function hashContext(context: NativeAgentContextBundle): string {
  return `sha256:${createHash('sha256')
    .update(JSON.stringify({ ...context, contextHash: '' }))
    .digest('hex')}`;
}

function readChangedFiles(payload: Record<string, unknown> | undefined): string[] {
  const entries = Array.isArray(payload?.observedChangedFiles)
    ? payload.observedChangedFiles
    : Array.isArray(payload?.changedFiles)
      ? payload.changedFiles
      : [];
  return Array.from(new Set(entries.flatMap((entry) => {
    if (typeof entry === 'string') return [entry];
    if (entry && typeof entry === 'object' && 'path' in entry && typeof entry.path === 'string') return [entry.path];
    return [];
  }))).sort();
}

function truncate(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, Math.max(0, maxChars - 20))}\n[truncated]`;
}

const EXCLUDED_TASK_INPUT_KEYS = new Set([
  'contextBundle',
  'decisions',
  'events',
  'invocations',
  'transcript',
  'transcripts',
  'workflowHistory',
]);

function sanitizeTaskInput(input: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!input) return undefined;
  const sanitized = sanitizeTaskInputValue(input, 0);
  return sanitized && typeof sanitized === 'object' && !Array.isArray(sanitized)
    ? sanitized as Record<string, unknown>
    : undefined;
}

function sanitizeTaskInputValue(value: unknown, depth: number): unknown {
  if (typeof value === 'string') return truncate(value, 2_000);
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (depth >= 5) return '[truncated: depth limit]';
  if (Array.isArray(value)) {
    return value.slice(0, 50).map((item) => sanitizeTaskInputValue(item, depth + 1));
  }
  if (!value || typeof value !== 'object') return undefined;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !EXCLUDED_TASK_INPUT_KEYS.has(key))
    .slice(0, 100)
    .map(([key, item]) => [key, sanitizeTaskInputValue(item, depth + 1)]));
}
