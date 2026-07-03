# Agent Loop Claude Review Plugin

Claude Code plugin for Tik-native review loop tasks.

Install or load this plugin in Claude Code so Tik can launch Claude Code with the `review-tik-agent-loop`, `plan-tik-agent-loop`, `question-tik-agent-loop`, and `final-review-tik-agent-loop` skills. Tik selects the Workbench task or workflow, verifies and provides the context, and owns state transitions; the plugin only returns structured planner/reviewer/questioner outputs back to Tik/Codex.

## Install

From this repository:

```bash
claude plugin marketplace add /Users/huyuehui/ace/tik/claude-plugin --scope user
claude plugin install agent-loop-claude-review@tik-local --scope user
```

Validate and inspect:

```bash
claude plugin validate /Users/huyuehui/ace/tik/claude-plugin
claude plugin list
claude plugin details agent-loop-claude-review
```

Start a new Claude Code session after installing so the `review-tik-agent-loop` skill is available.

## Runtime

Default Tik API base:

```bash
export TIK_API_BASE_URL=http://127.0.0.1:3300/api
```

Tik launches Claude Code through its own runtime. These environment variables tune that launch path:

```bash
export TIK_CLAUDE_CODE_PLUGIN_DIRS=/Users/huyuehui/ace/tik/claude-plugin/agent-loop-claude-review
export TIK_CLAUDE_CODE_ADD_DIRS=/Users/huyuehui/ace/tik
export TIK_CLAUDE_CODE_PERMISSION_MODE=bypassPermissions
```

Use `TIK_CLAUDE_CODE_PERMISSION_MODE=bypassPermissions` only for Tik-owned,
isolated review launches. Do not export it into ordinary interactive Claude Code
sessions.

The plugin does not claim tasks on its own. The normal review flow is:

```text
Codex skill -> Tik API -> claude-code runtime -> review-tik-agent-loop -> Tik ReviewResult API
```

The legacy multi-agent planning/final-review flow is:

```text
Codex workflow skill -> Tik API -> claude-code runtime -> plan/final-review skill -> Tik state/result API -> Codex workflow decision
```

The v1 Codex Evaluator / Claude Questioner flow does not call
`final-review-tik-agent-loop` for workflow completion. In v1, Codex runs final
evaluation with subtask id `__final__`, then launches `question-tik-agent-loop`
with `intent=question_final_evidence`; Tik completion is guarded by that
Questioner output.

Optional task lookup for debugging:

```bash
bash claude-plugin/agent-loop-claude-review/scripts/claim-next-review.sh
```

## Skill Capabilities

This plugin contributes four Tik-owned Claude Code skills. They are intentionally
read-only from the repository's point of view: Tik supplies the selected task or
workflow, Claude inspects state and source, and Tik records the returned
structured result.

| Skill | Capability | Tik input | Tik output |
| --- | --- | --- | --- |
| `plan-tik-agent-loop` | Produce a bounded `TaskGraph` for a multi-agent workflow. | Multi-agent workflow id, goal, refs, workspace binding, constraints. | TaskGraph JSON. Tik may store a draft from the planner invocation, but Codex must explicitly accept the reviewed graph with `PUT /v1/multi-agent/workflows/:id/task-graph`. |
| `review-tik-agent-loop` | Review the exact pinned worktree head for a Tik Claude review task. | Workbench task with `agentLoop.kind=claude_review`, `headSha`, allowed scope, acceptance criteria, review focus. Tik adds labels such as `external-claude-review` and, for final reviews, `final-claude-review`. | `ReviewResult` posted to `POST /v1/agent-loop/tasks/:id/review-result`, or stale-head notice posted to `/stale`. |
| `question-tik-agent-loop` | Challenge requirements, TaskGraph drafts, SprintContracts, Codex Evaluator evidence, or final v1 evidence. | Token-scoped `QuestionerRun`, `QuestionerContextV1`, expected HEAD, submit URL, and relevant contract/evaluation ids. | `QuestionerOutputV2` posted to `POST /v1/multi-agent/workflows/:id/questioner-runs/:runId/output` with context/output hashes, coverage matrix, and readonly audit evidence. `question_requirement` and `question_task_graph` are informational hookpoints today; v1 loop gates actively consume `question_contract`, `question_evaluation`, and `question_final_evidence`. |
| `final-review-tik-agent-loop` | Perform a read-only final workflow review across subtasks and recorded evidence. | Multi-agent workflow bundle, final diff context, evidence, subtask states. | FinalReviewResult JSON for the Codex workflow driver to inspect before completion. |

### ReviewResult Handling

`review-tik-agent-loop` submits the canonical Tik review result shape:

- `verdict=approve` only when there are no blocking issues.
- `verdict=request_changes` when `blockingIssues` is non-empty.
- `headShaReviewed` and `currentHeadSha` are included so Tik can detect stale reviews.
- `blockingIssues`, `nonBlockingSuggestions`, `testsNeeded`, and `markdown` are stored on the task and surfaced in Dashboard comments/timeline.

After Tik ingests a review result, Tik owns the state transition:

- blocking issues route the task toward Codex fixes;
- no blocking issues route the task to `human_review / needs_human_review`;
- stale HEAD reports stop the review instead of reviewing a moving target.
- Codex `process-review` treats stale tasks as a signal to request a fresh review
  for the current head rather than waiting for `agentLoop.reviewResult`.

`final-review-tik-agent-loop` uses the same writeback endpoint as subtask review:
`POST /v1/agent-loop/tasks/:id/review-result`.

### Boundaries

The plugin does not edit files, run Codex fixes, commit, push, merge, claim
unselected tasks, or choose the next workflow action. Those decisions stay in the
Codex workflow skill and Tik guardrails.

`question-tik-agent-loop` must submit through `scripts/post-questioner-output.mjs`.
The helper verifies the fetched context hash, canonicalizes the output hash,
turns HEAD mismatches into auditable blocking `QuestionerOutputV2`, and submits
`git status --porcelain=v1` as the readonly audit proof. Tik rejects the run if
forbidden repository writes are observed.
