# Adaptive Tool Intelligence Implementation Summary

## 当前落地范围

本轮实现采用 TypeScript 纵切面，不创建独立 Python 子系统。核心入口为：

- `server/src/routes/http/tool-registry-routes.ts`
- `server/src/tools/tool-search/index.ts`

已接入 9 个 REST API：

- `POST /api/resource/register`
- `POST /api/resource/search`
- `POST /api/resource/load`
- `POST /api/resource/execute`
- `POST /api/feedback/report`
- `POST /api/feedback/batch`
- `GET /api/resource/health-check`
- `POST /api/graph/query`
- `POST /api/intent/decompose`

额外新增：

- `POST /api/resource/:id/version/publish`
- `POST /api/resource/:id/version/rollback`
- `GET /api/tool-search/metrics`

## 模块分层

- Registry：三级元数据、版本管理、环境隔离、循环依赖检测
- Intent Router：语义路由接口 + BM25/规则兜底 + 复合任务拆解
- Hierarchical Router：DomainGroup → Domain → Capability → Resource
- Hybrid Retrieval：embedding / keyword / history / latency / failure penalty 融合
- Adaptive Top-P：按置信度选择 top_p，min=3、max=25
- Feedback Learning：在线学习、intent-resource 权重、top_p override、故障熔断
- Knowledge Graph：图谱关系常量、候选扩充、替代资源查询
- Lazy Loader：Level-3 Schema Redis-LRU / 内存 LRU，版本更新失效
- MCP Pool：HTTP/SSE MCP 心跳、超时和熔断骨架
- Reranking：规则硬过滤 → embedding/cross-encoder 近似重排 → 可选 LLM 前 10 精排
- Observability：轻量指标采集，JSON 和 Prometheus text 导出

## 降级策略

- SQLite 优先；`better-sqlite3` 原生模块 ABI 不匹配时自动降级内存存储
- Redis 可用时使用缓存 / sorted set；不可用时跳过缓存或内存 fallback
- Qdrant 可用时写 Level-1 domain collection；不可用时 registry 仍可通过本地索引工作
- Neo4j 已预留服务和接口形状；当前图谱边先落 SQLite / 内存 fallback
- RabbitMQ 已预留 compose 服务；当前反馈日志使用内存异步队列，主路由不阻塞
- OpenTelemetry 真 SDK 未接入；当前使用无依赖轻量指标

## 最后测试项

按用户要求，内容创建完成后再统一执行：

1. `npm.cmd run build --workspace=server`
2. `npx.cmd tsc -p server/tsconfig.scripts.json`
3. `node .tmp/tool-registry-test/scripts/test-tool-registry.js`

若本地 Node 版本与 `better-sqlite3` ABI 不匹配，验证脚本应打印 SQLite 初始化告警并自动使用内存 fallback。
