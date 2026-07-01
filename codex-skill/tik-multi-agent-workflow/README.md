# Tik Multi-Agent Workflow Skill

Codex-side driver for Tik multi-agent workflows.

This skill lets Codex drive implementation decisions while Tik stores durable
workflow state, TaskGraph plans, subtask state, evidence, review tasks, guard
decisions, and Dashboard-visible audit history.

## Capability Summary

| Command | Capability | Tik records |
| --- | --- | --- |
| `init` | Create a multi-agent workflow for a repo/worktree and pin the current head. | `MultiAgentWorkflowRecord` with goal, root task, refs, head SHA, workspace binding. |
| `plan` | Request a Claude planner invocation through Tik. When the planner invocation completes with `taskGraph`, Tik stores it automatically. | `request_dynamic_plan` decision plus planner `AgentInvocationRecord` and TaskGraph writeback. |
| `accept-plan` | Store a reviewed or edited TaskGraph. | TaskGraph plus initialized subtask run states. |
| `next` | Compute the next local Codex policy action from Tik state. | Guarded `WorkflowDecision`. |
| `execute` | Record Codex implementation evidence for a subtask. | Implementation evidence, subtask state, validation decision. |
| `validate` | Run a validation command and persist the result. | Validation evidence, pass/fail state, next review/fix decision. |
| `review` | Create a Tik-owned external Claude review task for a subtask. | Workbench task with `external-claude-review`, review metadata, subtask review state. |
| `process-review` | Read a Tik ReviewResult and decide fix, validation retry, human review, or subtask completion. | Review evidence, guarded workflow decision, `review_approved -> done` state when approved. |
| `fix` | Record Codex fix evidence after Claude blockers. | Fix evidence, `fixing -> implemented`, validation decision before re-review. |
| `final-review` | Create a Tik-owned final Claude review task after all subtasks are done. | `request_final_review` decision and final review task. |
| `process-final-review` | Read the final ReviewResult and complete or escalate the workflow. | Final review evidence and guarded `complete_workflow` decision. |
| `continue` | Advance safe automated steps such as planning request, validation, review request, re-review request, and final-review request. | The corresponding guarded decision and Tik mutation for the safe step. |
| `status` | Inspect workflow state, counts, and recent timeline for Dashboard/CLI cross-checks. | No mutation. |

## Workflow Shape

```text
Codex skill
  -> Tik multi-agent workflow APIs
  -> Tik guardrails and evidence store
  -> Tik-owned Claude planner/reviewer task when needed
  -> Codex inspects results and records the next decision
```

Codex owns implementation and policy decisions. Tik owns persistence,
guardrails, review task creation, state transitions, and the Dashboard-visible
history. Claude Code planner/reviewer output is treated as input, not as an
automatic authority.

## Typical Use

```bash
node codex-skill/tik-multi-agent-workflow/scripts/tik-multi-agent-workflow.mjs init \
  --goal "implement multi-agent workflow service" \
  --path /Users/huyuehui/ace/tik \
  --base main

node codex-skill/tik-multi-agent-workflow/scripts/tik-multi-agent-workflow.mjs plan \
  --workflow <workflow-id>

node codex-skill/tik-multi-agent-workflow/scripts/tik-multi-agent-workflow.mjs accept-plan \
  --workflow <workflow-id> \
  --task-graph /path/to/task-graph.json

node codex-skill/tik-multi-agent-workflow/scripts/tik-multi-agent-workflow.mjs execute \
  --workflow <workflow-id> \
  --subtask <subtask-id> \
  --summary "Implemented the scoped change."

node codex-skill/tik-multi-agent-workflow/scripts/tik-multi-agent-workflow.mjs validate \
  --workflow <workflow-id> \
  --subtask <subtask-id> \
  --command "pnpm test"

node codex-skill/tik-multi-agent-workflow/scripts/tik-multi-agent-workflow.mjs review \
  --workflow <workflow-id> \
  --subtask <subtask-id> \
  --start

node codex-skill/tik-multi-agent-workflow/scripts/tik-multi-agent-workflow.mjs process-review \
  --workflow <workflow-id> \
  --subtask <subtask-id> \
  --task <review-task-id>

node codex-skill/tik-multi-agent-workflow/scripts/tik-multi-agent-workflow.mjs continue \
  --workflow <workflow-id>

node codex-skill/tik-multi-agent-workflow/scripts/tik-multi-agent-workflow.mjs final-review \
  --workflow <workflow-id> \
  --start

node codex-skill/tik-multi-agent-workflow/scripts/tik-multi-agent-workflow.mjs process-final-review \
  --workflow <workflow-id> \
  --task <final-review-task-id>

node codex-skill/tik-multi-agent-workflow/scripts/tik-multi-agent-workflow.mjs status \
  --workflow <workflow-id>
```

Use `--api-base-url` or `TIK_API_BASE_URL` when Tik is not running at
`http://127.0.0.1:3300/api`.

## Dashboard Evidence

A real workflow run should leave evidence in both places:

- Workbench task comments/timeline: task creation, state transitions, review
  request, ReviewResult ingestion, and human-review state.
- Multi-agent workflow timeline: `workflow.created`, `task_graph.created`,
  `subtask.updated`, `evidence.recorded`, `decision.recorded`, and
  `workflow.completed` events.

`status` prints the workflow, subtask states, evidence/decision counts,
`timeline`, and recent event payloads so CLI output can be compared with the
Dashboard.

For a live-service verification run, use:

```bash
node scripts/verify-multi-agent-real-service.mjs
```

That script starts a real Tik API service, creates a real task, exercises the
workflow APIs over HTTP, records implementation and validation evidence, submits
a real ReviewResult, and writes a report under `.tik/verification/`.

Core and skill regression tests are part of the default root test command:

```bash
pnpm test
```

The skill-only smoke test can also be run directly:

```bash
pnpm run test:multi-agent-skill
```

## Acceptance Gates

- `init` creates a workflow in one command and pins repo/worktree metadata.
- Claude planner invocation completion with a `taskGraph` automatically writes
  the TaskGraph back to Tik.
- `next`/`continue` advance the DAG; dependent pending subtasks become
  executable only after dependencies are `done`.
- Each subtask follows `execute -> validate -> review`; validation uses
  `validated`, while Claude approval uses `review_approved`.
- Claude blocking findings route to `fix -> validate -> re-review`.
- `complete_subtask` is guarded by same-head passing validation and Claude
  approval evidence.
- After all subtasks are `done`, the workflow must request final review.
- `complete_workflow` is guarded by approved final review evidence.
- Preflight guard rejection prevents partial state mutation for unsafe commands.
- CLI `status` and the Dashboard timeline expose the workflow event history.

When validating the currently running Dashboard service instead of a temporary
server, create the task against the active `TIK_API_BASE_URL` so the task appears
in the current Dashboard workspace.

## Boundaries

Do:

- keep all decisions recorded through Tik workflow APIs;
- use Tik review tasks for Claude planner/reviewer work;
- inspect Claude output before applying fixes;
- keep code edits in the current Codex session unless a future CodexRunner path
  is explicitly added.

Do not:

- let Tik core choose the next Codex policy action;
- call Claude directly for canonical workflow review;
- let Claude Code edit files, commit, push, or claim arbitrary tasks;
- auto-merge or bypass human/project policy.
