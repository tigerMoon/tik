# Workspace Binding Examples

Single-repo workspace:

```bash
tik serve --host 127.0.0.1 --port 3300 --project /Users/me/repo

node codex-skill/tik-multi-agent-workflow/scripts/tik-multi-agent-workflow.mjs init \
  --api-base-url http://127.0.0.1:3300/api \
  --goal "review and fix current branch" \
  --workspace-root /Users/me/repo \
  --path /Users/me/repo \
  --repo repo \
  --base main
```

Workspace root with managed worktree:

```bash
tik serve --host 127.0.0.1 --port 64777 --project /Users/me/merchant-workspace

node codex-skill/tik-multi-agent-workflow/scripts/tik-multi-agent-workflow.mjs init \
  --api-base-url http://127.0.0.1:64777/api \
  --goal "review C2C RESELL shop-id changes" \
  --workspace-root /Users/me/merchant-workspace \
  --path /Users/me/merchant-workspace/worktrees/mall-merchant-c2c-shop-id \
  --repo mall-merchant \
  --source-path /Users/me/merchant-workspace/projects/mall-merchant \
  --worktree-kind git-worktree \
  --lane c2c-shop-id \
  --base origin/feature/funding-web-controller-switch \
  --head-ref feature/c2c-shop-id
```

Dashboard will show the root task in the workspace served by `--api-base-url`.
If a workflow appears in the "Multi-agent workflows" list but not in "Tasks by
progress", run the root-task repair endpoint through that same API before
continuing:

```bash
curl -X POST \
  http://127.0.0.1:64777/api/v1/multi-agent/workflows/<workflow-id>/root-task/repair
```

## Recovering from binding errors

If `init` fails with `invalid_workspace_binding`, **do not retry by dropping
`--workspace-root` / `--source-path` / `--worktree-kind` / `--lane`**. Those
fields are the workspace identity — silently stripping them binds the workflow
to the wrong API server's project root. Instead:

1. Start (or choose) the Tik API server whose `--project` equals the intended
   workspace root.
2. Point `--api-base-url` at that server.
3. Retry `init` with the same binding fields.

## --root-task

`init` creates the workflow root workbench task automatically (task id equals
the workflow id). Pass `--root-task <id>` **only** to bind to an existing
workbench task; do not synthesize an id, or the Dashboard entry will never
appear under "Tasks by progress" and the `root-task/repair` endpoint above
becomes the only recovery.


## Discovery Behavior

`init` discovers open workflows on this workspace before creating a new one:

- **Zero matches** — creates a new workflow.
- **Exactly one non-stale match** — reuses it; emits `reusedWorkflow: true`.
- **Multiple non-stale matches** — refuses with `ambiguous_open_workflows`. Pass `--workflow <id>` to pick, or `--force-new` (alias `--no-reuse-if-open`) to bypass discovery.

The filter matches on `workspaceRoot`, `effectiveProjectPath`, `repo`, `mode`,
and `headRef`. Stale candidates (`metadata.staleAt` set by the kernel's
stale-detector, or `metadata.pausedAt` set by `pause-workflow`) are excluded
from reuse — you must `abandon-workflow` or explicitly `--workflow <id>` them.
