---
name: tik-multi-agent-workflow
description: Use when Codex should drive a Tik multi-agent workflow while Tik stores state, guardrails, evidence, Codex Evaluator runs, and Claude Code Questioner invocations.
---

# Tik Multi-Agent Workflow

Use this skill as the Codex-side workflow driver. Codex owns policy decisions and implementation/fix work. Tik owns durable state, guardrails, evaluator/questioner runtime launch, evidence, and audit history.

## Activation Contract

When this skill is explicitly invoked for task execution, it is not advisory. Drive the work through a Tik durable workflow unless the user explicitly asks for a local-only dry run or is only asking about the skill itself.

Right-sizing rules (apply before `init`):
- The workflow is a heavyweight contract-lock + Evaluator + Questioner loop. For a typical review-and-fix run it adds roughly 30–60 minutes of overhead beyond the actual code work; final Questioner alone often needs 2–4 rounds when the working tree is not clean. Do not run it for tasks whose real work is much shorter than that overhead.
- Fits this skill: contract-breaking API/DTO changes, cross-service behavior changes, migrations, security- or policy-sensitive fixes, review-fix passes with multiple findings, anything that must produce durable evidence for audit.
- Does not fit: single-line typo/rename, one-file cosmetic refactor, purely local experiment, "just tell me what this does" reads, "just run these tests" one-shots. For those, do the work directly and note that the skill was intentionally skipped for scope reasons.
- If unsure, prefer to `init` — but call it out to the user first when the scope looks borderline, so they can veto before the loop starts.
- Pure read-only MR review that needs durable audit uses `init --mode review`; it must not be routed through the implementation contract/Builder loop.

Startup rules:
- Run `preflight --mode <implementation|review>` before creating durable state. `init` performs the same preflight automatically and fails before workflow creation when workspace binding, runtime versions, Claude Questioner, or both the Tik-owned native launcher and verified Codex hook fallback are unavailable.
- If the user provides `--workflow`, `workflowId`, or an obvious workflow id, read that workflow first with `status` or `next`, then continue from Tik state.
- If no workflow id is provided, create one with `init` before implementation. Use the user's request as `--goal`, the current repo as `--path`, and the current branch/base unless the user supplied different refs. Report the new `workflowId` in the next progress update.
- Do not treat "no workflowId was provided" as permission to skip Tik state. Missing workflow id means "start a new workflow" by default (subject to the right-sizing rules above).
- If Tik API is unavailable, do not silently fall back to local-only work. Try the obvious recovery for this repo; if still blocked, say the workflow could not be created and clearly label any further work as local-only.

Workspace binding rules:
- Bind the Tik API server to the workspace root before creating the workflow. `tik serve --project <workspace-root>` defines the only workspace root that `/api/v1/multi-agent/workflows` will accept.
- Treat `--workspace-root` as the Dashboard/workbench root and `--path` as the execution repo or worktree inside that root. Do not use a sibling or parent API server for a repo outside its workspace root.
- In a multi-project workspace, run `init` against the workspace-root API and pass `--workspace-root <workspace-root> --path <workspace-root-relative-or-absolute-worktree> --repo <project-name> --source-path <source-project-path> --worktree-kind git-worktree --lane <lane-id>`.
- If the first `init` fails with `invalid_workspace_binding`, do not retry by dropping binding fields. Start or choose the Tik API whose `--project` equals the intended workspace root, set `--api-base-url` to that server, and retry with the same `--workspace-root` and `--path`.
- `init` creates or repairs the workflow root workbench task. Use `--root-task <id>` only to bind an existing task; otherwise let Tik use the workflow id as the root task id and expose it in Dashboard.

TaskGraph rules:
- Do not edit source before the workflow has an accepted TaskGraph, unless the user is only asking for read-only review or diagnosis.
- For broad work, use `plan`, inspect the planner output, then `accept-plan`.
- For narrow code-review fixes where the findings are already the plan, Codex may write a minimal TaskGraph JSON and `accept-plan` it directly. Keep it small: one subtask for one tightly related fix set, or one subtask per independent file/behavior group.
- `init --mode review` creates deterministic review shards from the pinned diff. Review subtasks use `kind=review`, `assignedReviewer=codex`, omit `expectedChangedFiles`, and never declare source writes.
- Tik rejects TaskGraphs whose allowed and blocked paths overlap, whose dependencies are missing/cyclic, or whose task kind conflicts with workflow mode.

Execution rules:
- After implementation, record evidence with `execute` before moving to validation and isolated evaluation.
- Use `validate` for local verification commands, then use the v1 Codex Evaluator / Claude Questioner loop.
- Use `continue` only for safe automated transitions. If it returns `continue-instruction`, perform that work in the current Codex session and then record the appropriate command.
- Final completion must be recorded through the v1 final evaluator/questioner path; passing local tests alone is not workflow completion.
- Implementation evidence is recorded through the atomic `execute-subtask` action. Attestation, scope, and transition guards run before any evidence, decision, invocation, or subtask write; failed writes are rolled back.

Review-mode rules:
- The canonical flow is `TaskGraph -> readonly Reviewer -> focused Evaluator -> Questioner -> synthesis -> complete_workflow`.
- Review mode does not create SprintContracts, start Builders, record changed-file implementation evidence, or enter `execute_subtask`.
- Use `start-reviewers --max-concurrency 4` to launch all ready shards, or `start-reviewer` for one shard. Tik uses stable invocation ids, shares the workspace App Server, and returns the existing run on a safe retry. After completion, `record-review --invocation <id>` reads the native structured result directly.
- Evaluators receive `reviewEvidenceId` and `candidateOnly=true`; they validate candidates instead of rescanning the full shard.
- After all shards are done, use `synthesize-review` before `complete-workflow`.

Async-wait rules (main Codex thread):
- The main workflow thread must never sit inside a single `exec_command` waiting for a Questioner subagent to finish. Questioner runs are async by contract: Tik launches Claude with a token-scoped environment, the main thread returns, and the callback resumes the workflow.
- After `start-questioner` (or a `continue-instruction` that produces a Questioner action), return control or do independent non-blocking work. Do not launch a duplicate Questioner or block until the callback lands.
- If the subagent framework requires an explicit wait, use short bounded waits (≤ 60s per poll) and re-check `status` in a fresh turn. Anything longer than that is a bug, not a workflow step.

Pre-final-gate hygiene (before `evaluate --subtask __final__`):
- Working tree must be committed. Uncommitted files cause Questioner to reject final evidence as "produced from working-tree changes, not the pinned HEAD" and burns a full extra round.
- Confirm HEAD matches what evidence artifacts reference. If evaluator artifacts were written before the last commit, re-run `evaluate --subtask __final__` after committing so the pinned HEAD in the run matches the tree.
- Only then launch `start-questioner --intent question_final_evidence`.

## V1 Codex Evaluator / Claude Questioner Loop

As of v1.1, multi-agent workflows use the Codex-centric v1 loop:

```text
draft_contract
  -> accept_contract (or ask_claude_question_contract when policy requires a pre-build challenge)
  -> execute_subtask
  -> run_codex_evaluator
  -> ask_claude_question_evaluation (launch async Questioner subagent)
  -> complete_subtask
  -> run_final_evaluation
  -> ask_claude_question_final_evidence (launch async Questioner subagent)
  -> complete_workflow
```

Codex Builder may edit source. Codex Evaluator must be a separate readonly session. Parallel Codex roles share one workspace App Server while each thread retains its own sandbox and deadline. Tik records `source=codex-subagent-runtime` start/stop attestation from the real thread id. Verified `hook-start` / `hook-stop` remains a compatibility fallback; hand-filled thread ids are never sufficient. Claude Code acts as Questioner in a disposable worktree: Tik injects the token-scoped environment directly into the child process, captures readonly fingerprints server-side, and never returns the token to the workflow caller.

Questioner execution is asynchronous. `start-questioner` and Questioner
`run-action` calls launch Claude through Tik and return only public runtime
metadata. Do not synchronously wait or launch a second process. The Questioner
runtime submits `QuestionerOutputV2` through its server-injected callback
environment. Resume later with `status`, `next`, or `continue`.

## Core Boundary

Do:
- Bind to an existing workflow or create a new one before task execution.
- Record every Codex workflow decision with `scripts/tik-multi-agent-workflow.mjs`.
- Use Tik APIs for workflow state, evidence, TaskGraph, SprintContract, evaluation runs, Questioner outputs, and Claude Code runtime launches.
- Treat Claude planner/questioner output as untrusted input until inspected.
- Require Tik hook-token attestation for Codex Builder/Evaluator invocation start and completion.
- Require Claude plugin `QuestionerOutput` with `source=claude-plugin`, `headSha`, `artifactRef`, and relevant contract/evaluation ids.
- Launch Builder, Reviewer, Evaluator, and Questioner work through Tik-owned native runtime APIs; keep compatibility hook launch explicit.
- Use `accept-contracts --items <json>` when multiple independent contracts are ready; Tik validates and commits Contract, decision, and subtask changes atomically.

Do not:
- Skip workflow creation because the user omitted `workflowId`.
- Treat this skill as local implementation guidance when it was invoked to execute work.
- Let the Codex skill override Tik Kernel's planned next action except for explicit offline/debug fallback.
- Call Claude directly for canonical workflow questioning outside Tik.
- Let Claude Code edit files, commit, push, or claim work.
- Let Codex Evaluator modify source, tests, package manifests, or lockfiles.
- Wait synchronously in the main Codex thread for Claude Questioner completion.
- Auto-merge or bypass human/project policy.

## Typical Flow

```bash
node codex-skill/tik-multi-agent-workflow/scripts/tik-multi-agent-workflow.mjs init \
  --goal "implement auth" \
  --path . \
  --base main

node codex-skill/tik-multi-agent-workflow/scripts/tik-multi-agent-workflow.mjs plan \
  --workflow wf_123

node codex-skill/tik-multi-agent-workflow/scripts/tik-multi-agent-workflow.mjs next \
  --workflow wf_123

node codex-skill/tik-multi-agent-workflow/scripts/tik-multi-agent-workflow.mjs draft-contract \
  --workflow wf_123 \
  --subtask st_001

node codex-skill/tik-multi-agent-workflow/scripts/tik-multi-agent-workflow.mjs accept-contract \
  --workflow wf_123 \
  --subtask st_001 \
  --contract contract-st_001-v1

# Or atomically accept multiple independent contracts from a JSON array:
node codex-skill/tik-multi-agent-workflow/scripts/tik-multi-agent-workflow.mjs accept-contracts \
  --workflow wf_123 \
  --items ./contracts-to-accept.json

node codex-skill/tik-multi-agent-workflow/scripts/tik-multi-agent-workflow.mjs start-builder \
  --workflow wf_123 \
  --subtask st_001 \
  --invocation inv-builder-st_001

node codex-skill/tik-multi-agent-workflow/scripts/tik-multi-agent-workflow.mjs execute \
  --workflow wf_123 \
  --subtask st_001 \
  --summary "Implemented the scoped change." \
  --invocation inv-builder-st_001

node codex-skill/tik-multi-agent-workflow/scripts/tik-multi-agent-workflow.mjs start-evaluator \
  --workflow wf_123 \
  --subtask st_001 \
  --invocation inv-evaluator-st_001

node codex-skill/tik-multi-agent-workflow/scripts/tik-multi-agent-workflow.mjs evaluate \
  --workflow wf_123 \
  --subtask st_001 \
  --command "pnpm --filter @tik/kernel test" \
  --invocation inv-evaluator-st_001

node codex-skill/tik-multi-agent-workflow/scripts/tik-multi-agent-workflow.mjs start-questioner \
  --workflow wf_123 \
  --subtask st_001 \
  --intent question_evaluation \
  --contract contract-st_001-v1 \
  --evaluation <evaluation-run-id>

# Tik launches Claude and injects TIK_QUESTIONER_* server-side. Do not wait here;
# re-run `continue` after the callback records QuestionerOutputV2.

node codex-skill/tik-multi-agent-workflow/scripts/tik-multi-agent-workflow.mjs complete-subtask \
  --workflow wf_123 \
  --subtask st_001

node codex-skill/tik-multi-agent-workflow/scripts/tik-multi-agent-workflow.mjs evaluate \
  --workflow wf_123 \
  --subtask __final__ \
  --evaluation <final-evaluation-run-id> \
  --command "pnpm test"

node codex-skill/tik-multi-agent-workflow/scripts/tik-multi-agent-workflow.mjs start-questioner \
  --workflow wf_123 \
  --intent question_final_evidence \
  --evaluation <final-evaluation-run-id>

# Tik launches Claude. Continue only after Tik records the callback output.

node codex-skill/tik-multi-agent-workflow/scripts/tik-multi-agent-workflow.mjs complete-workflow \
  --workflow wf_123
```

Readonly review flow:

```bash
node codex-skill/tik-multi-agent-workflow/scripts/tik-multi-agent-workflow.mjs preflight \
  --mode review --path <repo>

node codex-skill/tik-multi-agent-workflow/scripts/tik-multi-agent-workflow.mjs init \
  --mode review --goal "review the pinned MR" --path <repo> --base <base-ref>

node codex-skill/tik-multi-agent-workflow/scripts/tik-multi-agent-workflow.mjs start-reviewer \
  --workflow <workflow-id> --subtask <review-shard> --invocation <id>

node codex-skill/tik-multi-agent-workflow/scripts/tik-multi-agent-workflow.mjs record-review \
  --workflow <workflow-id> --subtask <review-shard> --invocation <id> \
  --result <review-result.json>

# Run the focused Evaluator and Questioner loop for each shard, then:
node codex-skill/tik-multi-agent-workflow/scripts/tik-multi-agent-workflow.mjs synthesize-review \
  --workflow <workflow-id> --result <deduplicated-findings.json>
```

## Workspace Binding Examples

Single-repo workspace:

```bash
tik serve --host 127.0.0.1 --port 3300 --project /Users/me/repo

node codex-skill/tik-multi-agent-workflow/scripts/tik-multi-agent-workflow.mjs init \
  --api-base-url http://127.0.0.1:3300/api \
  --goal "review and fix current branch" \
  --workspace-root /Users/me/repo \
  --path /Users/me/repo \
  --repo repo \
  --base main
```

Workspace root with managed worktree:

```bash
tik serve --host 127.0.0.1 --port 64777 --project /Users/me/merchant-workspace

node codex-skill/tik-multi-agent-workflow/scripts/tik-multi-agent-workflow.mjs init \
  --api-base-url http://127.0.0.1:64777/api \
  --goal "review C2C RESELL shop-id changes" \
  --workspace-root /Users/me/merchant-workspace \
  --path /Users/me/merchant-workspace/worktrees/mall-merchant-c2c-shop-id \
  --repo mall-merchant \
  --source-path /Users/me/merchant-workspace/projects/mall-merchant \
  --worktree-kind git-worktree \
  --lane c2c-shop-id \
  --base origin/feature/funding-web-controller-switch \
  --head-ref feature/c2c-shop-id
```

Dashboard will show the root task in the workspace served by `--api-base-url`.
If a workflow appears in the "Multi-agent workflows" list but not in "Tasks by
progress", run the root-task repair endpoint through that same API before
continuing:

```bash
curl -X POST \
  http://127.0.0.1:64777/api/v1/multi-agent/workflows/<workflow-id>/root-task/repair
```

## Code Review Fix Flow

When the user invokes this skill to fix review findings and provides no workflow id:

1. Select the Tik API bound to the correct workspace root, then run `init --goal "<fix the listed review findings>" --workspace-root <workspace-root> --path <repo-or-worktree> --repo <project>` and capture the `workflowId`.
2. Create or obtain a TaskGraph that maps the findings to subtasks, then run `accept-plan`.
3. Implement the fix in the current Codex session.
4. Run `execute --workflow <workflowId> --subtask <id> --summary "<what changed>"`.
5. Run `validate --workflow <workflowId> --subtask <id> --command "<targeted tests>"` for the proof commands.
6. Use `evaluate`, then `start-questioner`; Tik launches the background Questioner. Complete the subtask only after Tik records the callback `QuestionerOutputV2`.
7. Complete the workflow through the final evaluator/questioner path, then confirm `status`.

If you cannot create or accept a TaskGraph because Tik is unavailable, state that blocker before making local-only edits.

## Command Notes

- `next` asks Tik Kernel for `/next-action`; local loop-gate logic is only an offline/debug fallback.
- `run-next` / `run-action` execute Kernel-owned workflow actions through `/actions/:actionId/run` where an executor exists. Questioner actions launch the token-scoped Claude runtime directly; builder/evaluator/state actions use their domain commands.
- `accept-plan` stores a TaskGraph returned by Claude planner or edited by Codex/human. Tik also auto-stores a planner invocation result when it contains `taskGraph`.
- `draft-contract` derives a SprintContract from the subtask unless `--contract` or `--contract-json` is provided.
- `accept-contract` uses the same atomic action as `accept-contracts`: accepted Contract, decisions, subtasks, revision, and events commit together under a crash-recoverable journal. `If-Match` is the exact workflow `revision`; stale revisions or any invalid item reject the whole batch.
- `start-builder`, `start-reviewer`, and `start-evaluator` use deterministic ids and bounded native deadlines. A retry with the same input returns the existing invocation; a different input under the same id returns `version_conflict`.
- `record-review --invocation <id>` and `evaluate --invocation <id>` consume the completed native structured output when no explicit result file is supplied. Empty or malformed Reviewer output is rejected instead of silently recording `{}`.
- `complete-invocation --status started` is a hook-start helper for the Codex runtime hook. It requires `--attestation-token`, `--nonce`, `--parent-thread`, and `--thread`/`--actual-subagent-thread`; do not call it from the main workflow thread with a copied token.
- Use repeated or comma-separated `--evaluator-artifact-path` values when a readonly Evaluator needs to write artifacts outside the default `.tik/multi-agent/`, `test-results/`, `playwright-report/`, `coverage/`, and `.tmp/evaluation/` paths.
- `execute` derives real changed files from git diff when `--changed-files` is omitted and records scoped implementation evidence.
- `init` snapshots pre-existing dirty files (unstaged and staged) into `workflow.metadata.preexistingChangedFiles`; the fallback branch of `execute` subtracts them from the observed diff so leftover edits from earlier work don't get attributed to the first subtask and trigger `worktree_out_of_scope`. A subtask can still claim a pre-existing file intentionally by listing it in `allowedPaths` — the CLI keeps overlap in that case.
- `evaluate` records an isolated Codex Evaluator run, runs commands in a throwaway worktree by default, enforces a command timeout, validates readonly git status as an audit layer, stores `CodexEvaluationResult`, and records `inconclusive` when neither a command nor structured result is provided.
- `start-questioner` and Questioner `run-action` calls create the token-scoped `QuestionerRun` and launch Claude directly. Tik injects `TIK_QUESTIONER_*` only into the child environment. Explicit `run-action --start=false` retains the manual compatibility envelope.
- `record-questioner` is only for explicit/manual structured Claude plugin Questioner JSON imports. Normal async Questioner execution should submit through the Questioner hook/callback endpoint.
- `continue` runs safe automated steps and launches up to four ready review shards together. While any role is in flight, Kernel returns `awaiting_native_runtime`; repeated `continue` waits instead of launching duplicates.
- v1.1 removed the legacy multi-agent Claude review commands (`review`, `process-review`, `fix`, `final-review`, and `process-final-review`). Final completion uses `evaluate --subtask __final__`, then async `start-questioner --intent question_final_evidence`, then `complete-workflow` after Tik records the callback output.
- `status` includes the workflow timeline for Dashboard/CLI cross-checking.

Tik guard rejection means the requested action is unsafe or illegal. The skill must inspect the guard and choose the next Codex policy action.
