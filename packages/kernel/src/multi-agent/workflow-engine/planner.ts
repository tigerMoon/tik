import type {
  EvaluationRun,
  MultiAgentWorkflowBundle,
  MultiAgentWorkflowEvidence,
  SubtaskRunState,
  WorkflowDecision,
  WorkflowDecisionAction,
} from '@tik/shared';
import { getWorkflowActionDefinition, type WorkflowActionDefinition, type WorkflowActionPhase } from './action-registry.js';
import { guardTransition } from './transition-guard.js';
import {
  allSubtaskGatesSatisfied,
  allSubtasksDone,
  createWorkflowDecisionContext,
  hasSufficientContractQuestionerOutput,
  hasSufficientEvaluationQuestionerOutput,
  hasSufficientFinalQuestionerOutput,
  latestAcceptedContract,
  latestContract,
  latestEvaluationRun,
  latestImplementationEvidence,
  latestMatchingQuestionerOutput,
  type WorkflowDecisionContext,
} from './predicates.js';
import type { PredicateRef } from './predicate-result.js';

export interface PlannedAction {
  action: WorkflowDecisionAction;
  phase: WorkflowActionPhase;
  reason: string;
  reasonCode: string;
  subtaskId?: string;
  evidenceRefs: string[];
  refs: PredicateRef[];
  inputs: Record<string, unknown>;
  commandHint?: string;
  actionDefinition: WorkflowActionDefinition;
}

export function planNextAction(input: {
  bundle: MultiAgentWorkflowBundle;
  subtaskId?: string;
  headSha?: string;
  now?: string;
}): PlannedAction {
  const ctx = createWorkflowDecisionContext(input);
  if (!ctx.taskGraph) {
    return planned('request_dynamic_plan', {
      reason: 'Workflow has no TaskGraph yet.',
      reasonCode: 'missing_task_graph',
      evidenceRefs: [],
      refs: [{ kind: 'workflow', id: ctx.workflow.id }],
      inputs: {},
    });
  }

  return planNextV1Action(ctx);
}

function planNextV1Action(ctx: WorkflowDecisionContext): PlannedAction {
  if (allSubtasksDone(ctx).ok) {
    return planFinalV1Action(ctx);
  }

  const needsFix = Object.values(ctx.subtasks).find((subtask) => subtask.status === 'needs_fix' || subtask.status === 'evaluation_failed');
  if (needsFix) {
    const invalidatedEvaluation = latestEvaluationWithStatus(ctx.bundle.evaluationRuns, needsFix.subtaskId, ['invalidated']);
    if (invalidatedEvaluation) {
      return planned('request_human_review', {
        subtaskId: needsFix.subtaskId,
        reason: `Codex evaluation ${invalidatedEvaluation.id} violated readonly policy and was invalidated.`,
        reasonCode: 'readonly_policy_violated',
        evidenceRefs: needsFix.evidenceRefs || [],
        refs: [{ kind: 'evaluation', id: invalidatedEvaluation.id }],
        inputs: { fixRound: needsFix.fixRound || 0, evaluationRunId: invalidatedEvaluation.id },
      });
    }
    return planned('fix_evaluation_findings', {
      subtaskId: needsFix.subtaskId,
      reason: 'Subtask needs Codex Builder to fix evaluator or questioner findings.',
      reasonCode: 'evaluation_or_questioner_findings',
      evidenceRefs: needsFix.evidenceRefs || [],
      refs: [{ kind: 'subtask', id: needsFix.subtaskId }],
      inputs: {
        fixRound: needsFix.fixRound || 0,
        evaluationRunId: latestFailedEvaluation(ctx.bundle.evaluationRuns, needsFix.subtaskId)?.id,
      },
    });
  }

  const active = chooseNextV1Subtask(ctx);
  if (!active) {
    return planned('request_human_review', {
      reason: 'No schedulable v1 subtask or automatic workflow action is available.',
      reasonCode: 'no_schedulable_action',
      evidenceRefs: collectEvidenceRefs(ctx.subtasks),
      refs: [{ kind: 'workflow', id: ctx.workflow.id }],
      inputs: { workflowStatus: ctx.workflow.status },
    });
  }

  return planSubtaskV1Action(ctx, active.id, active.title);
}

function planSubtaskV1Action(ctx: WorkflowDecisionContext, subtaskId: string, title: string): PlannedAction {
  const subtaskState = ctx.subtasks[subtaskId] || { subtaskId, status: 'pending', evidenceRefs: [] };
  const contract = latestContract(ctx.bundle, subtaskId);
  const subtaskCtx = { ...ctx, subtaskId, subtask: subtaskState };

  if (!contract) {
    return planned('draft_contract', {
      subtaskId,
      reason: `Subtask ${subtaskId} needs a SprintContract before Codex Builder starts.`,
      reasonCode: 'missing_contract',
      evidenceRefs: subtaskState.evidenceRefs || [],
      refs: [{ kind: 'subtask', id: subtaskId }],
      inputs: { title },
    });
  }

  if (contract.status !== 'accepted') {
    const questionedContract = latestMatchingQuestionerOutput(ctx.bundle, {
      subtaskId,
      intent: 'question_contract',
      contractId: contract.id,
      headSha: contract.headShaAtAcceptance || ctx.headSha,
    });
    if (ctx.policy?.requireQuestionerBeforeBuild && !questionedContract) {
      return planned('ask_claude_question_contract', {
        subtaskId,
        reason: `SprintContract ${contract.id} is ${contract.status}; Claude Questioner must challenge it before acceptance.`,
        reasonCode: 'missing_questioner_output',
        evidenceRefs: subtaskState.evidenceRefs || [],
        refs: [{ kind: 'contract', id: contract.id }],
        inputs: { contractId: contract.id },
      });
    }
    const contractQuestioner = hasSufficientContractQuestionerOutput(subtaskCtx, subtaskId);
    if (ctx.policy?.requireQuestionerBeforeBuild && !contractQuestioner.ok && questionedContract) {
      return planned('draft_contract', {
        subtaskId,
        reason: contractQuestioner.message || `Contract Questioner output ${questionedContract.id} is not sufficient; revise the SprintContract.`,
        reasonCode: contractQuestioner.code || 'blocking_question_unresolved',
        evidenceRefs: subtaskState.evidenceRefs || [],
        refs: contractQuestioner.refs || [{ kind: 'questioner_output', id: questionedContract.id }],
        inputs: { contractId: contract.id, questionerOutputId: questionedContract.id },
      });
    }
    if (ctx.policy?.requireQuestionerBeforeBuild && contractQuestioner.ok) {
      return planned('accept_contract', {
        subtaskId,
        reason: `SprintContract ${contract.id} has a validated Questioner challenge and can be accepted.`,
        reasonCode: 'contract_questioner_satisfied',
        evidenceRefs: subtaskState.evidenceRefs || [],
        refs: contractQuestioner.refs || [{ kind: 'contract', id: contract.id }],
        inputs: { contractId: contract.id, questionerOutputId: questionedContract?.id },
      });
    }
    if (ctx.policy?.requireQuestionerBeforeBuild) {
      return planned('ask_claude_question_contract', {
        subtaskId,
        reason: `SprintContract ${contract.id} is ${contract.status}; Claude Questioner should challenge it before acceptance.`,
        reasonCode: 'contract_not_accepted',
        evidenceRefs: subtaskState.evidenceRefs || [],
        refs: [{ kind: 'contract', id: contract.id }],
        inputs: { contractId: contract.id },
      });
    }
    return planned('accept_contract', {
      subtaskId,
      reason: `SprintContract ${contract.id} is drafted and the workflow does not require a pre-build Questioner challenge.`,
      reasonCode: 'contract_questioner_not_required',
      evidenceRefs: subtaskState.evidenceRefs || [],
      refs: [{ kind: 'contract', id: contract.id }],
      inputs: { contractId: contract.id },
    });
  }

  const implementation = latestImplementationEvidence(ctx.bundle, subtaskId);
  if (!implementation) {
    return planned('execute_subtask', {
      subtaskId,
      reason: `Subtask ${subtaskId} has an accepted contract and is ready for Codex Builder.`,
      reasonCode: 'missing_implementation_evidence',
      evidenceRefs: subtaskState.evidenceRefs || [],
      refs: [{ kind: 'contract', id: contract.id }],
      inputs: { title, contractId: contract.id },
    });
  }

  const evaluation = latestEvaluationRun(ctx.bundle, subtaskId);
  if (!evaluation) {
    return planned('run_codex_evaluator', {
      subtaskId,
      reason: `Subtask ${subtaskId} has implementation evidence and needs isolated Codex evaluation.`,
      reasonCode: 'missing_evaluation_result',
      evidenceRefs: mergeRefs(subtaskState.evidenceRefs, [implementation.id]),
      refs: [{ kind: 'contract', id: contract.id }, { kind: 'evidence', id: implementation.id }],
      inputs: { contractId: contract.id, implementationEvidenceId: implementation.id },
    });
  }

  if (evaluation.status === 'failed' || evaluation.result?.verdict === 'fail') {
    return planned('fix_evaluation_findings', {
      subtaskId,
      reason: `Codex evaluation ${evaluation.id} failed; Builder must fix findings.`,
      reasonCode: 'evaluation_not_passed',
      evidenceRefs: mergeRefs(subtaskState.evidenceRefs, [implementation.id]),
      refs: [{ kind: 'evaluation', id: evaluation.id }],
      inputs: { contractId: contract.id, evaluationRunId: evaluation.id },
    });
  }

  if (evaluation.status === 'invalidated') {
    return planned('request_human_review', {
      subtaskId,
      reason: `Codex evaluation ${evaluation.id} violated readonly policy and was invalidated.`,
      reasonCode: 'readonly_policy_violated',
      evidenceRefs: mergeRefs(subtaskState.evidenceRefs, [implementation.id]),
      refs: [{ kind: 'evaluation', id: evaluation.id }],
      inputs: { contractId: contract.id, evaluationRunId: evaluation.id },
    });
  }

  if (evaluation.status === 'inconclusive' || evaluation.result?.verdict === 'inconclusive') {
    return planned('re_evaluate', {
      subtaskId,
      reason: `Codex evaluation ${evaluation.id} was inconclusive; run a new evaluator session.`,
      reasonCode: 'evaluation_inconclusive',
      evidenceRefs: mergeRefs(subtaskState.evidenceRefs, [implementation.id]),
      refs: [{ kind: 'evaluation', id: evaluation.id }],
      inputs: { contractId: contract.id, evaluationRunId: evaluation.id },
    });
  }

  const evaluationHead = evaluation.result?.headSha || evaluation.headSha;
  const expectedHead = ctx.headSha || ctx.workflow.currentHeadSha;
  if (
    ctx.policy?.requireSameHeadShaForEvidence !== false
    && expectedHead
    && evaluationHead
    && evaluationHead !== expectedHead
  ) {
    return planned('re_evaluate', {
      subtaskId,
      reason: `Codex evaluation ${evaluation.id} was recorded for ${evaluationHead}, but workflow head is ${expectedHead}; run a fresh evaluator session.`,
      reasonCode: 'head_sha_mismatch',
      evidenceRefs: mergeRefs(subtaskState.evidenceRefs, [implementation.id]),
      refs: [{ kind: 'evaluation', id: evaluation.id }],
      inputs: {
        contractId: contract.id,
        evaluationRunId: evaluation.id,
        expectedHeadSha: expectedHead,
        evaluationHeadSha: evaluationHead,
      },
    });
  }

  if (ctx.policy?.requireQuestionerAfterEvaluation) {
    const questioner = hasSufficientEvaluationQuestionerOutput(subtaskCtx, subtaskId);
    if (!questioner.ok) {
      const existing = latestMatchingQuestionerOutput(ctx.bundle, {
        subtaskId,
        intent: 'question_evaluation',
        contractId: contract.id,
        evaluationRunId: evaluation.id,
        headSha: evaluation.result?.headSha || evaluation.headSha,
      });
      return planned(existing ? 'fix_evaluation_findings' : 'ask_claude_question_evaluation', {
        subtaskId,
        reason: existing
          ? questioner.message || `Claude Questioner output ${existing.id} contains blocking questions.`
          : `Codex evaluation ${evaluation.id} passed; Claude Questioner should challenge the evidence.`,
        reasonCode: questioner.code || 'missing_questioner_output',
        evidenceRefs: mergeRefs(subtaskState.evidenceRefs, [implementation.id]),
        refs: questioner.refs || [{ kind: 'evaluation', id: evaluation.id }],
        inputs: {
          contractId: contract.id,
          evaluationRunId: evaluation.id,
          headSha: evaluationHead,
          questionerOutputId: existing?.id,
        },
      });
    }
  }

  const gates = allSubtaskGatesSatisfied(subtaskCtx, subtaskId);
  if (!gates.ok) {
    return planned('request_human_review', {
      subtaskId,
      reason: gates.message || `Subtask ${subtaskId} gates are not satisfied; human review is required.`,
      reasonCode: gates.code || 'invalid_transition',
      evidenceRefs: mergeRefs(subtaskState.evidenceRefs, [implementation.id]),
      refs: gates.refs || [{ kind: 'subtask', id: subtaskId }],
      inputs: {
        contractId: contract.id,
        evaluationRunId: evaluation.id,
      },
    });
  }
  const completeGuard = preflightPlannedAction(ctx, 'complete_subtask', {
    subtaskId,
    reason: `Subtask ${subtaskId} has accepted contract, implementation evidence, passing evaluation, and no blocking questioner output.`,
    evidenceRefs: mergeRefs(subtaskState.evidenceRefs, [implementation.id]),
    inputs: {
      currentHeadSha: ctx.headSha,
      contractId: contract.id,
      evaluationRunId: evaluation.id,
    },
  });
  if (!completeGuard.accepted) {
    return planned(actionForRejectedCompletion(completeGuard.code), {
      subtaskId,
      reason: completeGuard.message || `Subtask ${subtaskId} cannot be completed yet.`,
      reasonCode: completeGuard.code || 'invalid_transition',
      evidenceRefs: mergeRefs(subtaskState.evidenceRefs, [implementation.id]),
      refs: [{ kind: 'subtask', id: subtaskId }],
      inputs: {
        contractId: contract.id,
        evaluationRunId: evaluation.id,
        guard: completeGuard,
      },
    });
  }
  return planned('complete_subtask', {
    subtaskId,
    reason: `Subtask ${subtaskId} has accepted contract, implementation evidence, passing evaluation, and no blocking questioner output.`,
    reasonCode: 'ok',
    evidenceRefs: mergeRefs(subtaskState.evidenceRefs, [implementation.id]),
    refs: gates.refs || [{ kind: 'subtask', id: subtaskId }],
    inputs: {
      contractId: contract.id,
      evaluationRunId: evaluation.id,
      questionerOutputId: latestMatchingQuestionerOutput(ctx.bundle, {
        subtaskId,
        intent: 'question_evaluation',
        contractId: contract.id,
        evaluationRunId: evaluation.id,
        headSha: evaluation.result?.headSha || evaluation.headSha,
      })?.id,
    },
  });
}

function planFinalV1Action(ctx: WorkflowDecisionContext): PlannedAction {
  const finalEvaluation = latestEvaluationRun(ctx.bundle, '__final__');
  if (!finalEvaluation) {
    return planned('run_final_evaluation', {
      reason: 'All subtasks are done; run final Codex evaluation before completing workflow.',
      reasonCode: 'missing_final_evaluation',
      evidenceRefs: collectEvidenceRefs(ctx.subtasks),
      refs: collectSubtaskRefs(ctx),
      inputs: { taskGraphVersion: ctx.taskGraph?.version },
    });
  }
  if (finalEvaluation.status === 'failed' || finalEvaluation.result?.verdict === 'fail') {
    return planned('request_human_review', {
      reason: `Final Codex evaluation ${finalEvaluation.id} failed.`,
      reasonCode: 'evaluation_not_passed',
      evidenceRefs: collectEvidenceRefs(ctx.subtasks),
      refs: [{ kind: 'evaluation', id: finalEvaluation.id }],
      inputs: { taskGraphVersion: ctx.taskGraph?.version, evaluationRunId: finalEvaluation.id },
    });
  }
  if (finalEvaluation.status === 'invalidated') {
    return planned('request_human_review', {
      reason: `Final Codex evaluation ${finalEvaluation.id} violated readonly policy and was invalidated.`,
      reasonCode: 'readonly_policy_violated',
      evidenceRefs: collectEvidenceRefs(ctx.subtasks),
      refs: [{ kind: 'evaluation', id: finalEvaluation.id }],
      inputs: { taskGraphVersion: ctx.taskGraph?.version, evaluationRunId: finalEvaluation.id },
    });
  }
  if (finalEvaluation.status === 'inconclusive' || finalEvaluation.result?.verdict === 'inconclusive') {
    return planned('run_final_evaluation', {
      reason: `Final Codex evaluation ${finalEvaluation.id} was inconclusive; run a new final evaluator session.`,
      reasonCode: 'evaluation_inconclusive',
      evidenceRefs: collectEvidenceRefs(ctx.subtasks),
      refs: [{ kind: 'evaluation', id: finalEvaluation.id }],
      inputs: { taskGraphVersion: ctx.taskGraph?.version, evaluationRunId: finalEvaluation.id },
    });
  }
  const finalEvaluationHead = finalEvaluation.result?.headSha || finalEvaluation.headSha;
  const expectedHead = ctx.headSha || ctx.workflow.currentHeadSha;
  if (
    ctx.policy?.requireSameHeadShaForEvidence !== false
    && expectedHead
    && finalEvaluationHead
    && finalEvaluationHead !== expectedHead
  ) {
    return planned('run_final_evaluation', {
      reason: `Final Codex evaluation ${finalEvaluation.id} was recorded for ${finalEvaluationHead}, but workflow head is ${expectedHead}; run a fresh final evaluator session.`,
      reasonCode: 'head_sha_mismatch',
      evidenceRefs: collectEvidenceRefs(ctx.subtasks),
      refs: [{ kind: 'evaluation', id: finalEvaluation.id }],
      inputs: {
        taskGraphVersion: ctx.taskGraph?.version,
        evaluationRunId: finalEvaluation.id,
        expectedHeadSha: expectedHead,
        evaluationHeadSha: finalEvaluationHead,
      },
    });
  }
  if (ctx.policy?.requireQuestionerAfterEvaluation) {
    const questioner = hasSufficientFinalQuestionerOutput(ctx);
    if (!questioner.ok) {
      const existing = latestMatchingQuestionerOutput(ctx.bundle, {
        intent: 'question_final_evidence',
        finalEvaluationRunId: finalEvaluation.id,
        headSha: finalEvaluation.result?.headSha || finalEvaluation.headSha,
      });
      return planned(existing ? 'request_human_review' : 'ask_claude_question_final_evidence', {
        reason: existing
          ? questioner.message || `Final Claude Questioner output ${existing.id} contains blocking questions.`
          : `Final Codex evaluation ${finalEvaluation.id} passed; Claude Questioner should challenge final evidence.`,
        reasonCode: questioner.code || 'missing_questioner_output',
        evidenceRefs: collectEvidenceRefs(ctx.subtasks),
        refs: questioner.refs || [{ kind: 'evaluation', id: finalEvaluation.id }],
        inputs: {
          taskGraphVersion: ctx.taskGraph?.version,
          evaluationRunId: finalEvaluation.id,
          headSha: finalEvaluationHead,
          questionerOutputId: existing?.id,
        },
      });
    }
  }
  const completeGuard = preflightPlannedAction(ctx, 'complete_workflow', {
    reason: 'All subtasks are done, final evaluation passed, and final Questioner has no blocking questions.',
    evidenceRefs: collectEvidenceRefs(ctx.subtasks),
    inputs: {
      currentHeadSha: ctx.headSha,
      taskGraphVersion: ctx.taskGraph?.version,
      evaluationRunId: finalEvaluation.id,
    },
  });
  if (!completeGuard.accepted) {
    return planned('request_human_review', {
      reason: completeGuard.message || 'Workflow cannot be completed yet.',
      reasonCode: completeGuard.code || 'invalid_transition',
      evidenceRefs: collectEvidenceRefs(ctx.subtasks),
      refs: [{ kind: 'evaluation', id: finalEvaluation.id }],
      inputs: {
        taskGraphVersion: ctx.taskGraph?.version,
        evaluationRunId: finalEvaluation.id,
        guard: completeGuard,
      },
    });
  }
  return planned('complete_workflow', {
    reason: 'All subtasks are done, final evaluation passed, and final Questioner has no blocking questions.',
    reasonCode: 'workflow_gates_satisfied',
    evidenceRefs: collectEvidenceRefs(ctx.subtasks),
    refs: [{ kind: 'evaluation', id: finalEvaluation.id }],
    inputs: {
      taskGraphVersion: ctx.taskGraph?.version,
      evaluationRunId: finalEvaluation.id,
      questionerOutputId: latestMatchingQuestionerOutput(ctx.bundle, {
        intent: 'question_final_evidence',
        finalEvaluationRunId: finalEvaluation.id,
        headSha: finalEvaluation.result?.headSha || finalEvaluation.headSha,
      })?.id,
    },
  });
}

function preflightPlannedAction(
  ctx: WorkflowDecisionContext,
  action: WorkflowDecisionAction,
  input: {
    subtaskId?: string;
    reason: string;
    evidenceRefs: string[];
    inputs: Record<string, unknown>;
  },
) {
  const decision: WorkflowDecision = {
    id: `planned-${action}`,
    workflowId: ctx.workflow.id,
    rootTaskId: ctx.workflow.rootTaskId,
    subtaskId: input.subtaskId,
    decidedBy: 'codex-workflow',
    decidedAt: ctx.now,
    action,
    reason: input.reason,
    evidenceRefs: input.evidenceRefs,
    inputs: input.inputs,
  };
  return guardTransition({ bundle: ctx.bundle, decision });
}

function actionForRejectedCompletion(code: string | undefined): WorkflowDecisionAction {
  if (
    code === 'evaluation_evidence_insufficient'
    || code === 'readonly_policy_violated'
  ) {
    return 're_evaluate';
  }
  if (code === 'head_sha_mismatch') {
    return 're_evaluate';
  }
  return 'request_human_review';
}

function planned(
  action: WorkflowDecisionAction,
  input: Omit<PlannedAction, 'action' | 'phase' | 'actionDefinition' | 'commandHint'>,
): PlannedAction {
  const actionDefinition = getWorkflowActionDefinition(action);
  return {
    action,
    phase: actionDefinition.phase,
    actionDefinition,
    commandHint: commandHintForAction(action, input.subtaskId, input.inputs),
    ...input,
  };
}

function commandHintForAction(
  action: WorkflowDecisionAction,
  subtaskId: string | undefined,
  inputs: Record<string, unknown>,
): string | undefined {
  const workflowArg = '--workflow <workflow-id>';
  const subtaskArg = subtaskId ? ` --subtask ${subtaskId}` : '';
  switch (action) {
    case 'request_dynamic_plan':
      return `tik-multi-agent-workflow plan ${workflowArg}`;
    case 'draft_contract':
      return `tik-multi-agent-workflow draft-contract ${workflowArg}${subtaskArg}`;
    case 'ask_claude_question_contract':
    case 'ask_claude_question_evaluation':
    case 'ask_claude_question_final_evidence':
      return `tik-multi-agent-workflow start-questioner ${workflowArg}${subtaskArg} --intent ${getWorkflowActionDefinition(action).intent}`;
    case 'accept_contract':
      return `tik-multi-agent-workflow accept-contract ${workflowArg}${subtaskArg} --contract ${String(inputs.contractId || '<contract-id>')}`;
    case 'execute_subtask':
      return `tik-multi-agent-workflow start-builder ${workflowArg}${subtaskArg}`;
    case 'run_codex_evaluator':
    case 're_evaluate':
    case 'run_final_evaluation':
      return `tik-multi-agent-workflow start-evaluator ${workflowArg}${subtaskArg}`;
    case 'complete_subtask':
      return `tik-multi-agent-workflow complete-subtask ${workflowArg}${subtaskArg}`;
    case 'complete_workflow':
      return `tik-multi-agent-workflow complete-workflow ${workflowArg}`;
    default:
      return undefined;
  }
}

function chooseNextV1Subtask(ctx: WorkflowDecisionContext): { id: string; title: string } | null {
  if (ctx.subtaskId) {
    const spec = ctx.taskGraph?.subtasks.find((subtask) => subtask.id === ctx.subtaskId);
    if (spec && isV1SubtaskSchedulable(ctx, spec.id)) {
      return { id: spec.id, title: spec.title };
    }
  }
  return ctx.taskGraph?.subtasks.find((subtask) => isV1SubtaskSchedulable(ctx, subtask.id)) || null;
}

function isV1SubtaskSchedulable(ctx: WorkflowDecisionContext, subtaskId: string): boolean {
  const spec = ctx.taskGraph?.subtasks.find((candidate) => candidate.id === subtaskId);
  const state = ctx.subtasks[subtaskId];
  const status = state?.status || 'pending';
  if (status === 'done' || status === 'blocked' || status === 'human_review_required') return false;
  return (spec?.dependsOn || []).every((dep) => ctx.subtasks[dep]?.status === 'done');
}

function latestEvaluationWithStatus(
  evaluationRuns: EvaluationRun[],
  subtaskId: string,
  statuses: EvaluationRun['status'][],
): EvaluationRun | undefined {
  const allowed = new Set(statuses);
  return evaluationRuns
    .filter((run) => run.subtaskId === subtaskId && allowed.has(run.status))
    .sort((left, right) => safeIsoTime(right.startedAt).localeCompare(safeIsoTime(left.startedAt)))[0];
}

function latestFailedEvaluation(evaluationRuns: EvaluationRun[], subtaskId: string): EvaluationRun | undefined {
  return evaluationRuns
    .filter((run) => run.subtaskId === subtaskId && (run.status === 'failed' || run.result?.verdict === 'fail'))
    .sort((left, right) => safeIsoTime(right.startedAt).localeCompare(safeIsoTime(left.startedAt)))[0];
}

function collectEvidenceRefs(subtasks: Record<string, SubtaskRunState>): string[] {
  return Array.from(new Set(Object.values(subtasks).flatMap((subtask) => subtask.evidenceRefs || [])));
}

function collectSubtaskRefs(ctx: WorkflowDecisionContext): PredicateRef[] {
  return (ctx.taskGraph?.subtasks || []).map((subtask) => ({ kind: 'subtask', id: subtask.id }));
}

function mergeRefs(left: string[] = [], right: Array<string | undefined> = []): string[] {
  return Array.from(new Set([...left, ...right].filter((item): item is string => Boolean(item))));
}

function safeIsoTime(value: string | undefined): string {
  return value || '';
}
