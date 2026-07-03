# Tik Multi-Agent Workflow Skill

Codex-side driver for Tik multi-agent workflows.

This skill lets Codex drive implementation decisions while Tik stores durable
workflow state, TaskGraph plans, subtask state, evidence, evaluator/questioner
runs, guard decisions, and Dashboard-visible audit history.

## Capability Summary

| Command | Capability | Tik records |
| --- | --- | --- |
| `init` | Create a multi-agent workflow for a repo/worktree and pin the current head. | `MultiAgentWorkflowRecord` with goal, root task, refs, head SHA, workspace binding. |
| `plan` | Request a Claude planner invocation through Tik. When the planner invocation completes with `taskGraph`, Tik may store that planner output as a draft. | `request_dynamic_plan` decision plus planner `AgentInvocationRecord` and draft TaskGraph writeback when available. |
| `accept-plan` | Explicitly accept a reviewed or edited TaskGraph as the active workflow graph. | TaskGraph plus initialized subtask run states. |
| `next` | Compute the next local Codex policy action from Tik state. | Guarded `WorkflowDecision`. |
| Contract APIs | Store and accept per-subtask SprintContracts before build when v1 policy requires it. | `SprintContract` history and contract events. |
| `execute` | Record Codex implementation evidence for a subtask. | Implementation evidence, subtask state, validation decision. |
| Evaluation APIs | Record isolated Codex Evaluator runs, results, artifacts, and readonly validation. | `EvaluationRun`, `CodexEvaluationResult`, readonly guard result. |
| Questioner APIs | Store Claude plugin Questioner outputs for contract, evaluation, and final evidence challenges. | `QuestionerOutput` records with source, head SHA, artifact refs, and timeline events. |
| `validate` | Run a validation command and persist the result. | Validation evidence, pass/fail state, next evaluator/build decision. |
| `start-evaluator` / `evaluate` | Record isolated Codex Evaluator runs, results, artifacts, and readonly validation. | `EvaluationRun`, `CodexEvaluationResult`, readonly guard result. |
| `start-questioner` / `record-questioner` | Store Claude plugin Questioner outputs for contract, evaluation, and final evidence challenges. | `QuestionerOutput` records with source, head SHA, artifact refs, and timeline events. |
| `complete-subtask` | Complete a subtask after v1 evidence gates pass. | Guarded `complete_subtask` decision and `done` state. |
| `complete-workflow` | Complete the workflow after final evaluator/questioner gates pass. | Guarded `complete_workflow` decision. |
| `continue` | Advance safe automated steps such as planning request, contract draft/accept, validation, and v1 runtime launch preparation. | The corresponding guarded decision and Tik mutation for the safe step. |
| `status` | Inspect workflow state, counts, and recent timeline for Dashboard/CLI cross-checks. | No mutation. |

## Workflow Shape

```text
Codex skill
  -> Tik multi-agent workflow APIs
  -> Tik guardrails and evidence store
  -> Tik-owned Claude planner/questioner task when needed
  -> Codex inspects results and records the next decision
```

Codex owns implementation and policy decisions. Tik owns persistence,
guardrails, runtime launch, state transitions, and the Dashboard-visible
history. Claude Code planner/questioner output is treated as input, not as an
automatic authority.

When a workflow policy enables the v1 Codex Evaluator / Claude Questioner gates,
the core loop is:

```text
accepted SprintContract
  -> Codex Builder implementation evidence
  -> isolated readonly Codex Evaluator pass
  -> Claude Questioner no blocking evidence questions
  -> complete_subtask
  -> final Codex evaluation
  -> final Claude Questioner no blocking questions
  -> complete_workflow
```

Builder and Evaluator invocations must be attested by Tik server-verified
Codex hook facts. Tik issues a one-time `attestationToken` when an invocation is
created; the token is not printed by the main workflow CLI. The Codex subagent
hook must call `hook-start` and `hook-stop` with that token, a nonce, the parent
thread id, the actual subagent thread id, and the role. Hand-filled thread ids or
CLI-provided `runtimeAttestation` payloads are stored only as audit metadata and
do not satisfy `complete_subtask`.

Evaluator commands run in a throwaway git worktree by default. The readonly git
status check remains as an audit layer, while the sandbox prevents source writes
from targeting the main worktree. Evaluation artifacts are copied to
`.tik/multi-agent/`, `test-results/`, `playwright-report/`, `coverage/`, or
other explicitly allowed artifact paths.

## Typical Use

Plan acceptance is explicit: a Claude planner invocation can produce a TaskGraph
draft, but Codex must inspect/edit it and call `accept-plan` before subtasks run.

### V1 Evaluator / Questioner Loop

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

node codex-skill/tik-multi-agent-workflow/scripts/tik-multi-agent-workflow.mjs draft-contract \
  --workflow <workflow-id> \
  --subtask <subtask-id> \

node codex-skill/tik-multi-agent-workflow/scripts/tik-multi-agent-workflow.mjs accept-contract \
  --workflow <workflow-id> \
  --subtask <subtask-id> \
  --contract <contract-id>

node codex-skill/tik-multi-agent-workflow/scripts/tik-multi-agent-workflow.mjs start-builder \
  --workflow <workflow-id> \
  --subtask <subtask-id> \
  --invocation inv-builder-<subtask-id> \
  --parent-thread <workflow-thread-id> \
  --thread <builder-codex-thread-id>

node codex-skill/tik-multi-agent-workflow/scripts/tik-multi-agent-workflow.mjs execute \
  --workflow <workflow-id> \
  --subtask <subtask-id> \
  --summary "Implemented the scoped change." \
  --invocation inv-builder-<subtask-id> \
  --attestation-token <token-from-codex-hook-runtime>

node codex-skill/tik-multi-agent-workflow/scripts/tik-multi-agent-workflow.mjs start-evaluator \
  --workflow <workflow-id> \
  --subtask <subtask-id> \
  --invocation inv-evaluator-<subtask-id> \
  --parent-thread <workflow-thread-id> \
  --thread <evaluator-codex-thread-id>

node codex-skill/tik-multi-agent-workflow/scripts/tik-multi-agent-workflow.mjs evaluate \
  --workflow <workflow-id> \
  --subtask <subtask-id> \
  --command "pnpm test" \
  --invocation inv-evaluator-<subtask-id> \
  --attestation-token <token-from-codex-hook-runtime>

node codex-skill/tik-multi-agent-workflow/scripts/tik-multi-agent-workflow.mjs record-questioner \
  --workflow <workflow-id> \
  --subtask <subtask-id> \
  --intent question_evaluation \
  --invocation <claude-questioner-invocation-id> \
  --head-sha <head-sha> \
  --contract <contract-id> \
  --evaluation <evaluation-run-id> \
  --artifact-ref <questioner-output-artifact>

node codex-skill/tik-multi-agent-workflow/scripts/tik-multi-agent-workflow.mjs complete-subtask \
  --workflow <workflow-id> \
  --subtask <subtask-id>

node codex-skill/tik-multi-agent-workflow/scripts/tik-multi-agent-workflow.mjs evaluate \
  --workflow <workflow-id> \
  --subtask __final__ \
  --evaluation <final-evaluation-run-id> \
  --command "pnpm test"

node codex-skill/tik-multi-agent-workflow/scripts/tik-multi-agent-workflow.mjs record-questioner \
  --workflow <workflow-id> \
  --intent question_final_evidence \
  --invocation <claude-questioner-invocation-id> \
  --head-sha <head-sha> \
  --evaluation <final-evaluation-run-id> \
  --artifact-ref <final-questioner-output-artifact>

node codex-skill/tik-multi-agent-workflow/scripts/tik-multi-agent-workflow.mjs complete-workflow \
  --workflow <workflow-id>

node codex-skill/tik-multi-agent-workflow/scripts/tik-multi-agent-workflow.mjs status \
  --workflow <workflow-id>
```

Use `--api-base-url` or `TIK_API_BASE_URL` when Tik is not running at
`http://127.0.0.1:3300/api`.

## Dashboard Evidence

A real workflow run should leave evidence in both places:

- Dashboard/task comments and timeline: task creation, state transitions,
  evaluator/questioner launch, evidence recording, and completion state.
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
strict v1 QuestionerOutputV2 for subtask and final gates, and writes a report
under `.tik/verification/`.

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
- Each subtask follows the v1 contract -> build -> evaluate -> question -> complete loop.
- Each subtask requires an accepted `SprintContract`, same-head
  implementation/evaluation evidence, hook-attested isolated Builder and
  Evaluator subagent invocations, readonly evaluator sandbox/audit validation,
  full must acceptance-criteria coverage, real command/artifact/reproduction
  evidence, and no blocking `question_evaluation` output from the Claude plugin.
- Claude Questioner blocking findings route back to `fix_evaluation_findings`.
- `complete_subtask` is guarded by Codex Evaluator plus Claude Questioner evidence gates.
- After all subtasks are `done`, the workflow must run final evaluation and final Questioner.
- `complete_workflow` is guarded by final Codex evaluation that covers every global must criterion,
  passes every final validation command, has no coverage gaps, and matches
  `question_final_evidence` output.
- Tik exposes action APIs such as `record-implementation`,
  `record-evaluation-result`, `record-questioner-output`, `complete-subtask`,
  and `complete-workflow` so higher-level drivers can submit guarded mutations
  as one server-owned action instead of stitching multiple API calls together.
- Preflight/action guard rejection prevents partial state mutation for unsafe commands.
- CLI `status` and the Dashboard timeline expose the workflow event history.

When validating the currently running Dashboard service instead of a temporary
server, create the task against the active `TIK_API_BASE_URL` so the task appears
in the current Dashboard workspace.

## Boundaries

Do:

- keep all decisions recorded through Tik workflow APIs;
- use Tik invocations/runs for Claude planner/questioner work;
- inspect Claude output before applying fixes;
- keep code edits in the current Codex session unless a future CodexRunner path
  is explicitly added.

Do not:

- let Tik core choose the next Codex policy action;
- call Claude directly for canonical workflow questioning;
- let Claude Code edit files, commit, push, or claim arbitrary tasks;
- auto-merge or bypass human/project policy.
