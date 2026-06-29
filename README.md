# Tik

> Observable, Controllable, Convergent Agent Runtime

Tik 是一个 `task-first` 的 agent runtime。  
它保留了清晰的 `Task / Event / Lifecycle` 外部契约，同时在内部使用 `Session`、`SIGHT` 和 `ACE` 驱动多轮执行、上下文管理与收敛判断。

当前版本已经具备：
- 默认交互壳 `tik shell`
- 默认 provider 为 `codex`
- session-based runtime
- Claude / OpenAI / Codex / Codex-Delegate / Mock provider
- continuation-style compact memory
- path-aware search + repo candidate resolution
- Dashboard task timeline
- Linear-like Dashboard workspace / project / task hierarchy
- Workspace SDD control plane (`workspace run/status/report/board/next/retry`)
- Workspace-managed worktree isolation (`worktree list/status/path/create/use/remove`)

## Architecture

```text
User → CLI / Dashboard → API Server → ExecutionKernel
                                          │
                                          ↓
                                       Session
                                          │
                                          ↓
                                      AgentLoop
                                          │
                   ┌──────────────────────┼──────────────────────┐
                   ↓                      ↓                      ↓
             SIGHT Context           Tool Scheduler         ACE Evaluation
      (bootstrap + execution +       (read/write/exec        (fitness +
       conversation memory)             + EventBus)         drift + entropy)
                   └──────────────────────┴──────────────────────┘
                                   EventBus (SSOT)
```

## Key Features

- `Task-first`: 用户提交任务，不是长聊天线程
- `Observable`: 所有关键运行态都通过 EventBus 可见
- `Controllable`: stop / resume / shell control
- `Session-based`: 工具结果会回注到后续 LLM 调用
- `Compact memory`: continuation-style session memory + micro-compaction
- `Pluggable LLM`: `claude` / `openai` / `codex` / `mock`
- `Search discipline`: path-aware glob、scoped grep、repo candidate resolution、shell probe suppression
- `Execution isolation`: workspace 项目默认可切到受管 worktree 执行，源工作区保持干净
- `Workspace hierarchy`: Dashboard 以 Workspace 为顶层，Project 绑定到 Workspace，Task 可绑定到 Workspace 或 Project

## Project Structure

```text
tik/
├── packages/
│   ├── shared/      # 核心类型系统
│   ├── kernel/      # ExecutionKernel + AgentLoop + tools + API server
│   ├── sight/       # Context intelligence + memory + bootstrap + rendering
│   ├── ace/         # Fitness / drift / entropy / convergence
│   ├── cli/         # tik CLI
│   └── dashboard/   # Web dashboard
├── design/baseline.md      # 当前实现基线
├── design/skill-compatibility.md # ~/.agents/skills 与 Tik 的兼容约束
└── design/claw-gap.md
```

## Quick Start

```bash
# install
pnpm install
pnpm build

# 在仓库源码模式运行 CLI（无需全局安装）
pnpm --filter @tik/cli exec node dist/index.js --help

# 默认直接进入 shell
tik

# 单次运行任务
tik run "implement user authentication"   # 默认走 codex

# Claude
export ANTHROPIC_API_KEY=sk-ant-...
tik run "implement user authentication"

# OpenAI / one-api compatible
export OPENAI_API_KEY=...
export OPENAI_BASE_URL=http://127.0.0.1:3000/v1
export TIK_MODEL=gpt-4.1
tik run "implement user authentication" --provider openai

# Codex CLI
codex login
tik run "implement user authentication" --provider codex

# Workspace SDD
tik workspace run --demand "给 service-b 增加缓存并同步 service-a 契约"
tik workspace board
tik workspace next --provider mock
tik workspace run --demand "..." --workflow-profile fast-feedback
tik worktree list
tik worktree create --target service-b --lane feature-a
tik worktree use --target service-b --lane feature-a

# 启动 API Server + Dashboard
tik serve --port 3300 --project /absolute/path/to/workspace-root
pnpm --filter @tik/dashboard dev
```

如果你是直接在本仓库源码里运行（尚未把 `tik` 安装到 PATH），可把上面的 `tik ...` 等价替换为：

```bash
pnpm --filter @tik/cli exec node dist/index.js ...
```

## CLI Overview

### Main Commands

```bash
tik                         # 默认进入 tik shell
tik shell                   # 显式进入交互壳
tik run <description>       # 提交并执行任务
tik plan <description>      # 只生成计划
tik serve                   # 启动 API server
tik sessions                # 列出 CLI session
tik init                    # 初始化 CLAUDE.md / AGENTS.md
tik workspace <subcommand>  # workspace SDD control plane
tik worktree <subcommand>   # workspace-managed worktree lifecycle
```

### Shell Commands

```text
/help
/status
/sessions
/resume <id>
/session list
/session switch <id>
/compact
/cost
/export [file]
/clear --confirm
/memory
/diff
/config [env]
/version
/model [name]
/init [--force]
/exit
```

### Workspace Commands

```text
tik workspace run --demand "..."
tik workspace run --demand "..." --workflow-profile fast-feedback
tik workspace policy
tik workspace policy --workflow-profile deep-verify
tik workspace status [--projects a,b]
tik workspace report [--projects a,b]
tik workspace board [--projects a,b]
tik workspace decisions
tik workspace decide --id <decisionId> [--option <optionId>] [--message "..."]
tik workspace next
tik workspace retry [--projects a,b]
tik workspace clarify
tik workspace specify
tik workspace plan-phase
tik workspace ace
tik workspace feedback --message "..." --projects a,b --next-phase PARALLEL_PLAN
```

### Worktree Commands

```text
tik worktree list
tik worktree status
tik worktree path [--target service-a] [--lane primary]
tik worktree create [--target service-a] [--lane feature-a]
tik worktree use --target service-a --lane feature-a
tik worktree remove [--target service-a] [--lane feature-a] [--force]
```

### Tracker Daemon Commands

`tracker` 是 Tik 在 kernel / workbench / worktree 之上的 Symphony-style 编排层：默认直接读取本地 Workbench Task，把 `todo` / `failed` task 调度给 agent，并把每次执行追加到同一个 task 的 `attempts[]`。JSON 快照仍可用于导入式验证；运行时 source of truth 是本地 Workbench Task。

```text
tik tracker tick [--file tasks.json] [--workflow WORKFLOW.md]
tik tracker watch [--workflow WORKFLOW.md]
```

常用入口：

```bash
# 本地 first run：用 JSON 快照 + mock LLM provider 验证 daemon 调度链路
tik tracker tick --file ./tasks.json --provider mock

# 默认使用 Workbench Task 作为 tracker source，持续轮询 tracker
tik tracker watch --workflow WORKFLOW.md --provider codex
```

`--provider mock` 只 mock LLM provider，不 mock task importer；不传 `--file` 时，任务来源就是本地 Workbench Task。`--file` 会读取 JSON snapshot。`tracker.kind: linear` 不再作为 daemon 运行时来源，运行 `tik tracker *` 时会直接报错，避免外部 tracker 和本地 task 双写。

`WORKFLOW.md` 示例：

```markdown
---
tracker:
  kind: json
  task_file: ./tasks.json
  active_states: [Todo, In Progress]
  terminal_states: [Done, Closed, Canceled, Cancelled]
polling:
  interval_ms: 30000
agent:
  max_concurrent_agents: 3
hooks:
  after_create: |
    echo "created $TIK_TRACKER_TASK_IDENTIFIER"
  before_run: echo "running $TIK_TRACKER_TASK_IDENTIFIER"
  before_remove: echo "removing $TIK_TRACKER_TASK_IDENTIFIER"
---
Implement {{task.shortIdentifier}}: {{task.title}}

{{task.description}}
```

当前 `WORKFLOW.md` 使用 YAML front matter + Liquid 模板渲染。支持 `{{ task.shortIdentifier }}`、`{{ task.title }}`、`{{ task.description }}`、`{{ task.state }}`、`{{ task.sourceUrl }}`、`{{ task.labels }}`、`{{ attempt }}`，也支持 `{% if %}` / `{% for %}` / `join` 之类常见 Liquid 语义。旧的 `{{issue.identifier}}` / `{{issue.url}}` 等变量仍兼容已有 `WORKFLOW.md`，但新配置应使用 `task.*`。

JSON task 快照可用数组或 `{ "tasks": [...] }`；旧 `{ "issues": [...] }` 仍可读取以便迁移：

```json
{
  "tasks": [
    {
      "id": "task-1",
      "shortIdentifier": "TIK-1",
      "title": "Add cache",
      "description": "Implement cache for service-b",
      "state": "Todo",
      "labels": ["backend"],
      "blockedBy": [],
      "repository": { "name": "service-b", "path": "/absolute/path/to/service-b" }
    }
  ]
}
```

JSON task 的 `state` 字段会推断 active / blocked / terminal；`stateKind` 是内部归一化字段，一般不需要写进 snapshot。

运行状态保存在 `<workspace-root>/.tik/tracker-daemon/state.json`。daemon 会按配置限制并发、对失败 dispatch 做指数退避、重启后 reconcile running task、在 task terminal/blocked 时停止对应 run；如果 `cleanup_terminal` 启用，只会清理 `<workspace-root>/.workspace/worktrees/*` 下的受管执行路径。状态文件会持久化 retry queue、watching 状态和 recent activity；`/api/v1/tracker/state` 会直接返回这些值，dashboard 上能看到最近 dispatch / stop / skip / fail 记录。

安全边界：`WORKFLOW.md` 是 trusted configuration。`hooks.*` 会作为 shell 片段通过 `/bin/sh -lc` 执行，并注入 `TIK_TRACKER_TASK_ID`、`TIK_TRACKER_TASK_IDENTIFIER`、`TIK_TRACKER_WORKSPACE_ROOT`、`TIK_TRACKER_PROJECT_PATH` 等环境变量。旧 `TIK_TRACKER_ISSUE_ID` / `TIK_TRACKER_ISSUE_IDENTIFIER` 仍会注入以兼容已有 hook。不要从不可信 PR、task 内容或用户输入生成 hook 字符串；把修改 `WORKFLOW.md` 视为修改 CI/CD 脚本同等级别的权限。

当前语义：
- `run` 初始化 `.workspace/*` 并进入 phase 流程
- workspace 当前默认从 `PARALLEL_CLARIFY` 启动，再进入 `PARALLEL_SPECIFY -> PARALLEL_PLAN -> PARALLEL_ACE`
- `--workflow-profile` 可切换 `balanced / fast-feedback / deep-verify`
- `policy` 可在 bootstrap 之后查看或更新当前 workspace 的策略档位
- `workspace clarify` 会生成 `.workspace/clarifications/<project>/clarify-<n>.md`
- workspace skill 默认从 `~/.agents/skills` 读取；clarify phase 会从 `~/.codex/skills` 读取 superpowers clarifier skill
- 兼容约束见 [skill-compatibility.md](./design/skill-compatibility.md)
- workspace 默认启用 `managed` worktree policy；真实执行路径优先使用 `effectiveProjectPath`
- 默认 worktree 根目录是 `<workspace-root>/.workspace/worktrees`
- 每个项目可保留多个受管 lane，但同一时刻只会有一个 active lane 作为真实 execution path
- 默认 primary lane 分支形如 `tik/<workspace>/<project>`；附加 lane 形如 `tik/<workspace>/<project>--<lane>`
- 非 git 项目默认走 `nonGitStrategy=source`；如需隔离，可切到 `nonGitStrategy=copy`
- worktree 完成后默认保留路径和隔离分支，不自动 merge back 到源工作区
- `next` 按 `currentPhase` 自动续跑
- `decisions` / `decide` 是结构化人机确认入口，适用于范围歧义、方案分歧、phase reroute 与 approval
- decision synthesis 会综合 demand、workflow contract、recent events、clarification artifact、已知 spec/plan artifact 与 memory next-action 生成更可解释的澄清提示
- `retry` 优先复用 feedback 的 `nextPhase + affectedProjects`
- `board` 展示 `Need Human / Replan Required / Healthy / In Flight`，并附带 pending decisions
- `status / board / report` 会展示项目的 `source`、`exec`、`worktree`、`worktree-branch`
- `worktree status` 会显示 lane kind、dirty file 计数、warning，以及 activate/remove 安全提示

典型确认链：

```bash
tik workspace clarify
tik workspace decisions
tik workspace decide --id decision-123 --option use-feature-b --message "按 feature-b 继续"
tik workspace next
```

兼容的自由文本反馈仍保留：

```bash
tik workspace feedback --message "按方案 B 继续" --projects service-a --next-phase PARALLEL_PLAN
```

## Providers

### Claude

可选 provider。支持：
- streaming
- watchdog + timeout fallback
- out-of-order stream fallback
- prompt caching 统计

```bash
export ANTHROPIC_API_KEY=...
tik run "..." --provider claude
```

### OpenAI

支持官方 OpenAI API 和 one-api 这类兼容网关。

```bash
export OPENAI_API_KEY=...
export OPENAI_BASE_URL=http://127.0.0.1:3000/v1
export TIK_MODEL=gpt-4.1
tik run "..." --provider openai
```

### Codex

默认 provider。通过 Codex App Server 复用官方 `codex` 登录态、thread/turn runtime 与原生执行能力。

```bash
codex login
tik run "..." --provider codex
```

当前形态是：
- Tik 负责 task、context、memory、event、dashboard
- Codex App Server 负责原生 agent loop、thread/turn、工具执行与流式事件
- 适合没有 API key、但已登录 ChatGPT/Codex 的环境
- 当前推荐用法：真实业务实现任务优先使用 `--provider codex`

### Codex-Delegate

`codex-delegate` 是原生 Codex 的“完整子任务委托”模式。

```bash
codex login
tik run "review this change and summarize risks" --provider codex-delegate
```

推荐语义：
- `codex`: governed mode，适合当前需要 Tik 更强治理的实现任务
- `codex-delegate`: delegate mode，适合把一个完整子任务交给 Codex 自主跑完，然后由 Tik 做观测、结果接入和治理

当前 `codex-delegate` 更适合作为：
- 只读分析
- 风险评估
- 代码审查
- 完整子任务委托

它不是当前默认的“强实现主路径”。

## Built-in Tools

| Tool | Type | Description |
|------|------|-------------|
| `read_file` | READ | 读取文件 |
| `write_file` | WRITE | 写文件 |
| `edit_file` | WRITE | search & replace 编辑 |
| `glob` | READ | path-aware 文件搜索 |
| `grep` | READ | 内容搜索 |
| `bash` | EXEC | shell 命令，带 guard |
| `git_status` | READ | git 状态 |
| `git_diff` | READ | git diff |
| `git_log` | READ | git 历史 |
| `git_commit` | EXEC | 提交代码 |

### Search / Tool Policy

Tik 当前已经内建一层 `claw-code-main` 风格的搜索纪律：

- 模糊路径补齐：`one-api` 可补齐到真实模块候选
- scoped search：宽泛 `glob/grep` 自动收窄到高概率路径
- path-aware glob：支持 `one-api/**/*`
- `read_file` 目录保护
- `bash cat -> read_file`
- 低价值 shell probe suppression
- `bash find -name` / shell `grep/rg` 在结构化搜索可替代时会被拒绝

## Runtime Semantics

### Task Status

Tik 当前使用这些关键终态：

- `converged`: 达到收敛标准
- `completed`: 证据充分、任务成功结束，但未必达到收敛门槛
- `failed`: 真正失败
- `cancelled`: 被停止

这避免了“分析/定位已完成但未收敛”的任务被误报成 `failed`。

### Session Memory

当前 continuation-style compact memory 会持续跟踪：

- `Goal`
- `Key files`
- `Pending work`
- `Current work`
- `Blockers`
- `Implementation ready`
- `Current focus`

它被用于：
- context rendering
- stopping / completion policy
- exploration → implementation 切换

### Workspace Worktree Isolation

Workspace 模式下，Tik 当前默认使用受管 worktree 作为项目执行隔离层：

- `sourceProjectPath` 永远指向原始仓库路径
- `effectiveProjectPath` 指向当前真正执行用的路径
- git 项目默认会先进入 `primary` lane，必要时可再创建附加 lane，路径形如 `<workspace-root>/.workspace/worktrees/<project>--<lane>`
- 默认分支命名类似 `tik/<workspace>/<project>`；附加 lane 使用 `tik/<workspace>/<project>--<lane>`
- `tik worktree use --lane <id>` 可切换 active lane；后续 phase 会沿 active lane 的 `effectiveProjectPath` 继续执行
- 非 git 项目默认使用 source strategy；切到 `workspace policy --non-git copy` 后，会在 `<workspace-root>/.workspace/worktrees/<project>--<lane>` 下创建受管 copy lane
- 完成后默认保留 worktree 与分支，供后续 review / diff / merge 使用
- `tik worktree remove` 只移除隔离工作树，不自动删除保留分支
- lane 切换和删除带有基本安全门：运行中 lane、带未提交改动的 active lane 默认不会被直接切走或删除

这让 workspace flow 可以在不污染源工作区的前提下产出 `.specify`、代码改动和测试结果。

## Dashboard

Dashboard 当前支持：

- Linear-like 左侧导航：`Workspace -> Projects -> Views`
- workspace/project 作用域切换：Workspace 显示全部 task，Project 只显示绑定到该项目的 task
- task 列表、事件流、execution timeline、artifact review gallery / detail preview
- task 创建时绑定 execution context：`Workspace · <name>` 或 `Project · <name>`
- Universal composer：无当前 task 时按当前 workspace/project scope 创建新 task；从已有 task 分支时继承该 task 的环境与 workspace binding
- artifact gallery 会按 task、kind、producer template 和标题折叠同一逻辑 artifact 的多次运行，侧边栏 badge 与 gallery filter 使用同一组 review counts；`cancelled` / `archived` task 的 artifact 不再进入可操作 review 列表
- artifact detail 支持按 artifact-id/version 预览、accept / reject / archive，并展示 source events、evidence refs、changed files、validation refs 和 risks
- environment pack / skill manifest 视图
- workspace 决策面板、pending decisions 的结构化展示与 resolve
- workspace worktree lane 面板，可直接 create / use / remove lane

workspace 级 control plane 当前主要在 CLI：

- `workspace status`
- `workspace report`
- `workspace board`
- `workspace decisions`
- `workspace decide`
- `worktree list`
- `worktree status`

```bash
tik serve --port 3300 --project /absolute/path/to/workspace-root
pnpm --filter @tik/dashboard dev
```

默认前端地址：

```text
http://localhost:5173
```

Dashboard 本地开发默认把 localhost 前端流量指向 `http://localhost:3300/api`。如果 API server 使用其他端口，可显式指定：

```bash
VITE_API_BASE_URL=http://localhost:3001/api pnpm --filter @tik/dashboard dev
```

### Dashboard Data Model

Dashboard 复用现有 kernel / workbench / worktree 能力，不引入独立任务后端：

- workspace 元数据来自 `GET /api/workspace/status`
- task 列表来自 `GET /api/workbench/tasks`
- artifact review 数据来自 `GET /api/workbench/artifacts`、`GET /api/workbench/tasks/:id/artifacts` 和 `GET /api/workbench/artifacts/:artifactId/versions`
- artifact 预览使用 artifact-id 路由 `GET /api/workbench/artifacts/:artifactId/versions/:versionId/preview`；legacy path preview 仅保留兼容入口
- artifact 操作通过 `POST /api/workbench/artifacts/:artifactId/accept|reject|archive` 写回 workbench timeline，并驱动 task review / completion 状态
- task 执行上下文写入 `workspaceBinding`
- project 列表优先来自 `.code-workspace` settings、workspace memory、worktree entries；单仓库模式下会用 workspace root 生成 fallback project
- scope key 语义为 `workspace` 或 `project:<name>:<path>`

`workspaceBinding` 关键字段：

```json
{
  "workspaceRoot": "/absolute/path/to/workspace",
  "workspaceName": "tik",
  "projectName": "dashboard",
  "sourceProjectPath": "/absolute/path/to/workspace/dashboard",
  "effectiveProjectPath": "/absolute/path/to/workspace/.workspace/worktrees/dashboard--lane",
  "worktreeKind": "git-worktree"
}
```

Workspace decision API：

```text
GET  /api/workspace/status
GET  /api/workspace/board
GET  /api/workspace/report
GET  /api/workspace/memory
GET  /api/workspace/decisions
GET  /api/workspace/worktrees
POST /api/workspace/decisions/:id/resolve
POST /api/workspace/worktrees/create
POST /api/workspace/worktrees/use
POST /api/workspace/worktrees/remove
```

`POST /api/workspace/decisions/:id/resolve` body:

```json
{
  "optionId": "artifact-2",
  "message": "按 feature-b 继续"
}
```

### Comment Slash Commands

Task comments support a small set of slash commands that auto-fire a status
transition immediately after the comment is saved. They turn "leave a note,
then change the status dropdown" into a single action and leave a clean audit
trail in the timeline.

| Keyword (line-anchored) | Status target  | Typical use                       |
| ----------------------- | -------------- | --------------------------------- |
| `/approve`              | `in_progress`  | Unblock a `waiting_for_user` task |
| `/done`                 | `completed`    | Mark a verified task complete     |
| `/retry`                | `todo`         | Re-queue a `failed` / `cancelled` task |
| `/block`                | `blocked`      | Mark blocked, with a note         |
| `/cancel`               | `cancelled`    | Stop a task without retrying      |

Rules:

- Only `human` comments can trigger transitions; `agent` and `system`
  comments are ignored even if they include the same keyword.
- The keyword must be anchored to the start of a line (`/^\s*\/(...)\b/`).
  Mid-paragraph mentions like `see the /done note` do not trigger.
- First match wins when multiple commands appear in one comment.
- If the resulting transition is illegal for the current status (e.g.
  `/done` from `backlog`), the comment still saves and the status stays put;
  no error is raised.

Both the comment and the resulting state transition appear in the task
timeline as separate entries (`Comment added: …`, `Task state changed:
in_progress -> completed. Reason: Marked done via comment by <author>`).

Example:

```text
**Looking good.** Verified the new dashboard binding.

/done
```

After submitting this comment as a human author, the task moves to
`completed`, the green status banner appears in the right rail, and the
acceptance block expands automatically.

The Properties rail textarea exposes the supported keywords inline as a
placeholder. Comments themselves render as Markdown (bold, lists, code
blocks, fenced code, links — raw HTML is filtered for safety).

### Operator Comments in Agent Context

Recent **human** comments are folded into the supervisor's prompt context
on every turn under a dedicated `# Operator Guidance` section. The agent
treats them as authoritative direction without needing a re-prompt.

Budget rules:

- Only `authorKind: 'human'` comments are surfaced. Agent / system comments
  never enter the prompt.
- Most recent 5 comments at most.
- Each body is truncated to 256 chars, total budget 1024 chars; oldest
  entries are dropped first if the total exceeds the cap.

This means a comment like `/done` is visible to the agent *and* fires the
status transition. A longer comment such as `Prioritize the failing
acceptance test before docs` shapes the next turn without changing status.

## Current Position vs claw-code-main

Tik 已经明显补齐了这些高价值能力：

- interactive shell
- session persistence + resume
- compact memory
- bootstrap instructions (`CLAUDE.md` + `AGENTS.md`)
- path-aware search discipline
- provider watchdog / fallback

但仍未完全追平 `claw-code-main` 的部分包括：

- formal permission layer
- richer output modes (`text/json/ndjson`)
- 完整 `/permissions` / `--permission-mode` / `--allowedTools`
- 更成熟的 continuation memory 和 permission-aware runtime

详见：
- [baseline.md](./design/baseline.md)
- [claw-gap.md](./design/claw-gap.md)

## Development

```bash
pnpm --dir packages/shared build
pnpm --dir packages/kernel typecheck
pnpm --dir packages/kernel exec vitest run
pnpm --dir packages/cli build
```

## Notes

- 当前真实 LLM smoke 可能受外部 provider quota / budget 影响
- runtime 的剩余主要差距已经从“找不到代码”转向“权限层和更强的 stop / implementation policy”


## 最新定位

Local-first engineering control plane for coding agents：
用 task/workspace/phase/evidence/convergence 管理 Claude Code、Codex、OpenCode、Cline 等 runner 的执行。

换句话说，Tik 应该成为：

Symphony/Sortie 的 local-first 版本 + AoE 的 session/worktree 能力 + SIGHT/ACE 的收敛判断层。
