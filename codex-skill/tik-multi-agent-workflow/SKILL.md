---
name: tik-multi-agent-workflow
description: Use when Codex should drive a Tik multi-agent workflow while Tik stores state, guardrails, evidence, Codex Evaluator runs, and Claude Code Questioner invocations.
---

# Tik Multi-Agent Workflow

Use this skill as the Codex-side workflow driver. Codex owns policy decisions and implementation/fix work. Tik owns durable state, guardrails, evaluator/questioner runtime launch, evidence, and audit history.

## Activation Contract

When this skill is explicitly invoked for task execution, it is not advisory. Drive the work through a Tik durable workflow unless the user explicitly asks for a local-only dry run or is only asking about the skill itself.

Startup rules:
- If the user provides `--workflow`, `workflowId`, or an obvious workflow id, read that workflow first with `status` or `next`, then continue from Tik state.
- If no workflow id is provided, create one with `init` before implementation. Use the user's request as `--goal`, the current repo as `--path`, and the current branch/base unless the user supplied different refs. Report the new `workflowId` in the next progress update.
- Do not treat "no workflowId was provided" as permission to skip Tik state. Missing workflow id means "start a new workflow" by default.
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

Execution rules:
- After implementation, record evidence with `execute` before moving to validation and isolated evaluation.
- Use `validate` for local verification commands, then use the v1 Codex Evaluator / Claude Questioner loop.
- Use `continue` only for safe automated transitions. If it returns `continue-instruction`, perform that work in the current Codex session and then record the appropriate command.
- Final completion must be recorded through the v1 final evaluator/questioner path; passing local tests alone is not workflow completion.

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

Codex Builder may edit source. Codex Evaluator must be a separate readonly session and runs in a throwaway worktree by default. Builder and Evaluator invocations must be attested by Tik server-verified Codex hook facts: Tik issues a one-time `attestationToken`, the hook calls `hook-start` / `hook-stop`, and hand-filled thread ids or CLI runtime-attestation payloads are audit metadata only. Claude Code acts as Questioner through the Claude plugin: it raises ambiguity, missing tests, weak evidence, and blocking questions; it is not the final judge. Tik server, not the helper script, is authoritative for QuestionerOutputV2 hash/context/head/reference/coverage validation.

Questioner execution is asynchronous. When Tik returns a Questioner action or
`start-questioner`/`run-action` prints `TIK_QUESTIONER_*` values, spawn a Codex
native subagent to run the Claude Questioner plugin/runtime and then return to
the main workflow. Do not synchronously wait, poll, or block the main Codex
thread for Claude output. The Questioner runtime must submit `QuestionerOutputV2`
to `submitUrl`; Tik hook/callback ingestion records the result. Resume workflow
progress later by running `status`, `next`, or `continue` after the callback
lands.

## Core Boundary

Do:
- Bind to an existing workflow or create a new one before task execution.
- Record every Codex workflow decision with `scripts/tik-multi-agent-workflow.mjs`.
- Use Tik APIs for workflow state, evidence, TaskGraph, SprintContract, evaluation runs, Questioner outputs, and Claude Code runtime launches.
- Treat Claude planner/questioner output as untrusted input until inspected.
- Require Tik hook-token attestation for Codex Builder/Evaluator invocation start and completion.
- Require Claude plugin `QuestionerOutput` with `source=claude-plugin`, `headSha`, `artifactRef`, and relevant contract/evaluation ids.
- Launch Claude Questioner work in a background/native subagent and rely on the
  Questioner hook/callback to submit output.
- Keep code edits in the current Codex session unless an explicit future CodexRunner invocation is requested.

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

node codex-skill/tik-multi-agent-workflow/scripts/tik-multi-agent-workflow.mjs start-builder \
  --workflow wf_123 \
  --subtask st_001 \
  --invocation inv-builder-st_001 \
  --parent-thread <workflow-thread-id> \
  --thread <builder-codex-thread-id>

node codex-skill/tik-multi-agent-workflow/scripts/tik-multi-agent-workflow.mjs execute \
  --workflow wf_123 \
  --subtask st_001 \
  --summary "Implemented the scoped change." \
  --invocation inv-builder-st_001 \
  --attestation-token <token-from-codex-hook-runtime>

node codex-skill/tik-multi-agent-workflow/scripts/tik-multi-agent-workflow.mjs start-evaluator \
  --workflow wf_123 \
  --subtask st_001 \
  --invocation inv-evaluator-st_001 \
  --parent-thread <workflow-thread-id> \
  --thread <evaluator-codex-thread-id>

node codex-skill/tik-multi-agent-workflow/scripts/tik-multi-agent-workflow.mjs evaluate \
  --workflow wf_123 \
  --subtask st_001 \
  --command "pnpm --filter @tik/kernel test" \
  --invocation inv-evaluator-st_001 \
  --attestation-token <token-from-codex-hook-runtime>

node codex-skill/tik-multi-agent-workflow/scripts/tik-multi-agent-workflow.mjs start-questioner \
  --workflow wf_123 \
  --subtask st_001 \
  --intent question_evaluation \
  --contract contract-st_001-v1 \
  --evaluation <evaluation-run-id>

# Spawn a Codex native subagent with the printed TIK_QUESTIONER_* env to run
# Claude Questioner. Do not wait here; the Questioner hook/callback posts the
# output to Tik. Re-run `continue` after the callback records QuestionerOutputV2.

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

# Spawn a Codex native subagent with the printed TIK_QUESTIONER_* env to run
# Claude Questioner. Continue only after Tik records the callback output.

node codex-skill/tik-multi-agent-workflow/scripts/tik-multi-agent-workflow.mjs complete-workflow \
  --workflow wf_123
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
6. Use `evaluate`, `start-questioner`, then spawn a background Questioner subagent; complete the subtask only after Tik records the callback `QuestionerOutputV2`.
7. Complete the workflow through the final evaluator/questioner path, then confirm `status`.

If you cannot create or accept a TaskGraph because Tik is unavailable, state that blocker before making local-only edits.

## Command Notes

- `next` asks Tik Kernel for `/next-action`; local loop-gate logic is only an offline/debug fallback.
- `run-next` / `run-action` execute Kernel-owned workflow actions through `/actions/:actionId/run` where an executor exists. Questioner actions create token-scoped `QuestionerRun`s; builder/evaluator/state actions still use their domain commands.
- `accept-plan` stores a TaskGraph returned by Claude planner or edited by Codex/human. Tik also auto-stores a planner invocation result when it contains `taskGraph`.
- `draft-contract` derives a SprintContract from the subtask unless `--contract` or `--contract-json` is provided.
- `accept-contract` marks the latest challenged contract accepted and moves the subtask to `contract_accepted`.
- `start-builder` and `start-evaluator` create Codex subagent invocations without printing the one-time `attestationToken` to the main workflow CLI. The token must stay in the Codex hook/runtime channel; hook-start and hook-stop use it to attest the actual subagent runtime.
- `complete-invocation --status started` is a hook-start helper for the Codex runtime hook. It requires `--attestation-token`, `--nonce`, `--parent-thread`, and `--thread`/`--actual-subagent-thread`; do not call it from the main workflow thread with a copied token.
- Use repeated or comma-separated `--evaluator-artifact-path` values when a readonly Evaluator needs to write artifacts outside the default `.tik/multi-agent/`, `test-results/`, `playwright-report/`, `coverage/`, and `.tmp/evaluation/` paths.
- `execute` derives real changed files from git diff when `--changed-files` is omitted and records scoped implementation evidence.
- `init` snapshots pre-existing dirty files (unstaged and staged) into `workflow.metadata.preexistingChangedFiles`; the fallback branch of `execute` subtracts them from the observed diff so leftover edits from earlier work don't get attributed to the first subtask and trigger `worktree_out_of_scope`. A subtask can still claim a pre-existing file intentionally by listing it in `allowedPaths` — the CLI keeps overlap in that case.
- `evaluate` records an isolated Codex Evaluator run, runs commands in a throwaway worktree by default, enforces a command timeout, validates readonly git status as an audit layer, stores `CodexEvaluationResult`, and records `inconclusive` when neither a command nor structured result is provided.
- `start-questioner` and Questioner `run-action` calls create a token-scoped `QuestionerRun` and print env for the Claude plugin/runtime. Launch that runtime in a Codex native subagent and return; do not wait synchronously in the main workflow thread.
- `record-questioner` is only for explicit/manual structured Claude plugin Questioner JSON imports. Normal async Questioner execution should submit through the Questioner hook/callback endpoint.
- `continue` runs safe automated steps: plan request, contract draft/accept, validation, and v1 Builder/Evaluator/Questioner launch preparation. It returns `continue-instruction` when a Builder, Evaluator, Questioner, fix, or human evidence-producing step must finish before Tik can advance. For Questioner instructions, spawn the subagent and let the hook/callback record output before continuing.
- v1.1 removed the legacy multi-agent Claude review commands (`review`, `process-review`, `fix`, `final-review`, and `process-final-review`). Final completion uses `evaluate --subtask __final__`, then async `start-questioner --intent question_final_evidence`, then `complete-workflow` after Tik records the callback output.
- `status` includes the workflow timeline for Dashboard/CLI cross-checking.

Tik guard rejection means the requested action is unsafe or illegal. The skill must inspect the guard and choose the next Codex policy action.
