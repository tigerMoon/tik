import * as path from 'node:path';
import type {
  GuardResult,
  MultiAgentWorkflowBundle,
  MultiAgentWorkflowEvidence,
  MultiAgentWorkflowRecord,
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

  if (decision.decidedBy !== 'codex-workflow') {
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

  const missingEvidence = decision.evidenceRefs.filter((ref) => !hasEvidence(bundle.evidence, ref));
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

  return {
    accepted: true,
    code: 'ok',
  };
}

function hasEvidence(evidence: MultiAgentWorkflowEvidence[], evidenceId: string): boolean {
  return evidence.some((item) => item.id === evidenceId);
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
