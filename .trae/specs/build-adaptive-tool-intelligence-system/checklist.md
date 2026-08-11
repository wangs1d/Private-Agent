# Checklist

> 当前实现口径：在现有 `server/src/tools/tool-search/` TypeScript 架构内升级，不新建 Python `tool-router/` 子系统。运行时使用 Zod 做 HTTP 输入校验，Registry 模型使用严格 TS 类型；SQLite/Qdrant/Redis 优先，SQLite 原生模块不可用时自动降级内存存储。

## Phase-1：资源注册中心
- [x] Level-1 / Level-2 / Level-3 三级元数据 TS 模型已定义
- [x] ResourceType / ResourceStatus / AuthLevel / Environment 枚举常量已定义
- [x] Level-1 索引支持 Qdrant 按 domain collection 分片 + Redis 热点缓存
- [x] Level-2 能力描述支持 SQLite 存储；SQLite 不可用时自动降级内存存储
- [x] Level-3 Schema 支持延迟读取，服务初始化不预读执行 schema
- [x] `POST /api/resource/register` 注册接口已实现
- [x] 资源版本发布、灰度标记、版本回退接口已实现
- [x] dev/staging/prod 环境隔离基于 `AGENT_ENV` 生效
- [x] Skill/资源注册时循环依赖检测已接入，错误码 `CIRCULAR_DEPENDENCY_DETECTED`
- [x] 新资源冷启动 `base_score=0.5` 默认保护已实现
- [ ] Qdrant/Redis 在线环境下的集成验证待最后统一测试

## Phase-2：四级分层路由 + 意图路由
- [x] Intent Router 输入 `raw_user_query` + `agent_context_hash`，输出固定 JSON 结构
- [x] Intent Router 支持可插拔语义路由；无 LLM 或低置信度时 BM25/规则兜底
- [x] 复合意图拆解（子任务、domain 合并、约束合并）已实现
- [x] Redis 高频意图缓存已实现；Redis 不可用时自动跳过缓存
- [x] 四级分层路由：DomainGroup → Domain → Capability → Resource
- [x] 路由按租户、环境、domain、capability、status 走索引切片，不走全资源扫描
- [x] 前置过滤：租户、状态、读写约束、基础鉴权级别
- [x] 高频 capability Redis 热点缓存已实现
- [x] `POST /api/intent/decompose` 已实现
- [ ] 意图路由准确率 >= 95% 待样本集评测

## Phase-3：混合检索引擎
- [x] 打分公式 `embedding*w1 + keyword*w2 + history*w3 + latency*w4 - failure*w5` 已实现
- [x] 短关键词权重：keyword=0.4 / embedding=0.25
- [x] 长文本权重：embedding=0.6 / keyword=0.2
- [x] BM25 关键词检索已接入当前 capability 切片候选
- [x] history_success_score 滑动窗口与时间衰减已实现
- [x] failure_penalty 基于滑动窗口失败率计算
- [x] `POST /api/resource/search` 已实现，并串联 intent → route → retrieval → top-p → graph expansion → rerank

## Phase-4：Adaptive-Top-P 召回
- [x] 使用概率累积选择，禁止固定 Top-K
- [x] 置信度绑定：>0.85→0.7；0.6~0.85→0.9；<=0.6→0.95
- [x] 候选硬边界：min_candidate=3、max_candidate=25
- [x] 复合任务每条子意图独立 Top-P 召回并合并
- [x] 同类意图失败时支持 Redis top_p override

## Phase-5：反馈学习闭环
- [x] 完整反馈结构体（11 个字段）Zod schema 已定义
- [x] `POST /api/feedback/report` 单条上报接口已实现
- [x] `POST /api/feedback/batch` 批量上报接口已实现
- [x] 在线更新 history_success_score / failure_penalty
- [x] 失败样本降低 intent-resource 匹配权重
- [x] 同类意图多次失败自动上调默认 top_p
- [x] 滑动窗口故障熔断，触发后自动 `status=rate_limited`
- [x] 异步反馈队列已实现，主路由不等待日志消费者
- [x] `docker-compose.infra.yml` 已新增 RabbitMQ 服务
- [ ] RabbitMQ 真 AMQP adapter 待接入依赖后替换内存队列

## Phase-6：工具知识图谱
- [x] 8 个关系常量已定义：similar_to、depends_on、requires、alternative_to、combine_with、supersede、conflict_with、child_of
- [x] 注册依赖自动落图谱边
- [x] 失败替代查询 `alternative_to` 已实现
- [x] 召回候选集图谱扩充已实现
- [x] 工具组合链路辅助输出已实现
- [x] `POST /api/graph/query` 已实现
- [x] `docker-compose.infra.yml` 已新增 Neo4j 服务
- [ ] Neo4j driver 真连接适配待接入；当前使用 SQLite/内存 fallback

## Phase-7：动态延迟加载 + 执行层
- [x] `POST /api/resource/load` 延迟加载 Level-3 Schema
- [x] Level-3 Redis-LRU + 内存 LRU 缓存已实现
- [x] 版本发布/回退后主动失效对应 schema 缓存
- [x] MCP connection pool 状态、心跳、超时、熔断骨架已实现
- [x] Skill 依赖存活校验与 alternative_to 替代查询已实现
- [x] `POST /api/resource/execute` 已实现 dry-run/参数校验/MCP HTTP 调用路径
- [x] `GET /api/resource/health-check` 已实现
- [ ] Level-3 缓存命中率 >= 90% 待最后压测验证

## Phase-8：生产级加固
- [x] Tool-Reranking 顺序：规则硬过滤 → embedding/cross-encoder 近似重排 → 可选 LLM 前 10 精排
- [x] 重排输入字段包含 query、context hash、上一轮工具结果、query constraints
- [x] 租户 id 请求头强制校验已实现
- [x] 统一结构化返回体包含 tenant、environment、elapsed_ms
- [x] 轻量指标收集器已实现
- [x] `GET /api/tool-search/metrics` JSON / Prometheus 文本导出已实现
- [ ] OpenTelemetry 真 SDK 接入待新增依赖后完成
- [ ] 接口限流复用现有 http-rate-limit 的细粒度规则待接入
- [ ] 10,000 / 100,000 资源压测待最后统一测试
- [ ] 路由 + 召回 + 重排 P99 < 200ms 待压测验证

## 接口完整性
- [x] `POST /api/resource/register`
- [x] `POST /api/resource/search`
- [x] `POST /api/resource/load`
- [x] `POST /api/resource/execute`
- [x] `POST /api/feedback/report`
- [x] `POST /api/feedback/batch`
- [x] `GET /api/resource/health-check`
- [x] `POST /api/graph/query`
- [x] `POST /api/intent/decompose`

## 最后统一验证
- [x] `npm.cmd run build --workspace=server`
- [x] `npx.cmd tsc -p server/tsconfig.scripts.json`
- [x] `node .tmp/tool-registry-test/scripts/test-tool-registry.js`
- [x] `tool_search` / `tool_discover` production bridge adaptive cutover
- [x] `node .tmp/tool-registry-test/scripts/test-adaptive-tool-search-recall.js`
- [x] Recall: all-deferred Top1/Top5 26/26; contextual production Top1/Top5 26/26
- [x] Latency: all-deferred P95 12.12ms / P99 15.93ms; contextual production P95/P99 14.57ms
