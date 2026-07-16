# Tasks

- [ ] Task 1: 修复 pinning 绕过 contextual token 预算
  - [ ] SubTask 1.1: 在 `server/src/external-model/resolve-chat-tools.ts` 修改 `applyToolExposureProfile`，使 `pinDesktopVisualTools` 注入的 pinned 工具纳入 `trimToolsToTokenBudget` 核算
  - [ ] SubTask 1.2: 超预算时按优先级裁剪非 pinned 工具的 description（保留 pinned 工具完整 schema，裁剪 contextual 选中工具的 description）
  - [ ] SubTask 1.3: 验证 desktop bridge 在线时实际注入工具 schema token 总数不超过 2200 预算

- [ ] Task 2: 消除 cognize 与 standard path 重复记忆召回
  - [ ] SubTask 2.1: 在 `BrainCenter.cognize` 返回结果中携带 recall 结果（扩展 CognitiveResult 或通过 AgentCore 注入点传递）
  - [ ] SubTask 2.2: 在 `AgentCore.handleUserMessage` 中检测 cognize 已召回结果，复用而非重新调用 `turnLifecycle.prepareNarrativeRecall`
  - [ ] SubTask 2.3: 验证同一轮用户消息仅触发一次 MemoryCortex.recall

- [ ] Task 3: MemoryRecallItem 文本截断
  - [ ] SubTask 3.1: 在 `server/src/brain/memory-cortex.ts` 的 `textToRecallItems` 中对单条 text 施加 800 字符上限
  - [ ] SubTask 3.2: 超长文本截断后追加 `…` 省略标记
  - [ ] SubTask 3.3: 验证 agentic/narrative domain 返回的大段文本被正确截断，limit 仍生效

- [ ] Task 4: 收敛子 Agent maxRounds / maxThreadMessages
  - [ ] SubTask 4.1: 在 `server/src/services/master-agent-coordinator.ts` 调整 `SUB_AGENT_MAX_ROUNDS`：tech 25→15、info 12→10、life 15→10、creative 8→6
  - [ ] SubTask 4.2: 将 `maxThreadMessages` 从 12 收敛到 8
  - [ ] SubTask 4.3: 验证子 Agent 委派在收敛后仍能完成典型任务（不因轮次不足提前终止）

- [ ] Task 5: 主动决策记忆共享
  - [ ] SubTask 5.1: 修改 `ProactionCortex.decide` 返回结果中携带 recall 上下文
  - [ ] SubTask 5.2: `executeProactiveDecision` 复用 decide 阶段的 recall 结果，移除独立的 episodic 召回（`buildProactivePrompt` 中 limit=3 的 recall）
  - [ ] SubTask 5.3: 验证同一 LifeSignal 仅触发一次记忆召回

- [ ] Task 6: 收敛 prompt-context-builder 重叠字段
  - [ ] SubTask 6.1: 在 `server/src/agent/prompt-context-builder.ts` 的 `assembleMemory` 中，当 shortTermTaskContext 非空时跳过 taskContext 注入（互斥）
  - [ ] SubTask 6.2: 验证 system prompt 中不再同时出现 taskContext 与 shortTermTaskContext 完整文本

# Task Dependencies
- Task 2 依赖 Task 3（截断逻辑先行，避免复用未截断结果）
- Task 5 依赖 Task 3（同上）
- Task 1、Task 4、Task 6 相互独立，可并行
