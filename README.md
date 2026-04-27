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
├── baseline.md      # 当前实现基线
├── skill-compatibility.md # ~/.agents/skills 与 Tik 的兼容约束
├── tik_cli_alignment.md
└── claw-gap.md
```

## Quick Start

```bash
# install
pnpm install
pnpm build

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
tik serve --port 3001 --project /absolute/path/to/workspace-root
pnpm --filter @tik/dashboard dev
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

当前语义：
- `run` 初始化 `.workspace/*` 并进入 phase 流程
- workspace 当前默认从 `PARALLEL_CLARIFY` 启动，再进入 `PARALLEL_SPECIFY -> PARALLEL_PLAN -> PARALLEL_ACE`
- `--workflow-profile` 可切换 `balanced / fast-feedback / deep-verify`
- `policy` 可在 bootstrap 之后查看或更新当前 workspace 的策略档位
- `workspace clarify` 会生成 `.workspace/clarifications/<project>/clarify-<n>.md`
- workspace skill 默认从 `~/.agents/skills` 读取；clarify phase 会从 `~/.codex/skills` 读取 superpowers clarifier skill
- 兼容约束见 [skill-compatibility.md](/Users/huyuehui/ace/tik/skill-compatibility.md)
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

- task 列表与事件流
- execution timeline
- workspace 决策面板
- pending decisions 的结构化展示与 resolve
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
tik serve --port 3001
pnpm --filter @tik/dashboard dev
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

默认前端地址：

```text
http://localhost:5173
```

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
- [baseline.md](/Users/huyuehui/ace/tik/baseline.md)
- [tik_cli_alignment.md](/Users/huyuehui/ace/tik/tik_cli_alignment.md)
- [claw-gap.md](/Users/huyuehui/ace/tik/claw-gap.md)

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
