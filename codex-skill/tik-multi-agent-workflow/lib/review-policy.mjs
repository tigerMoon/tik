export function decideAfterReview({ workflow, subtaskId, task, result, validationPassed, validationEvidence }) {
  const round = Number(task?.agentLoop?.round || 1);
  const maxRounds = Number(task?.agentLoop?.maxRounds || workflow?.maxRounds || 3);
  const blockingIssues = result?.blockingIssues || [];

  if (blockingIssues.length > 0) {
    if (round >= maxRounds) {
      return {
        action: 'request_human_review',
        subtaskId,
        reason: 'Claude still reports blocking issues after max review rounds.',
        inputs: { round, maxRounds, reviewTaskId: task?.id },
        risks: blockingIssues.map((issue) => issue.title || issue.reason).filter(Boolean),
      };
    }
    return {
      action: 'fix_claude_blockers',
      subtaskId,
      reason: 'Claude reported blocking issues that must be inspected and fixed by Codex.',
      inputs: { round, maxRounds, reviewTaskId: task?.id, blockingIssueCount: blockingIssues.length },
      risks: blockingIssues.map((issue) => issue.title || issue.reason).filter(Boolean),
    };
  }

  if (result?.verdict === 'approve' && validationPassed) {
    return {
      action: 'complete_subtask',
      subtaskId,
      reason: 'Claude approved and validation passed.',
      inputs: {
        round,
        maxRounds,
        reviewTaskId: task?.id,
        validationEvidenceId: validationEvidence?.id,
        currentHeadSha: result?.headShaReviewed,
      },
      confidence: result?.confidence,
    };
  }

  if (result?.verdict === 'approve') {
    return {
      action: 'validate_subtask',
      subtaskId,
      reason: 'Claude approved, but there is no passing validation evidence for the reviewed head.',
      inputs: {
        round,
        maxRounds,
        reviewTaskId: task?.id,
        reviewedHeadSha: result?.headShaReviewed,
        validationEvidenceId: validationEvidence?.id,
      },
    };
  }

  return {
    action: 'request_human_review',
    subtaskId,
    reason: 'Review did not block but final approval is operator/project policy.',
    inputs: { round, maxRounds, reviewTaskId: task?.id, verdict: result?.verdict },
  };
}
