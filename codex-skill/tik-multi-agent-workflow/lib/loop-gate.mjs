import { allSubtasksDone, chooseNextSubtask } from './task-graph.mjs';

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

  if (allSubtasksDone(graph, subtasks)) {
    return {
      action: 'request_final_review',
      reason: 'All subtasks are done; request final review before completing workflow.',
      evidenceRefs: collectEvidenceRefs(subtasks),
      inputs: { taskGraphVersion: graph.version },
    };
  }

  const needsFix = Object.values(subtasks).find((subtask) => subtask.status === 'needs_fix');
  if (needsFix) {
    return {
      action: 'fix_claude_blockers',
      subtaskId: needsFix.subtaskId,
      reason: 'Subtask is waiting for Codex to fix Claude blocking issues.',
      evidenceRefs: needsFix.evidenceRefs || [],
      inputs: { fixRound: needsFix.fixRound || 0 },
    };
  }

  const implemented = Object.values(subtasks).find((subtask) => subtask.status === 'implemented' || subtask.status === 'approved');
  if (implemented) {
    return {
      action: 'validate_subtask',
      subtaskId: implemented.subtaskId,
      reason: 'Subtask has implementation evidence and should be validated.',
      evidenceRefs: implemented.evidenceRefs || [],
      inputs: {},
    };
  }

  const validationFailed = Object.values(subtasks).find((subtask) => subtask.status === 'validation_failed');
  if (validationFailed) {
    return {
      action: 'execute_subtask',
      subtaskId: validationFailed.subtaskId,
      reason: 'Validation failed; current Codex session should inspect and fix the subtask.',
      evidenceRefs: validationFailed.evidenceRefs || [],
      inputs: { retry: true },
    };
  }

  const reviewing = Object.values(subtasks).find((subtask) => subtask.status === 'reviewing');
  if (reviewing) {
    return {
      action: 'request_re_review',
      subtaskId: reviewing.subtaskId,
      reason: 'Subtask is in review state; process or request the next Claude review round.',
      evidenceRefs: reviewing.evidenceRefs || [],
      inputs: {},
    };
  }

  const ready = chooseNextSubtask(graph, subtasks);
  if (ready) {
    return {
      action: 'execute_subtask',
      subtaskId: ready.id,
      reason: `Subtask ${ready.id} is ready and dependencies are done.`,
      evidenceRefs: [],
      inputs: { title: ready.title },
    };
  }

  return {
    action: 'request_human_review',
    reason: 'No schedulable subtask or automatic workflow action is available.',
    evidenceRefs: collectEvidenceRefs(subtasks),
    inputs: { workflowStatus: workflow?.status },
  };
}

function collectEvidenceRefs(subtasks) {
  return Array.from(new Set(Object.values(subtasks).flatMap((subtask) => subtask.evidenceRefs || [])));
}
