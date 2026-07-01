# Tik Multi-Agent Workflow Skill

Codex-side driver for Tik multi-agent workflows.

This skill lets Codex drive implementation decisions while Tik stores durable
workflow state, TaskGraph plans, subtask state, evidence, review tasks, guard
decisions, and Dashboard-visible audit history.

## Capability Summary

| Command | Capability | Tik records |
| --- | --- | --- |
| `init` | Create a multi-agent workflow for a repo/worktree and pin the current head. | `MultiAgentWorkflowRecord` with goal, root task, refs, head SHA, workspace binding. |
| `plan` | Request a Claude planner invocation through Tik. | `request_dynamic_plan` decision plus planner `AgentInvocationRecord`. |
| `accept-plan` | Store a reviewed or edited TaskGraph. | TaskGraph plus initialized subtask run states. |
| `next` | Compute the next local Codex policy action from Tik state. | Guarded `WorkflowDecision`. |
| `execute` | Record Codex implementation evidence for a subtask. | Implementation evidence, subtask state, validation decision. |
| `validate` | Run a validation command and persist the result. | Validation evidence, pass/fail state, next review/fix decision. |
| `review` | Create a Tik-owned external Claude review task for a subtask. | Workbench task with `external-claude-review`, review metadata, subtask review state. |
| `process-review` | Read a Tik ReviewResult and decide fix, re-review, human review, or completion. | Review evidence, guarded workflow decision, subtask blocker/fix state. |
| `fix` | Record Codex fix evidence after Claude blockers. | Fix evidence, updated implementation head, re-review decision. |
| `continue` | Advance only safe automated steps and print instructions for unsafe/manual work. | Guarded decision for the next workflow step. |
| `status` | Inspect workflow state for debugging and Dashboard cross-checks. | No mutation. |

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
```

Use `--api-base-url` or `TIK_API_BASE_URL` when Tik is not running at
`http://127.0.0.1:3300/api`.

## Dashboard Evidence

A real workflow run should leave evidence in both places:

- Workbench task comments/timeline: task creation, state transitions, review
  request, ReviewResult ingestion, and human-review state.
- Multi-agent workflow timeline: `workflow.created`, `task_graph.created`,
  `subtask.updated`, `evidence.recorded`, and `decision.recorded` events.

For a live-service verification run, use:

```bash
node scripts/verify-multi-agent-real-service.mjs
```

That script starts a real Tik API service, creates a real task, exercises the
workflow APIs over HTTP, records implementation and validation evidence, submits
a real ReviewResult, and writes a report under `.tik/verification/`.

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
