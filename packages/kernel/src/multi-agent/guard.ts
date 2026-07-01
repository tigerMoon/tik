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
        'validation_failed',
        'needs_fix',
        'fixing',
        'blocked',
      ]);

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
      if (!hasApprovedFinalReview(bundle) && !plannedFinalReviewApproved(decision)) {
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
  if (!result || result.verdict !== 'approve') {
    return undefined;
  }
  const headSha = typeof result.headShaReviewed === 'string'
    ? result.headShaReviewed
    : typeof result.currentHeadSha === 'string'
      ? result.currentHeadSha
      : readStringInput(decision.inputs, 'currentHeadSha') || bundle.workflow.currentHeadSha;
  return {
    id: '__planned_review__',
    workflowId: bundle.workflow.id,
    subtaskId: decision.subtaskId,
    kind: 'review',
    title: 'Planned review evidence',
    headSha,
    payload: { result },
    createdAt: new Date(0).toISOString(),
  };
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
