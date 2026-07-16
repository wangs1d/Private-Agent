# Checklist

- [x] `pinDesktopVisualTools` 注入的 pinned 工具纳入 `trimToolsToTokenBudget` 核算，不再绕过 2200 token 预算
- [x] desktop bridge 在线时实际注入工具 schema token 总数 ≤ 2200
- [x] 超预算时非 pinned 工具的 description 被裁剪，pinned 工具 schema 保持完整
- [x] `BrainCenter.cognize` 返回结果携带 recall 上下文
- [x] `AgentCore.handleUserMessage` 在 cognize 已召回时复用结果，不重复调用 MemoryCortex.recall
- [x] 同一轮用户消息仅触发一次记忆召回
- [x] `MemoryCortex.textToRecallItems` 对单条 text 施加 800 字符截断
- [x] 截断文本追加 `…` 省略标记
- [x] agentic/narrative domain 大段文本被正确截断，limit 仍生效
- [x] `SUB_AGENT_MAX_ROUNDS`：tech≤15、info≤10、life≤10、creative≤6
- [x] `maxThreadMessages` 收敛到 8
- [x] 子 Agent 委派在收敛后仍能完成典型任务
- [x] `ProactionCortex.decide` 返回结果携带 recall 上下文
- [x] `executeProactiveDecision` 复用 decide 阶段 recall，移除独立 episodic 召回
- [x] 同一 LifeSignal 仅触发一次记忆召回
- [x] `assembleMemory` 中 shortTermTaskContext 非空时跳过 taskContext 注入
- [x] system prompt 不再同时出现 taskContext 与 shortTermTaskContext 完整文本
- [x] `tsc --noEmit` 零错误
