# Command Notes

Per-command implementation details. Read the top-level SKILL.md for the activation contract and boundary rules; this file is reference material for edge cases.

## Planning and Kernel loop

- `next` asks Tik Kernel for `/next-action`; local loop-gate logic is only an offline/debug fallback.
- `run-next` / `run-action` execute Kernel-owned workflow actions through `/actions/:actionId/run` where an executor exists. Questioner actions launch the token-scoped Claude runtime directly; builder/evaluator/state actions use their domain commands.
- `accept-plan` stores a TaskGraph returned by Claude planner or edited by Codex/human. Tik also auto-stores a planner invocation result when it contains `taskGraph`.
- `draft-contract` derives a SprintContract from the subtask unless `--contract` or `--contract-json` is provided.
- `accept-contract` uses the same atomic action as `accept-contracts`: accepted Contract, decisions, subtasks, revision, and events commit together under a crash-recoverable journal. `If-Match` is the exact workflow `revision`; stale revisions or any invalid item reject the whole batch.
- `continue` runs safe automated steps and launches up to four ready review shards together. While any role is in flight, Kernel returns `awaiting_native_runtime`; repeated `continue` waits instead of launching duplicates.

## Native invocations and reuse

- `start-builder`, `start-reviewer`, and `start-evaluator` use deterministic ids and bounded native deadlines. A retry with the same input returns the existing invocation; a different input under the same id returns `version_conflict`. When the launcher returns `reused: true` (or the CLI prints `action: builder-reused` / `reviewer-reused` / `evaluator-reused`), the corresponding subagent is already in flight or completed — do not launch again. Wait for the callback and record evidence via `execute` / `record-review` / `evaluate`.
- `start-questioner` follows the same pattern: `action: questioner-run-reused` means the Questioner run for these inputs is already running or complete. Do not launch again; wait for `QuestionerOutputV2` to be recorded.
- `complete-invocation --status started` is a hook-start helper for the Codex runtime hook. It requires `--attestation-token`, `--nonce`, `--parent-thread`, and `--thread`/`--actual-subagent-thread`; do not call it from the main workflow thread with a copied token.
- Use repeated or comma-separated `--evaluator-artifact-path` values when a readonly Evaluator needs to write artifacts outside the default `.tik/multi-agent/`, `test-results/`, `playwright-report/`, `coverage/`, and `.tmp/evaluation/` paths. **The runtime check is fixed at `start-evaluator` time** — passing the flag to `evaluate`, `record-review`, or `start-reviewer` only updates the recorded metadata sidecar; the runtime violation check reads `invocation.allowedPaths`, which is frozen when the invocation is created. Pass the flag to `start-evaluator` to let it reach the runtime enforcement.

## Evidence and results

- `record-review --invocation <id>` and `evaluate --invocation <id>` consume the completed native structured output when no explicit result file is supplied. Empty or malformed Reviewer output is rejected instead of silently recording `{}`.
- `execute` derives real changed files from git diff when `--changed-files` is omitted and records scoped implementation evidence.
- `init` snapshots pre-existing dirty files (unstaged and staged) into `workflow.metadata.preexistingChangedFiles`; the fallback branch of `execute` subtracts them from the observed diff so leftover edits from earlier work don't get attributed to the first subtask and trigger `worktree_out_of_scope`. A subtask can still claim a pre-existing file intentionally by listing it in `allowedPaths` — the CLI keeps overlap in that case.
- `evaluate` records an isolated Codex Evaluator run, runs commands in a throwaway worktree by default, enforces a command timeout, validates readonly git status as an audit layer, stores `CodexEvaluationResult`, and records `inconclusive` when neither a command nor structured result is provided.
- `start-questioner` and Questioner `run-action` calls create the token-scoped `QuestionerRun` and launch Claude directly. Tik injects `TIK_QUESTIONER_*` only into the child environment. Explicit `run-action --start=false` retains the manual compatibility envelope.
- `start-questioner` context is capped at 12k tokens. Tik now auto-slims verbose stdout/stderr logs, diff excerpts, and relevant-file text when the raw context would exceed the budget, then rehashes the ContextBundle so downstream attestation still matches. Only after slimming still overflows will the launch fail with `context_budget_exceeded`. If you see that error, the fix is fewer subtasks / smaller relevant-file spans, not longer prompts.
- `record-questioner` is only for explicit/manual structured Claude plugin Questioner JSON imports. Normal async Questioner execution should submit through the Questioner hook/callback endpoint. It now runs a client-side shape lint against `QuestionerOutputV2` (schemaVersion, verdict enum, `coverageMatrix` fields `criterionId/criterionText/required/status/evidenceRefs/comment`). Pair with `--expected-criterion-id global-ac-1 --expected-criterion-id global-ac-2 …` to also check the criterion set matches the workflow's global acceptance criteria. Bypass with `--skip-shape-lint` if you know why.
- `fix-evaluation --workflow <id> --subtask <id>` is the sanctioned recovery when an evaluation fails. It records the `fix_evaluation_findings` decision AND atomically transitions the subtask to `needs_fix` so `execute` accepts it. Before this existed, callers were forced to patch subtask state manually, which drifted outside the audit trail.
- v1.1 removed the legacy multi-agent Claude review commands (`review`, `process-review`, `fix`, `final-review`, and `process-final-review`). Final completion uses `evaluate --subtask __final__`, then async `start-questioner --intent question_final_evidence`, then `complete-workflow` after Tik records the callback output.

## Discovery, cooldown, and terse output

- `init` first runs `GET /v1/multi-agent/workflows?status=open&workspaceRoot=…` and reuses a single non-stale match. `--force-new` (alias `--no-reuse-if-open`) bypasses discovery. `--workflow <id>` explicitly binds to a specific workflow. Ambiguity (multiple non-stale open workflows for the same workspace) returns `ambiguous_open_workflows` and requires the caller to pick.
- `status` includes the workflow timeline for Dashboard/CLI cross-checking.
- Write-action responses (`execute`, `accept-contract` / `accept-contracts`, `record-review`, `synthesize-review`, `evaluate`) include a `nextRecommendedCommand` array. When present and non-empty, prefer picking one of those commands over rediscovering the next step via `next` / `status`. Each item is `{cmd, args, rationale}` with `cmd` matching a subcommand of this script.
- CLI output defaults to terse mode (long fields like `runtime.metadata`, `recentEvents`, and `contextBundle` are replaced with `[elided: pass --verbose to include]`). Pass `--verbose` (or set `TIK_OUTPUT_TERSE=0`) when debugging a workflow — the elided fields are recoverable that way.
- When Tik returns `awaiting_native_runtime`, the response is HTTP `202 Accepted` with a `Retry-After` header. The CLI writes a cooldown lock at `~/.tik/state/cooldown-<workflowId>.json` and rejects the next `continue` / `next` / `status` on the same workflow with `action: cooldown` and exit code `3`. Pass `--force` (or set `TIK_DISABLE_COOLDOWN=1`) only when you genuinely need to bypass the lock.
- All `init` / discovery / cooldown / reuse behaviour respects `--force-new`, `--force`, and `TIK_DISABLE_COOLDOWN=1` as explicit opt-outs; using any of these should be uncommon and worth explaining in the turn.

Tik guard rejection means the requested action is unsafe or illegal. The skill must inspect the guard and choose the next Codex policy action.
