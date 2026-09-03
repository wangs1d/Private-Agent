# Runtime 进程拓扑架构（Runtime Topology Architecture）

> 目标：把 Agent runtime（大脑：服务图 + 工具 + 技能 + 记忆 + Brain/Body）抽成独立后台进程，
> 外壳（shell / gateway）可整体替换；对客户端可见的 WS/HTTP 协议保持不变，客户端零改动。
>
> **落地状态（2026-09-01）**：全部实现并验证——契约包 `packages/agent-protocol`、
> 端口层 `server/src/ports/`、Runtime 契约与链路 `server/src/runtime/`、
> 双进程入口 `server/src/runtime-main.ts` + `server/src/gateway-main.ts`、
> 脚本接入（`dev:remote` / `start:runtime` / `start:gateway`）。
> 测试：`server/test/runtime-link.test.ts`（链路 RPC/流式回调/abort/鉴权）；
> 全量套件 821 例，失败 4 例与改造前基线完全相同（既有失败，零新增回归）。
> 端到端验证：embedded 与 remote 双模式均跑通真实 LLM 对话
> （ack → assistant_chunk → assistant_done）；kill runtime → gateway 降级 503 →
> 重启 runtime → 客户端重连即恢复。

## 1. 两种拓扑

| | embedded（默认，现状形态） | remote（双进程） |
|---|---|---|
| 入口 | `server/src/index.ts`（`npm run start:server`） | `server/src/runtime-main.ts` + `server/src/gateway-main.ts` |
| 进程 | 单进程：runtime + 对外网关一体 | runtime 守护进程 + 轻薄 gateway 进程 |
| 端口 | 3000（对外） | runtime 内部 3211（`RUNTIME_HTTP_PORT`，仅回环）+ 链路 3210（`RUNTIME_LINK_PORT`）；gateway 对外 3000（`GATEWAY_PORT`/`PORT`） |
| 开发启动 | `npm run dev`（= `dev:all`） | `npm run dev:remote` |
| 切换 | `RUNTIME_MODE` 未设 = embedded | `RUNTIME_MODE=remote`（两个入口自带语义） |

world 能力由 server 经 npm workspace（`@private-ai-agent/agent-world`）在进程内运行，与拓扑无关；原 :3333 独立进程已从启动链路移除（需要独立部署时在 `agent-world` 目录手动 `npm run standalone`）。

## 2. 四层边界（换外壳的契约面）

```
客户端(Flutter/web/orb/桥接器)
   │  客户端协议：{type,payload} 信封（不变）
   ▼
gateway 进程（可替换外壳适配器：WS 隧道 + HTTP 反代 + /__gateway/health）
   │  ① 逐连接 WS 隧道（session/桥接/心跳语义全部由 runtime 处理）
   │  ② catch-all HTTP 反代（REST/页面/媒体，流式转发不缓冲）
   │  ③ 链路 RPC（可选智能网关演进路径，见 §4）
   ▼
runtime 进程（完整世界：createAppServices 全量装配，一处未拆）
   │  内部分层：
   │  ├─ RuntimeFacade（server/src/runtime/runtime-facade.ts）：唯一 Turn 入口契约
   │  │    handleUserMessage / runToolIfNeeded / routeTurnForWs / resumeAutonomousTasks
   │  ├─ ClientPushPort（server/src/ports/client-push-port.ts）：runtime→客户端反向推送
   │  └─ @private-ai-agent/agent-protocol：线缆契约包（事件/载荷/schema/错误码）
   ▼
持久化（server/data/**，全部归属 runtime 进程；启动目录锚定 server/）
```

### 2.1 协议契约包 `@private-ai-agent/agent-protocol`

`packages/agent-protocol/`（根 workspace）。内容：`events.ts`（ClientEventType/ServerEventType
与全部载荷类型，自原 `server/src/protocol.ts` 迁入）、`unified-errors.ts`、`client-location.ts`、
`schemas.ts`（chat turn 入参 zod schema，自 `schemas/api.ts` 迁入）。
原路径（`server/src/protocol.ts` 等）保留 re-export shim，旧 import 零改动。
换外壳 / 换 runtime 实现时以本包为唯一兼容性承诺面。

### 2.2 RuntimeFacade（Turn 入口收敛）

`server/src/runtime/runtime-facade.ts`。13 处调用方全部改依赖此接口（不再 import AgentCore 具体类）：
WS 处理器（`ws/handlers/chat-user-message.ts`、`ws/connection.ts`）、微信桥
（`services/chat-turn-runner.ts`、`wechat-claw-bridge-service.ts`）、虚拟电话协调器、
日程任务回调、消息桥/消息中心（`message-bridge-service.ts`、`message-hub-tools.ts`）、
视觉调度器（`vision/vision-periodic-scheduler.ts`）、HTTP 路由（`routes/http/chat.ts`、
`messages.ts`、`multi-agent-monitor.ts`）。实现两个：
`DirectRuntimeAdapter`（同进程直连，runtime-main 用）与 `WsRuntimeClient`（链路 RPC，§4）。

### 2.3 ClientPushPort（反向推送收口）

`server/src/ports/client-push-port.ts`。runtime 侧一律不得持有客户端 socket——
具身补丁/媒体控制/语音播报/虚拟电话/aip 等 12 个文件的
`WsConnectionRegistry` 类型依赖收窄为该端口（结构兼容，gateway 注入 registry 即实现）。
`ClientLocationPort` 同文件定义 `agent.location_request` 闭环的位置请求 RPC。

### 2.4 持久化归属

`server/data/**` 全部归属 runtime 进程（chat-threads、turn WAL、长期记忆、skills、
schedule 等）。gateway 是无状态隧道，不持有任何会话/记忆状态——这正是「杀 gateway 无感、
杀 runtime 才有感知」的依据。`runtime-main.ts` 启动时把 cwd 锚定到 `server/`
（持久化默认基于 `process.cwd()/data`，守护进程从任意目录启动都安全）。

## 3. remote 拓扑细节

### runtime-main.ts（守护进程）

- 复用 `createAppServices()` **全量装配**（不拆装配函数——工具层经构造注入依赖几乎所有服务，
  「gateway 留服务、runtime 拿工具」会迫使每个工具调用跨进程，故不采用）；
- `process.env.PORT` 重定向为内部端口：桌面桥自连、sidecar 等一切「自己端口」引用随之走内部；
- 内部 HTTP/WS 监听 `127.0.0.1:3211`；链路 `127.0.0.1:3210`
  （`startRuntimeLinkServer`，token 鉴权 `RUNTIME_LINK_TOKEN`）；
- 自主任务恢复、BrainCenter 错误上报接管、FunASR/PaddleOCR 侧车照旧。

### gateway-main.ts（可替换外壳）

约 200 行、零业务装配：
- `/ws` 逐连接隧道（上游未就绪时先缓存首帧，session.init 不丢；runtime 断开时清理连接，
  由客户端既有重连逻辑恢复）；
- catch-all HTTP 反代：fetch 转发 + `Readable.fromWeb` 流式回写（媒体/语音大响应不缓冲）；
  runtime 不可达时 503；
- `GET /__gateway/health`：gateway 自身 + runtime 存活探测（WS probe）。

### 链路协议（`server/src/runtime/link/link-protocol.ts`）

WS 上的四种帧：`req`（method + correlationId）、`ev`（流式回调回推，cb 名 =
`HandleUserMessageOptions` 回调名）、`res` / `err`（收尾）。abort 独立成 method
（`runtime.abortTurn`），runtime 侧 `ActiveTurnRegistry` 按 actor 中断进行中 turn 的
AbortController。客户端断开不中断 turn；runtime 死亡时未完成请求以 `err` 收尾。

## 4. 智能网关演进路径（未实施，接口已就绪）

当前 gateway 是纯隧道。若后续要在 gateway 侧做路由/限流/多 runtime 编排，
`WsRuntimeClient`（`server/src/runtime/link/ws-runtime-client.ts`，实现 RuntimeFacade，
含重连与 abort 翻译）即是接入点：gateway 用它连接 runtime 链路即可获得结构化 turn 控制，
不必经过隧道。多 runtime / 多用户分片场景按 actorId 路由到不同链路连接即可。

## 5. 运维速查

```bash
npm run dev              # embedded 开发（默认，行为与改造前一致）
npm run dev:remote       # remote 开发：world + runtime(3211/3210) + gateway(3000)
npm run start:runtime    # 生产：runtime 守护进程
npm run start:gateway    # 生产：gateway 外壳
curl localhost:3000/__gateway/health   # 网关与 runtime 健康观测
```

环境变量：`RUNTIME_MODE=embedded|remote`（缺省 embedded，防误启动守卫见两入口）、
`RUNTIME_HTTP_PORT=3211`、`RUNTIME_LINK_PORT=3210`、`RUNTIME_LINK_TOKEN`（设后链路强制鉴权）、
`GATEWAY_PORT`（缺省回落 `PORT`/3000）。
