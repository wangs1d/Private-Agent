# Tasks

> 实现路径：在现有 `server/src/tools/tool-search/` TypeScript 代码基础上升级，不新建 Python 子系统。主链路已经形成可运行纵切面；最后再统一执行构建、脚本验证和压测。

## Phase-1：资源注册中心

- [x] Task 1.1：三级元数据 TS 模型与枚举常量
  - [x] `server/src/tools/tool-search/registry/models.ts`
  - [x] ResourceType / ResourceStatus / AuthLevel / Environment
  - [x] Level1IndexMeta / Level2CapabilityMeta / Level3ToolSchema / Level3SkillSchema / Level3McpSchema
  - [x] ResourceRecord / ResourceVersion

- [x] Task 1.2：Tool-Registry 存储适配层
  - [x] `server/src/tools/tool-search/registry/store.ts`
  - [x] Level-1：Qdrant domain collection + Redis 热点
  - [x] Level-2：SQLite；SQLite 原生模块不可用时降级内存存储
  - [x] Level-3：按需存取，不在 initialize 阶段预读
  - [x] route index：tenant/env/domain/capability/status 切片查询，避免全量扫描
  - [x] graph edge fallback 表：Neo4j 未接入时保证图谱 API 可用

- [x] Task 1.3：注册服务与版本管理
  - [x] `registry-service.ts`
  - [x] 注册、注销、查询、版本发布、灰度标记、版本回退
  - [x] dev/staging/prod 环境隔离
  - [x] 冷启动 base_score 默认 0.5

- [x] Task 1.4：循环依赖检测
  - [x] `dependency-checker.ts`
  - [x] DFS 三色标记检测
  - [x] 注册服务接入 `CIRCULAR_DEPENDENCY_DETECTED`

- [ ] Task 1.5：Phase-1 最后验证
  - [x] 验证脚本已创建：`server/scripts/test-tool-registry.ts`
  - [x] 最后统一执行构建和脚本验证
  - [ ] 在线 Qdrant/Redis 集成环境验证

## Phase-2：四级分层路由 + 意图路由

- [x] Task 2.1：Intent Router
  - [x] `intent-router/intent-router.ts`
  - [x] 固定结构输出：intent、domain_candidates、primary_capability、confidence、query_constraints、param_extract、is_compound_task、sub_intents
  - [x] 可插拔 semanticRouter；低置信度 BM25/规则兜底
  - [x] 复合任务拆分
  - [x] Redis 缓存；Redis 不可用时跳过

- [x] Task 2.2：四级分层路由
  - [x] `hierarchical-router/hierarchical-router.ts`
  - [x] DomainGroup → Domain → Capability → Resource
  - [x] tenant/env/status/auth/read-only/file-type 过滤
  - [x] 精确 capability 无命中时仅在同 domain 内降级
  - [x] 高频 route Redis cache

- [x] Task 2.3：`POST /api/intent/decompose`

- [ ] Task 2.4：Phase-2 最后验证
  - [ ] 意图路由准确率样本集评估

## Phase-3：混合检索引擎

- [x] Task 3.1：动态权重 Hybrid Retrieval
  - [x] `retrieval/hybrid-retrieval.ts`
  - [x] final_score 公式
  - [x] 短关键词 / 长文本权重切换
  - [x] BM25 + embedding + history + latency + failure penalty
  - [x] 只消费分层路由后的 capability/domain 候选切片

- [x] Task 3.2：滑动窗口历史评分
  - [x] `retrieval/history-score.ts`
  - [x] Redis sorted set；Redis 不可用时内存 fallback
  - [x] history_success_score、failure_penalty、latency_score、consecutive_failures

- [x] Task 3.3：`POST /api/resource/search`

- [ ] Task 3.4：Phase-3 最后验证
  - [ ] Qdrant/Redis 在线集成验证
  - [ ] P99 基线测试

## Phase-4：Adaptive-Top-P

- [x] Task 4.1：概率累积召回
  - [x] `top-p-selector/top-p-selector.ts`
  - [x] confidence → top_p 绑定
  - [x] min=3、max=25

- [x] Task 4.2：复合任务子意图独立召回 + 合并

- [ ] Task 4.3：Phase-4 最后验证

## Phase-5：反馈学习闭环

- [x] Task 5.1：反馈结构体与上报接口
  - [x] `feedback/feedback-models.ts`
  - [x] `POST /api/feedback/report`
  - [x] `POST /api/feedback/batch`

- [x] Task 5.2：在线学习规则
  - [x] `feedback/online-learner.ts`
  - [x] 更新 history/failure
  - [x] intent-resource 权重调整
  - [x] intent top_p override

- [x] Task 5.3：故障熔断
  - [x] `feedback/circuit-breaker.ts`
  - [x] 失败率/连续失败阈值触发 `rate_limited`

- [x] Task 5.4：异步反馈队列
  - [x] `feedback/async-feedback-queue.ts`
  - [x] 内存异步队列，主路由不等待日志消费者
  - [x] `docker-compose.infra.yml` RabbitMQ 服务
  - [ ] 真 RabbitMQ adapter 待接入 AMQP 依赖后替换

- [ ] Task 5.5：Phase-5 最后验证

## Phase-6：工具知识图谱

- [x] Task 6.1：图谱关系模型与基础设施
  - [x] `knowledge-graph/graph-relations.ts`
  - [x] `knowledge-graph/neo4j-client.ts` 接口形状 + SQLite fallback
  - [x] `docker-compose.infra.yml` Neo4j 服务

- [x] Task 6.2：图谱业务功能
  - [x] alternative_to 替代候选
  - [x] similar/combine/depends/requires 候选扩充
  - [x] combine_with 组合链路输出

- [x] Task 6.3：`POST /api/graph/query`

- [ ] Task 6.4：Neo4j 真连接适配和集成验证

## Phase-7：动态延迟加载 + 执行层

- [x] Task 7.1：动态延迟加载
  - [x] `lazy-loader/lazy-loader.ts`
  - [x] Level-3 schema Redis-LRU + 内存 LRU
  - [x] 版本更新缓存失效

- [x] Task 7.2：MCP 连接池
  - [x] `lazy-loader/mcp-connection-pool.ts`
  - [x] HTTP/SSE endpoint 心跳、超时、失败计数
  - [x] stdio 保留状态接口

- [x] Task 7.3：Skill 依赖存活校验与替代切换

- [x] Task 7.4：执行层接口
  - [x] `POST /api/resource/load`
  - [x] `POST /api/resource/execute`
  - [x] `GET /api/resource/health-check`

- [ ] Task 7.5：Phase-7 最后验证
  - [ ] Level-3 缓存命中率 >= 90%

## Phase-8：生产级加固

- [x] Task 8.1：Tool-Reranking 链路
  - [x] `reranking/reranking-pipeline.ts`
  - [x] 规则硬过滤 → cross-encoder 近似重排 → 可选 LLM 前 10 精排

- [x] Task 8.2：轻量可观测指标
  - [x] `observability/metrics.ts`
  - [x] `GET /api/tool-search/metrics`
  - [x] Prometheus text export
  - [ ] OpenTelemetry 真 SDK 待新增依赖后接入

- [x] Task 8.3：租户隔离与统一返回
  - [x] `x-tenant-id` 或 body `tenant_id`
  - [x] 结构化返回包含 ok、tenant_id、environment、elapsed_ms

- [ ] Task 8.4：压力测试与 10w 分片扩容验证

- [x] Task 8.5：最终全链路基础验证
  - [x] `npm.cmd run build --workspace=server`
  - [x] `npx.cmd tsc -p server/tsconfig.scripts.json`
  - [x] `node .tmp/tool-registry-test/scripts/test-tool-registry.js`
  - [ ] 在线 Qdrant/Redis/Neo4j/RabbitMQ 集成验证

## Current Files Added / Updated

- `server/src/tools/tool-search/registry/*`
- `server/src/tools/tool-search/intent-router/intent-router.ts`
- `server/src/tools/tool-search/hierarchical-router/hierarchical-router.ts`
- `server/src/tools/tool-search/retrieval/*`
- `server/src/tools/tool-search/top-p-selector/top-p-selector.ts`
- `server/src/tools/tool-search/feedback/*`
- `server/src/tools/tool-search/knowledge-graph/*`
- `server/src/tools/tool-search/lazy-loader/*`
- `server/src/tools/tool-search/reranking/reranking-pipeline.ts`
- `server/src/tools/tool-search/observability/metrics.ts`
- `server/src/routes/http/tool-registry-routes.ts`
- `server/scripts/test-tool-registry.ts`
- `server/tsconfig.scripts.json`
- `docker-compose.infra.yml`

## Production Bridge Cutover Verification

- [x] `tool_search` and `tool_discover` now call the adaptive pipeline by default.
- [x] Existing deferred catalog resources are classified into Resource records with domain/capability indexes.
- [x] Skill chat tools are tagged through `skillManifestToChatTool`; MCP tools are classified by `mcp.*`.
- [x] Recall test: `node .tmp/tool-registry-test/scripts/test-adaptive-tool-search-recall.js`.
- [x] All-deferred recall: Top1 26/26, Top5 26/26.
- [x] Contextual production bridge recall: Top1 26/26, Top5 26/26.
- [x] Latency: all-deferred P95 12.12ms, P99 15.93ms; contextual production P95/P99 14.57ms.
