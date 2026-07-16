# Brain Center 神经解剖扩展 Spec

## Why

上一版 Brain Center 只覆盖了 4 个高级皮层（Capability/Awareness/Proaction/Evolution），但人脑类比中还有五块缺位：

1. **感官器官缺位**：ASR / 视觉 / TTS / 端到端语音 LLM 散落在 `voice-dialogue-service` / `desktop-visual` / `voice-capability-service` / `vision.*` 工具，BrainCenter 没有 "耳朵/眼睛/嘴巴" 入口
2. **记忆分区缺位**：短期记忆（`short-term-memory-gateway`）、长期记忆（`agentic-memory` Mem0）、海马体（`human-like-memory-service` 多域 + 睡眠巩固）、叙事（`narrative-memory-port`）四套并行，BrainCenter 没有 "海马体" 统一入口
3. **突触通信缺位**：进程内 `HookBus` + 跨 Agent `MessageHub` + `AipService` + `WsConnectionRegistry` 四套总线，BrainCenter 没有 "胼胝体" 统一通信层
4. **边缘系统缺位**：安全护栏 `agent-task-safety` + 情感计算 `mood-inference` + `emotion-tone` 已存在，但 BrainCenter 没有 "杏仁核" 入口
5. **额叶规划缺位**：`plan-execute-loop` + `master-agent-coordinator` 已是 "CEO"，但 BrainCenter 没有 "前额叶" 入口

本 spec 在已有 BrainCenter 基础上**新增 5 个神经解剖分区**，把现有感官/记忆/通信/安全/规划服务**注册为子系统**（不重写），并保持现有 4 皮层接口向后兼容。**全程不走 prompt 路线**——所有分区入口都是程序化 API，LLM 只在感官输出/规划执行的具体话术环节参与。

## What Changes

### 新增（`server/src/brain/` 下新增 5 个分区文件）

- **`sensory-cortex.ts`**（感官皮层 = 耳朵/眼睛/嘴巴）
  - 注册 `VoiceDialogueService`（ASR + TTS + LLM 三合一）、`VoiceCapabilityService`、桌面视觉子系统（`desktop-visual-port` 或 `vision.*` 工具）
  - 暴露 `listen(audio) / look(opts) / speak(text, opts) / endToEndVoice(audioStream)` 统一入口
  - 多模态融合：把 ASR 文本 + 视觉描述 + 情绪向量融合为统一 `SensoryFrame`

- **`memory-cortex.ts`**（记忆皮层 = 海马体）
  - 注册 `ShortTermMemoryGateway`（工作记忆）、`AgenticMemoryRuntime`（Mem0 长期）、`HumanLikeMemoryService`（多域 + 睡眠巩固）、`NarrativeMemoryFacade`（叙事）
  - 暴露 `remember(actorId, item) / recall(actorId, query, opts) / consolidate(actorIds)` 统一入口
  - 跨域检索：`recallCrossDomain(actorId, query)` 调用 `HumanLikeMemoryService` 的 cross-domain recall
  - 巩固：`consolidate()` 触发 `runSleepConsolidation`（夜间睡眠巩固）

- **`synapse-bus.ts`**（突触总线 = 胼胝体）
  - 以 `HookBus` 为底座，桥接 `MessageHubService`（跨进程消息）+ `AipService`（跨 Agent 协议）+ `WsConnectionRegistry`（WebSocket 推送）
  - 暴露 `fire(type, data, opts) / subscribe(type, handler) / sendToAgent(agentId, msg) / sendToUser(actorId, msg)` 统一入口
  - 统一事件类型扩展（在 `HookEventType` 上加 `sensory.* / memory.* / limbic.* / planner.*`）

- **`limbic-cortex.ts`**（边缘皮层 = 杏仁核 + 情感）
  - 注册 `AgentTaskSafety`（DENIED/HIGH_RISK/ALLOWED 安全护栏）、`MoodInferenceService`（情绪推断）、`AssistantTonePolicy` / `EmotionTone`（情感语气策略）
  - 暴露 `checkSafety(action, ctx) / inferEmotion(actorId, signals) / applyTonePolicy(text, emotion)` 统一入口
  - 危险熔断：`checkSafety` 命中 DENIED 时直接阻止，HIGH_RISK 触发审批

- **`planner-cortex.ts`**（额叶规划皮层）
  - 注册 `PlanExecuteLoop`（先规划后执行）、`MasterAgentCoordinator`（子 Agent 委派 = 左右脑协作）、`TaskRouter`（快慢双系统路由：fast_chat / direct_llm / master_delegate / plan_execute）
  - 暴露 `plan(goal) / execute(plan) / react(observation) / delegate(subAgentType, task)` 统一入口
  - 快慢双系统：`routeSystem(goal)` 返回 System 1（快，模式匹配）或 System 2（慢，深度推理）

### 修改

- **MODIFIED** `server/src/brain/brain-center.ts`：
  - 新增 5 个分区引用（`sensory / memory / synapse / limbic / planner`），均为可选
  - 新增 `registerSensory / registerMemory / registerSynapse / registerLimbic / registerPlanner` 方法
  - 新增 9 个核心方法代理到对应分区：`listen / look / speak / remember / recall / fire / checkSafety / plan / routeSystem`
  - `snapshot(actorId)` 扩展为包含 9 个分区的状态（向后兼容：旧字段保留，新字段为新增）
- **MODIFIED** `server/src/brain/types.ts`：
  - 新增类型：`SensoryFrame / SensoryInput / MemoryItem / MemoryRecallResult / SynapseMessage / SafetyCheckResult / EmotionVector / PlanStep / PlanResult`
- **MODIFIED** `server/src/brain/index.ts`：导出 5 个新分区类
- **MODIFIED** `server/src/bootstrap/create-app-services.ts`：
  - 实例化 5 个新分区
  - 注册现有感官/记忆/通信/安全/规划服务为子系统（不重写其内部实现）
  - 把 5 个新分区注册到 BrainCenter
- **MODIFIED** `server/src/services/hooks/hook-types.ts`：扩展 `HookEventType` 枚举，加入 `sensory.* / memory.* / limbic.* / planner.*` 类型（**BREAKING** 仅对订阅严格类型检查的下游，实际运行时 HookBus 接受任意字符串）

### 不走 prompt 路线的具体含义

- 感官接入：`listen / look / speak` 是程序化 API，ASR/TTS/VLM 直接调用底层服务，不让 LLM 决定 "要不要听/看"
- 记忆检索：`recall` 走 Mem0 语义检索 + 海马体多域检索，不让 LLM 自己想 "我记得什么"
- 突触通信：`fire / subscribe / sendToAgent` 是事件驱动，不让 LLM 自己 "决定要不要通知其他模块"
- 安全护栏：`checkSafety` 是规则匹配 + 正则黑名单，不让 LLM 自我审查
- 规划：`plan / execute` 走 PlanExecuteLoop 状态机，不让 LLM 在 prompt 里自我规划

## Impact

- **Affected specs**：`add-agent-brain-center`（本 spec 是其扩展，向后兼容）、`self_programming`（PlannerCortex 编排）、`embodiment`（后续 Body spec 会消费 SensoryCortex / MemoryCortex 状态）
- **Affected code**：
  - 新增：`server/src/brain/sensory-cortex.ts` / `memory-cortex.ts` / `synapse-bus.ts` / `limbic-cortex.ts` / `planner-cortex.ts`
  - 修改：`server/src/brain/brain-center.ts` / `types.ts` / `index.ts`、`server/src/bootstrap/create-app-services.ts`、`server/src/services/hooks/hook-types.ts`
  - 收编（注册为子系统，不改实现）：`voice-dialogue-service` / `voice-capability-service` / `desktop-visual-port` / `short-term-memory-gateway` / `agentic-memory` / `human-like-memory-service` / `narrative-memory-port` / `hook-bus` / `message-hub-service` / `aip-service` / `ws-connection-registry` / `agent-task-safety` / `mood-inference-service` / `assistant-tone-policy` / `emotion-tone` / `plan-execute-loop` / `master-agent-coordinator` / `task-router`
- **Rollout**：默认开启，`BRAIN_NEURO_ENABLED=0` 时 5 个新分区不实例化，BrainCenter 回退到 4 皮层模式

## ADDED Requirements

### Requirement: SensoryCortex 感官皮层（耳朵/眼睛/嘴巴）

系统 SHALL 提供 `SensoryCortex`，注册 `VoiceDialogueService / VoiceCapabilityService / 桌面视觉子系统` 为子系统，暴露 `listen / look / speak / endToEndVoice` 统一感官入口，**不让 LLM 决定要不要感知**。

#### Scenario: Agent 听用户语音

- **WHEN** 调用 `sensoryCortex.listen(audioBuffer, { language })`
- **THEN** 委托 `VoiceDialogueService.transcribeAudio` 返回 `ASRResult`
- **AND** 把识别结果与 `AwarenessCortex` 的当前 `UserActivityState` 融合为 `SensoryFrame` 推给 SynapseBus

#### Scenario: Agent 看屏幕

- **WHEN** 调用 `sensoryCortex.look({ region?, capture })`
- **THEN** 委托桌面视觉子系统截屏 + 可选 VLM 描述
- **AND** 返回 `SensoryFrame { visual: { screenshot, description } }`

#### Scenario: Agent 说话

- **WHEN** 调用 `sensoryCortex.speak(text, { voiceId })`
- **THEN** 委托 `VoiceDialogueService.synthesizeSpeech` 返回 `AudioBuffer`
- **AND** 同时通过 SynapseBus 发射 `sensory.speak` 事件

### Requirement: MemoryCortex 记忆皮层（海马体）

系统 SHALL 提供 `MemoryCortex`，注册 `ShortTermMemoryGateway / AgenticMemoryRuntime / HumanLikeMemoryService / NarrativeMemoryFacade` 为子系统，暴露 `remember / recall / recallCrossDomain / consolidate` 统一记忆入口，**不让 LLM 自己想"我记得什么"**。

#### Scenario: 短期记忆写入

- **WHEN** 调用 `memoryCortex.remember(actorId, { kind: "task", content, sessionId })`
- **THEN** 委托 `ShortTermMemoryGateway` 写入工作记忆
- **AND** 若 `importance >= high`，同时通过 `AgenticMemoryRuntime.ingest` 写入长期记忆

#### Scenario: 跨域检索

- **WHEN** 调用 `memoryCortex.recallCrossDomain(actorId, query)`
- **THEN** 委托 `HumanLikeMemoryService` 的 cross-domain recall
- **AND** 返回多域结果合并后的 `MemoryRecallResult`

#### Scenario: 睡眠巩固

- **WHEN** 调用 `memoryCortex.consolidate(actorIds)`
- **THEN** 委托 `NarrativeMemoryFacade.runSleepConsolidation`
- **AND** 返回巩固统计（dailyCleanupCount / weeklyMergedCount / ...）

### Requirement: SynapseBus 突触总线（胼胝体）

系统 SHALL 提供 `SynapseBus`，以 `HookBus` 为底座，桥接 `MessageHubService / AipService / WsConnectionRegistry`，暴露 `fire / subscribe / sendToAgent / sendToUser` 统一通信入口。

#### Scenario: 进程内事件分发

- **WHEN** 调用 `synapse.fire("sensory.look", { screenshot }, { actorId })`
- **THEN** 委托 `HookBus.emit` 分发给所有订阅者
- **AND** 自动记录到 `MessageHubService` 历史（可选）

#### Scenario: 跨 Agent 通信

- **WHEN** 调用 `synapse.sendToAgent(targetAgentId, message)`
- **THEN** 委托 `AipService.dispatch` 发送到目标 Agent
- **AND** 同时通过 HookBus 发射 `synapse.agent_message` 事件

#### Scenario: 推送给用户

- **WHEN** 调用 `synapse.sendToUser(actorId, payload)`
- **THEN** 委托 `WsConnectionRegistry.trySend`
- **AND** 失败时降级到 `MessageHubService` 离线存储

### Requirement: LimbicCortex 边缘皮层（杏仁核 + 情感）

系统 SHALL 提供 `LimbicCortex`，注册 `AgentTaskSafety / MoodInferenceService / AssistantTonePolicy / EmotionTone` 为子系统，暴露 `checkSafety / inferEmotion / applyTonePolicy` 统一入口，**安全检查不走 LLM**。

#### Scenario: 危险操作熔断

- **WHEN** Agent 准备执行 `shell.exec({ command: "rm -rf /" })`
- **AND** 调用 `limbic.checkSafety({ tool: "shell.exec", args: { command } })`
- **THEN** 返回 `{ allowed: false, reason: "DENIED: 匹配黑名单", severity: "denied" }`
- **AND** BrainCenter 不允许该工具调用继续

#### Scenario: 情感推断

- **WHEN** 调用 `limbic.inferEmotion(actorId, { text, voiceTone, faceMetrics })`
- **THEN** 委托 `MoodInferenceService` 推断
- **AND** 返回 `EmotionVector { valence, arousal, dominance, label }`

#### Scenario: 语气策略应用

- **WHEN** 调用 `limbic.applyTonePolicy(text, emotion)`
- **THEN** 委托 `AssistantTonePolicy` 决定语气
- **AND** 返回 `{ rewrittenText, toneProfile }`

### Requirement: PlannerCortex 额叶规划皮层

系统 SHALL 提供 `PlannerCortex`，注册 `PlanExecuteLoop / MasterAgentCoordinator / TaskRouter` 为子系统，暴露 `plan / execute / react / delegate / routeSystem` 统一入口，**规划走状态机不走 prompt**。

#### Scenario: 任务拆解

- **WHEN** 调用 `planner.plan("帮用户规划北京三日游")`
- **THEN** 委托 `PlanExecuteLoop` 拆解为有序 `PlanStep[]`
- **AND** 每个 step 标注 expectedTools / dependencies

#### Scenario: ReAct 闭环

- **WHEN** 调用 `planner.react(observation)`
- **THEN** 把 observation 反馈给 PlanExecuteLoop
- **AND** 返回下一个 action（继续 / 重试 / 终止）

#### Scenario: 子 Agent 委派（左右脑协作）

- **WHEN** 调用 `planner.delegate("research", { task })`
- **THEN** 委托 `MasterAgentCoordinator.invokeSubAgent`
- **AND** 返回 `SubAgentResult`

#### Scenario: 快慢双系统路由

- **WHEN** 调用 `planner.routeSystem(userMessage)`
- **THEN** 委托 `TaskRouter` 判定
- **AND** 返回 `{ system: "system1" | "system2", mode: "fast_chat" | "direct_llm" | "master_delegate" | "plan_execute" }`

### Requirement: BrainCenter 扩展为 9 分区

系统 SHALL 把 `BrainCenter` 从 4 皮层扩展为 9 分区（4 旧 + 5 新），新增 `registerSensory / registerMemory / registerSynapse / registerLimbic / registerPlanner` 方法，新增 9 个核心方法代理到对应分区。**旧 4 皮层接口向后兼容**。

#### Scenario: 9 分区完整快照

- **WHEN** 调用 `brainCenter.snapshot(actorId)`
- **THEN** 返回包含 9 个分区状态的 `BrainSnapshot`（旧字段 `capabilities / userActivity / lastDecisions / pendingEvolutions` 保留，新增 `sensory / memory / synapse / limbic / planner` 字段）

#### Scenario: 降级到 4 皮层

- **WHEN** `BRAIN_NEURO_ENABLED=0`
- **THEN** 5 个新分区不实例化
- **AND** BrainCenter 的 `listen / look / speak / remember / recall / fire / checkSafety / plan / routeSystem` 返回降级响应
- **AND** 旧 4 皮层方法（introspect / observe / decide / evolve）行为不变

## MODIFIED Requirements

### Requirement: BrainCenter 核心方法集

**修改为**：BrainCenter SHALL 暴露以下 13 个核心方法（4 旧 + 9 新）：
- 旧：`introspect / observe / decide / evolve / snapshot`
- 新：`listen / look / speak / remember / recall / fire / checkSafety / plan / routeSystem`
- 旧方法签名不变；新方法在对应分区缺失时优雅降级

## REMOVED Requirements

无。本 spec 不删除任何现有能力，只扩展。
