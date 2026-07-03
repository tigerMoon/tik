import type { GuardResult, MultiAgentWorkflowBundle, WorkflowDecision } from '@tik/shared';
import { evaluateWorkflowDecisionGuard } from '../guard.js';

export function guardTransition(input: {
  bundle: MultiAgentWorkflowBundle;
  decision: WorkflowDecision;
}): GuardResult {
  return evaluateWorkflowDecisionGuard(input.bundle, input.decision);
}

