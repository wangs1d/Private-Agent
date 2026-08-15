# Adaptive Hierarchical Tool Intelligence System

This directory contains the standalone `tool-router/` Python subsystem described in `.trae/specs/build-adaptive-tool-intelligence-system/spec.md`.

## 两种集成方式

### 1) FastAPI 微服务（HTTP REST，推荐）

独立部署为一个 Python 微服务，TS 服务端通过 HTTP 调用（配置 `TOOL_ROUTER_HTTP_URL` 时优先走 HTTP；未启动/不可用时自动回退 stdio）。

```bash
cd tool-router
python -m venv .venv
.venv\Scripts\activate
pip install -e .
# 启动 FastAPI 服务（默认 0.0.0.0:8787）
uvicorn tool_router.main:app --host 0.0.0.0 --port 8787 --reload
```

TS 端（`server/src/tools/tool-search/tool-router-adapter.ts`）在检测到 `TOOL_ROUTER_HTTP_URL`（如 `http://127.0.0.1:8787`）时，通过 HTTP 客户端（`tool-router-http-client.ts`）调用本服务：先 `POST /api/catalog/init` 批量注册目录，再 `POST /api/resource/search` 检索。服务不可达时打印警告并回退 stdio `bridge_worker.py`，不影响对话主链路。

### 2) stdio 子进程（兜底，默认）

TS 服务端 spawn `scripts/bridge_worker.py`（stdio JSON-Lines 子进程），向其导入工具目录并下发搜索请求，结果与 TS 端 adaptive 检索并行融合。不需要常驻服务。

## REST API 清单

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/catalog/init` | 批量注册资源 + 图边（幂等，对齐 stdio init_catalog） |
| POST | `/api/resource/register` | 注册单个资源 |
| POST | `/api/resource/search` | 混合检索（intent → hierarchical → hybrid → top-p → KG → rerank） |
| POST | `/api/resource/load` | 按需加载 Level-3 schema |
| POST | `/api/resource/execute` | 执行资源（dry_run 支持） |
| POST | `/api/feedback/report` | 上报单条反馈 |
| POST | `/api/feedback/batch` | 批量上报反馈 |
| GET | `/api/resource/health-check` | 健康检查 + 后端状态 |
| POST | `/api/graph/query` | 知识图谱查询 |
| POST | `/api/intent/decompose` | 意图拆解 |

## 执行流水线

1. Intent Router（意图解析 → 领域/能力候选）
2. Hierarchical Router（DomainGroup → Domain → Capability → Resource 路由）
3. Hybrid Retrieval（检索打分）
4. Adaptive Top-P（按意图自适应 top-p）
5. Knowledge-Graph Expansion（图关系扩展）
6. Tool Reranking（重排）
7. Dynamic Lazy-Loading（按需加载 schema/执行）
8. Resource Execute（执行负载解析）
9. Feedback Learning（反馈更新历史/失败惩罚/top-p 覆盖/熔断状态）

默认**纯内存实现**，不依赖 Redis/Qdrant/PostgreSQL/Neo4j/RabbitMQ 等外部中间件，可离线运行；需要外部后端时可启动 `docker-compose.infra.yml` 并配置 `TOOL_ROUTER_*` 连接变量（见 `.env.example`）。

## Celery（可选）

`tool_router/workers/` 提供异步反馈持久化骨架（`tool_router.feedback.persist`）。未配置 RabbitMQ 时使用内存 broker，仅作占位，不参与同步检索链路。

## 开发脚本

- `scripts/bridge_worker.py` — stdio worker（TS 端兜底路径）
- `scripts/evaluate_tool_router.py` — 离线评估（fixtures 用例）
- `scripts/benchmark_tool_router_scale.py` — 规模基准
