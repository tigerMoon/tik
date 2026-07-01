---
name: plan-tik-agent-loop
description: Use when Claude Code is launched by Tik as a read-only planner to produce a TaskGraph for a Tik multi-agent workflow.
---

# Plan Tik Agent Loop

Use this skill only as the Claude Code side of a Tik-owned planning invocation. Tik selects the workflow and provides context. Codex workflow decides whether to accept, edit, reject, or replan from your output.

## Contract

Do:
- Read the selected workflow from `GET ${TIK_API_BASE_URL:-http://127.0.0.1:3300/api}/v1/multi-agent/workflows/:workflowId` if needed.
- Inspect the repository only to understand scope.
- Return a `TaskGraph` object that Codex can store with `PUT /v1/multi-agent/workflows/:workflowId/task-graph`.
- Keep subtasks bounded, dependency-aware, and assigned to Codex execution plus Claude Code review.

Do not:
- Edit files.
- Commit, push, merge, or claim tasks.
- Decide the next workflow action after planning.
- Post review results or mark work complete.

## TaskGraph JSON

Return JSON matching:

```json
{
  "workflowId": "wf_123",
  "version": 1,
  "createdBy": "claude-code",
  "subtasks": [
    {
      "id": "st_001",
      "title": "Focused title",
      "goal": "What Codex should implement.",
      "dependsOn": [],
      "allowedPaths": ["packages/kernel/src"],
      "blockedPaths": [],
      "acceptanceCriteria": ["Observable behavior or contract to satisfy."],
      "validationCommands": ["pnpm --filter @tik/kernel test"],
      "reviewFocus": ["Specific risk for Claude review."],
      "expectedChangedFiles": [],
      "assignedExecutor": "codex",
      "assignedReviewer": "claude-code"
    }
  ],
  "risks": ["Important implementation risk."],
  "globalAcceptanceCriteria": ["End-to-end requirement."],
  "finalValidationCommands": ["pnpm test"]
}
```

## Output To User

Report the TaskGraph JSON and a short note that Codex workflow must decide whether to accept it.
