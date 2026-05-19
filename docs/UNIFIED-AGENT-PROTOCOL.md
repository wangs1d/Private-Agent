# 统一 Agent 协议（UAP v0.1）

**版本**：0.1  
**状态**：与仓库实现同步（`agent-world/protocol-unified.ts`、`server/src/ws/connection.ts`、`*-tools`、`*-service`）  

UAP 在 **[AWP v0.1](./AGENT-PROTOCOL-CATALOG.md#awp-v01)** 的传输信封与会话模型之上，把 **L1–L6** 通用能力收敛为同一套 **WebSocket 事件名、HTTP 只读面、进程内工具名** 与 **发现元数据**，便于人、客户端与多模型 Agent 共用。

**与相邻规范的关系**：

| 规范 | 职责 |
|------|------|
| **AWP** | 根传输、`session.init`、世界分区 `world.partition.*`、错误 `error.event` |
| **AIP** | 跨 Agent 结构化语义（结盟、冲突、交易意向等） |
| **UAP（本文）** | 算力配额、记忆同步切片、人类指令审计、治理探针、能力发现 |

---

## 1. 设计原则

1. **同一语义，多入口**：同一操作可通过 WS 帧或 Tool 调用（Tool 侧以 **`resolveActorId`（`userId` 优先于 `sessionId`）** 为权威主体，防跨主体伪造）。
2. **与 AWP 兼容**：WS 消息仍为顶层 JSON：`{ "type": string, "payload": object, "traceId"?: string }`（`traceId` 可选，建议与 AWP 一致）。
3. **渐进实现**：L2（全局广播除世界外）等能力可先在 manifest 中留空，由 AWP `world.*` 承担。
4. **审计**：人类指令与工具路径写入 `logs/audit.log`（内容脱敏策略与现有审计一致）。

---

## 2. 发现

### 2.1 `GET /.well-known/agent-world`

响应 JSON 中的 **`unifiedProtocol`** 字段：

| 键 | 说明 |
|----|------|
| `version` | `"0.1"` |
| `wsClientEvents` | 客户端可发送的 `type` 列表 |
| `wsServerEvents` | 服务端可能推送的 `type` 列表 |
| `tools` | 与 WS 对齐的 Tool 名称列表 |
| `http` | `quotaPath`、`memoryPath` |
| `layers` | L1–L6 能力声明（`UNIFIED_LAYER_MANIFEST`） |

### 2.2 能力握手（可选）

- **客户端 → 服务端**：`type: "protocol.unified.capabilities"`，`payload: { "traceId"?: string }`
- **服务端 → 客户端**：`type: "protocol.unified.capabilities"`，`payload` 含 `ok`、`unifiedProtocol`、`layers`、`traceId`

无需 `session.init` 即可调用（便于探针）。

---

## 3. 会话与安全

除 **`protocol.unified.capabilities`** 外，其余 UAP 客户端事件要求连接已发送 **`session.init`**。

- **`session.init`**：`payload` 可提供 **`userId`**（稳定登录/账号 id）与/或 **`sessionId`**（连接级 id）。服务端 **`boundActorId = trim(userId) || trim(sessionId)`**，个人房世界分区与 UAP 记忆/配额均按该 **actor** 隔离。
- **UAP 载荷**：`protocol.unified.*` 的 `payload` 中 **`userId` 与 `sessionId` 至少填其一**；若两者皆填，须与连接在 `session.init` 中声明的一致（与 `boundActorId` 对齐），否则返回 `error.event`，`code` 为 `SESSION_REQUIRED` 或 `FORBIDDEN`。

---

## 4. WebSocket 事件与载荷

### 4.1 算力配额（L3）

**客户端**：`protocol.unified.quota.adjust`

```json
{
  "userId": "<可选，与 session.init 一致，优先>",
  "sessionId": "<可选，与 session.init 一致>",
  "op": "reserve" | "consume" | "release",
  "units": <正整数>,
  "reason": "<可选，简短说明>",
  "traceId": "<可选>"
}
```

**服务端**：`protocol.unified.quota.state`

```json
{
  "ok": true | false,
  "op": "<回显>",
  "units": <回显>,
  "limit": <number>,
  "reserved": <number>,
  "consumed": <number>,
  "available": <number>,
  "reason": "<失败时，如 INSUFFICIENT_QUOTA | RESERVE_UNDERFLOW>",
  "traceId": "<可选>"
}
```

**语义**：

- `reserve`：从 `available` 划入 `reserved`。
- `release`：`reserved` 释放回可用池。
- `consume`：优先冲减 `reserved`，不足部分从剩余可用扣减，并增加已消费计数。

**环境变量**：

| 变量 | 含义 |
|------|------|
| `COMPUTE_QUOTA_DEFAULT_UNITS` | 每会话默认上限（默认 `1000000`） |
| `COMPUTE_QUOTA_UNITS_PER_MODEL_CALL` | 若设为 **正整数**，每次外部模型 **`streamCompletion` 成功** 后自动 `consume` 该单位数；不足时在助手文本末尾追加提示，**不阻断**本次回复 |

### 4.2 记忆同步切片（L4）

用于跨客户端/Agent 对齐 **短期 KV**（非替代本地长期向量库）。

**补丁**：`protocol.unified.memory.patch`

```json
{
  "userId": "<可选>",
  "sessionId": "<可选，与 userId 至少其一>",
  "basisRevision": <非负整数，乐观并发>,
  "patches": [
    { "key": "<string>", "op": "put", "value": <JSON 可序列化> },
    { "key": "<string>", "op": "delete" }
  ],
  "traceId": "<可选>"
}
```

**读取**：`protocol.unified.memory.get`

```json
{
  "userId": "<可选>",
  "sessionId": "<可选，与 userId 至少其一>",
  "keys": ["<可选，限定键列表>"],
  "traceId": "<可选>"
}
```

**服务端**：`protocol.unified.memory.snapshot`

成功补丁：

```json
{
  "ok": true,
  "revision": <新 revision>,
  "entries": { "<key>": <value> },
  "traceId": "<可选>"
}
```

`basisRevision` 不匹配：

```json
{
  "ok": false,
  "reason": "REVISION_MISMATCH",
  "currentRevision": <number>,
  "traceId": "<可选>"
}
```

**持久化**：默认文件 `data/agent-memory-sync.json`，可用 **`AGENT_MEMORY_SYNC_FILE`** 覆盖。

**聊天 system 注入（可选）**：若设置环境变量 **`AGENT_PROMPT_MEMORY_KEYS`** 为逗号分隔键列表，服务端在每次调用外部模型前从当前 **actor**（`userId` 优先）的快照读取这些键，按分层拼入 system（顺序见 [`docs/ARCHITECTURE.md`](./ARCHITECTURE.md)「长期演化与身份记忆」）：`persona` / `soul` →「人格与角色」；`values` / `values_profile` →「价值观与原则」；`abilities` / `skill_tendencies` →「能力倾向」；**其余键** →「持久记忆与偏好」（带键名小标题）。长期演化推荐示例：`persona,values,abilities,memory_summary`。设为 `off`、`false` 或 `0` 或不设置时**不注入**，与旧行为一致。

**养成履历自动写入（服务端）**：世界内 **入账**（`creditCredits`）与 **购技能**（`purchaseSkill`）成功后，若未设置 **`AGENT_EVOLUTION_MEMORY_AUTOPATCH=off`**（或 `0` / `false`），服务端会向 UAP 键 **`memory_summary`** 追加一行中文短履历（受控 patch，带 revision 重试）。单行过长或总长度超过 **`AGENT_MEMORY_SUMMARY_MAX_CHARS`**（默认 `16000`）时会截断尾部，避免无限增长。

### 4.3 人类轻干预指令（L5/L6）

**客户端**：`protocol.unified.human.directive`

```json
{
  "userId": "<可选>",
  "sessionId": "<可选，与 userId 至少其一>",
  "scope": "session" | "partition",
  "partitionId": "<scope=partition 时必填>",
  "text": "<指令正文>",
  "priority": "low" | "normal" | "high",
  "traceId": "<可选>"
}
```

**服务端**：`protocol.unified.human.directive.ack`

```json
{
  "ok": true,
  "scope": "<回显>",
  "partitionId": "<可选>",
  "receivedAt": "<ISO8601>",
  "traceId": "<可选>"
}
```

正文写入审计；WS 回包 **不重复全文** 以降低泄露面。

### 4.4 治理探针（L6）

**客户端**：`protocol.unified.governance.probe`

```json
{
  "userId": "<可选>",
  "sessionId": "<可选，与 userId 至少其一>",
  "action": "<逻辑动作名，如 world.http.mutation>",
  "context": { "<可选自定义键>": <value> },
  "traceId": "<可选>"
}
```

**服务端**：`protocol.unified.governance.ack`

```json
{
  "ok": true,
  "allowed": <boolean>,
  "action": "<回显>",
  "rulesApplied": ["<规则说明字符串>"],
  "traceId": "<可选>"
}
```

**v0.1 内置规则**：`action === "world.http.mutation"` 时，`allowed` 与 **`ALLOW_WORLD_HTTP_MUTATIONS`** 一致。

---

## 5. HTTP 只读面

| 方法 | 路径 | 查询参数 | 响应要点 |
|------|------|----------|----------|
| GET | `/protocol/unified/quota` | **`userId` 或 `sessionId`**（至少其一；优先 `userId`） | `{ ok, limit, reserved, consumed, available }` |
| GET | `/protocol/unified/memory` | 同上、`keys`（逗号分隔，可选） | `{ ok, revision, entries }` |

错误：`400` + `{ ok: false, reason: "userId_or_sessionId_required" }`。

---

## 6. 进程内工具（与 WS 对齐）

工具名与 **`/.well-known/agent-world` → `unifiedProtocol.tools`** 一致：

| 工具名 | 对应 WS |
|--------|---------|
| `protocol.unified.quota_adjust` | `protocol.unified.quota.adjust` |
| `protocol.unified.memory_patch` | `protocol.unified.memory.patch` |
| `protocol.unified.memory_get` | `protocol.unified.memory.get` |
| `protocol.unified.human_directive` | `protocol.unified.human.directive` |
| `protocol.unified.governance_probe` | `protocol.unified.governance.probe` |

入参与 Zod 模式见 **`agent-world/protocol-unified.ts`**；**`sessionId` 以 `ToolContext.sessionId` 为准**。

---

## 7. 错误码（沿用服务端惯例）

UAP 不单独定义 HTTP 状态树；WebSocket 失败统一通过 **`error.event`**：

| `code` | 场景 |
|--------|------|
| `SESSION_REQUIRED` | 未 `session.init` |
| `FORBIDDEN` | `sessionId` 与连接不一致 |
| `VALIDATION_ERROR` | Zod 校验失败，`message` 含详情 |
| `BAD_JSON` | 帧非合法 JSON（根 WS 处理） |
| `UNKNOWN_EVENT` | `type` 未识别 |

---

## 8. L1–L6 能力总表（实现状态 v0.1）

| 层 | 主题 | UAP 载体 |
|----|------|----------|
| L1 | 传输载体 | AWP 信封 + `protocol.unified.capabilities` |
| L2 | 实时与一致性 | 由 AWP `world.partition.*`、游戏快照等承担；UAP manifest 预留 |
| L3 | 算力与接入 | `quota.*`、环境变量自动扣减、HTTP GET |
| L4 | 记忆与调度 | `memory.*`、日程等其它调度仍走既有 Tool |
| L5 | 领域语义 | `human.directive`（世界坐标/经济见 World 子域与 AIP） |
| L6 | 治理与合规 | `governance.probe`、审计、World HTTP 写保护策略 |

---

## 9. 示例：配额预留后调用模型

1. WS 发送 `protocol.unified.quota.adjust`：`op: "reserve"`, `units: 5000`  
2. 调用聊天或外部模型（若配置 `COMPUTE_QUOTA_UNITS_PER_MODEL_CALL`，成功后再扣一笔 `consume`）  
3. 若未使用预留，WS `op: "release"` 相同 `units`  

---

## 10. 演进

- v0.2 候选：配额窗口重置、`memory` 命名空间、与 `actorId` 显式绑定、L2 独立广播命名空间。  
- 变更时应递增 **`UNIFIED_PROTOCOL_VERSION`**，并在 `/.well-known/agent-world` 中并列旧版本直至弃用。
