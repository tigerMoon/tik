# Agent Loop Claude Review Plugin

Claude Code plugin for Tik-native review loop tasks.

Install or load this plugin in Claude Code, then ask Claude Code to use the `review-tik-agent-loop` skill. The skill claims a Tik Workbench task in the `needs-claude-review` phase, verifies the recorded `headSha`, reviews the bound worktree, and posts `ReviewResult` JSON back to the same Tik task.

Default Tik API base:

```bash
export TIK_API_BASE_URL=http://127.0.0.1:3300/api
```

Quick task lookup:

```bash
bash claude-plugin/agent-loop-claude-review/scripts/claim-next-review.sh
```
