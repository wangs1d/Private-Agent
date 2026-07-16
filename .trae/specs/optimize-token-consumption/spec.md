# 优化 Brain Center Token 消耗 Spec

## Why
当前 Brain Center 架构存在多处 Token 浪费：工具 schema 被 pinning 强制注入绕过 contextual 预算、cognize 与主对话路径重复召回记忆、子 Agent maxRounds=25 配合 maxThreadMessages=12 导致单次委派消耗失控、MemoryCortex 返回整段未截断文本。这些浪费推高单轮交互成本，阻碍贾维斯级持续感知与主动行动的可持续运行。

## What Changes
- 修复 `pinDesktopVisualTools` 绕过 contextual token 预算的问题：pinned 工具纳入预算核算
- 消除 `BrainCenter.cognize` 与 `AgentCore.handleUserMessage` 在同一轮用户消息上的重复记忆召回
- 收敛子 Agent `maxRounds` / `maxThreadMessages` 配置，避免 tech=25 轮 × 12 条历史的失控场景
- `MemoryCortex.recall` 返回的 `MemoryRecallItem` 文本按上限截断
- `executeProactiveDecision` 与 `EndToEndDecisionMaker` 复用同一次记忆召回结果
- 收敛 `prompt-context-builder.assembleMemory` 中语义重叠的字段（taskContext 与 shortTermTaskContext）

## Impact
- Affected specs: `add-agent-brain-center`、`extend-brain-neuroanatomy`
- Affected code:
  - `server/src/external-model/resolve-chat-tools.ts`（pinning 预算核算）
  - `server/src/brain/brain-center.ts`（cognize 阶段记忆去重）
  - `server/src/agent/agent-core.ts`（复用 cognize 召回结果）
  - `server/src/services/master-agent-coordinator.ts`（maxRounds/maxThreadMessages）
  - `server/src/brain/memory-cortex.ts`（textToRecallItems 截断）
  - `server/src/bootstrap/create-app-services.ts`（EndToEndDecisionMaker 与 executeProactiveDecision 共享 recall）
  - `server/src/agent/prompt-context-builder.ts`（字段收敛）

## ADDED Requirements

### Requirement: 工具 Schema 预算统一核算
系统 SHALL 在所有工具暴露路径上（contextual / scoped / pinned）统一执行 token 预算核算，pinned 工具不得绕过预算上限。

#### Scenario: desktop bridge 在线时工具暴露
- **WHEN** desktop bridge 在线且 ProactionCortex 触发 executeProactiveDecision
- **THEN** pinned desktop 工具与 contextual 筛选工具共同纳入 2200 token 预算
- **AND** 超出预算时按优先级裁剪非 pinned 工具的 description

### Requirement: 单轮记忆召回去重
系统 SHALL 在同一轮用户消息处理中避免重复执行记忆召回，cognize 阶段已召回的结果 SHALL 在后续 standard path 中复用。

#### Scenario: cognize 成功后的主对话路径
- **WHEN** BrainCenter.cognize 完成认知且需进入 standard path 工具循环
- **THEN** AgentCore.handleUserMessage 复用 cognize 阶段的 recall 结果
- **AND** 不再重复调用 MemoryCortex.recall

### Requirement: MemoryRecallItem 文本截断
系统 SHALL 对 MemoryCortex.recall 返回的每条 MemoryRecallItem.text 施加上限截断，防止单条召回文本无限膨胀。

#### Scenario: agentic memory 返回大段文本
- **WHEN** agentic domain 返回单段超过 800 字符的文本
- **THEN** 该文本被截断至 800 字符并追加省略标记
- **AND** 召回结果 item 数量仍遵循调用方指定的 limit

### Requirement: 子 Agent 配置收敛
系统 SHALL 对子 Agent 的 toolLoop.maxRounds 与 maxThreadMessages 收敛到合理上限，防止单次委派 Token 失控。

#### Scenario: tech 子 Agent 委派
- **WHEN** tech 类型子 Agent 被委派执行任务
- **THEN** maxRounds 上限不超过 15（原 25）
- **AND** maxThreadMessages 上限不超过 8（原 12）

### Requirement: 主动决策记忆共享
系统 SHALL 在 ProactionCortex.decide 与 executeProactiveDecision 之间共享同一次记忆召回结果，避免对同一信号重复召回。

#### Scenario: 主动信号触发完整决策链
- **WHEN** LifeSignal 触发 ProactionCortex.decide 并通过话术决策
- **THEN** executeProactiveDecision 复用 decide 阶段的 recall 结果
- **AND** 不再独立调用 recallRecentMemories / buildProactivePrompt 中的 episodic 召回

## MODIFIED Requirements

### Requirement: 主 Agent 上下文组装
`prompt-context-builder.assembleMemory` 组装的 system prompt 中，语义重叠字段 SHALL 进行合并或互斥，避免 taskContext 与 shortTermTaskContext 同时以完整长度注入。
