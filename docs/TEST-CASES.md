# 日程模块测试用例（MVP）

## 功能测试
- 创建提醒任务：提交后可查询到任务，状态为 `active`。
- 创建动作任务：合法 URL 可保存成功。
- 到点触发提醒任务：生成成功运行记录，包含提醒内容。
- 到点触发动作任务：调用 API 成功并记录输出。
- 动作任务失败：记录失败原因并在 1 分钟后重试一次。
- 重复任务（daily/weekly）：执行后正确更新 `nextRunAt`。
- 一次性任务：执行成功后状态变为 `completed`。
- 任务暂停：暂停后到点不执行；恢复后继续调度。
- 任务取消：取消后 `nextRunAt` 为空，不再触发。
- 手动触发：`/schedule/tasks/:taskId/trigger` 可立即执行一次。

## 界面测试
- 日历加载：切换月份后请求时间范围正确。
- 标签颜色：提醒/动作/失败/完成四种状态展示正确。
- 详情抽屉：操作后状态与下一次执行时间即时刷新。
- 表单校验：提醒任务缺少文案、动作任务缺少 URL 时阻止提交。

## 性能测试
- 1000 条任务数据下，`GET /schedule/tasks` 响应时间可接受（本地 < 300ms）。
- 调度器连续执行 100 次任务后内存无明显异常增长。
- 服务重启后加载任务数据时间可接受（本地 < 1s）。

## 回归重点
- 任务创建/更新 API 参数兼容性。
- 定时触发精度（分钟级）。
- 执行失败时的错误透传与重试逻辑。

---

## AIP v0.1（跨 Agent 结构化消息）

### 功能测试
- **`aip.dispatch`（工具）**：合法 `trade_proposal` 生成 `proposalId`，收件方 `trade_response` 可更新状态；未配对且开启 `AGENT_RELAY_REQUIRE_PAIR` 时拒绝。
- **WebSocket `aip.dispatch`**：与工具等价，成功推送 `AgentPeerMessage` 且 `payload.aip` 非空。
- **`GET /agent/aip/state`**：`sessionId` 正确时返回与该 session 相关的 `alliances`、`openConflicts`。
- **`aip.get_proposal`**：仅参与方可读；无关 session 返回错误或拒绝。
- **持久化**：成功投递后 `data/aip-state.json`（或 `AIP_STATE_FILE`）含对应 `proposals` / `alliances` / `conflicts`；**重启服务**后 `GET /agent/aip/state` 与 `aip.get_proposal` 结果与重启前一致。
- **审计**：每次成功投递后 `logs/audit.log` 新增一行 JSON，`type` 为 `aip_dispatch`，含 `kind`、`messageId`；经 `chat.user_message` 触发的工具链路还应含 **`chatUserMessageId`**，与 `GET /agent/inbox` 条目中该字段一致。
- **会话关联**：同一条用户消息触发的 `aip.dispatch` / `agent.send_to_peer`，其中继记录应带相同 `chatUserMessageId`。

### 界面 / 客户端
- 协作收件 UI：**不对终端用户**展示 `aip` 结构化体或突出展示 `chatUserMessageId`；仅摘要级文案。
- 错误信息（配对失败、未知 `proposalId`）对用户可读。

### 回归重点
- AIP 校验失败时不落盘、不写审计。
- `alliance_response` 接受后结盟记录出现在双方 state 查询中。
