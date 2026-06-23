---
name: review-tik-agent-loop
description: Review Tik-native claude_review work items from Workbench and submit ReviewResult JSON back to Tik.
---

# Review Tik Agent Loop

Use this skill when asked to review a Tik agent-loop task, review the current worktree through Tik, or close a Tik `claude_review` work item.

## Contract

You are the reviewer worker for Tik Workbench tasks whose `agentLoop.kind` is `claude_review`.

Do:
- Read the selected Tik task from `GET ${TIK_API_BASE_URL:-http://127.0.0.1:3300/api}/v1/tasks`.
- Select a task with `status=todo`, `status=in_progress`, or `status=running`, label `needs-claude-review` (or legacy `claude-review`), and `agentLoop.kind=claude_review`.
- Review exactly `task.agentLoop.headSha`.
- Use `task.workspaceBinding.effectiveProjectPath` as the repository path.
- Compare the recorded head SHA with `git -C <path> rev-parse HEAD`.
- If HEAD differs, call `POST /v1/agent-loop/tasks/:id/stale` with `{ "expectedHeadSha": "...", "actualHeadSha": "..." }` and stop.
- Submit only the Tik `ReviewResult` object to `POST /v1/agent-loop/tasks/:id/review-result`.

Do not:
- Edit files.
- Commit, push, merge, or approve externally.
- Call GitHub/GitLab review APIs.
- Review a moving target if the current HEAD differs from `agentLoop.headSha`.

## ReviewResult JSON

The body sent to Tik must match:

```json
{
  "verdict": "request_changes",
  "headShaReviewed": "abc123",
  "currentHeadSha": "abc123",
  "blockingIssues": [
    {
      "title": "Short issue title",
      "file": "relative/path.ts",
      "line": 42,
      "reason": "Why this blocks merge or acceptance.",
      "suggestedFix": "Concrete fix direction."
    }
  ],
  "nonBlockingSuggestions": [
    {
      "title": "Optional improvement",
      "file": "relative/path.ts",
      "line": 7,
      "reason": "Why this is useful but not blocking."
    }
  ],
  "testsNeeded": ["Focused test or verification still needed."],
  "markdown": "Human-readable review summary.",
  "reviewerWorkerId": "claude-code"
}
```

Use `verdict=approve` only when there are zero blocking issues. Use `verdict=request_changes` when `blockingIssues` is non-empty. Use `verdict=comment` for non-blocking feedback without approval.

## Suggested Commands

```bash
export TIK_API_BASE_URL="${TIK_API_BASE_URL:-http://127.0.0.1:3300/api}"
curl -sS "$TIK_API_BASE_URL/v1/tasks"
git -C "<effectiveProjectPath>" rev-parse HEAD
git -C "<effectiveProjectPath>" diff --stat HEAD~1..HEAD
git -C "<effectiveProjectPath>" diff --find-renames HEAD~1..HEAD
curl -sS -X POST "$TIK_API_BASE_URL/v1/agent-loop/tasks/<taskId>/review-result" \
  -H 'Content-Type: application/json' \
  --data-binary @review-result.json
```

If `task.agentLoop.changeRequest.baseRef` is available, prefer:

```bash
git -C "<effectiveProjectPath>" diff --find-renames "<baseRef>..<headSha>"
```

## Output To User

After submitting, report:
- Tik task id and short identifier.
- Reviewed head SHA.
- Verdict.
- Number of blocking issues.
- The next Tik task kind returned by the API, if any.
