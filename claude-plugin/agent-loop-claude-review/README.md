# Agent Loop Claude Review Plugin

Claude Code plugin for Tik-native review loop tasks.

Install or load this plugin in Claude Code so Tik can launch Claude Code with the `review-tik-agent-loop` skill. Tik selects the Workbench task, verifies and provides the review context, and owns state transitions; the plugin only reviews the provided task and posts `ReviewResult` JSON back to Tik.

## Install

From this repository:

```bash
claude plugin marketplace add /Users/huyuehui/ace/tik/claude-plugin --scope user
claude plugin install agent-loop-claude-review@tik-local --scope user
```

Validate and inspect:

```bash
claude plugin validate /Users/huyuehui/ace/tik/claude-plugin
claude plugin list
claude plugin details agent-loop-claude-review
```

Start a new Claude Code session after installing so the `review-tik-agent-loop` skill is available.

## Runtime

Default Tik API base:

```bash
export TIK_API_BASE_URL=http://127.0.0.1:3300/api
```

Tik launches Claude Code through its own runtime. These environment variables tune that launch path:

```bash
export TIK_CLAUDE_CODE_PLUGIN_DIRS=/Users/huyuehui/ace/tik/claude-plugin/agent-loop-claude-review
export TIK_CLAUDE_CODE_ADD_DIRS=/Users/huyuehui/ace/tik
export TIK_CLAUDE_CODE_PERMISSION_MODE=bypassPermissions
```

The plugin does not claim tasks on its own. The normal flow is:

```text
Codex skill -> Tik API -> claude-code runtime -> review-tik-agent-loop -> Tik ReviewResult API
```

Optional task lookup for debugging:

```bash
bash claude-plugin/agent-loop-claude-review/scripts/claim-next-review.sh
```
