# Tik 相对 claw-code-main 的剩余差距

> 日期: 2026-04-03  
> 目的: 记录 `tik` 当前已追平的能力，以及相对 `claw-code-main` 仍存在的核心差距

## 1. 当前结论

`tik` 已经补齐了 `claw-code-main` 的一大批高价值能力：

- session-based runtime
- interactive shell
- CLI session persistence + resume
- path-aware search
- repo candidate resolution
- bootstrap instructions (`CLAUDE.md` + `AGENTS.md`)
- low-value shell probe suppression
- shell search fallback 收紧 (`bash find -name`, shell `grep/rg`)
- Claude provider 的基础鲁棒性增强
- “enough evidence -> completed” 任务语义
- continuation-style compact memory
- implementation-intent-aware stop / completion policy

但 `tik` 还没有完全成为 `claw` 那种：

```text
session-first + permission-aware + compact-memory-driven runtime
```

当前更准确的判断是：

```text
tik 已接近 claw 的执行骨架
但仍未完全追平其控制面、权限层和 permission-aware runtime 深度
```

## 2. 已基本追平的部分

## 2.1 Retrieval / Search Discipline

已追平或接近追平：

- 模糊路径补齐
- path-aware glob
- scoped `glob/grep/read_file`
- `bash find` guard
- `read_file` 目录保护
- `bash cat` 归一化
- 低价值 shell probe suppression

这意味着 `tik` 已经不太会像早期那样：

- 先在 spec 文档里打转
- repo-wide 乱搜
- 用 `cat -A / wc -l / tail` 做大量噪音探测

## 2.2 Bootstrap Context

已接近追平：

- cwd
- date
- platform/os
- git status / diff
- `CLAUDE.md`
- `AGENTS.md`
- `.claude/*`
- `.agents/*`

这部分已经具备 `claw` 那种“先把该知道的背景喂够”的方向。

## 2.3 CLI Shell 基础

已追平或接近追平：

- 默认交互壳
- session 持久化
- `--resume`
- `/sessions`
- `/compact`
- `/cost`
- `/export`
- `/memory`
- `/diff`
- `/config`

CLI 层已经不再是 Tik 的主要短板。

## 2.4 Provider 基础鲁棒性

已明显改善：

- Claude streaming watchdog
- streaming timeout fallback
- `Unexpected event order` fallback 到 non-streaming
- LLM 重试

这让 `tik` 不再轻易因为 provider 层瞬时异常整轮失败。

## 3. 仍存在的核心差距

## 3.0 Native Codex Control Boundary 仍在收敛

`tik` 现在已经支持：

- `codex` governed mode
- `codex-delegate` delegate mode
- 原生 Codex JSON 事件到 Tik EventBus 的细粒度映射

但真实任务验证表明：

- `codex` 更容易在实现任务里较早产出第一版 patch
- `codex-delegate` 的架构边界更合理，但当前更适合作为完整子任务委托，而不是默认的强实现主路径

这说明当前剩余 gap 不只是“模型能力”，而是：

```text
Tik 与原生执行引擎之间的控制边界还需要继续收敛
```

也就是：

- `Tik` 更适合做 task/control plane/governance
- `Codex` 更适合做 delegated execution

这一点已经在方向上明确，但还没有完全沉淀成统一运行模型。

## 3.1 Permission Policy 仍明显弱于 claw

`claw` 的权限层是 runtime 的核心组成部分：

- `ReadOnly`
- `WorkspaceWrite`
- `DangerFullAccess`
- `Prompt`
- `Allow`

而 `tik` 现在更多是：

- 工具级 guard
- shell probe suppression
- 搜索范围限制

缺少的关键点：

- 正式 `permission mode`
- CLI 暴露的 `/permissions`
- `--allowedTools`
- deny/ask/allow 作为一等 runtime 语义
- deny 结果统一回灌为 tool result 的完整闭环

这是当前最重要的差距之一。

## 3.2 Implementation Mode / Stop Policy 仍弱于 claw

`tik` 现在已经有：

- `Goal / Key files / Pending work / Current work / Blockers`
- `implementationReady`
- `implementationStrict`
- `intent-aware completed`

所以 compact memory 本身已经不再是主要短板。

但和 `claw` 相比，仍然还差：

- 更彻底的 `permission-aware` runtime 边界
- 更少依赖 heuristic 的实现态切换
- 让“继续调用工具”天然需要理由，而不是靠后续 deny/redirect 不断修正

也就是说，当前主要差距已经从“有没有 continuation memory”转成了：

```text
有没有 claw 那种更原生的 implementation-mode + permission-mode 融合
```

## 3.3 Stop Condition 仍有优化空间

`tik` 已经补上：

- repeated read-only exploration stop
- implementation-ready stop
- enough-evidence -> `completed`
- implementation-intent-aware completion
- implementation-strict cross-step narrowing

但 `claw` 的停止机制更自然，因为：

- 主循环更纯
- compact memory 更成熟
- permission boundary 更明确

`tik` 目前仍保留较多 heuristic policy。  
方向是对的，但还没完全沉到底层 runtime。

## 3.4 Tooling 生态广度仍弱于 claw

虽然 `tik` 的核心文件/搜索/编辑工具已足够实用，但和 `claw` 相比还差：

- 更成熟的 MCP 整合深度
- 更丰富的标准工具集合
- 更统一的外部工具命名空间
- 更强的 tool/policy/config 一体化

## 3.5 非交互控制面仍未追平

`claw` 已经把下面这些能力变成 CLI 一等能力：

- `--permission-mode`
- `--allowedTools`
- `--output-format text|json|ndjson`
- `/model`
- `/permissions`
- `/version`
- `/init`

而 `tik` 当前还未补齐。

## 4. 差距优先级

## P1

- Permission policy 正式化
- `/permissions` + `--permission-mode`
- `--allowedTools`
- `--output-format text|json|ndjson`
- 更原生的 implementation-mode / tool boundary 融合

## P2

- `/model`
- `/version`
- `/init`
- richer session metadata
- 更少 heuristic 的 stop / conclude 策略

## P3

- 更深的 MCP / remote runtime 对齐
- 更广的工具生态
- 更强的 transcript/export/schema

## 5. 一句话判断

今天的 `tik` 已经不再落后于 `claw-code-main` 一个时代。

它已经具备：

- 正确进入目标代码域
- 正确限制搜索范围
- 正确结束无价值探索
- 正确把“有结论但未收敛”表示为 `completed`
- continuation-style compact memory
- 实现任务的 intent-aware completion

剩下最核心的 gap 不再是“能不能跑”，而是：

```text
有没有 claw 那种成熟的 permission layer
+ 有没有 claw 那种 permission-aware implementation mode
+ 有没有 claw 那种完整 CLI 控制面
```

## 6. 建议下一步

按投入产出比，最值得优先推进的是：

1. Permission layer
- `--permission-mode`
- `--allowedTools`
- `/permissions`

2. 输出格式
- `--output-format text|json|ndjson`

3. implementation-mode 深化
- 更少 heuristic
- 更原生的 deny / ask / allow 语义
- 把“继续调用工具”真正变成有边界的动作

如果只选一个最关键点，我建议：

```text
先做 permission layer
```

因为这是 `claw` 和 `tik` 当前最大的结构性差距。
