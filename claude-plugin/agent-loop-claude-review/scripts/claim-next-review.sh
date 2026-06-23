#!/usr/bin/env bash
set -euo pipefail

base_url="${TIK_API_BASE_URL:-http://127.0.0.1:3300/api}"

curl -sS "$base_url/v1/tasks" \
  | node -e '
const fs = require("node:fs");
const payload = JSON.parse(fs.readFileSync(0, "utf8"));
const claimableStatuses = new Set(["todo", "in_progress", "running"]);
const task = (payload.tasks || []).find((item) =>
  claimableStatuses.has(item.status)
  && item.agentLoop?.kind === "claude_review"
  && ((item.labels || []).includes("needs-claude-review") || (item.labels || []).includes("claude-review"))
);
if (!task) {
  console.error("No claimable Tik claude_review task found.");
  process.exit(1);
}
process.stdout.write(JSON.stringify(task, null, 2));
'
