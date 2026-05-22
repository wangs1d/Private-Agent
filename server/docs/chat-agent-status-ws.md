# WebSocket：`chat.agent_status`（模型生成的活人感进度）

委派子 Agent 时，客户端应监听 `chat.agent_status`，用 `payload.line` 替换固定「思考中」文案。

## 事件

### `chat.agent_status`

```json
{
  "type": "chat.agent_status",
  "payload": {
    "sessionId": "session-mvp-001",
    "messageId": "assistant-user-msg-id-xxx",
    "traceId": "user-msg-id-xxx",
    "phase": "delegate_start",
    "line": "我派生活助手去帮你盯明早七点的闹钟了",
    "agentType": "life",
    "subAgentDisplayName": "生活助手",
    "toolName": "master.invoke_sub_agent"
  }
}
```

| 字段 | 说明 |
|------|------|
| `phase` | `delegate_start`：主 Agent 刚委派；`delegate_done`：子 Agent 收尾一句 |
| `line` | **模型生成**的口语化短句，直接展示 |
| `agentType` | life / work / social / … |
| `subAgentDisplayName` | 中文角色名（辅助展示，勿替代 line） |

### 时序

1. `tool.call`（`master.invoke_sub_agent`，含 `input.userStatusLine`）
2. **`chat.agent_status`** `delegate_start` ← 用 `line` 更新 UI
3. `tool.result`（含可选 `uiDoneLine`）
4. **`chat.agent_status`** `delegate_done`（若子 Agent 报告含 `【用户可见进度】`）

## 文案来源（非固定模板）

- **开始**：主 Agent 调用 `master_invoke_sub_agent` 时必填参数 `userStatusLine`
- **结束**：子 Agent 报告最后一行 `【用户可见进度】…`（子 Agent 模型自写）

## 客户端示例（伪代码）

```dart
void onWsMessage(Map m) {
  if (m['type'] == 'chat.agent_status') {
    final line = m['payload']['line'] as String;
    setThinkingText(line); // 如「Agent：$line」
  }
}
```
