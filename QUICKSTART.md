# Tik Quick Start

Tik 是一个 `task-first` 的 agent runtime，默认通过 `tik shell` / `tik run` 执行任务，默认 provider 是 `codex`。

如果你只想先跑起来，记住这 3 条就够了：

1. 单项目任务：优先用 `tik` 或 `tik run "..."`
2. 真正要改代码：优先用 `--provider codex`
3. 多项目需求拆解与推进：用 `tik workspace ...`

## 1. 安装与构建

在仓库根目录执行：

```bash
cd /Users/huyuehui/ace/tik
pnpm install
pnpm build
```

如果你希望直接用 `tik` 命令，确保本地已经把 CLI 暴露到 PATH，或者从已安装的包环境里运行。

## 2. 最短上手路径

### 进入交互壳

```bash
tik
```

等价写法：

```bash
tik shell
tik shell --project /absolute/path/to/project
```

适合：
- 连续多轮交互
- 查看 session
- 在同一个项目里持续推进任务

### 执行一个单次任务

```bash
tik run "create a hello world app"
```

常见变体：

```bash
# Mock 模式，适合本地链路验证
tik run "add logging system" --mock

# 指定策略和最大迭代次数
tik run "add logging system" --strategy defensive --max-iterations 3

# 只生成计划，不执行
tik plan "refactor database layer"
```

## 3. Provider 选择

Tik 当前支持 `claude`、`openai`、`codex`、`codex-delegate`、`mock`。

### `codex`

默认 provider，也是当前最推荐的真实业务实现路径。

```bash
codex login
tik run "给票务查询接口做缓存" --provider codex
```

适合：
- 真正改代码
- 真实业务 patch
- 希望复用本机 `codex login` 登录态

### `codex-delegate`

把一个完整子任务交给 Codex 处理，再由 Tik 接入结果。

```bash
codex login
tik run "review this change and summarize risks" --provider codex-delegate
```

适合：
- 只读分析
- 风险评估
- 代码审查
- 完整子任务委托

### `claude`

```bash
export ANTHROPIC_API_KEY=...
tik run "implement user authentication" --provider claude
```

适合：
- 已有 Anthropic API key
- 希望走 API provider

### `openai`

支持官方 OpenAI API 和兼容网关。

```bash
export OPENAI_API_KEY=...
export OPENAI_BASE_URL=http://127.0.0.1:3000/v1
export TIK_MODEL=gpt-4.1
tik run "implement user authentication" --provider openai
```

### `mock`

```bash
tik run "implement user authentication" --mock
```

适合：
- 调试 CLI 链路
- 不依赖真实模型验证流程

## 4. 单项目 CLI 常用命令

```bash
tik                         # 默认进入 tik shell
tik shell                   # 显式进入交互壳
tik run <description>       # 提交并执行任务
tik plan <description>      # 只生成计划
tik sessions                # 列出 shell session
tik init                    # 初始化 CLAUDE.md / AGENTS.md
tik serve                   # 启动 API server
tik workspace <subcommand>  # Workspace SDD control plane
```

### Shell 内置命令

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

## 5. Workspace SDD 最小示例

当需求跨多个项目时，优先走 `workspace`：

```bash
tik workspace run --demand "给 service-b 增加缓存并同步 service-a 契约"
tik workspace board
tik workspace next --provider mock
tik workspace status
```

如果你想直接切换 workspace 策略档位：

```bash
tik workspace run --demand "..." --workflow-profile fast-feedback
```

可选 profile：

- `balanced`
- `fast-feedback`
- `deep-verify`

常用子命令：

```bash
tik workspace run --demand "..."
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

### Workspace-managed worktrees

Tik 现在会把 workspace 项目的真实执行路径收口到 `effectiveProjectPath`。默认 policy 是 `managed`，也就是：

- 源仓库路径保留为 `sourceProjectPath`
- git 项目执行 phase 时优先在 `<workspace-root>/.workspace/worktrees/<project>` 的 active lane 里跑
- 每个项目可以保留多个 lane，但同一时刻只有一个 active lane 会成为 `effectiveProjectPath`
- 默认保留隔离分支与 worktree，不自动 merge back
- 非 git 项目默认使用 `nonGitStrategy=source`，需要隔离时可切到 `nonGitStrategy=copy`

常用命令：

```bash
tik worktree list
tik worktree status
tik worktree path --target service-a --lane primary
tik worktree create --target service-a --lane feature-a
tik worktree use --target service-a --lane feature-a
tik worktree remove --target service-a --lane feature-a --force
```

看状态时，你会在 `workspace status / board / report` 里看到：

- `source`
- `exec`
- `worktree`
- `worktree-branch`

当前语义：

- `run` 初始化 `.workspace/settings.json`、`.workspace/state.json`、`.workspace/split-demands.json`
- workspace 默认从 `PARALLEL_CLARIFY` 开始；先做 clarify gating，再进入 `specify -> plan -> ace`
- `policy` 查看或更新当前 workspace 的 workflow profile
- `workspace policy --non-git source|copy|block` 可切换非 git 项目的 worktree 策略
- `clarify` 会生成 `.workspace/clarifications/<project>/clarify-<n>.md`，并在需要时生成结构化 decision
- workspace skill 默认从 `~/.agents/skills` 读取；clarify 例外，会从 `~/.codex/skills` 读取 superpowers clarifier skill
- 安装版 skill 需要满足 Tik 的兼容约束，见 [skill-compatibility.md](/Users/huyuehui/ace/tik/skill-compatibility.md)
- `next` 按 `currentPhase` 自动续跑，并自动推进 phase
- `decisions` 查看待确认的人机决策；`decide` 用结构化选项或自由文本完成确认
- decision synthesis 会结合 demand、workflow contract、recent events、clarification artifact、spec/plan artifact 和 memory hint，而不只是原始 blocker 文本
- `retry` 优先复用 feedback 的 `nextPhase + affectedProjects`
- `board` 展示 `Need Human / Replan Required / Healthy / In Flight`，并列出 pending decisions
- workspace 默认使用 managed worktree policy，真实 artifact 优先写到 worktree 执行路径
- `worktree status` 会显示每个 lane 的状态，`*` 标记当前 active lane
- `worktree status` 还会显示 lane kind、dirty file 计数和 activate/remove 风险提示

当 workspace 进入 `FEEDBACK_ITERATION` 时，优先走结构化确认链：

```bash
tik workspace decisions
tik workspace decide --id decision-123 --option use-feature-b --message "选 feature-b 继续"
tik workspace next
```

兼容路径仍然保留：

```bash
tik workspace feedback --message "请按方案 B 继续" --projects service-a --next-phase PARALLEL_PLAN
```

每个项目 phase 会记录：

- `workflowContract`
- `workflowSkillName`
- `workflowSkillPath`
- `specTaskId`
- `planTaskId`
- `aceTaskId`

## 6. Dashboard 与 API

启动 API server：

```bash
tik serve --port 3001 --project /absolute/path/to/workspace-root
```

启动 dashboard：

```bash
pnpm --filter @tik/dashboard dev
```

常用 workspace decision API：

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

HTTP resolve 示例：

```bash
curl -X POST http://127.0.0.1:3001/api/workspace/decisions/<decisionId>/resolve \
  -H 'Content-Type: application/json' \
  -d '{"optionId":"artifact-2","message":"按 feature-b 继续"}'
```

## 7. 工具与运行时语义

Tik 内建的核心工具包括：

| Tool | Type | 并发 | 说明 |
|------|------|------|------|
| `read_file` | READ | 并行 | 读取文件内容 |
| `write_file` | WRITE | 并行 | 写入文件 |
| `edit_file` | WRITE | 并行 | 搜索替换编辑文件 |
| `glob` | READ | 并行 | path-aware 文件搜索 |
| `grep` | READ | 并行 | 内容搜索 |
| `bash` | EXEC | 串行 | 执行 shell 命令，带 guard |
| `git_status` | READ | 并行 | Git 工作区状态 |
| `git_diff` | READ | 并行 | Git diff |
| `git_log` | READ | 并行 | Git 提交历史 |
| `git_commit` | EXEC | 串行 | 暂存并提交 |

关键任务终态：

- `converged`: 达到收敛标准
- `completed`: 任务完成，但不一定达到收敛门槛
- `failed`: 真正失败
- `cancelled`: 被停止

## 8. 推荐用法

如果你想改代码：

```bash
tik run "..." --provider codex
```

如果你想分析或审查：

```bash
tik run "..." --provider codex-delegate
```

如果你想推进 Workspace SDD：

```bash
tik workspace run --demand "..."
tik workspace next --provider mock
```

如果你想更快暴露问题：

```bash
tik workspace run --demand "..." --workflow-profile fast-feedback
```

## 9. Workbench

单工作区 workbench 需要本地后端和 dashboard 同时启动：

```bash
pnpm --dir /Users/huyuehui/ace/tik --filter @tik/cli exec tik serve --project /Users/huyuehui/ace/tik --provider mock
pnpm --dir /Users/huyuehui/ace/tik --filter @tik/dashboard dev -- --host 127.0.0.1
```

打开 `http://127.0.0.1:5173` 后，你可以：

- 在左栏创建任务
- 选择任务查看右侧混合时间线
- 在任务进入 `waiting_for_user` 时看到内联决策卡

左栏顶部的 `Environment` 选择器会读取 `tik/env-packs/*/pack.json`，当前 active pack 会持久化到 `tik/.tik/environment-pack.json`。

## 10. 相关文档

- [README.md](/Users/huyuehui/ace/tik/README.md)
- [baseline.md](/Users/huyuehui/ace/tik/baseline.md)
- [skill-compatibility.md](/Users/huyuehui/ace/tik/skill-compatibility.md)
- [workspace_sdd_alignment.md](/Users/huyuehui/ace/tik/workspace_sdd_alignment.md)
- [workspace_runtime_milestone.md](/Users/huyuehui/ace/tik/workspace_runtime_milestone.md)
