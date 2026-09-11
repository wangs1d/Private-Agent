# 进程内工具检索架构（2026-09-11 收口）

> 状态：**已实施**。Python `tool-router/` 服务已删除；其检索架构已完整移植进
> TS 进程内管线（`server/src/tools/tool-search/`）。本文是移植对照表、有意偏离
> 清单与后续「神经级检索」演进方案的唯一权威文档。

## 1. 架构总览

```
LLM tool_discover(query)
   │
   ▼  handlers.ts → adaptiveSearchDeferredTools()（六阶段管线，与原 Python 服务同名同序）
intent_router → hierarchical_router → hybrid_retrieval → adaptive_top_p
   → knowledge_graph_expansion → tool_reranking
   │
   ▼
top-N 候选（含 schema）→ LLM tool_call → ToolRegistry.execute（本地执行）
```

- 检索索引从 LLM 同源的 schema 目录构建（`buildAdaptiveCatalogIndex`），签名缓存跨轮复用；
- 全链路零网络跳数、零子进程；异常唯一降级路径是纯 BM25（`catalog.ts`）；
- 管理面 HTTP 路由（`routes/http/tool-registry-routes.ts`）镜像原 `/api/resource/*`，
  供运维查询与金丝雀评估，不在对话热路径。

## 2. Python → TS 移植对照表（1:1）

| Python 模块 | TS 对应 | 状态 |
|---|---|---|
| `services/registry.py` RegistryStore（倒排索引/BM25/图边/注册默认值） | `adaptive-catalog.ts` AdaptiveCatalogIndex + `registry/store.ts` | 1:1（图边注册带幂等键，同 Python 修复版） |
| `_assert_no_circular_dependency`（DFS 环检测） | `seedGraphEdges` 灌边前逐边环检测 | 1:1 |
| `route_search` 分层回退匹配 + `_allows` 过滤（status/auth/read_only/file_type） | `routeAdaptiveCatalog` + `passesRouteFilters` | 1:1 |
| `services/intent_router.py`（中英正则、复合拆分、约束推断） | `intent-router/intent-router.ts` | 1:1（词表补「记住|记下|保存」） |
| `services/hierarchical_router.py`（四级路由 + TTL 路由缓存） | `hierarchical-router/hierarchical-router.ts` + `routeAdaptiveCatalog` | 1:1 |
| `DOMAIN_GROUPS` 分类表 | `hierarchical-router.ts DOMAIN_GROUPS` + `adaptive-catalog.ts inferDomainGroups` | 1:1（两处统一为 Python 真值，含 travel/notes/file→productivity） |
| `services/retrieval.py`（混合打分 + HistoryScoreStore） | `retrieval/hybrid-retrieval.ts` + `history-score.ts` | 1:1（含 domain_match/capability_match 分量） |
| `services/top_p.py`（自适应 top-p + 失败升档） | `top-p-selector/top-p-selector.ts` + `topPIntentOverrides`（10min TTL） | 1:1 |
| `services/knowledge_graph.py`（替代/相似/组合边） | `knowledge-graph/` + `seedGraphEdges`（depends_on/similar_to/combine_with） | 1:1 + 调用后边权强化 |
| `services/reranking.py` 三层重排 | `reranking/reranking-pipeline.ts` | 1:1（见 §3 偏离） |
| `services/feedback.py`（连续失败 → rate_limited 旁路） | `recordAdaptiveResourceFeedback`（3 连败旁路 60s，成功复位） | 1:1 |
| `services/telemetry.py` | `observability/metrics.ts`（超出：p50/p95/p99 + Prometheus 文本） | 超集 |
| `services/executor.py` 模拟执行器 | **不移植**（执行恒在 ToolRegistry） | 有意删除 |
| `services/user_store.py` / `users_api.py` | 不属于检索面，随服务删除 | 有意删除 |
| `api.py` HTTP 端点 | `routes/http/tool-registry-routes.ts`（管理面） | 镜像 |

## 3. 有意偏离清单（每条都有代码内注释）

| # | Python 行为 | TS 行为 | 理由 |
|---|---|---|---|
| 1 | 重排规则层对 `latency_ms > max_latency_ms` 硬剔除 | 软惩罚 -0.08 | Python 默认预算 200ms 会误杀全部联网/浏览器工具 |
| 2 | 写资源判定扫 name+description+tags 全文 | name+capability | 描述含「查询已创建的日程」措辞会把 `calendar.list_tasks` 误判为写工具（golden 实证） |
| 3 | 只读约束：中性 query 不过滤写工具（反转缺省） | 缺省只读，检出写动词才放开 | 采用 Python 语义 + 补隐性写意图词（记住/记下/保存） |
| 4 | 域/能力匹配权重 0.15/0.25 | 0.06/0.10（env 可调） | TS 通道分值分布更尖，等权照搬会让结构信号盖过词面相关性（golden 实证） |
| 5 | 复合意图置信度 = min(0.95, max(子)) | 同（本轮修复，原 TS 为平均值） | 对齐 |
| 6 | HistoryScoreStore 50 样本/1h 线性衰减 | 7 天窗口/指数衰减/内存上限 500 | 保留 TS 更稳健实现 |
| 7 | 路由缓存 TTL 30s | 5 分钟（LRU） | 索引签名失效即重建，TTL 仅兜底 |

## 4. 与 Python 的通信方式（历史问题澄清）

原链路为 **HTTP REST + stdio 双通道**（均 JSON，无 gRPC）：
- HTTP：`tool-router-http-client.ts` → `POST /api/resource/search`（fetch + AbortController 30s）；
- stdio：`tool-router-adapter.ts` spawn `bridge_worker.py`，按行 JSON-RPC（60s 命令超时）。

检索收口后**该链路已不存在**。当前 Python 在运行时的角色仅剩模型推理类 sidecar
（PaddleOCR，HTTP）。跨进程通信约定见 §6 军规：常驻 HTTP 服务、无状态、可降级、
严格预算——不再使用按需 spawn 与 stdio 长连接。

## 5. 跨进程边界军规（从 tool-router 事故固化）

1. 控制面不过界：目录/路由决策/调用状态留在 Node；跨进程只传数据。
2. 可降级：sidecar 不可用 = 质量降级，绝不阻塞功能。
3. 常驻服务，永不按需 spawn；无 gRPC 必要（内网单机，HTTP JSON 足够且可 curl 调试）。
4. 严格超时预算 + 熔断（沿用原 router-endpoint-guard 的数值经验：预算 1.5s、连败 2 次开闸、冷却 60s）。
5. 无状态、幂等、可横扩；状态（学习/缓存）归 Node 侧。

## 6. 「神经级」检索质量方案（见 neural-retrieval-plan.md）

三个已预留的接入点，全部按 §5 军规设计：
1. **查询/工具 embedding**：`tool-embedding.ts`（现为 OpenAI API + 磁盘缓存）→ 本地 sidecar provider；
2. **交叉编码重排**：`reranking-pipeline.ts` 的 `llmReranker` 钩子（管线第三层，失败自动回退词面序）；
3. **ANN 索引**：目录 >2000 时把 `embeddingIndex` 暴力扫描换 HNSW。

实施细节、预算与验收标准：`docs/neural-retrieval-plan.md`。
