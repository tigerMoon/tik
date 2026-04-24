# Tik Installed Skill Compatibility

## 1. 目的

Tik 现在默认从 `~/.agents/skills` 读取 workspace 相关 skill，而不是从项目仓库内绑定 skill 源。

当前默认读取位置：

- `~/.agents/skills/sdd-specify/SKILL.md`
- `~/.agents/skills/sdd-plan/SKILL.md`
- `~/.agents/skills/ace-sdd-workflow/SKILL.md`

这份文档描述的是：

- Tik 当前对安装版 skill 的最低兼容假设
- 哪些行为可以自由变化
- 哪些行为如果变化，会打破 workspace 主链

一句话：

> 你可以自由升级 `~/.agents/skills` 里的方法论，但不能破坏 Tik 当前的 phase contract、artifact contract 和 delegated native-mode 假设。

---

## 2. 当前加载机制

Tik 当前 skill 加载链路：

```text
workspace phase
  -> workflow skill route
  -> ~/.agents/skills/<skill>/SKILL.md
  -> workflow skill runtime adapter
  -> delegated subtask description
  -> subtask runtime
  -> artifact / evidence gate
```

对应实现：

- [workflow-skill-routes.ts](/Users/huyuehui/ace/tik/packages/kernel/src/workflow-skill-routes.ts)
- [workflow-skill-runtime.ts](/Users/huyuehui/ace/tik/packages/kernel/src/workflow-skill-runtime.ts)
- [workspace-context-assembler.ts](/Users/huyuehui/ace/tik/packages/kernel/src/workspace-context-assembler.ts)

Tik 会：

1. 按 phase 选择 skill 名
2. 读取 `~/.agents/skills/<skill>/SKILL.md`
3. 把 skill 文本绑定进 delegated description
4. 必要时对 skill 做 native-mode 适配
5. 用 artifact / evidence 判断 phase 是否完成

Tik 不会：

- 原生解释执行 `SKILL.md` 的每一条步骤
- 把 skill 当成独立的插件 VM
- 允许 skill 决定 workspace phase 的外部 contract

---

## 3. Tik 当前固定依赖的 3 个 skill

### 3.1 `sdd-specify`

绑定 phase：

- `PARALLEL_SPECIFY`

Tik 固定依赖的结果：

- 生成或确认 feature-local `spec.md`
- 产物路径由 Tik 提前固定
- phase 只在目标 `spec.md` 存在时算完成

Tik 当前的 native-mode 假设：

- 不依赖 MCP 工具
- 不依赖 branch 创建副作用
- 不依赖 feature number 分配副作用
- 不允许 skill 自己决定 generic `.specify/specs/spec.md`
- 必须围绕 Tik 提供的 target spec path 收敛

### 3.2 `sdd-plan`

绑定 phase：

- `PARALLEL_PLAN`

Tik 固定依赖的结果：

- 生成或确认 feature-local `plan.md`
- 必须读取 Tik 提供的 resolved `spec.md`
- phase 只在目标 `plan.md` 存在且通过 plan quality gate 时算完成

Tik 当前的 native-mode 假设：

- 不依赖 MCP 工具
- 不依赖 skill 自己决定 feature directory
- 必须围绕 Tik 提供的 target plan path 收敛
- plan 不能保留模板占位符

### 3.3 `ace-sdd-workflow`

绑定 phase：

- `PARALLEL_ACE`

Tik 固定依赖的结果：

- 产生 project-local implementation convergence 或明确 blocker
- 接受 delegated execution + evidence promotion
- 若子任务本身没形成明确终态，Tik 仍会用 contract/evidence 做 completion gate

Tik 当前的假设：

- skill 需要接受 spec/plan 作为执行合同
- skill 需要能在 projectPath 里完成真实代码读写与验证
- 如果不能收敛，必须允许返回清晰 blocker

---

## 4. 哪些内容你可以自由升级

你可以自由改这些部分，而不会直接破坏 Tik：

- 方法论顺序
- 提示词风格
- 领域术语
- 风险检查清单
- 额外建议项
- 更强的输出质量要求
- 更严格的验证偏好

例如：

- 在 `sdd-specify` 里强化 API/契约影响分析
- 在 `sdd-plan` 里强化 rollout / rollback
- 在 `ace-sdd-workflow` 里强化测试优先、review 优先、验证要求

只要不破坏 Tik 的固定 contract，方法论可以继续进化。

---

## 5. 哪些变化会打破 Tik 当前兼容性

下面这些变化会直接影响 workspace 主链：

### 5.1 改变 artifact contract

例如：

- `sdd-specify` 不再围绕 `spec.md`
- `sdd-plan` 不再围绕 `plan.md`
- 把产物写到完全不同的位置
- 要求 Tik 去猜目录，而不是使用 target path

这会打破：

- artifact detection
- plan/spec phase completion
- downstream path continuity

### 5.2 改回 MCP-first 依赖

例如：

- 强制要求 `aiops-sdd-specify`
- 强制要求 `aiops-sdd-plan`
- 把 skill 设计成必须依赖外部 tool side effects

这会打破：

- 当前 delegated native-mode 执行
- 当前无 MCP 的 workspace specify/plan 主路径

### 5.3 依赖 branch / 编号副作用决定输出目录

例如：

- 只有先建分支才能知道 feature dir
- 只有拿到自动编号后才能写 spec/plan

这会打破：

- Tik 的 deterministic artifact path
- workspace 多项目一致性

### 5.4 把 skill 改成只输出分析，不产出 project-local 结果

例如：

- 只给总结，不写 artifact
- 只做建议，不写 plan/spec
- ACE 只讨论，不改代码也不给 blocker

这会打破：

- phase completion gate
- native completion promotion
- evidence-based convergence

---

## 6. 当前的最低兼容约束

如果你要维护安装版 skill，最重要的是满足这几条：

### `sdd-specify`

- 接受“target spec path 是权威路径”
- 能在无 MCP 情况下完成
- 目标是让 Tik 最终拿到一个具体可用的 `spec.md`

### `sdd-plan`

- 接受“resolved spec path / target plan path 是权威路径”
- 能在无 MCP 情况下完成
- 目标是让 Tik 最终拿到一个具体可执行的 `plan.md`

### `ace-sdd-workflow`

- 接受 spec + plan + execution contract 作为输入
- 能在 projectPath 内推进实现
- 目标是“完成”或“明确 blocker”，不能无限停留在泛分析

---

## 7. 推荐的维护方式

为了让安装版 skill 和 Tik 解耦但不失控，建议这样维护：

1. 把通用方法论持续放在 `~/.agents/skills`
2. 把 Tik 的固定兼容约束写在这份文档里
3. 每次升级 skill 时，至少人工检查：
   - 是否仍围绕 target artifact path
   - 是否仍能在无 MCP 模式下完成
   - 是否仍接受 project-local execution
4. 如果方法论变化已经超出当前 contract，再回头升级 Tik，而不是让 Tik 去猜 skill 新语义

---

## 8. 当前边界

当前 Tik 已经和项目内 skill 源解耦，但还没有做到：

- 动态发现任意新 skillName
- 动态注册新 workflow phase
- 根据 skill metadata 自动生成 contract

所以当前正确理解是：

> Tik 已经支持“安装版 skill 驱动的 workspace 执行”，但仍然要求这些 skill 服从 Tik 当前定义的 phase/contract 边界。

