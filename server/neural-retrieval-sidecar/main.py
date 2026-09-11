"""
神经检索 sidecar（N1/N2/N3 已全部落地，方案见 docs/neural-retrieval-plan.md）。

职责（无状态、常驻、HTTP JSON——边界军规见 in-process-tool-search.md §5）：
  POST /embed           {"texts": [...]}                       → {"model", "dim", "vectors"}
  POST /rerank          {"query", "documents", "top_k"?}       → {"model", "scores"}
  POST /classify-intent {"query", "labels": {domain: text}}    → {"domain", "confidence", "scores"}
  GET  /health                                                 → {"ok", "warm", "embed_model", ...}
  GET  /metrics                                                → Prometheus 文本

启动：
  pip install fastapi uvicorn sentence-transformers
  python -m uvicorn main:app --host 127.0.0.1 --port 8790

模型按需下载（首次启动会拉权重）；AGNEURAL_* 环境变量可换型号。
分类（N3）是 query→域 的最近质心：域词表由 TS 侧随请求传入（状态归 Node 军规），
本服务不持有任何类别知识，softmax(cosine / temperature) 输出校准置信度。
"""
from __future__ import annotations

import math
import os
import time
from typing import Dict, List

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

EMBED_MODEL = os.environ.get("AGNEURAL_EMBED_MODEL", "BAAI/bge-small-zh-v1.5")
RERANK_MODEL = os.environ.get("AGNEURAL_RERANK_MODEL", "BAAI/bge-reranker-base")
MAX_BATCH = int(os.environ.get("AGNEURAL_MAX_BATCH", "64"))
# 模型版本锁（部署化）：固定 HF revision（commit/branch/tag），防止上游模型更新
# 导致 TS 侧磁盘缓存向量与模型静默失配。生产建议锁 commit hash。
MODEL_REVISION = os.environ.get("AGNEURAL_MODEL_REVISION") or None
CLASSIFY_TEMPERATURE = float(os.environ.get("AGNEURAL_CLASSIFY_TEMPERATURE", "0.05"))

app = FastAPI(title="neural-retrieval-sidecar", version="0.2.0")

_state: dict = {"embed": None, "rerank": None, "embed_dim": 0, "loaded_at": 0.0}
_metrics: dict = {
    "start_time": time.time(),
    "counters": {},  # path -> {"requests": n, "errors": n}
    "latencies": {},  # path -> 最近 N 个耗时(ms)
}
_METRICS_WINDOW = 512


def _lazy_load() -> None:
    """首请求懒加载（进程常驻，加载一次）。sentence-transformers 缺失时 /health 报 not_ready，
    调用方（TS）按预算超时/失败回落既有 provider，不影响主链路。"""
    if _state["embed"] is not None:
        return
    from sentence_transformers import CrossEncoder, SentenceTransformer

    started = time.perf_counter()
    _state["embed"] = SentenceTransformer(EMBED_MODEL, revision=MODEL_REVISION)
    _state["embed_dim"] = _state["embed"].get_sentence_embedding_dimension()
    try:
        _state["rerank"] = CrossEncoder(RERANK_MODEL, max_length=512, revision=MODEL_REVISION)
    except Exception:  # rerank 可选：仅装了 embedding 模型时 /rerank 返回 503
        _state["rerank"] = None
    _state["loaded_at"] = round(time.perf_counter() - started, 2)


def _track(path: str, started: float, ok: bool) -> None:
    slot = _metrics["counters"].setdefault(path, {"requests": 0, "errors": 0})
    slot["requests"] += 1
    if not ok:
        slot["errors"] += 1
    lat = _metrics["latencies"].setdefault(path, [])
    lat.append(round((time.perf_counter() - started) * 1000, 2))
    if len(lat) > _METRICS_WINDOW:
        del lat[: len(lat) - _METRICS_WINDOW]


def _pct(samples: List[float], p: float) -> float:
    if not samples:
        return 0.0
    ordered = sorted(samples)
    idx = min(len(ordered) - 1, max(0, int(len(ordered) * p) - 1))
    return ordered[idx]


class EmbedRequest(BaseModel):
    texts: List[str] = Field(..., max_length=MAX_BATCH)


class EmbedResponse(BaseModel):
    model: str
    dim: int
    vectors: List[List[float]]


class RerankRequest(BaseModel):
    query: str
    documents: List[str] = Field(..., max_length=MAX_BATCH)
    top_k: int | None = None


class RerankResponse(BaseModel):
    model: str
    scores: List[float]


class ClassifyIntentRequest(BaseModel):
    query: str
    labels: Dict[str, str] | None = None
    label_vectors: Dict[str, List[float]] | None = None


class ClassifyIntentResponse(BaseModel):
    domain: str | None
    confidence: float
    scores: Dict[str, float]


@app.get("/health")
def health() -> dict:
    warm = _state["embed"] is not None
    return {
        "ok": warm,
        "warm": warm,
        "embed_model": EMBED_MODEL,
        "rerank_model": RERANK_MODEL if _state["rerank"] is not None else None,
        "revision": MODEL_REVISION or "default",
        "dim": _state["embed_dim"],
        "load_seconds": _state["loaded_at"],
    }


@app.get("/metrics")
def metrics() -> str:
    uptime = time.time() - _metrics["start_time"]
    lines = [
        "# TYPE neural_sidecar_uptime_seconds gauge",
        f"neural_sidecar_uptime_seconds {uptime:.0f}",
        "# TYPE neural_sidecar_model_warm gauge",
        f'neural_sidecar_model_warm{{kind="embed"}} {1 if _state["embed"] is not None else 0}',
        f'neural_sidecar_model_warm{{kind="rerank"}} {1 if _state["rerank"] is not None else 0}',
    ]
    for path, slot in _metrics["counters"].items():
        key = path.strip("/").replace("/", "_")
        lines.append(f"# TYPE neural_sidecar_{key}_requests_total counter")
        lines.append(f"neural_sidecar_{key}_requests_total {slot['requests']}")
        lines.append(f"neural_sidecar_{key}_errors_total {slot['errors']}")
        lat = _metrics["latencies"].get(path, [])
        lines.append(f"# TYPE neural_sidecar_{key}_latency_ms summary")
        lines.append(f'neural_sidecar_{key}_latency_ms{{quantile="0.50"}} {_pct(lat, 0.50)}')
        lines.append(f'neural_sidecar_{key}_latency_ms{{quantile="0.95"}} {_pct(lat, 0.95)}')
        lines.append(f'neural_sidecar_{key}_latency_ms{{quantile="0.99"}} {_pct(lat, 0.99)}')
        if slot["requests"] > 0 and uptime > 0:
            lines.append(
                f"neural_sidecar_{key}_qps {slot['requests'] / uptime:.4f}"
            )
    return "\n".join(lines) + "\n"


@app.post("/embed", response_model=EmbedResponse)
def embed(req: EmbedRequest) -> EmbedResponse:
    started = time.perf_counter()
    ok = False
    try:
        _lazy_load()
        vecs = _state["embed"].encode(req.texts, normalize_embeddings=True)
        ok = True
        return EmbedResponse(
            model=EMBED_MODEL,
            dim=_state["embed_dim"],
            vectors=[[float(x) for x in v] for v in vecs],
        )
    finally:
        _track("/embed", started, ok)


@app.post("/rerank", response_model=RerankResponse)
def rerank(req: RerankRequest) -> RerankResponse:
    started = time.perf_counter()
    ok = False
    try:
        _lazy_load()
        if _state["rerank"] is None:
            raise HTTPException(status_code=503, detail="rerank model not loaded")
        pairs = [(req.query, doc) for doc in req.documents]
        scores = [float(s) for s in _state["rerank"].predict(pairs)]
        ok = True
        if req.top_k is not None:
            # 仅返回 top_k 的（索引, 分数）按 TS 钩子约定映射回全长度数组
            order = sorted(range(len(scores)), key=lambda i: scores[i], reverse=True)[: req.top_k]
            kept = {i: scores[i] for i in order}
            return RerankResponse(
                model=RERANK_MODEL, scores=[kept.get(i, -1e9) for i in range(len(scores))]
            )
        return RerankResponse(model=RERANK_MODEL, scores=scores)
    finally:
        _track("/rerank", started, ok)


@app.post("/classify-intent", response_model=ClassifyIntentResponse)
def classify_intent(req: ClassifyIntentRequest) -> ClassifyIntentResponse:
    """query → 域 的最近质心分类（N3）。

    两种形态（二选一）：
      - labels：{domain: 域描述文本}——sidecar 编码全部文本（每次 ~100ms，首调用/低频用）；
      - label_vectors：{domain: [float]}——TS 侧预编码缓存后只传向量，sidecar 仅编码
        query 本身（~5ms）。热路径应使用向量形态：编码 18 条文本既慢又与 embed/rerank
        抢 CPU，曾把全开 p95 推到 570ms。
    向量须与 /embed 同模型同维度（sidecar 不校验来源，余弦照算）。
    softmax(cosine / T) 得每域概率；T=0.05 时 cosine 差 0.1 ≈ 7 倍概率比——TS 侧
    按相对差值规则（top/second ratio）自行取舍，不依赖绝对置信度。
    """
    if not req.labels and not req.label_vectors:
        raise HTTPException(status_code=400, detail="labels or label_vectors required")
    started = time.perf_counter()
    ok = False
    try:
        if req.label_vectors:
            domains = list(req.label_vectors.keys())
            _lazy_load()
            query_vec = _state["embed"].encode([req.query], normalize_embeddings=True)[0]
            for d, v in req.label_vectors.items():
                if len(v) != len(query_vec):
                    raise HTTPException(
                        status_code=400,
                        detail=f"label_vectors[{d}] dim {len(v)} != embed dim {len(query_vec)}; label cache 与 sidecar 模型不一致",
                    )
            cosines = [
                float(sum(a * b for a, b in zip(query_vec, v)))
                for v in (req.label_vectors[d] for d in domains)
            ]
        else:
            _lazy_load()
            domains = list(req.labels.keys())
            texts = [req.query] + [req.labels[d] for d in domains]
            vecs = _state["embed"].encode(texts, normalize_embeddings=True)
            query_vec = vecs[0]
            cosines = [float(sum(a * b for a, b in zip(query_vec, v))) for v in vecs[1:]]
        exps = [math.exp(c / CLASSIFY_TEMPERATURE) for c in cosines]
        total = sum(exps) or 1.0
        probs = {d: e / total for d, e in zip(domains, exps)}
        best = max(probs, key=probs.get)
        ok = True
        return ClassifyIntentResponse(domain=best, confidence=probs[best], scores=probs)
    finally:
        _track("/classify-intent", started, ok)
