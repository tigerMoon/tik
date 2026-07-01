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
- Return a structured final review result to the prompt/output path requested by Tik.

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
