# 网关层统一路由协调（Gateway）实施计划

## 一、摘要

新建 TS 端网关层 `server/src/gateway/`，作为 Agent 执行链的**唯一调度收口**：任务路由、工具准备、资源检索（tool/skill/mcp）、强制工具路由、渲染路由全部经网关集中调用，并附全链路 GatewayTrace。同时**删除旧 tool-search 架构**（TS 本地检索 pipeline 及其 REST 面），检索唯一后端切换为 Python `tool-router/`（FastAPI :8787，HTTP 优先 + bridge_worker.py stdio 兜底），执行结果异步上报 tool-router 反馈 API 形成学习闭环。

Python tool-router 端**本期零改动**（架构已就绪：ResourceType 三类资源、L1-L3 元数据、检索流水线、熔断/依赖校验/反馈学习均已实现）。

## 二、现状分析

### 2.1 三套并存的检索/路由实现（要收敛为 1 套）

| 实现 | 位置 | 现状 |
|---|---|---|
| ① TS 本地 adaptive pipeline | `server/src/tools/tool-search/`（36 文件：intent-router/、hierarchical-router/、retrieval/、top-p-selector/、knowledge-graph/、reranking/、registry/、lazy-loader/、feedback/、bm25.ts、tool-embedding*.ts 等） | 主对话链路的默认检索路径（`searchAdaptiveAgentPath`） |
| ② TS 本地 REST 面 | `routes/http/tool-registry-routes.ts`（/api/resource/search、execute、feedback 等，runtime 为 TS 本地实现） | 无前端消费者（client 目录 grep 零命中），仅调试用 |
| ③ Python tool-router | `tool-router/tool_router/`（FastAPI，api.py 完整 REST 面 + services/ 全流水线） | 新架构。`handlers.ts` 中 backend="tool_router" 时与 ① 双后端并行 + merge |

用户决策：①② 删除，③ 成为唯一资源路由，所有 tool/skill/mcp 调用走它。

### 2.2 分散的路由决策点（要收口到网关）

| 路由点 | 实现 | 直接调用方（分散） |
|---|---|---|
| 任务路由 | `routeLlmExecution`（agent/task-router.ts:211） | chat-user-message.ts:490、agent-core.ts:642/778、master-agent-coordinator.ts:1224、planner-cortex.ts:1340（svc 注入） |
| 规则路由 | `brainCenter.routeLight`（DecisionHub） | agent-core.ts:649 内嵌 |
| 强制工具路由 | `resolveForcedToolChoice`（openai-compatible-tool-loop.ts:644） | tool-loop 内部 :2280 |
| 工具准备 | `prepareToolsWithToolSearch`（tool-search/index.ts:130） | abstract-chat-provider.ts:194、openai-compatible-tool-loop.ts:2188 |
| 延迟工具桥接执行 | `executeToolSearchBridge`（tool-search/handlers.ts:53） | openai-compatible-tool-loop.ts:2447/2471 |
| 渲染路由 | `classifyRenderHint`（services/render-hint-service.ts:104） | tool-result-processor.ts:88 |

### 2.3 关键架构事实

- Python `executor.execute` 返回**模拟执行结果**（`{"message": "Executed ..."}`），只做编排决策（熔断/依赖校验/fallback）；**真实执行体在 TS 端**（ToolRegistry.execute 内部已做 tool/skill/mcp 三类分流：skillManager 优先，回退传统工具）。
- `tool_call` 桥接现状：handlers.ts 解析出 `registryToolName + parsedArgs` → tool-loop 走 ToolRegistry 真实执行。
- 前端（client/）不消费 /api/resource/*、/api/tool-search/* 等管理端点。
- LoopOrchestrator（agent/loop/）是执行策略编排而非路由决策，**保留在 agent-core，不入网关**。

## 三、目标架构

```
触发源（WS chat / HTTP chat / master-agent / planner-cortex / 定时任务）
    ↓ 全部经网关
AgentGateway（server/src/gateway/，模块级单例）
    ├─ routeTask()          ① 任务路由：routeLlmExecution(硬规则) + routeLight(DecisionHub) 合并；turn 级缓存
    ├─ prepareTools()       ② 工具准备：core/deferred 切分 + bridge tools 注入 + catalog 导出 prewarm
    ├─ resolveForcedTool()  ③ 强制工具路由（phone/clock/weather/search）
    ├─ searchResources()    ④ 资源检索：唯一调 tool-router /api/resource/search（删本地 pipeline 与双后端 merge）
    ├─ executeBridge()      ⑤ tool_discover/tool_call 桥接执行 + 执行反馈上报 /api/feedback/report
    ├─ routeRender()        ⑥ 渲染路由（包装 classifyRenderHint）
    └─ GatewayTrace         全链路路由追踪（phase/decision/reasons/duration，滚动 200 条）

真实执行链（保持）：tool-loop → ToolRegistry.execute（tool/skill/mcp 三类分流）→ 结果异步上报 tool-router feedback
tool-router 部署：FastAPI HTTP 优先（TOOL_ROUTER_HTTP_URL），bridge_worker.py stdio 兜底自动拉起
```

## 四、变更清单

### 4.1 新建 `server/src/gateway/`（8 个文件）

| 文件 | 内容 |
|---|---|
| `index.ts` | 导出 `getAgentGateway()`、类型、`CORE_TOOL_LIBRARY` 等再导出 |
| `agent-gateway.ts` | AgentGateway 类 + 模块级单例。方法：`bindDependencies({toolRegistry, brainCenter})`（装配期调用，brainCenter 可空）、`routeTask(text, opts?)`（routeLlmExecution + routeLight 合并，沿用 agent-core.ts:646-653 规则：shouldGoComplex = fastRoute.complex ∥ light.complex ∥ confidence<0.4；LRU 缓存 key=turnKey‖text，TTL 10s，容量 256）、`prepareTools(visible, searchable?)`、`resolveForcedTool(userText, apiTools, fastProfile?)`、`searchResources(query, limit, opts?)`、`executeBridge(bridgeName, args, catalog)`、`routeRender(text, ctx?)`、`reportToolFeedback(entry)`（fire-and-forget POST /api/feedback/report）。每方法记录 GatewayTrace |
| `gateway-trace.ts` | GatewayTrace：`{traceId, phase, decision, reasons, durationMs, timestamp}`；`listTraces()/getRecentTraces()`，内存滚动 200 条 |
| `gateway-env.ts` | 迁移自 tool-search/env.ts 并精简：只留 tool-router 连接配置（TOOL_ROUTER_HTTP_URL/TOOL_ROUTER_ROOT/TOOL_ROUTER_PYTHON_BIN、开关、超时）；删除 backend/adaptive/bridgeMode 旧配置 |
| `tool-router-client.ts` | 合并 tool-search/tool-router-adapter.ts + tool-router-http-client.ts：HTTP REST 优先 → bridge_worker.py stdio 兜底；导出 `searchResourcesViaToolRouter`、`prewarmToolRouterCatalog`、`getToolRouterHealth`、bridge worker 路径解析（供 self-evolution-router-registrar 复用） |
| `tool-router-export.ts` | 迁移自 tool-search/tool-router-export.ts（TS 工具目录 → ResourceRecord L1/L2/L3 导出，tool/skill/mcp 分型，inferResourceType 逻辑） |
| `bridge-tools.ts` | 迁移自 tool-search/bridge-tools.ts（`tool_discover`/`tool_call` 定义 + `isToolSearchBridgeName`；只保留 merged 模式，删 legacy 三件套） |
| `core-tool-library.ts` + `deferred-catalog.ts` | 前者迁移自 tool-search/core-tool-library.ts（CORE_TOOL_LIBRARY/isFastLaneTool/isMasterAgentBuiltinTool/registerDynamicFastLaneName 等）；后者从 tool-search/catalog.ts 迁移 deferred catalog 构建 + `estimateToolsSchemaTokens`（**剥离** embedding/BM25 本地检索资产：embeddingIndex/categoryBm25/categorySearches 等字段与构建逻辑） |

另建 `gateway/forced-tool.ts`：迁移 `resolveForcedToolChoice` + `shouldRequireFreshWebLookup` + 相关正则（DIRECT_CLOCK_OR_LOCATION_RE、FRESH_WEB_LOOKUP_RE、扩展触发场景）。

### 4.2 删除清单

1. `server/src/tools/tool-search/` 整目录（36 文件）。能力迁移映射：8 个文件迁 gateway（见 4.1）；其余全部删除，包括 TS 本地检索 pipeline（intent-router/、hierarchical-router/、retrieval/、top-p-selector/、knowledge-graph/、reranking/、adaptive-catalog.ts、bm25.ts、tool-embedding*.ts、tool-category.ts 中未被迁移引用的部分、feedback/、registry/、lazy-loader/、observability/、intent-metadata.ts、handlers.ts、core-tools.ts、env.ts、index.ts）。
2. `routes/http/tool-registry-routes.ts`（TS 本地 REST 面，无前端消费者；Python tool-router 自带完整 REST + /metrics）。
3. `routes/http/tool-search-admin.ts` → 改造为 `routes/http/gateway-admin.ts`：`GET /api/gateway/traces`（网关全链路记录）、`GET /api/gateway/health`（网关状态 + 代理 tool-router /api/resource/health-check）。
4. `tools/capability-modules/{agent-browser,code-sandbox,shopping-order,finance-deep,media-music}/intent.ts`（5 个文件，唯一消费者 setExtraIntentRules 随本地检索删除）。
5. `bootstrap/create-app-services.ts` 中 `setExtraIntentRules(getAllCapabilityModuleIntentRules(...))` 接线（:690 附近）。
6. handlers.ts 中 `recordToolCallFeedback`（本地 online-learner 上报）——由网关 `reportToolFeedback` 上报 Python 替代。

### 4.3 调用点改造（逐文件）

| # | 文件:行 | 改造 |
|---|---|---|
| 1 | `ws/handlers/chat-user-message.ts:490` | `routeLlmExecution(...)` → `getAgentGateway().routeTask(text, {preferFullPipeline: true, turnKey: batched.originalMessageId})` |
| 2 | `services/agent-core.ts:642` | `opts?.routeDecision ?? routeLlmExecution(...)` → `gateway.routeTask(text, {preferFullPipeline, turnKey})`；删除 routeDecision 参数透传链（网关缓存替代 C5 手动复用） |
| 3 | `services/agent-core.ts:778` | 同上（降级路径兜底决策） |
| 4 | `services/agent-core.ts:649` | `brainCenter.routeLight` 调用移入网关 routeTask；agent-core 使用网关返回的 ruleConfidence，cognize 深流程保持原位 |
| 5 | `services/master-agent-coordinator.ts:1224` | → `gateway.routeTask(userMessage)`（独立决策，无 turnKey） |
| 6 | `brain/planner-cortex.ts:1337-1340` | 注入的 `svc.routeLlmExecution` → `svc.routeTask`（接口注入改签名，查 taskRouter 注入来源后对齐类型） |
| 7 | `external-model/openai-compatible-tool-loop.ts:27-31` | import 全部改 `../gateway/index.js` |
| 8 | `external-model/openai-compatible-tool-loop.ts:2188` | `prepareToolsWithToolSearch` → `gateway.prepareTools` |
| 9 | `external-model/openai-compatible-tool-loop.ts:2280` | `resolveForcedToolChoice` → `gateway.resolveForcedTool` |
| 10 | `external-model/openai-compatible-tool-loop.ts:2194` | `shouldRequireFreshWebLookup` 从 gateway/forced-tool.ts import |
| 11 | `external-model/openai-compatible-tool-loop.ts:2447/2471` | `executeToolSearchBridge` → `gateway.executeBridge`（返回结构不变：kind=search/describe/discover/call + registryToolName/parsedArgs，tool-loop 执行流程不动）；deferred 工具真实执行完成后调 `gateway.reportToolFeedback`（fire-and-forget） |
| 12 | `external-model/abstract-chat-provider.ts:25/194` | → `gateway.prepareTools` |
| 13 | `external-model/resolve-chat-tools.ts:14` | `estimateToolsSchemaTokens` 从 `../gateway/deferred-catalog.js` import |
| 14 | `services/tool-result-processor.ts:88` | `classifyRenderHint` → `gateway.routeRender`（render-hint-service.ts 保留为网关调用的纯函数实现） |
| 15 | `services/master-agent-tool-filter.ts:5/13` | import 改 `../gateway/core-tool-library.js` |
| 16 | `bootstrap/create-app-services.ts:132/134` | setExtraIntentRules 删除；registerDynamicFastLaneName 改 gateway 路径；新增 `getAgentGateway().bindDependencies({toolRegistry, brainCenter})`（在 brainCenter 创建后、路由注册前） |
| 17 | `routes/http/index.ts:100-101` | registerToolSearchAdminRoutes → registerGatewayAdminRoutes（gateway-admin.ts）；registerToolRegistryRoutes 删除 |
| 18 | `services/self-evolution-router-registrar.ts` | bridge worker 路径解析等逻辑复用 `gateway/tool-router-client.ts` 导出 |
| 19 | MCP 重连失效入口（现 `invalidateFullCatalogCache` 调用点） | 网关 deferred-catalog 提供同名函数，调用点改 gateway 路径（执行期定位实际调用方） |

## 五、假设与决策

1. **网关定位**：Agent 执行链调度网关，不做 HTTP 反向代理网关（HTTP/WS 路由注册已集中，不重复包一层）。
2. **检索唯一后端**：Python tool-router。删除 TS 本地 adaptive pipeline 与双后端 merge。tool-router 不可达时：bridge_worker.py stdio 自动兜底（仍是 tool-router）；两者皆失败时 `tool_discover` 返回错误结果，**core visible tools 不经检索直接可用，对话主链路不阻断**。
3. **执行分流留在 TS**：Python executor 无真实执行体，真实执行保持 tool-loop → ToolRegistry.execute（tool/skill/mcp 三类分流）。网关不引入"执行前 dry-run 编排校验"（避免每次执行 +1 次跨进程往返；熔断/依赖校验由反馈学习侧闭环承接）。
4. **Python 端零改动**。
5. **LoopOrchestrator 保留 agent-core**（执行策略编排，非路由决策点）。
6. **tool-registry-routes.ts 直接删除**：无前端消费者；需要 REST/指标时直接访问 Python tool-router 自带端点。
7. **turn 缓存 key**：显式 turnKey（originalMessageId）优先，缺省回退 text 字符串；TTL 10s / 容量 256 LRU。
8. **bridge 模式只留 merged**（tool_discover + tool_call），legacy 三件套（tool_search/tool_describe/tool_call）删除。

## 六、验证步骤

1. 编译：`cd server && npx tsc --noEmit` 零错误。
2. 残留引用检查（grep 全仓）：
   - `tools/tool-search` 无任何 import 残留；
   - `routeLlmExecution|prepareToolsWithToolSearch|executeToolSearchBridge|resolveForcedToolChoice|classifyRenderHint` 在业务侧无直接调用（仅 gateway 与各自实现文件内部）；
   - `setExtraIntentRules|toolSearchMetrics|searchAdaptiveAgentPath` 零残留。
3. 启动：`tool-router/start-tool-router.ps1`（uvicorn :8787）→ server 启动（观察 gateway bindDependencies 与 catalog prewarm 日志）。
4. WS 实测四条链路：
   - 闲聊（"你好"）→ fast 路由 + 分段输出正常；
   - "上海天气" → 强制工具 weather_get_local 命中并返回天气数据；
   - 复杂检索任务 → tool_discover（tool-router 检索命中）→ tool_call 真实执行 → 回复正常；
   - skill 工具 / MCP 工具各触发一次 → 三类分流执行正常。
5. `GET /api/gateway/traces`：确认 task_route / tool_prepare / forced_tool / resource_search / bridge_execute / render_route 各阶段记录完整。
6. `GET http://127.0.0.1:8787/api/resource/health-check`：catalog 资源数 > 0；连续对话后 feedback 计数增长（反馈闭环生效）。
