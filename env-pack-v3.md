工作台是控制面，skill / 知识库 / 工具接入 / 规则是环境面。

也就是说，工作台不属于某个具体工作环境；它只是你管理 agent、收消息、做决策、看产物的地方。
当你从一个环境切到另一个环境时，理想状态下你不需要换“驾驶舱”，只需要换“当前装载的能力包”。

不过我会把你的想法再往前推半步：

可替换的单元不应该只是 skill 和知识库，而应该是一个完整的 Environment Pack。

这个包里至少有 5 类东西：

Tools / Connectors
这个环境能接哪些系统：GitHub、Jira、Slack、数据库、K8s、Figma、Notion、日志平台……
Skills
这个环境里 agent 会哪些具体动作：查慢 SQL、写前端组件、读 PR、做 RCA、生成 API 兼容性分析……
Knowledge
这个环境的知识来源：代码库索引、架构文档、runbook、历史事故、规范文档、术语表……
Policies / Guardrails
这个环境的规则：哪些变更必须审批、哪些目录不能自动改、是否允许直连生产、PII 规则、发布门禁……
Workflow Bindings
同一个 workflow 在不同环境里的落地方式。比如“线上问题处理”这个流程骨架不变，但在 A 环境里调用 Datadog + PagerDuty，在 B 环境里调用 ClickHouse + 飞书告警。

所以更准确地说，不是：

Workbench + Skill + KnowledgeBase

而是：

Workbench + Runtime + Environment Pack

这样拆，工作台才能真的稳定

你要让工作台长期不变，它就不能知道太多“环境细节”。

工作台只应该关心这些稳定对象：

Task
Event
Decision
Artifact
Workflow Run
Agent Status
Inbox / Notification
User Preference

这些东西在任何环境里都成立。

比如你看见的永远是：

哪些任务正在跑
哪些任务卡住了
哪些地方需要你拍板
哪些产物已经生成
哪些风险在升高

而不是：

当前 repo 是 monorepo 还是 polyrepo
当前知识库存在哪个向量库
当前 skill 是 Python 写的还是 MCP server 暴露的
当前日志来自 Loki 还是 Elasticsearch

这些都不该泄漏到工作台层。

你这个思路里，还有一个很重要的补充：记忆也要分层

不是所有“知识”都应该跟环境一起替换掉。

我会把记忆拆成 3 层：

1. 用户层记忆

这是全局保留的，不随环境切换：

你的决策风格
你喜欢的输出格式
你对风险的容忍度
你常要求的审查标准
你讨厌哪些做法

这部分应该跟着你走。

2. 环境层知识

这是切换环境时要换掉的：

当前项目/业务/代码库知识
当前组织的 SOP
当前团队术语
当前系统结构和 runbook
当前环境允许的操作边界

这部分应该按环境隔离。

3. 任务层上下文

这是短期的：

当前任务计划
中间产物
最近几轮发现
当前阻塞点
决策历史

任务结束后可以归档，有些沉淀回环境层，有些只留在任务历史。

所以你以后切环境时，真正发生的是：

保留用户层记忆
替换环境层知识
清理或归档任务层上下文
加载对应环境的 skill / tools / policies

这会比“全换掉”更合理。

Workflow 也别整块替换，最好拆成“骨架 + 绑定”

这是你这个想法里最值得继续深化的一点。

很多 workflow 其实有一个跨环境通用的骨架，比如：

需求处理
理解目标 → 出方案 → 实施 → 评审 → 验证 → 沉淀

线上问题处理
告警接收 → 复现/定位 → 提案 → 修复 → 验证 → RCA

这些骨架其实很稳定。

变化的是每一步怎么执行：

用什么工具
查哪些知识
跑哪些检查
由哪些 agent 负责
哪些步骤必须人审

所以不要把 workflow 设计成“完全环境绑定的脚本”，更好的方式是：

Workflow Skeleton + Environment Binding

工作台看到的是统一流程图。
Environment Pack 决定这个流程图每个节点具体挂哪种技能、哪种知识检索、哪条规则。

这样你切环境时，不一定连流程理解方式都变了，只是换了一套落地执行件。

我会建议你引入一个统一概念：Environment Pack

这个概念会比“skill + 知识库”更完整。

一个 pack 大概像这样：

name: commerce-ops
version: 0.1

tools:
  - github
  - jira
  - clickhouse
  - kubernetes
  - feishu

skills:
  - pr-review
  - api-compat-check
  - incident-rca
  - sql-slow-query-analysis

knowledge:
  - repo-index
  - architecture-docs
  - runbooks
  - incident-history

policies:
  - prod-change-requires-approval
  - pii-redaction
  - forbidden-direct-db-write

workflow_bindings:
  feature-request: feature-workflow-v2
  incident-response: incident-workflow-v3
  code-review: review-workflow-v1

evaluators:
  - risk-evaluator
  - architecture-impact-evaluator
  - rollout-safety-check

这样你切到另一个环境时，不是“换系统”，而是“挂另一个 pack”。

这会让你的产品边界非常清楚

你这个系统最后会自然分成三层。

第一层：Workbench

你每天看的东西。

Inbox
Tasks
Decisions
Risks
Artifacts
Workflow Runs
Learned Skills
Environment Selector
第二层：Runtime

系统怎么跑起来。

Task state machine
Event bus
Agent orchestration
Workflow engine
Policy checks
Evaluator pipeline
Context composer
第三层：Environment Pack

当前环境的“手脚、地图、法规、经验”。

tools
skills
knowledge
policies
bindings

这三层一旦分清楚，你的系统就不会越做越粘。

这里有一个特别关键的收益：你会得到“可移植的人机协作习惯”

这很重要。

你真正想保留的，不只是 UI，而是：

你管理任务的方式
你审批的方式
你看摘要的方式
你训练技能的方式
你升级风险的方式

这些应该是跨环境稳定的。

也就是说，无论你在做：

产品研发
设计到代码
客户项目交付
技术支持
事故处理
内容生产

你都还是在用同一个工作台习惯。
变化的只是当前装载的环境能力。

这就像一个操作系统：

桌面和窗口管理不变
换的是驱动、应用、文件系统挂载和权限策略
但要小心一个误区：不要把所有东西都塞进 Knowledge Base

很多系统一说“环境切换”，就把所有差异都丢到知识库里。这样会出问题。

因为很多东西不是“知识”，而是“可执行能力”或“约束”。

比如：

“怎么查慢 SQL” 是 skill
“线上不允许自动执行 DDL” 是 policy
“付款服务在 repo/payments” 是 knowledge
“事故处理先看告警聚类再看近 30 分钟变更” 是 workflow binding

这 4 种东西长得很像，但本质不同。
一旦混在一起，后面就很难治理。

我会再补一个你以后很需要的设计：Skill 的作用域

因为你说你会“新学习一些 skill”。

那 skill 不应该只有“有/没有”，而应该有作用域：

local

只在当前任务里临时生效

environment

对当前环境通用

global

跨环境可复用

比如：

“当前这个业务系统的表结构排查方法” 很可能是 environment skill
“如何把模糊需求整理成两套技术方案” 很可能是 global skill
“这次排查某个特例 bug 的补丁流程” 可能只是 local

这样你学到的东西不会一锅粥。

所以我对你这句话的精炼版会是：

不是“工作台和 skill、知识库解耦”，而是：

把工作台做成稳定的控制面，把环境相关能力封装成可插拔的 Environment Pack。

其中：

工作台负责任务、事件、消息、决策、产物
Runtime 负责编排和状态迁移
Environment Pack 负责 tools / skills / knowledge / policies / workflow bindings
用户偏好记忆全局保留
环境知识按 namespace 隔离
workflow 尽量保留骨架，只替换绑定

这是一个很强的方向，而且一旦这么设计，你的系统天然就具备：

可迁移
可扩展
可多环境复用
可分层治理
可持续学习


我直接给你一版能落地的定义：把 Environment Pack 当成可插拔的“环境镜像”，工作台只负责控制和呈现。

Thought for 6m 49s

那我直接给你一版 Environment Pack v0.1。

目标只有一个：

工作台永久稳定，环境能力可插拔。

也就是你以后只维护这三层：

Workbench：你看的任务、消息、决策、产物
Runtime：状态机、编排、事件总线、审批流
Environment Pack：当前环境的 tools / skills / knowledge / policies / workflow bindings
1. 先定边界

Environment Pack 不负责 UI，不负责任务状态机，不负责消息流。

它只回答这几个问题：

这个环境能连什么系统
这个环境有哪些技能
这个环境有哪些知识来源
这个环境有哪些规则和禁区
这个环境里 workflow 每一步怎么落地
这个环境里哪些 agent 可用、默认怎么配

所以它更像：

一组“当前工作环境的执行配置 + 能力资产”

而不是一个应用本身。

2. 一个 Pack 里应该有什么

我建议固定成 8 个模块。

A. Metadata

标识这个 pack 是谁、版本多少、适用于什么场景。

B. Tools

外部系统接入。

比如：

github
gitlab
jira
feishu
slack
notion
figma
postgres
clickhouse
kubernetes
datadog
sentry
C. Skills

可执行能力单元。

比如：

pr-review
api-compat-check
sql-slow-query-analysis
incident-rca
figma-to-react
design-audit
rollout-checklist
D. Knowledge

可检索知识源。

比如：

repo index
architecture docs
ADRs
runbooks
incident history
coding guidelines
product glossary
E. Policies

规则和 guardrails。

比如：

生产变更必须审批
禁止自动执行 destructive migration
敏感信息必须脱敏
只有 reviewer 通过才能进入 deploy
F. Workflow Bindings

把通用 workflow 骨架映射到当前环境的具体实现。

比如：

incident-response 用哪个 skill 组合
feature-delivery 的 code review 和 test gate 怎么定义
design-to-code 走 figma skill 还是 repo skill
G. Agents

当前环境启用哪些 agent，以及它们的默认权限和技能绑定。

比如：

planner
coder
reviewer
evaluator
operator
documenter
H. Evaluators

用来评估质量、风险、完整性。

比如：

architecture-impact-evaluator
rollout-safety-check
spec-completeness-evaluator
ux-consistency-evaluator
3. Manifest 长什么样

我建议一个 pack 先只保留一个主清单 pack.yaml。

示例：

apiVersion: tik.env/v0.1
kind: EnvironmentPack

metadata:
  id: commerce-ops
  name: Commerce Ops
  version: 0.1.0
  owner: you
  description: 通用研发环境
  tags:
    - backend
    - java
    - monorepo
    - incident
  extends:
    - base-engineering

defaults:
  workflow_namespace: engineering
  knowledge_namespace: env/commerce-ops
  decision_policy: conservative
  risk_profile: medium

tools:
  - id: github-main
    type: github
    enabled: true
    config_ref: secret://github/main

  - id: jira-core
    type: jira
    enabled: true
    config_ref: secret://jira/core

  - id: ck-prod
    type: clickhouse
    enabled: true
    config_ref: secret://clickhouse/prod
    access_mode: read_only

  - id: k8s-prod
    type: kubernetes
    enabled: true
    config_ref: secret://k8s/prod
    access_mode: guarded

knowledge:
  namespaces:
    - id: env/commerce-ops/repo
      kind: repo-index
      source: github-main
      scope: environment

    - id: env/commerce-ops/docs
      kind: docs
      source: notion
      scope: environment

    - id: env/commerce-ops/runbooks
      kind: runbook
      source: file-store
      scope: environment

    - id: env/commerce-ops/incidents
      kind: incident-history
      source: incident-db
      scope: environment

skills:
  - id: pr-review
    version: 1.0.0
    entrypoint: skill://review/pr
    scope: environment
    allowed_tools:
      - github-main
    required_knowledge:
      - env/commerce-ops/repo
      - env/commerce-ops/docs

  - id: sql-slow-query-analysis
    version: 1.1.0
    entrypoint: skill://db/slow-query
    scope: environment
    allowed_tools:
      - ck-prod
    required_knowledge:
      - env/commerce-ops/runbooks

  - id: incident-rca
    version: 0.9.0
    entrypoint: skill://ops/incident-rca
    scope: environment
    allowed_tools:
      - ck-prod
      - k8s-prod
    required_knowledge:
      - env/commerce-ops/incidents
      - env/commerce-ops/runbooks

policies:
  - id: prod-change-requires-approval
    applies_to:
      - deploy
      - config_change
      - schema_change
    effect: require_human_approval

  - id: forbid-destructive-ddl
    applies_to:
      - ddl.execute
    effect: deny

  - id: pii-redaction
    applies_to:
      - log.read
      - artifact.publish
    effect: transform
    transformer: mask-pii

workflow_bindings:
  - workflow: feature-delivery
    implementation: engineering/feature-delivery-v2
    phases:
      plan:
        skills: [solution-proposal]
      implement:
        skills: [coder, api-compat-check]
      review:
        skills: [pr-review, architecture-impact-evaluator]
      verify:
        skills: [test-runner, rollout-safety-check]
      compound:
        skills: [doc-compound]

  - workflow: incident-response
    implementation: ops/incident-response-v3
    phases:
      triage:
        skills: [incident-triage]
      diagnose:
        skills: [sql-slow-query-analysis, log-correlation]
      propose_fix:
        skills: [incident-fix-proposal]
      approve:
        human_gate: true
      execute:
        skills: [operator]
      rca:
        skills: [incident-rca]

agents:
  - id: planner
    model_profile: deep-reasoning
    allowed_skills:
      - solution-proposal
      - incident-fix-proposal
    max_autonomy: medium

  - id: reviewer
    model_profile: critical-review
    allowed_skills:
      - pr-review
      - architecture-impact-evaluator
    max_autonomy: medium

  - id: operator
    model_profile: cautious-executor
    allowed_skills:
      - deploy
      - rollback
    max_autonomy: low

evaluators:
  - id: architecture-impact-evaluator
    threshold: warn
  - id: rollout-safety-check
    threshold: block

promotion_rules:
  skill_learning:
    local_to_environment: manual_review
    environment_to_global: manual_review

telemetry:
  event_namespace: env.commerce-ops
  artifact_retention_days: 180
4. 运行时协议怎么定

这里最关键。

你不需要先设计成复杂 RPC 规范，但一定要先定 Runtime 和 Pack 的交界面。

我建议先只定 7 个核心接口。

1）加载 Pack
loadEnvironmentPack(packId: string): LoadedPack

作用：

校验 manifest
初始化 connectors
注册 skills
挂载 knowledge namespaces
激活 policies
暴露 workflow bindings
2）为任务选择 workflow
resolveWorkflow(taskType: string, packId: string): WorkflowBinding

例如：

feature-request -> engineering/feature-delivery-v2
incident -> ops/incident-response-v3
design-to-code -> design/design-to-code-v1
3）为某阶段解析可用技能
resolveSkills(
  phase: string,
  workflowId: string,
  packId: string,
  taskContext: TaskContext
): SkillRef[]

作用：

同一 workflow 的不同环境绑定不同 skills
根据 task 类型、风险等级、资源可用性做裁剪
4）检索知识
retrieveKnowledge(
  query: string,
  namespaces: string[],
  scope: "task" | "environment" | "global"
): KnowledgeResult[]

重点不是“搜所有库”，而是：

任务先搜 task scope
再搜 environment scope
最后才搜 global scope

这样不会污染上下文。

5）执行技能
executeSkill(
  skillId: string,
  input: SkillInput,
  context: ExecutionContext
): SkillResult

其中 ExecutionContext 至少有：

task id
workflow id
phase
current pack
allowed tools
knowledge namespaces
policy hooks
6）策略校验
evaluatePolicy(
  action: ProposedAction,
  packId: string,
  context: PolicyContext
): PolicyDecision

返回值只要这几个就够了：

type PolicyDecision =
  | { effect: "allow" }
  | { effect: "deny"; reason: string }
  | { effect: "require_human_approval"; reason: string }
  | { effect: "transform"; transformer: string }
7）学习结果回灌
proposeLearningArtifact(
  artifact: LearnedArtifact,
  targetScope: "local" | "environment" | "global"
): PromotionProposal

这个接口很重要，因为你说你会持续教新 skill。

系统不应该直接把每次经验都升级为全局能力，而要先提案。

5. Skill 协议也要统一

Skill 最好长成统一对象，不管它底层是 prompt、脚本、MCP 工具还是 agent 子流程。

我建议 skill 统一有这些字段：

id: pr-review
version: 1.0.0
name: Pull Request Review
description: 对 PR 进行结构化审查
scope: environment

input_schema:
  type: object
  required: [repo, pr_number]
  properties:
    repo:
      type: string
    pr_number:
      type: integer

output_schema:
  type: object
  properties:
    summary:
      type: string
    findings:
      type: array
    risk:
      type: string
    recommendation:
      type: string

required_tools:
  - github-main

required_knowledge:
  - env/commerce-ops/repo
  - env/commerce-ops/docs

policy_hooks:
  before_execute:
    - pii-redaction
  before_publish:
    - review-output-sanitize

success_criteria:
  - 至少输出 1 个 summary
  - findings 必须结构化
  - 必须给出 risk level

这样 Runtime 就不关心 skill 底层怎么实现，只关心：

输入是什么
输出是什么
可以用什么工具
依赖什么知识
会触发什么规则
6. Knowledge 也别只做“向量库”

Knowledge Source 我建议显式区分类型。

至少这几类：

repo-index
docs
runbook
incident-history
decision-log
glossary
api-spec
design-system
artifact-store

因为不同知识源后面检索方式不一样。

例如：

repo-index 适合代码符号检索
runbook 适合 procedure 检索
decision-log 适合相似决策召回
design-system 适合 token/组件语义召回

所以不要把它们都抽象成一个“knowledge_base_url”。

7. 记忆作用域怎么定

这个很重要，不然以后一定乱。

我建议一开始就强行分 4 级。

local

只对当前任务生效
任务结束自动归档

project

对当前项目/环境生效
比如业务平台、设计系统、增长业务

global

跨环境复用
比如“如何输出两套方案并附成本收益对比”

personal

只属于你这个用户
比如你的风险偏好、审阅风格、输出偏好

你前面那句“换环境只换 skill 和知识库”，更精确一点其实是：

保留 personal
切换 project/environment
归档 local
部分能力晋升到 global
8. Workflow 不要写死，要做“骨架 + 绑定”

我建议 Workflow Skeleton 放 Runtime 里，Binding 放 Pack 里。

例如统一骨架：

workflow: feature-delivery
phases:
  - clarify
  - plan
  - implement
  - review
  - verify
  - compound

然后 Pack 决定每一阶段实际怎么跑：

workflow_bindings:
  - workflow: feature-delivery
    phases:
      clarify:
        skills: [requirements-clarifier]
      plan:
        skills: [solution-proposal, architecture-impact-evaluator]
      implement:
        skills: [coder, api-compat-check]
      review:
        skills: [pr-review]
      verify:
        skills: [test-runner, rollout-safety-check]
      compound:
        skills: [doc-compound]

这样你换环境时，工作台上的流程认知不变，只是阶段内的“执行件”变了。

9. 事件模型也要和 Pack 解耦

事件是 Runtime 的，不属于 Pack。

Pack 只能：

订阅哪些事件
在哪些事件上挂 policy / evaluator / automation

比如：

event_hooks:
  - on: TASK_CREATED
    run: workflow-selector

  - on: PHASE_ENTERED
    when:
      phase: review
    run: reviewer-setup

  - on: ACTION_PROPOSED
    run: policy-check

  - on: TASK_COMPLETED
    run: learning-harvest

但事件定义本身应该是统一的，比如：

TASK_CREATED
WORKFLOW_SELECTED
PHASE_STARTED
PHASE_COMPLETED
SKILL_EXECUTED
POLICY_BLOCKED
DECISION_REQUIRED
ARTIFACT_CREATED
TASK_COMPLETED
LEARNING_PROPOSED

这样你的工作台才能跨环境看同一套信号。

10. 你最需要的两个操作：切环境、晋升能力
切环境

用户在工作台上做的动作应该非常简单：

Switch Environment

从 commerce-ops 切到 design-system
工作台不换
inbox/task/decision/artifact 结构不换
runtime 卸载原 pack，挂载新 pack
personal memory 保留
environment knowledge 切 namespace
晋升能力

系统执行完任务后，会产出学习提案：

这次生成了一个新 skill
这次修正了 incident workflow 的 diagnose 步骤
这次沉淀了一条环境规则
这次形成了一份 runbook

然后你审批：

仅当前任务用
升级为环境能力
升级为全局能力
只归档，不晋升

这个“晋升流程”会是你整个系统最有价值的地方之一。

11. 我建议你先做两个 Pack，就够验证了

不要先做通用平台，先做两个差异很大的环境。

Pack A：Engineering Pack

适合：

GitHub
Jira
Repo index
Runbook
Incident history
PR review
Test / deploy / RCA
Pack B：Design-to-Code Pack

适合：

Figma
Design system docs
Frontend repo
UI review
Token consistency check
Figma-to-react
UX consistency evaluator

如果这两个 pack 都能跑在同一个工作台上，你这条路就成立了。

12. MVP 最小目录结构

你可以先简单到这样：

/env-packs
  /base-engineering
    pack.yaml
    skills/
    policies/
    evaluators/

  /commerce-ops
    pack.yaml
    skills/
    policies/
    bindings/

  /design-to-code
    pack.yaml
    skills/
    policies/
    bindings/

/runtime
  workflow-skeletons/
  event-types/
  policy-engine/
  skill-runner/

/workbench
  inbox/
  tasks/
  decisions/
  artifacts/
  environment-switcher/

MVP 实现备注

当前仓库里的第一版可以先用 `pack.json` 落地，而不是一上来引入 `pack.yaml` 解析链路。

也就是先固定：

- `env-packs/<pack-id>/pack.json` 作为 manifest
- Runtime 只负责 `list / get active / switch active`
- Workbench 先只展示和切换 active pack

等 pack contract 稳定之后，再决定是否升级到 yaml、多文件 pack、或者带脚本的 pack bundle。
13. 我会建议你现在就固定的 5 条原则
1. 工作台不感知环境细节

工作台只看任务、事件、决策、产物。

2. Pack 不拥有任务状态机

状态机一定要在 Runtime。

3. Skill、Knowledge、Policy、Workflow Binding 必须分开

不要混成一个“大提示词包”。

4. 记忆必须分层

至少分 personal / global / environment / local。

5. 学习结果先提案，再晋升

不要自动把一次经验写进全局能力。

14. 如果我替你下一个定义

我会把你这个系统定义成：

Tik = 一个稳定工作台 + 一个通用运行时 + 一组可切换的 Environment Packs。

其中：

Workbench 解决“看、管、批”
Runtime 解决“跑、控、记”
Environment Pack 解决“会什么、知道什么、能连什么、受什么约束”

这个结构是很干净的。
