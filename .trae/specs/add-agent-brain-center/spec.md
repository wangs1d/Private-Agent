# Agent Brain Center（大脑中心）Spec

## Why

当前 agent 的"大脑"能力分散在十多个服务里，存在三个核心问题：

1. **能力认知是 prompt 注入式**：`server/src/agent/agent-capabilities.ts` 通过构建 system prompt 段让 LLM "知道自己有什么能力"，无法被程序化查询、对比、扩展，且新增能力必须改代码再重启。
2. **主动 / 实时观察能力三套并行实现重叠**：`ProactiveAgentCenter`、`ProactiveLifeRuntimeService`、`JarvisHarness` 都在做"是否要主动找用户"的判定，逻辑分散、策略互相覆盖。
3. **自我意识与"活人感"缺统一抽象**：感知（life signal / presence / mood）、认知（anticipation / decision）、进化（self-learning / skill-generator / promotion / hermes-loop）没有统一的"自我"入口，agent 没有一处可以回答"我现在感知到什么 / 我下一步该做什么 / 我缺什么能力"。

需要一个 **Brain Center（大脑中心）** 作为统一中枢，把感知-认知-决策-进化收口到一个程序化外观（Facade + Orchestrator），且**不走 prompt 路线**——所有能力自省、用户观察、主动出击决策都通过 API/事件驱动，而非靠 LLM prompt 自我引导。

本 spec 仅覆盖 **Brain Center**。具身（Body / Embodiment）作为后续独立 spec 处理。

## What Changes

### 新增

- 新建 `server/src/brain/` 目录作为大脑中心模块，包含：
  - `BrainCenter` —— 统一外观与编排器，持有四个皮层引用，对外暴露 `observe() / decide() / introspect() / evolve()` 单一入口
  - `CapabilityCortex`（能力皮层）—— 把 `agent-capabilities.ts` 的硬编码清单改造为**数据驱动 + 可程序化查询**的能力注册表，提供 `list / has / identifyGap / expand` API（替代 prompt 注入）
  - `AwarenessCortex`（感知皮层）—— 合并 `LifeSignalHubService + DesktopPresenceSignalService + MoodInferenceService + AnticipationEngineService` 为子系统，产出统一的 `UserActivityState`（如 `just_off_work / going_out / idle / busy / sleeping`），由事件/信号驱动而非 LLM 判定
  - `ProactionCortex`（主动皮层）—— 以 `JarvisHarness` 决策引擎为唯一决策入口，把 `ProactiveAgentCenter` / `ProactiveLifeRuntimeService` 的判定逻辑收口到单条决策流水线（value/disturb 双轨评分 + 策略闸门）
  - `EvolutionCortex`（进化皮层）—— 注册 `AgentSelfLearningService + SkillGenerator + SkillPromotionPipeline + HermesEvolutionLoopService` 为子系统，暴露 `proposeCapability / evolve / gapReport`
  - `types.ts` —— 统一类型定义（`UserActivityState / BrainDecision / CapabilityDescriptor / EvolutionProposal`）
  - `index.ts` —— 对外导出 + `registerBrainRoutes` / `registerBrainTools`

- 新增 HTTP 路由 `server/src/routes/http/brain.ts`：
  - `GET /brain/capabilities` —— 程序化能力清单（**替代 prompt 段**）
  - `GET /brain/state` —— 当前感知 + 决策状态快照
  - `POST /brain/proactive/test` —— 注入测试信号走完整决策流水线
  - `POST /brain/evolve/propose` —— 提交能力缺口提案

- 新增 agent 工具（`server/src/tools/brain-tools.ts`），让 agent 自己通过工具调用而非 prompt 认识能力：
  - `brain.list_capabilities` —— 查询自己拥有的能力域
  - `brain.identify_gap` —— 描述一个场景，返回可能缺失的能力
  - `brain.propose_capability` —— 提议新增能力（走 EvolutionCortex，可触发 self-programming）
  - `brain.observe_user` —— 查询当前用户活动状态（off_work / going_out / idle 等）

### 修改

- **MODIFIED** `server/src/agent/agent-capabilities.ts`：`CAPABILITY_DOMAINS` 与 `DOMAIN_LABELS` 不再硬编码，改为向 `CapabilityCortex` 查询；`buildAgentCapabilityPromptSection` 保留为兼容入口但数据源切到 cortex
- **MODIFIED** `server/src/bootstrap/create-app-services.ts`：实例化 `BrainCenter` 与四个皮层，把现有感知/主动/进化服务**注册为子系统**（不重写），注入 `agentCore` / `toolRegistry` / HTTP 路由
- **MODIFIED** 现有 proactive 流：`ProactiveAgentCenter.start()` / `ProactiveLifeRuntimeService.start()` 默认不再独立启动，由 `ProactionCortex` 统一驱动；通过 `BRAIN_PROACTION_LEGACY=1` 可降级回旧路径
- **MODIFIED** `server/src/agent/prompt-context-builder.ts`：能力清单段改从 `CapabilityCortex.snapshot()` 取，移除"prompt 引导 agent 自我反思"相关文案

### 不走 prompt 路线的具体含义

- 能力清单：HTTP / 工具查询，不在 system prompt 里硬塞清单
- 用户观察：由 `AwarenessCortex` 基于信号（life signal / desktop presence / mood）的规则与统计模型产出 `UserActivityState`，不让 LLM 自己猜用户在干嘛
- 主动决策：沿用 Jarvis 的 value/disturb 评分 + 策略闸门，LLM 只在"决定要说之后"生成具体话术（话术 ≠ 决策）
- 进化提案：缺口识别由规则 + 历史失败轨迹分析产出，不由 LLM 自我反思生成

## Impact

- **Affected specs**：`self_programming`（被 EvolutionCortex 编排）、`embodiment`（具身后续 spec 会消费 BrainCenter 的状态）、`proactive_outreach`（被 ProactionCortex 收口）
- **Affected code**：
  - 新增：`server/src/brain/`（全部新增）
  - 修改：`server/src/agent/agent-capabilities.ts`、`server/src/bootstrap/create-app-services.ts`、`server/src/agent/prompt-context-builder.ts`、`server/src/routes/http/index.ts`、`server/src/tools/tool-registry.ts`
  - 收编（注册为子系统，不改实现）：`life-signal-hub-service.ts`、`desktop-presence-signal-service.ts`、`mood-inference-service.ts`、`anticipation-engine-service.ts`、`proactive-agent-center.ts`、`proactive-life-runtime-service.ts`、`jarvis/`、`agent-self-learning-service.ts`、`skill-generator.ts`、`skill-promotion-pipeline.ts`、`hermes-evolution-loop-service.ts`
- **Rollout**：默认开启，`BRAIN_CENTER_ENABLED=0` 完全降级回现状

## ADDED Requirements

### Requirement: BrainCenter 作为大脑统一入口

系统 SHALL 提供 `BrainCenter` 类作为 agent 大脑的单一对外入口，持有 `CapabilityCortex / AwarenessCortex / ProactionCortex / EvolutionCortex` 四个皮层引用，并暴露 `introspect() / observe(actorId) / decide(signal) / evolve(proposal)` 四个核心方法。

#### Scenario: 外部查询 agent 当前大脑状态

- **WHEN** 任意调用方调用 `brainCenter.snapshot(actorId)`
- **THEN** 返回包含 `capabilities / userActivity / lastDecisions / pendingEvolutions` 四段的状态快照
- **AND** 单次调用 < 5ms（仅读取内存状态）

#### Scenario: BrainCenter 启动顺序

- **WHEN** `create-app-services.ts` 启动
- **THEN** 先实例化四个皮层并各自 `register()` 现有子系统，再 `brainCenter.start()`
- **AND** 任意皮层初始化失败不阻断其他皮层（降级而非崩溃）

### Requirement: CapabilityCortex 提供程序化能力自省

系统 SHALL 提供 `CapabilityCortex`，把当前 `CAPABILITY_DOMAINS` 硬编码改造为运行时可查询、可扩展的能力注册表，**不通过 system prompt 注入**。

#### Scenario: Agent 通过工具查询自身能力

- **WHEN** LLM 调用 `brain.list_capabilities` 工具
- **THEN** 返回当前已注册的所有 `CapabilityDescriptor`（含 `domain / label / tools / status / source`）
- **AND** 不依赖 system prompt 段拼接

#### Scenario: Agent 识别能力缺口

- **WHEN** LLM 调用 `brain.identify_gap` 描述场景"用户要去旅游，需要规划行程"
- **THEN** CapabilityCortex 基于规则（关键词 → 期望能力域映射）+ 现有能力对比，返回 `gapReport`：缺失的能力域 + 已有可复用的相邻能力
- **AND** 不调用 LLM 做自我反思

#### Scenario: Agent 提议新增能力

- **WHEN** LLM 调用 `brain.propose_capability` 提交"行程规划"能力提案
- **THEN** EvolutionCortex 接收提案，进入 `pending / reviewing / approved / rejected` 状态机
- **AND** 若 approved 且权限允许，触发 `SkillGenerator` 生成技能代码（复用现有 self-programming 流）

### Requirement: AwarenessCortex 产出统一 UserActivityState

系统 SHALL 提供 `AwarenessCortex`，订阅 `LifeSignalHubService / DesktopPresenceSignalService / MoodInferenceService` 的信号，基于规则与时间节律产出统一的 `UserActivityState`，**不由 LLM 推断**。

#### Scenario: 检测到用户刚下班

- **WHEN** `DesktopPresenceSignalService` 在工作日 18:00-19:30 检测到桌面活动从"工作应用"切换到"非工作应用" + 锁屏/解锁事件
- **THEN** AwarenessCortex 产出 `UserActivityState { activity: "just_off_work", confidence, evidence, occurredAt }`
- **AND** 推送给 ProactionCortex 评估是否要主动联系

#### Scenario: 检测到用户准备出行

- **WHEN** 用户在对话中提及"明天要去 XX 玩" + 日历出现出行时段日程
- **THEN** AwarenessCortex 产出 `UserActivityState { activity: "going_out", metadata: { destination, time } }`
- **AND** ProactionCortex 可基于此主动生成行程规划建议

#### Scenario: Agent 查询用户当前状态

- **WHEN** LLM 调用 `brain.observe_user` 工具
- **THEN** 返回最近的 `UserActivityState` 与证据窗口
- **AND** 不让 LLM 自己根据聊天历史猜

### Requirement: ProactionCortex 单点决策

系统 SHALL 提供 `ProactionCortex`，以 `JarvisDecisionEngine` 为唯一决策入口，整合 `ProactiveAgentCenter` 与 `ProactiveLifeRuntimeService` 的判定逻辑到单条流水线。

#### Scenario: 信号进入决策流水线

- **WHEN** AwarenessCortex 产出 `UserActivityState` 或 LifeSignal 到达
- **THEN** ProactionCortex 调用 Jarvis 的 value/disturb 双轨评分
- **AND** 通过 contact policy / cooldown / 时间节律闸门后，才调用 LLM 生成具体话术
- **AND** 默认 `ProactiveAgentCenter` / `ProactiveLifeRuntimeService` 不再独立 start

#### Scenario: 降级到旧路径

- **WHEN** `BRAIN_PROACTION_LEGACY=1`
- **THEN** 旧的 `ProactiveAgentCenter.start()` 与 `ProactiveLifeRuntimeService.start()` 照常启动
- **AND** ProactionCortex 进入 shadow 模式（只记录决策不实际发送）

### Requirement: EvolutionCortex 编排自我进化

系统 SHALL 提供 `EvolutionCortex`，注册 `AgentSelfLearningService / SkillGenerator / SkillPromotionPipeline / HermesEvolutionLoopService` 为子系统，提供统一的能力扩展入口。

#### Scenario: 能力缺口触发进化

- **WHEN** CapabilityCortex 的 `identifyGap` 命中缺失能力，且该缺口在 `gapReport` 中被标记为 `expandable`
- **THEN** EvolutionCortex 创建 `EvolutionProposal`，状态 `pending`
- **AND** 经审批后调用 `SkillGenerator` 生成技能 + `SkillPromotionPipeline` 装载

#### Scenario: 失败轨迹自动触发学习

- **WHEN** `AgentSelfLearningService` 累积的失败轨迹达到阈值
- **THEN** EvolutionCortex 汇总为 `EvolutionProposal { type: "optimize_existing", rationale }`
- **AND** 不由 LLM 自我反思生成

## MODIFIED Requirements

### Requirement: 能力清单注入到 system prompt

**修改为**：能力清单 SHALL 通过 `CapabilityCortex.snapshot()` 在 turn 边界以**最简摘要**注入 system prompt（仅声明"调用 `brain.list_capabilities` 工具可查完整能力清单"），不再硬塞 30+ 工具的完整描述。完整能力查询走工具调用。

## REMOVED Requirements

### Requirement: ProactiveAgentCenter 与 ProactiveLifeRuntimeService 并行独立启动

**Reason**：两套并行判定逻辑与 Jarvis 决策引擎重叠，导致策略互相覆盖与冷却不一致。
**Migration**：由 `ProactionCortex` 统一编排；旧实现保留为 `BRAIN_PROACTION_LEGACY=1` 时的降级路径，不在本 spec 删除代码。
