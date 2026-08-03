# 异步回复/垫词机制重构方案

## Summary

把当前的「垫词 + 流式回复」两条独立消息路径，改造成「同一条流式消息分多次推送」的单一路径，从根本上消除"重复回复"问题，并模拟真人"边想边说"的节奏。

核心改动：
- **服务端**：`chat.assistant_interim` 改为"为同一条 assistant 消息预下第一段文本"（不再用独立 messageId），`chat.assistant_chunk` 继续往同一条消息推后续段，`chat.assistant_done` 收尾。
- **客户端**：interim / chunk / done 三种事件都按同一个 `messageId` 合并到一条 assistant 消息，不再入库成两条。
- **新增 PhasedReplyController**：在主回复阶段按语义边界（句号/段落/换行）把 finalText 自适应切成 1~N 段，段间随机停顿，模拟人敲字节奏。

---

## Current State Analysis

### 1. 重复的根因

[chat-user-message.ts](file:///e:/ws-project/Private-Agent/server/src/ws/handlers/chat-user-message.ts) 中：

- 第 369~393 行：`LivingInterimController` 推送 `chat.assistant_interim`，**`messageId = interim-${traceId}-${seq}`**（独立 ID）
- 第 305 行：主回复的 `messageId = assistant-${batched.originalMessageId}`（不同 ID）

**客户端** [main.dart](file:///e:/ws-project/Private-Agent/client/flutter_app/lib/main.dart) 第 755~794 行：
- `chat.assistant_interim` 收到后作为独立 ChatMessage 入列表（messageId=interim-xxx）
- `chat.assistant_done` 收到后用 `assistant-xxx` 又是另一条 ChatMessage 入列表

→ 用户看到两条不同 messageId、不同内容的回复，体感"重复"。

### 2. 当前 interim 设计的其他问题

- `sanitizeInterimText` 截断 72 字后，LLM 倾向输出"好的"开场白，与主回复开头经常语义重叠
- 阅读延迟 0.8~1.6s + LLM 调用 3~4s + chunk 推送，整链路 5~8 秒后用户才能看到完整回复第一段
- 没有"分次"概念：主回复只能整体一次性或流式一次性推完

### 3. 涉及文件

| 文件 | 角色 |
|------|------|
| [interim-ack.ts](file:///e:/ws-project/Private-Agent/server/src/agent/interim-ack.ts) | LivingInterimController 主体 |
| [chat-user-message.ts](file:///e:/ws-project/Private-Agent/server/src/ws/handlers/chat-user-message.ts) | WS 处理器，调用 controller + 推 chunk/done |
| [protocol.ts](file:///e:/ws-project/Private-Agent/server/src/protocol.ts) | 事件类型定义 |
| [main.dart](file:///e:/ws-project/Private-Agent/client/flutter_app/lib/main.dart) | 客户端事件处理 (interim/chunk/done handler) |
| [agent-runtime-config.ts](file:///e:/ws-project/Private-Agent/server/src/agent/agent-runtime-config.ts) | 运行时配置 `interimAck.enabled` |

---

## Proposed Changes

### 改动 1：服务端 interim 改为「预下首段」

**目标**：消除独立 messageId，让 interim / chunk / done 共用同一个 messageId。

**文件**：[chat-user-message.ts](file:///e:/ws-project/Private-Agent/server/src/ws/handlers/chat-user-message.ts) 第 369~393 行

**改动**：
- 移除 `interimController.send` 中的 `interimAckMessageId(traceId, seq)`，改为复用 `assistantMessageId = assistant-${batched.originalMessageId}`
- 推送事件从 `ChatAssistantInterim` 改为 `ChatAssistantChunk`（**类型合并**），但保留 `phase: "interim"` 字段供客户端区分
- 客户端的 `_clearInterimAck` 调用（`main.dart` 第 851 行）变为 no-op（chunk 到达时自动续写，不需要清空旧占位）

**改动 2**：客户端按同一 messageId 合并渲染

**文件**：[main.dart](file:///e:/ws-project/Private-Agent/client/flutter_app/lib/main.dart) 第 755~868 行

**改动**：
- 删除 `chat.assistant_interim` 类型的事件处理分支
- 改在 `chat.assistant_chunk` 处理器内：根据 `payload["phase"]` 判断：
  - `phase == "interim"` → 创建/获取 messageId 对应的 ChatMessage，作为该消息的"首段"入库
  - `phase == undefined / "stream"` → 续写到已存在的 ChatMessage
- 移除 `_interimAckText` / `_clearInterimAck` 相关字段

**改动 3**：新增 PhasedReplyController（核心新增）

**目标**：让主回复也按语义边界分次推送，模拟真人说话节奏。

**新增文件**：[server/src/agent/phased-reply-controller.ts](file:///e:/ws-project/Private-Agent/server/src/agent/phased-reply-controller.ts)

**API 形态**：
```typescript
export interface PhasedReplyConfig {
  sendChunk: (text: string, phase: "interim" | "stream") => void;  // 复用现有 sendAssistantChunk
  isCancelled: () => boolean;
}

export async function emitPhasedReply(
  fullText: string,
  config: PhasedReplyConfig
): Promise<void>;
```

**切分规则**（自适应 1~N 段）：
- 文本 ≤ 20 字：1 段直接发
- 文本 ≤ 60 字：最多 2 段（按第一个句号/问号/感叹号/换行切）
- 文本 > 60 字：按段落（`\n\n`）/句号边界切 2~4 段
- 每段最短 15 字，避免碎得太零散

**段间停顿**（拟人化）：
- 第一段立即推（用户已等够久了）
- 后续段：800ms ~ 2500ms 随机停顿
- 停顿中如检测到 `isCancelled()`（用户发了新消息打断）→ 立即停止后续段

**实现位置**：[chat-user-message.ts](file:///e:/ws-project/Private-Agent/server/src/ws/handlers/chat-user-message.ts) 中：
- 第 588~589 行：把 `chunkText(reply.text, 12).forEach(sendAssistantChunk)` 改为 `await emitPhasedReply(reply.text, ...)`
- 第 652~660 行：`sendAssistantChunk(scheduleOutcome)` 同样改成走 `emitPhasedReply`

**改动 4**：垫词 + 主回复统一到 chunk 通道

**文件**：[interim-ack.ts](file:///e:/ws-project/Private-Agent/server/src/agent/interim-ack.ts) 第 350~393 行

**改动**：
- `LivingInterimController.send` 不再区分 eventType，复用 `sendAssistantChunk` 路径
- 移除 `chat.assistant_interim` 事件相关的所有代码
- 删除 `interimAckMessageId` 函数（不再需要独立 messageId）
- 但保留 `LivingInterimController` 的语义门控（`shouldEmitInitial` / `looksLikeActualAnswer`），只是出口换成 `sendChunk`

**改动 5**：LLM prompt 强化"避免与主回复重复"

**文件**：[interim-ack.ts](file:///e:/ws-project/Private-Agent/server/src/agent/interim-ack.ts) 第 41~53 行

**改动**：在 initial prompt 中加入：
```
- You're saying the FIRST sentence of your reply, not a separate acknowledgment.
- Do not duplicate content that your main reply will cover — just open the topic naturally.
- Treat what you say here as the opening of your real answer, not a placeholder.
```

这条 prompt 引导 LLM 把垫词当作回复首段去写，从源头降低重复概率。

**改动 6**：协议层清理

**文件**：[protocol.ts](file:///e:/ws-project/Private-Agent/server/src/protocol.ts) 第 89 行

**改动**：
- 废弃 `ChatAssistantInterim`（保留 enum 兼容旧客户端，但新代码不再发送）
- 给 `ChatAssistantChunk` payload 加可选 `phase: "interim" | "stream"` 字段（默认 stream）

---

## Assumptions & Decisions

1. **保留 `LivingInterimController` 类名不变**，但内部出口换成 `sendChunk`。改名成本大、收益小。
2. **不删除 `interimAck.enabled` 配置开关**：用户可一键关闭整个垫词体系（保持向后兼容）。
3. **段间停顿上限 2500ms**：再长会让人怀疑"是不是卡了"。
4. **切分时不调 LLM**：纯规则（标点/换行/字数），避免给 LLM 增加新负担；LLM 已经在 streaming 时按自然节奏停顿了，我们只是再切一次。
5. **打断响应**：用户在分次中途发新消息时，正在进行的 `emitPhasedReply` 立即取消（`isCancelled` 检测），不会把后续段拼到错位的消息上。
6. **保留 ChatAssistantInterim 事件类型 6 个月**作为废弃过渡：旧客户端仍能工作，只是 interim 和 done 仍会渲染成两条。

---

## Verification

### 单元/集成验证
1. **重复消除**：连发 5 条消息，检查每条只渲染成 1 条 assistant 消息（之前是 2 条）
2. **分次节奏**：构造一段 200 字主回复，观察是否被切成 2~3 段推送，每段间 0.8~2.5s
3. **打断响应**：分次中途用户发新消息，原消息后续段不再推送，新消息从新 turn 开始
4. **短消息无分次**：≤ 20 字的回复仍为 1 段，不出现"碎段"
5. **prompt 重复度**：让 LLM 跑 10 轮相同用户消息，统计垫词首字和主回复首字的语义相似度（人工或 embedding 余弦），目标 < 0.4

### 回归测试
- `chat.assistant_interim` 事件还能被旧客户端收到并渲染（兼容期）
- `interimAck.enabled=false` 时整个垫词链路关掉，主回复仍正常
- 工具执行（tool call/result）期间的分次回复不受影响
- 流式 chunk 已在推送的情况下，interim 不再触发（`isMainReplyStarted` 门控保留）

### 人工体验验证（截图 + 录屏）
- 长消息场景：观察用户是否感觉"AI 在边想边说"，而不是"AI 突然吐出一大段"
- 短消息场景：观察是否仍感觉自然，不出现"AI 说话结巴"
