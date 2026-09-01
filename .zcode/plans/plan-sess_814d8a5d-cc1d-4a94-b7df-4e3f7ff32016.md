# Agent Runtime 独立后台进程改造方案

## 目标与思路

把 Agent「大脑」（AgentCore + 工具 + 技能 + 记忆）从 gateway 进程中抽出，成为独立后台进程；对客户端可见的 WS 协议**保持不变**，客户端本次零改动。落地分两步：先进程内分层（定义端口、收敛调用方），再拆进程（把进程内适配器换成 WS 链路适配器）。

天然切分线已存在：`createAgentCore()` 工厂（`server/src/agent/agent-runtime.ts`）+ 回调式流式契约（`HandleUserMessageOptions`）+ 传输无关的 `server/src/protocol.ts`。

## 步骤 0：协议契约包 `@private-ai-agent/agent-protocol`

- 根 workspaces 新增 `packages/agent-protocol`，迁入 `server/src/protocol.ts`、`protocol-unified-errors.ts` 及相关 zod schema（`schemas/api.ts` 中与 chat 事件相关的部分）。
- server（gateway + runtime 两个入口）都依赖它；这是「换外壳/换实现」的唯一正式契约。原路径保留 re-export，避免大范围改 import。

## 步骤 1：进程内分层（不改进程拓扑，拆完可运行可验证）

1. **ClientPushPort**（反向推送收口）：定义 `{ pushToActor(actorId, event): boolean; requestClientLocation(actorId, req): Promise }` 等端口。gateway 用现有 `WsConnectionRegistry` 实现；替换 `AgentCore.setWsRegistry` 直连、以及 `tools/embodiment-tools.ts`、`surface-tools.ts`、`agent-relay-tools.ts`、`capability-modules/media-music/` 等直接 `trySend` 的调用点。`ToolContext`（`tools/tool-registry.ts:17`）增加该端口注入。
2. **统一 Turn 入口 RuntimeFacade**：定义传输无关接口 `{ startTurn(req, onEvent): Promise<TurnResult>; abortTurn(actorId); routeTurn(...); resumeTasks(); }`。先提供**进程内实现** `DirectRuntimeAdapter`。把 6+ 个散落调用方全部收敛到它：WS 处理器（`ws/handlers/chat-user-message.ts`）、微信桥（`services/chat-turn-runner.ts`）、虚拟电话协调器、`scheduleTaskService.setAgentTaskHandler`、message-hub、vision 调度器、HTTP `messages.ts`/`multi-agent-monitor.ts`。
3. **Runtime 侧装配函数**：从 `create-app-services.ts`（3700 行）中抽出 runtime 侧装配 `createRuntimeServices()`——AgentCore 依赖树（ToolRegistry、SkillManager、ExternalChatProvider、记忆同步、BrainCenter 等）。gateway 保留 Fastify/WS/HTTP 路由、消息展示层（批量/分段/媒体卡片）、设备桥、schedule/world/phone 服务。
4. **持久化归属划清**：chat-threads、turn WAL、长期记忆、skills 数据归 runtime 侧；gateway 侧服务不再直接读写这些文件（现状同进程本就不该读，做一次审计与收口）；数据目录统一用绝对路径配置（消除 `process.cwd()` 隐式依赖）。

**验证门**：现有测试套件通过；dev 启动后对话、工具调用、行程技能全流程正常（此时仍是单进程）。

## 步骤 2：拆进程（独立 runtime + WS 链路）

1. **runtime 入口** `server/src/runtime-main.ts`：新进程，监听专用 WS 端口（默认 3210，env `RUNTIME_WS_PORT` + 共享 token 鉴权），装配 `createRuntimeServices()`，含自主任务恢复、BrainCenter 错误上报接管。
2. **链路协议**：复用协议包的 `{type, payload}` 信封。流式 turn = 请求带 `turnId`，事件流式回推；需要应答的调用（`requestClientLocation`、设备桥执行、`runtime.health` 等）用 correlationId RPC。
3. **gateway 侧换适配器**：新增 `WsRuntimeClient implements RuntimeFacade`（带断线重连、turn 失败优雅降级），与 `DirectRuntimeAdapter` 二选一（env `RUNTIME_MODE=embedded|remote`，默认 remote，embedded 兜底）。gateway 继续持有客户端 socket、展示层、静态媒体文件。
4. **进程管理**：`scripts/dev-all.mjs` 与 `start` 脚本增加 runtime 进程（跳过已占用端口，对齐 agent-world 先例）；健康检查与重启策略。

## 明确不做（本次范围外）

- 客户端 Flutter 任何改动（WS 协议不变，故不需要）；`main.dart` 事件路由抽取留作后续。
- 45 个 HTTP 路由的迁移（它们留在 gateway，只有 turn 入口收敛）。
- 69 个模块级单例的全量治理——只处理跨进程边界会出问题的关键项（ChatThreadStore、tool-loop 全局注入、`_activeFastGate`、per-actor AbortController 等，全部随 runtime 走或经端口化）。

## 风险与对策

- **工具反向命令客户端**（桌面桥/媒体/实体）：经 ClientPushPort → gateway → 客户端，桥执行结果走 RPC 回传。
- **性能**：流式 delta 跨进程多一跳 WS，本机回环延迟可忽略；批量/分段仍在 gateway 层。
- **改动量**：步骤 1 是主体（触碰 create-app-services、agent-core、若干 tools 文件），步骤 2 主要是新增入口与适配器、脚本项目，改装配而非改业务逻辑。

## 验证

每步结束跑 `npm test --workspace=server` + 手动 dev 全流程（对话流式、工具卡片、行程面板、日程任务、微信桥路径）；拆进程后另验：kill runtime 再拉起，gateway 重连恢复、客户端无感。