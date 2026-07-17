import type { WorkflowDecisionAction } from '../types/multi-agent.js';

/**
 * A single suggested next CLI command for the caller to run, after the server
 * has committed a workflow action. Emitted in write-response bodies so callers
 * do not have to re-plan by calling `next` / `status` / `continue`.
 */
export interface NextRecommendedCommand {
  /** Command name as it appears in `tik-multi-agent-workflow.mjs`. */
  cmd: string;
  /** CLI flag → value pairs, already normalized (e.g. `{"--workflow": "wf_x"}`). */
  args: Record<string, string>;
  /** Short human-readable rationale for surfacing in JSON output. */
  rationale: string;
}

/**
 * Context needed to translate a planned WorkflowDecisionAction into a concrete
 * skill CLI command. All fields are optional so callers can build partial
 * hints even when they do not know every id.
 */
export interface CliMappingContext {
  workflowId?: string;
  subtaskId?: string;
  contractId?: string;
  evaluationRunId?: string;
  finalEvaluationRunId?: string;
  reviewEvidenceId?: string;
  invocationId?: string;
  headSha?: string;
  intent?: 'question_contract' | 'question_evaluation' | 'question_final_evidence';
}

/**
 * Map a planner-computed WorkflowDecisionAction to the skill CLI command
 * a caller should run next. Returns `undefined` when the action is not
 * mapped to a single deterministic CLI command (e.g. planner phases that
 * require multiple parallel commands or human intervention).
 */
export function mapWorkflowActionToCliCommand(
  action: WorkflowDecisionAction,
  ctx: CliMappingContext = {},
): NextRecommendedCommand | undefined {
  const wf = ctx.workflowId;
  const withWorkflow = (extra: Record<string, string> = {}): Record<string, string> => {
    return wf ? { '--workflow': wf, ...extra } : { ...extra };
  };
  const withSubtask = (extra: Record<string, string> = {}): Record<string, string> => {
    return ctx.subtaskId ? { ...extra, '--subtask': ctx.subtaskId } : { ...extra };
  };

  switch (action) {
    case 'request_dynamic_plan':
      return {
        cmd: 'plan',
        args: withWorkflow(),
        rationale: 'TaskGraph is missing; request a dynamic plan.',
      };
    case 'draft_contract':
      return {
        cmd: 'draft-contract',
        args: withSubtask(withWorkflow()),
        rationale: 'Subtask needs a SprintContract before Builder starts.',
      };
    case 'accept_contract':
      return {
        cmd: 'accept-contract',
        args: withSubtask(withWorkflow(ctx.contractId ? { '--contract': ctx.contractId } : {})),
        rationale: 'SprintContract is drafted or Questioner-validated; accept it.',
      };
    case 'ask_claude_question_contract':
      return {
        cmd: 'start-questioner',
        args: withSubtask(withWorkflow({ '--intent': 'question_contract' })),
        rationale: 'Claude Questioner must challenge the SprintContract before build.',
      };
    case 'execute_subtask':
      return {
        cmd: 'start-builder',
        args: withSubtask(withWorkflow()),
        rationale: 'Contract accepted; launch Codex Builder for this subtask.',
      };
    case 'run_readonly_reviewer':
      return {
        cmd: 'start-reviewer',
        args: withSubtask(withWorkflow()),
        rationale: 'Review shard needs a pinned-HEAD readonly Codex reviewer.',
      };
    case 'run_codex_evaluator':
    case 're_evaluate':
      return {
        cmd: 'start-evaluator',
        args: withSubtask(withWorkflow()),
        rationale: action === 're_evaluate'
          ? 'Previous evaluation was inconclusive or head_sha_mismatch; re-run.'
          : 'Implementation evidence is ready; run isolated Codex evaluator.',
      };
    case 'ask_claude_question_evaluation':
      return {
        cmd: 'start-questioner',
        args: withSubtask(withWorkflow({ '--intent': 'question_evaluation' })),
        rationale: 'Codex evaluation passed; Claude Questioner should challenge it.',
      };
    case 'fix_evaluation_findings':
      return {
        cmd: 'start-builder',
        args: withSubtask(withWorkflow()),
        rationale: 'Evaluator or Questioner found blocking issues; Builder must fix them.',
      };
    case 'complete_subtask':
      return {
        cmd: 'complete-subtask',
        args: withSubtask(withWorkflow()),
        rationale: 'All gates satisfied for this subtask; mark it done.',
      };
    case 'run_final_evaluation':
      // Launch the isolated final Codex evaluator invocation; `evaluate` is
      // the record-side command, called only after the evaluator finishes.
      return {
        cmd: 'start-evaluator',
        args: withWorkflow({ '--subtask': '__final__' }),
        rationale: 'All subtasks are done; launch the final Codex evaluator.',
      };
    case 'ask_claude_question_final_evidence':
      return {
        cmd: 'start-questioner',
        args: withWorkflow({ '--intent': 'question_final_evidence' }),
        rationale: 'Final Codex evaluation passed; Claude Questioner should challenge final evidence.',
      };
    case 'synthesize_review':
      return {
        cmd: 'synthesize-review',
        args: withWorkflow(),
        rationale: 'All review shards done; deduplicate and synthesize findings.',
      };
    case 'complete_workflow':
      return {
        cmd: 'complete-workflow',
        args: withWorkflow(),
        rationale: 'Final evaluation and Questioner both passed; complete the workflow.',
      };
    case 'validate_subtask':
      return {
        cmd: 'validate',
        args: withSubtask(withWorkflow()),
        rationale: 'Run local verification commands for this subtask.',
      };
    case 'request_replan':
      return {
        cmd: 'plan',
        args: withWorkflow(),
        rationale: 'Circumstances changed; request a fresh TaskGraph.',
      };
    case 'abort_workflow':
      return {
        cmd: 'abandon-workflow',
        args: withWorkflow(),
        rationale: 'Workflow cannot proceed; abandon it explicitly.',
      };
    case 'request_human_review':
    case 'record_implementation':
    case 'record_review':
    case 'ask_claude_question_requirement':
    case 'ask_claude_question_task_graph':
      // These actions are either recorded as side-effects of other CLI commands
      // (record_implementation happens inside `execute-subtask` action), or
      // require human intervention outside the CLI surface.
      return undefined;
    default:
      return undefined;
  }
}

/**
 * Build the `nextRecommendedCommand` array for a write-response body. Returns
 * at most `limit` items (default 3). Currently emits a single mapped command
 * from `planNextAction`'s result — the array shape is future-compatible with
 * multi-command suggestions (e.g. "run these two in parallel").
 */
export function buildNextRecommendedCommands(
  actions: WorkflowDecisionAction[],
  ctx: CliMappingContext = {},
  limit: number = 3,
): NextRecommendedCommand[] {
  const out: NextRecommendedCommand[] = [];
  const seen = new Set<string>();
  for (const action of actions) {
    if (out.length >= limit) break;
    const mapped = mapWorkflowActionToCliCommand(action, ctx);
    if (!mapped) continue;
    const key = `${mapped.cmd}|${JSON.stringify(mapped.args)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(mapped);
  }
  return out;
}
