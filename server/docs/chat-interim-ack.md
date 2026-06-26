# 分阶段异步对话交互（Phased Asynchronous Conversation）

把一次用户请求拆成两段回复，缓解长耗时任务的等待焦虑。

## 设计

| 阶段 | 事件 | 客户端表现 | 服务端动作 |
|------|------|----------|-----------|
| 阶段一「即时确认应答」 | `chat.assistant_interim` | 底部思考气泡先显示"好的，让我查一下…" | 路由判定后立即推送（几十毫秒内） |
| 中间：后台计算 | `tool.call` / `tool.result` / `chat.agent_status` | 思考气泡持续更新为子 Agent 实际进度 | 主 Agent 委派、工具调用、检索 |
| 阶段二「结果交付」 | `chat.assistant_chunk` × N → `chat.assistant_done` | 流式显示真实回复 | LLM 流式生成最终结果 |

- `messageId` 解耦：interim 用 `interim-${traceId}`，真实回复用 `assistant-${traceId}`。
- traceId 复用 `batched.originalMessageId`，与现有轮次跟踪机制对齐。
- 客户端收到首条 `chat.assistant_chunk` 时，interim 自动让位。

## 触发条件

仅在**用户明显会等一会儿**的多步 / 工具型任务上发送，闲聊 / 极短消息不发：

| 路由模式 | 是否发 | 默认模板（无关键词命中时） |
|---------|------|-------------------------|
| `master_delegate` | ✅ | "好的，我先派个助手去处理…" |
| `plan_execute` | ✅ | "好的，我先整理一下思路…" |
| `direct_llm`（带工具） | ✅ | "好的，让我看一下…" |
| `fast_chat` | ❌ | — |
| `master_only`（简单） | ❌ | — |

同时按关键词做轻量润色：

| 关键词 | master_delegate | plan_execute | direct_llm |
|-------|----------------|--------------|------------|
| 天气 / 气温 / weather | "好的，我先看一眼天气…" | "我先确认下天气…" | "让我先查一下天气…" |
| 搜索 / 联网 / search | "好的，我先联网去查…" | "我先查一下资料…" | "让我先查一下…" |
| 写 / 起草 / 翻译 / 润色 | "好的，我先准备一下…" | "我先理一下思路…" | "让我先写一版…" |
| 代码 / debug / sql / api | "好的，我先派个技术助手看一下…" | "我先拆解一下实现步骤…" | "让我先看一下代码…" |

## 环境变量

| 变量 | 默认 | 说明 |
|------|------|------|
| `CHAT_INTERIM_ACK_ENABLED` | `1` | 关闭后不发 interim ack。设 `0/off/false/no` 即关 |

启动日志中会打印 `interimAck=on/off`。

## 时序示例

```text
T+0     用户发送: "查一下明天北京天气"
T+50ms  服务端路由 → master_delegate
T+80ms  → chat.assistant_interim { messageId: "interim-msg-001", text: "好的，我先联网去查…" }
T+90ms  客户端: 思考气泡显示 "好的，我先联网去查…"
T+300ms → chat.agent_status { line: "我派生活助手去查一下天气" }
T+800ms → tool.call { toolName: "weather.fetch" }
T+1.2s  → tool.result { ok: true, ... }
T+1.4s  → chat.assistant_interim 让位 (首条 chunk 抵达)
T+1.4s  → chat.assistant_chunk { messageId: "assistant-msg-001", chunk: "明天" }
T+1.5s  → chat.assistant_chunk { chunk: "北京" }
...
T+1.9s  → chat.assistant_done { finalText: "明天北京晴，18~25°C。" }
```

## 协议事件

### `chat.assistant_interim`（服务端 → 客户端）

```json
{
  "type": "chat.assistant_interim",
  "payload": {
    "sessionId": "user-001",
    "messageId": "interim-msg-001",
    "traceId": "msg-001",
    "mode": "master_delegate",
    "text": "好的，我先联网去查…"
  }
}
```

| 字段 | 说明 |
|------|------|
| `sessionId` | 会话 ID（与 assistant_chunk 一致） |
| `messageId` | `interim-${traceId}`，与 `assistant-${traceId}` 解耦 |
| `traceId` | 原始用户消息 ID（与 chat.assistant_chunk/done 对齐） |
| `mode` | 触发时的路由模式（`master_delegate` / `plan_execute` / `direct_llm`） |
| `text` | 即时确认文本（短句，1~30 字符） |

## 客户端契约

- **必须**按 `traceId` 做轮次匹配：stale 轮次（即 `_pendingAgentUserMessageId` 不匹配时）的 interim 必须丢弃。
- **必须**在首条 `chat.assistant_chunk`（同 traceId）抵达时让位 interim（清空/淡出）。
- **必须**在 `chat.assistant_done` 抵达时清空 interim 状态。

## 关键文件

- 服务端
  - [server/src/agent/interim-ack.ts](../../server/src/agent/interim-ack.ts) — 路由模式 + 关键词润色的模板
  - [server/src/agent/agent-runtime-config.ts](../../server/src/agent/agent-runtime-config.ts) — `InterimAckConfig` & `CHAT_INTERIM_ACK_ENABLED`
  - [server/src/ws/handlers/chat-user-message.ts](../../server/src/ws/handlers/chat-user-message.ts) — `maybeEmitInterimAck` 注入点
  - [server/src/protocol.ts](../../server/src/protocol.ts) — `ServerEventType.ChatAssistantInterim`
- 客户端
  - Flutter 主端：[client/flutter_app/lib/main.dart](../../client/flutter_app/lib/main.dart)（`_interimAckText` 状态 + `_setInterimAck`/`_clearInterimAck`）
  - Flutter 聊天页：[client/flutter_app/lib/features/chat/chat_page.dart](../../client/flutter_app/lib/features/chat/chat_page.dart)（`interimAckText` 入参 + `_processingStatusText` 优先级）
  - Flutter 笔记端：[client/flutter_app/lib/features/notes/notes_chat_page.dart](../../client/flutter_app/lib/features/notes/notes_chat_page.dart)（`_status` 字段复用）
  - Web 端：[server/web/chat/app.js](../../server/web/chat/app.js)（progress-bubble 占位 + 跨轮次清空）

## 自测场景

| 场景 | 期望 |
|------|------|
| 用户发"你好" | 不发 interim（fast_chat 模式） |
| 用户发"查明天北京天气" | interim "好的，我先联网去查…" |
| 用户发"帮我写一个 Python 排序" | interim "好的，我先派个技术助手看一下…"（命中代码关键词） |
| 寒暄"谢谢你" | 不发（NOISE_PREFIXES） |
| 极长消息（>2000 字） | 不发（避免打扰） |
| 轮次被新消息顶掉 | interim 不应在新轮次里出现（traceId 校验） |
| 收到 interim 后立刻 401/网络断 | interim 文本应随 `_clearAgentProcessingState` 一并清空 |
