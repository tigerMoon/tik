# Tik

Tik is a local-first engineering control plane for coding agents. It keeps work as tasks, runs them through providers such as Codex or Claude, records events/evidence/artifacts, and exposes the same state through CLI, API, and dashboard.

## What Is Here

- Task runtime: `ExecutionKernel`, `AgentLoop`, EventBus, SIGHT context, ACE evaluation.
- Providers: `codex` default, plus `claude`, `openai`, `codex-delegate`, and `mock`.
- Workspace flow: split demand into projects, clarify/spec/plan/execute phases, managed worktree lanes.
- Tracker flow: local Workbench tasks can be dispatched by `tik tracker tick/watch`.
- Dashboard: task timeline, workspace/project views, artifact review, decisions, and worktree lanes.
- Tool safety: file tools and structured `glob`/`grep` resolve paths inside the workspace and reject traversal, absolute escapes, and symlink escapes.

## Project Structure

```text
tik/
├── packages/
│   ├── shared/      # shared types
│   ├── kernel/      # runtime, tools, workspace/tracker logic, API server
│   ├── sight/       # context and memory
│   ├── ace/         # convergence/evaluation
│   ├── cli/         # tik CLI
│   └── dashboard/   # web dashboard
├── codex-skill/     # Tik Claude-review Codex skill
├── claude-plugin/   # Claude Code review plugin
├── design/          # design notes and deeper plans
├── docs/            # supporting docs
└── examples/legacy-mock/ # old mock-provider output examples, not build inputs
```

`mock` provider writes demo implementation output to `src/mock-app.html` or `src/mock-output.ts` in the target project when a task asks it to create code. The root examples above are kept only as reference artifacts.

## Quick Start

```bash
pnpm install
pnpm build

# run from source without installing globally
pnpm --filter @tik/cli exec node dist/index.js --help

# default provider is codex
tik
tik run "implement user authentication" --provider codex

# Claude requires explicit provider selection
export ANTHROPIC_API_KEY=sk-ant-...
tik run "implement user authentication" --provider claude

# OpenAI / one-api compatible
export OPENAI_API_KEY=...
export OPENAI_BASE_URL=http://127.0.0.1:3000/v1
export TIK_MODEL=gpt-4.1
tik run "implement user authentication" --provider openai
```

## Server And Dashboard

`tik serve` defaults to `localhost:3300`, matching the dashboard dev proxy.

```bash
tik serve --project /absolute/path/to/workspace-root
pnpm --filter @tik/dashboard dev
```

Dashboard dev server runs at `http://localhost:5173` and proxies `/api` to `http://localhost:3300`. If the API server uses another port:

```bash
VITE_API_BASE_URL=http://localhost:3001/api pnpm --filter @tik/dashboard dev
```

## CLI Commands

| Command | Status | Purpose |
| --- | --- | --- |
| `tik` / `tik shell` | stable | Interactive shell. |
| `tik run <description>` | stable | Submit and execute a task. |
| `tik plan <description>` | stable | Generate a plan without executing. |
| `tik status [taskId]` | stable | Read task status from the API server. |
| `tik logs <taskId>` | stable | Stream task events from the API server. |
| `tik eval <taskId>` | stable | Show evaluation metrics. |
| `tik stop <taskId>` | stable | Stop a running task. |
| `tik list` | stable | List API-server tasks. |
| `tik sessions` | stable | List saved shell sessions. |
| `tik init` | stable | Scaffold `CLAUDE.md` and `AGENTS.md`. |
| `tik serve` | stable | Start API server, default port `3300`. |
| `tik workspace <subcommand>` | active | Workspace SDD control plane. |
| `tik worktree <subcommand>` | active | Managed workspace worktree lanes. |
| `tik tracker tick/watch` | active | Dispatch local Workbench tasks. |
| `tik workflow init/validate/explain` | active | Manage workflow v2 files. |
| `tik artifacts <subcommand>` | active | List/show/create/review/export artifacts. |
| `tik runs proof` | active | Inspect run proof records. |
| `tik agent list` | internal | Inspect registered agents. |
| `tik update` | internal | Rebuild Tik from source. |

Common workspace commands:

```bash
tik workspace run --demand "给 service-b 增加缓存并同步 service-a 契约"
tik workspace board
tik workspace next --provider codex
tik workspace decisions
tik workspace decide --id <decisionId> --option <optionId>

tik worktree list
tik worktree create --target service-b --lane feature-a
tik worktree use --target service-b --lane feature-a
```

Tracker and workflow commands:

```bash
tik tracker tick --provider mock
tik tracker watch --workflow WORKFLOW.md --provider codex

tik workflow init --v2
tik workflow validate --file WORKFLOW.md
tik workflow explain <task-id> --file WORKFLOW.md
```

Artifact and proof commands:

```bash
tik artifacts list
tik artifacts show <artifactId>
tik artifacts accept <artifactId> --message "looks good"
tik artifacts reject <artifactId> --reason "missing tests"
tik artifacts export <artifactId> --out ./artifact.html

tik runs proof <runId>
tik runs proof --task <taskId>
```

## Providers

- `codex`: default governed implementation path, requires logged-in Codex CLI.
- `codex-delegate`: full delegated Codex subtask mode, useful for review/analysis/handoff runs.
- `claude`: Anthropic API via `ANTHROPIC_API_KEY`.
- `openai`: OpenAI-compatible API via `OPENAI_API_KEY`, optional `OPENAI_BASE_URL`, `TIK_MODEL`.
- `mock`: deterministic local provider for tests and demos.

## Built-In Tools

| Tool | Type | Notes |
| --- | --- | --- |
| `read_file` | read | Workspace-safe file read. |
| `write_file` | write | Workspace-safe write with parent creation. |
| `edit_file` | write | Workspace-safe exact replacement. |
| `glob` | read | Path-aware search; safe cwd resolution. |
| `grep` | read | Scoped content search; safe path resolution. |
| `bash` | exec | Guarded shell execution. |
| `git_status` / `git_diff` / `git_log` / `git_commit` | read/exec | Git helpers. |

Structured search auto-scopes broad `glob`/`grep` calls when the task has likely target paths. Search roots still must resolve inside the workspace.

## Development

```bash
pnpm --dir packages/shared build
pnpm --dir packages/kernel typecheck
pnpm --dir packages/kernel exec vitest run
pnpm --dir packages/cli typecheck
pnpm --dir packages/cli build
```

Current focused docs:

- [QUICKSTART.md](./QUICKSTART.md)
- [design/baseline.md](./design/baseline.md)
- [design/claw-gap.md](./design/claw-gap.md)
- [design/skill-compatibility.md](./design/skill-compatibility.md)
