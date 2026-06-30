---
name: review-tik-agent-loop
description: Use when Claude Code is launched by Tik to review a Tik claude_review work item and submit ReviewResult JSON back to Tik.
---

# Review Tik Agent Loop

Use this skill only as the Claude Code side of a Tik-owned workflow. Tik selects the task, launches Claude Code, provides the prompt/context, and owns state transitions.

## Contract

You are the reviewer worker for the Tik Workbench task named in the current prompt.

Do:
- Read the selected Tik task from `GET ${TIK_API_BASE_URL:-http://127.0.0.1:3300/api}/v1/tasks` if the prompt does not include all needed fields.
- Review exactly the recorded `task.agentLoop.headSha`.
- Use the repository path provided by Tik's runtime prompt.
- Compare the recorded head SHA with `git -C <path> rev-parse HEAD`.
- If HEAD differs, call `POST /v1/agent-loop/tasks/:id/stale` with `{ "expectedHeadSha": "...", "actualHeadSha": "..." }` and stop.
- Submit only the Tik `ReviewResult` object to `POST /v1/agent-loop/tasks/:id/review-result`.

Do not:
- Edit files.
- Commit, push, merge, or approve externally.
- Call GitHub/GitLab review APIs.
- Claim tasks or choose another task from the board.
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
