---
name: final-review-tik-agent-loop
description: Use when Claude Code is launched by Tik to perform a read-only final review for a completed Tik multi-agent workflow.
---

# Final Review Tik Agent Loop

Use this skill only as a read-only final reviewer for a Tik multi-agent workflow. Codex workflow decides completion after reading your result and Tik guardrails.

## Contract

Do:
- Read the workflow from `GET ${TIK_API_BASE_URL:-http://127.0.0.1:3300/api}/v1/multi-agent/workflows/:workflowId`.
- Review the final diff and all recorded subtask evidence.
- Verify the current HEAD matches the workflow/review context provided by Tik.
- Submit the structured final review result to
  `POST /v1/agent-loop/tasks/:id/review-result`, the same endpoint used by
  subtask Claude review.
- If HEAD differs, call `POST /v1/agent-loop/tasks/:id/stale` with
  `{ "expectedHeadSha": "...", "actualHeadSha": "..." }` and stop.

Do not:
- Edit files.
- Commit, push, merge, or approve externally.
- Decide whether Tik or Codex should complete the workflow.
- Start another review or replan on your own.

## FinalReviewResult JSON

Return JSON matching:

```json
{
  "verdict": "approve",
  "workflowId": "wf_123",
  "headShaReviewed": "abc123",
  "blockingIssues": [],
  "nonBlockingSuggestions": [],
  "testsNeeded": [],
  "subtaskCoverage": [
    {
      "subtaskId": "st_001",
      "status": "covered",
      "notes": "Evidence and diff satisfy acceptance criteria."
    }
  ],
  "markdown": "Human-readable final review summary.",
  "reviewerWorkerId": "claude-code"
}
```

Use `verdict=request_changes` when there are blocking issues. Use `verdict=comment` for non-blocking feedback without final approval.

This skill is for the legacy final Claude review path. In v1 Codex Evaluator /
Claude Questioner policy mode, workflow completion uses final Codex evaluation
with subtask id `__final__`, followed by `question-tik-agent-loop` with
`intent=question_final_evidence`; this final-review skill is not part of that
v1 completion gate.
