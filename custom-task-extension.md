# Tik 定制任务能力扩展指南

## 1. 这份文档解决什么问题

当你想把 Tik 扩成“更懂你业务”的系统时，最容易遇到的问题不是“能不能扩展”，而是“不知道应该落在哪一层”。

这份文档的目标是把当前 Tik 的扩展机制拆清楚，回答 4 个问题：

1. 哪些地方可以扩展
2. 每一层分别适合什么类型的定制能力
3. 做一类新能力时应该优先改哪里
4. 哪些能力适合先做 skill，哪些应该升级成 phase、policy 或 runtime

一句话总结：

> 当前 Tik 的扩展机制不是单点插件，而是分层扩展：`skill -> contract/context -> workflow -> policy -> runtime/tools -> read model/api`。

---

## 2. 当前系统里的主要扩展层

### 2.1 Skill 层

这是最轻、最直接的扩展层。

当前 workspace phase 会绑定 skill：

- `PARALLEL_SPECIFY -> sdd-specify`
- `PARALLEL_PLAN -> sdd-plan`
- `PARALLEL_ACE -> ace-sdd-workflow`

见：

- [workflow-skill-routes.ts](/Users/huyuehui/ace/tik/packages/kernel/src/workflow-skill-routes.ts)
- [workflow-skill-runtime.ts](/Users/huyuehui/ace/tik/packages/kernel/src/workflow-skill-runtime.ts)

skill 目前是：

- `~/.agents/skills/<skill>/SKILL.md`
- 被 runtime 读取
- 被包装成 delegated subtask description
- 作为 agent 的主执行面，而不是被 Tik 解释执行

适合的扩展类型：

- 改一类任务的方法论
- 加强某类任务的提示约束
- 注入业务术语、边界、风险、验收清单
- 调整某个 phase 的执行风格

不适合的扩展类型：

- 新增底层工具能力
- 新增 workflow phase
- 新增稳定 API / dashboard 视图

---

### 2.2 Contract / Context 层

这是最适合做“定制任务能力”的一层。

见：

- [workspace-context-assembler.ts](/Users/huyuehui/ace/tik/packages/kernel/src/workspace-context-assembler.ts)
- [workspace-execution-contract-synthesizer.ts](/Users/huyuehui/ace/tik/packages/kernel/src/workspace-execution-contract-synthesizer.ts)

这一层负责把需求收敛成：

- 目标文件
- 候选文件
- 目标方法
- 验证目标
- execution-ready summary
- confidence / rationale / signals

适合的扩展类型：

- 某类业务需求总是落在固定模块
- 某类任务需要固定的 validation target
- 某类改造需要更强的 target ranking
- 某类任务需要专门的 context hint

这是当前最推荐的扩展点，因为它能直接提升：

- 选错文件的概率
- agent 的收敛速度
- phase 完成判断的可靠性

---

### 2.3 Workflow / Phase 层

如果你要扩的不是“做法”，而是“流程本身”，就应该落在这一层。

见：

- [workspace-workflow-spec.ts](/Users/huyuehui/ace/tik/packages/kernel/src/workspace-workflow-spec.ts)
- [workspace-phase-executors.ts](/Users/huyuehui/ace/tik/packages/kernel/src/workspace-phase-executors.ts)
- [subtask.ts](/Users/huyuehui/ace/tik/packages/shared/src/types/subtask.ts)

当前 Tik 已有的 workflow phase：

- `PARALLEL_SPECIFY`
- `PARALLEL_PLAN`
- `PARALLEL_ACE`

每个 phase 绑定：

- `contract`
- `role`
- `skillName`
- `requiredArtifacts`
- `nextPhase`

适合的扩展类型：

- 你要新增一个真正独立的新阶段
- 你要让某类任务成为一等 workflow 能力
- 你要对某类任务定义专属 completion promise

典型例子：

- `PARALLEL_MIGRATION`
- `PARALLEL_REVIEW`
- `PARALLEL_BACKFILL`
- `PARALLEL_KNOWLEDGE_SYNC`

---

### 2.4 Policy 层

如果能力差异主要不是“做什么”，而是“怎么做得更快/更稳/更重验证”，就应该落在 policy。

见：

- [workspace-policy-engine.ts](/Users/huyuehui/ace/tik/packages/kernel/src/workspace-policy-engine.ts)

当前已有 profile：

- `balanced`
- `fast-feedback`
- `deep-verify`

当前 policy 控制：

- phase budgets
- feedback retry
- native artifact rescue
- ACE evidence promotion

适合的扩展类型：

- 更严格的验证模式
- 更保守的迁移模式
- 更快的快速反馈模式
- 针对特定任务族的 reroute / escalation 规则

---

### 2.5 Runtime / Tool 层

如果你的定制能力需要新的“系统能力”，而不是仅靠 prompt 更聪明，就应该扩这一层。

见：

- [execution-kernel.ts](/Users/huyuehui/ace/tik/packages/kernel/src/execution-kernel.ts)
- [tools.ts](/Users/huyuehui/ace/tik/packages/kernel/src/tools.ts)
- [builtin-agents.ts](/Users/huyuehui/ace/tik/packages/kernel/src/agent/builtin-agents.ts)

适合的扩展类型：

- 新工具
- 新外部系统接入
- 新 agent role
- 新 provider/harness
- 新 execution mode

典型例子：

- repo-aware 检索器
- schema diff 工具
- contract 兼容性检查器
- 领域专用 API reader
- 静态风险分析器

---

### 2.6 Read Model / API / UI 层

如果你不只是要“执行”，还要“被看见、被治理、被 dashboard 消费”，就要扩这一层。

见：

- [workspace-public-api.ts](/Users/huyuehui/ace/tik/packages/kernel/src/workspace-public-api.ts)
- [server.ts](/Users/huyuehui/ace/tik/packages/kernel/src/server.ts)
- [client.ts](/Users/huyuehui/ace/tik/packages/dashboard/src/api/client.ts)

适合的扩展类型：

- 新的 report 视图
- 新的 board 维度
- 更强的 memory 可视化
- 自定义 evidence 展示
- 任务族专用 dashboard

---

## 3. 定制任务能力应该落在哪一层

### 3.1 快速判断规则

- 想改变“怎么做”：改 skill
- 想改变“怎么判断该改哪里”：改 contract/context
- 想改变“流程本身”：改 workflow/phase
- 想改变“执行风格”：改 policy
- 想增加“系统能力”：改 runtime/tools
- 想增加“展示和治理”：改 read model/api

### 3.2 选型表

| 需求类型 | 推荐落点 | 原因 |
| --- | --- | --- |
| 某类任务总写不准 spec/plan | Skill | 优先提高 phase 方法论 |
| 某类任务老是选错目标文件 | Contract / Context | 这是 target synthesis 问题 |
| 某类任务需要固定验证路径 | Contract / Context | 这是 validation target 问题 |
| 某类任务要成为系统一等能力 | Workflow / Phase | 需要 first-class phase |
| 某类任务需要更保守或更快模式 | Policy | 主要差异在 budget / retry / promotion |
| 某类任务必须访问外部系统 | Runtime / Tool | prompt 不够，需要新工具能力 |
| 某类任务要在 dashboard 里单独治理 | Read Model / API | 需要稳定读取面和展示层 |

---

## 4. 三种最常见的定制能力落法

### 4.1 领域特定改造助手

例如：

- 类目同步改造
- 缓存治理
- DB 改 API
- contract migration

推荐落点：

1. 先做 Skill
2. 再做 Contract / Context
3. 稳定后再考虑是否升级成 Workflow Phase

原因：

- 这类任务最开始通常不是缺 phase，而是缺领域理解
- 先把 target extraction 和 validation 做准，收益最大

---

### 4.2 严格验证模式

例如：

- 上线前 deep verify
- 高风险改造强验证
- review-first 执行模式

推荐落点：

1. Policy
2. Completion Evidence
3. Read Model / Report

原因：

- 这类需求的核心不是多一个 phase
- 而是执行预算、反馈策略、promotion 规则和证据视图

---

### 4.3 外部系统驱动任务

例如：

- 调内部 API 做结构扫描
- 做 contract diff
- 调平台检查器判断兼容性

推荐落点：

1. Runtime / Tool
2. Contract / Context
3. Skill

原因：

- 这类能力的核心不在 prompt，而在系统工具面

---

## 5. 实施顺序建议

对大多数定制任务能力，我建议按这个顺序实施：

1. 先补安装到 `~/.agents/skills` 的 skill
2. 再补 contract synthesis / context hints
3. 用真实需求验证是否稳定
4. 稳定后再决定是否升级成新 phase
5. 最后补 policy profile 和 read model

这样做的好处是：

- 成本最低
- 回滚最容易
- 最接近真实问题
- 不会太早把局部能力做成重型框架

---

## 6. 典型实施模板

下面是一类新能力最常见的落地路径。

### 模板 A：先做 skill 强化

适用：

- 任务类型已经明确
- 但 agent 做法不稳定

改动点：

- `~/.agents/skills/<skill>/SKILL.md`
- [workflow-skill-routes.ts](/Users/huyuehui/ace/tik/packages/kernel/src/workflow-skill-routes.ts)

预期收益：

- phase 方法论更稳
- 输出更一致

---

### 模板 B：做 contract-aware 定制

适用：

- 总是选错目标文件
- 总是漏验证目标
- 总是对业务边界理解不准

改动点：

- [workspace-execution-contract-synthesizer.ts](/Users/huyuehui/ace/tik/packages/kernel/src/workspace-execution-contract-synthesizer.ts)
- [workspace-context-assembler.ts](/Users/huyuehui/ace/tik/packages/kernel/src/workspace-context-assembler.ts)

预期收益：

- 目标定位更准
- 验证更稳
- ACE evidence 更容易收敛

---

### 模板 C：升成 workflow 能力

适用：

- 这类任务已经反复出现
- 已经不只是 prompt 方法论问题
- 需要自己的 phase / contract / completion semantics

改动点：

- [subtask.ts](/Users/huyuehui/ace/tik/packages/shared/src/types/subtask.ts)
- [workspace-workflow-spec.ts](/Users/huyuehui/ace/tik/packages/kernel/src/workspace-workflow-spec.ts)
- [workflow-skill-routes.ts](/Users/huyuehui/ace/tik/packages/kernel/src/workflow-skill-routes.ts)
- [workspace-phase-executors.ts](/Users/huyuehui/ace/tik/packages/kernel/src/workspace-phase-executors.ts)

预期收益：

- 成为系统级能力
- 可治理、可观测、可稳定演进

---

## 7. 当前扩展机制的边界

当前 Tik 是“有清晰扩展槽位”，但还不是“热插拔插件平台”。

这意味着：

- 改已有 skill 很轻
- 增强 contract/context 很划算
- 新增 phase / contract / skillName 仍然需要代码改动
- runtime/tool 扩展也需要明确注册点

关键静态定义点在：

- [subtask.ts](/Users/huyuehui/ace/tik/packages/shared/src/types/subtask.ts)
- [workspace-workflow-spec.ts](/Users/huyuehui/ace/tik/packages/kernel/src/workspace-workflow-spec.ts)
- [workflow-skill-routes.ts](/Users/huyuehui/ace/tik/packages/kernel/src/workflow-skill-routes.ts)

所以当前最合理的认知是：

> Tik 已经具备产品级的分层扩展能力，但还不是任意 skill/phase 的零代码动态注册平台。

---

## 8. 推荐的实践策略

如果你准备开始做你的定制任务能力，我建议遵循下面的策略：

1. 不要一开始就新增 phase
2. 先用 skill + contract/context 做出真实收益
3. 用真实任务样本验证收益是否稳定
4. 只有当它已经反复出现、值得成为系统能力时，再升成 phase/policy/API

一句话建议：

> 先把“领域理解做准”，再把“流程做重”。
