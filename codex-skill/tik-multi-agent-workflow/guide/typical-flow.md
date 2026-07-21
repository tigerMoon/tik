# Typical Flow

Commands you run in order for a normal implementation-mode workflow, top to bottom.

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

# ---
# If the evaluator returns `fail`, the subtask lands in `evaluation_failed`.
# The sanctioned recovery is a single `fix-evaluation` call — it records the
# fix_evaluation_findings decision AND atomically transitions the subtask to
# `needs_fix` in one round-trip. `execute_subtask` accepts `needs_fix`, so the
# next execute is legal.
#
#   node codex-skill/tik-multi-agent-workflow/scripts/tik-multi-agent-workflow.mjs fix-evaluation \
#     --workflow wf_123 --subtask st_001 --reason "address ac-3 gap"
#   node codex-skill/tik-multi-agent-workflow/scripts/tik-multi-agent-workflow.mjs execute \
#     --workflow wf_123 --subtask st_001 --invocation inv-builder-st_001-v2 --summary "..."

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

## Readonly Review Flow

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
