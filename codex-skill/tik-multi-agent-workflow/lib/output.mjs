/**
 * Fields to elide when terse mode is on. The values are usually long, echoed
 * on every write, and rarely load-bearing for Codex' next-action decision.
 * Terse mode keeps the compacted 5-minute prompt-cache TTL warm across calls;
 * verbose mode restores the full body for humans debugging a workflow.
 *
 * Nested paths are dotted: `runtime.metadata` means `obj.runtime.metadata`.
 */
const TERSE_ELIDE_PATHS = [
  'environmentPreflight',
  'environmentPreflight.report',
  'recentEvents',
  'runtime.metadata',
  'invocation.input.contextBundle',
  'discoveredCandidates.details',
  'contextBundle',
];

const TERSE_ELIDE_MARK = '[elided: pass --verbose to include]';

/**
 * Type-stable elide: an array becomes `[]`, an object becomes `{}`, a string
 * becomes the marker. This preserves the shape downstream consumers expect
 * (e.g. `.map` on an array field still works) while still trimming the
 * context weight. The marker is also attached as a sibling `__elided`
 * property on the parent so callers can detect elision without size
 * heuristics.
 */
function elideAtPath(obj, dottedPath) {
  const segments = dottedPath.split('.');
  const last = segments.pop();
  let cursor = obj;
  for (const key of segments) {
    if (!cursor || typeof cursor !== 'object') return;
    cursor = cursor[key];
    if (Array.isArray(cursor)) return;
  }
  if (!cursor || typeof cursor !== 'object' || !(last in cursor)) return;
  const value = cursor[last];
  if (value === null || value === undefined) return;
  // Skip elision for cheap primitives; they're already small.
  if (typeof value === 'number' || typeof value === 'boolean') return;
  let size;
  try {
    size = typeof value === 'string' ? value.length : JSON.stringify(value).length;
  } catch {
    // Non-serializable (cyclic, BigInt, etc.). Treat as "large" and elide.
    size = Number.POSITIVE_INFINITY;
  }
  if (size < 200) return; // don't elide short values — they're worth keeping
  if (Array.isArray(value)) {
    cursor[last] = [];
  } else if (typeof value === 'object') {
    cursor[last] = {};
  } else {
    cursor[last] = TERSE_ELIDE_MARK;
  }
  const elidedKeys = (cursor.__elided = cursor.__elided || []);
  if (!elidedKeys.includes(last)) elidedKeys.push(last);
}

/**
 * Print a JSON payload to stdout. `options.terse` (default: true when
 * TIK_OUTPUT_TERSE=1 or the caller passes { terse: true }) trims long
 * fields that inflate Codex context. Pass `terse: false` (or CLI
 * `--verbose`) to keep the full body.
 */
export function printJson(value, options = {}) {
  const envValue = process.env.TIK_OUTPUT_TERSE;
  // Empty string is treated as "not set" so a `TIK_OUTPUT_TERSE=` shell
  // preamble (a common way to "unset" a var) doesn't silently disable terse.
  const terseByDefault = envValue === '1' || envValue === undefined || envValue === '';
  const terseForcedOff = envValue === '0';
  const terse = typeof options.terse === 'boolean'
    ? options.terse
    : terseForcedOff ? false : terseByDefault;
  if (!terse || value === null || typeof value !== 'object') {
    console.log(JSON.stringify(value, null, 2));
    return;
  }
  // structuredClone throws on functions/symbols/Response/Headers/etc.; fall
  // back to a JSON round-trip so we still print something usable rather than
  // aborting the whole command with DataCloneError.
  let cloned;
  try {
    cloned = structuredClone(value);
  } catch {
    try {
      cloned = JSON.parse(JSON.stringify(value));
    } catch {
      console.log(JSON.stringify(value, null, 2));
      return;
    }
  }
  for (const p of TERSE_ELIDE_PATHS) elideAtPath(cloned, p);
  console.log(JSON.stringify(cloned, null, 2));
}

export function instructionForDecision(decision, state) {
  switch (decision.action) {
    case 'request_dynamic_plan':
      return `Request a Claude dynamic plan for workflow ${decision.workflowId}, then store the TaskGraph with accept-plan.`;
    case 'execute_subtask': {
      const subtask = state?.taskGraph?.subtasks?.find((item) => item.id === decision.subtaskId);
      return `Implement subtask ${decision.subtaskId}${subtask?.title ? ` (${subtask.title})` : ''} in the current Codex session, then run execute/validate.`;
    }
    case 'draft_contract':
      return `Draft a SprintContract for subtask ${decision.subtaskId}, then ask Claude Questioner to challenge it before acceptance.`;
    case 'ask_claude_question_contract':
      return `Ask Claude Questioner to challenge the SprintContract for subtask ${decision.subtaskId}, then accept or revise the contract.`;
    case 'run_readonly_reviewer':
      return `Ask Tik to launch an attested read-only Codex Reviewer for shard ${decision.subtaskId}, then record candidate findings with record-review.`;
    case 'run_codex_evaluator':
    case 're_evaluate':
      return `Ask Tik to launch an isolated read-only Codex Evaluator session for subtask ${decision.subtaskId}, then record its EvaluationResult.`;
    case 'run_final_evaluation':
      return 'Ask Tik to launch an isolated read-only Codex Evaluator session for final workflow evidence, then record its EvaluationResult.';
    case 'ask_claude_question_evaluation':
      return `Ask Tik to launch an async Claude Questioner for subtask ${decision.subtaskId}; the callback records QuestionerOutputV2.`;
    case 'ask_claude_question_final_evidence':
      return 'Ask Tik to launch an async Claude Questioner for final evidence; the callback records QuestionerOutputV2 before workflow completion.';
    case 'fix_evaluation_findings':
      return `Fix Codex Evaluator or Claude Questioner findings for subtask ${decision.subtaskId}, then re-evaluate.`;
    case 'validate_subtask':
      return `Run the validation commands for subtask ${decision.subtaskId}, then record validation evidence.`;
    case 'complete_subtask':
      if (state?.workflow?.mode === 'review') {
        return `Complete review shard ${decision.subtaskId} after readonly Reviewer, focused Evaluator, and Claude Questioner guards pass.`;
      }
      return `Complete subtask ${decision.subtaskId} only after contract, implementation evidence, Codex evaluation evidence, Claude Questioner approval, same-headSha, scope, and subagent-isolation guards pass.`;
    case 'synthesize_review':
      return 'Deduplicate evaluated findings across review shards, remove confirmed false positives, and record the final synthesis artifact.';
    case 'complete_workflow':
      if (state?.workflow?.mode === 'review') {
        return 'Complete the review workflow after all shards are done and synthesis evidence is recorded at the pinned HEAD.';
      }
      return 'Complete workflow only after all subtasks are done and final evaluation/questioner evidence passes Tik guards.';
    case 'request_human_review':
      return 'Create or surface a human review work item; Tik guardrails or policy require a person.';
    case 'abort_workflow':
      return 'Abort the workflow and preserve evidence for audit.';
    default:
      return `Handle workflow decision ${decision.action}.`;
  }
}
