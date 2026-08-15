from __future__ import annotations

import time
from collections import defaultdict, deque

from tool_router.config import Settings
from tool_router.models import ParsedIntent, ResourceRecord
from tool_router.services.registry import RegistryStore


class HistoryScoreStore:
    """滑动窗口历史得分存储，久远调用记录自动衰减权重。"""

    def __init__(self, window_size: int = 50) -> None:
        self._window_size = window_size
        # resource_id -> deque[(success: bool, timestamp: float)]
        self._records: dict[str, deque[tuple[bool, float]]] = defaultdict(deque)

    def record(self, resource_id: str, success: bool, timestamp: float) -> None:
        dq = self._records[resource_id]
        dq.append((success, timestamp))
        while len(dq) > self._window_size:
            dq.popleft()

    def get_score(self, resource_id: str) -> tuple[float, float, float, int]:
        """返回 (history_success_score, latency_score, failure_penalty, consecutive_failures)。"""
        dq = self._records.get(resource_id)
        if not dq:
            return 0.5, 0.8, 0.0, 0  # 冷启动基础分
        now = time.time()
        consecutive_failures = 0
        for success, _ in reversed(dq):
            if not success:
                consecutive_failures += 1
            else:
                break
        total_weight = 0.0
        success_weight = 0.0
        for success, ts in dq:
            age = now - ts
            decay = max(0.1, 1.0 - age / 3600)  # 1 小时内权重接近 1
            total_weight += decay
            if success:
                success_weight += decay
        history_success = success_weight / total_weight if total_weight > 0 else 0.5
        failure_rate = 1.0 - history_success
        failure_penalty = min(1.0, failure_rate * (1 + consecutive_failures * 0.2))
        latency_score = 0.8 if len(dq) >= 3 else 0.6
        return history_success, latency_score, failure_penalty, consecutive_failures


class HybridRetrievalEngine:
    """多因子加权混合检索引擎。

    打分公式（全部得分归一化至 0~1）：
      final_score = embedding_score * w1 + keyword_score * w2
                  + history_success_score * w3 + latency_score * w4
                  - failure_penalty * w5
    动态权重自适应：短关键词指令 vs 长文本模糊需求。
    仅在候选子集（分层路由前置过滤后）内检索，禁止全库扫描。
    """

    def __init__(self, registry: RegistryStore, settings: Settings) -> None:
        self.registry = registry
        self.settings = settings
        self.history_store = HistoryScoreStore(settings.history_window_size)

    def rank(
        self,
        query: str,
        intent: ParsedIntent,
        candidates: list[ResourceRecord],
    ) -> list[tuple[ResourceRecord, dict[str, float], float]]:
        if not candidates:
            return []
        weights = self._dynamic_weights(query)
        candidate_ids = [record.level1.resource_id for record in candidates]
        # BM25 关键词得分（在候选子集内）
        bm25_scores = self.registry.bm25_scores(query, candidate_ids)

        scored: list[tuple[ResourceRecord, dict[str, float], float]] = []
        for record in candidates:
            rid = record.level1.resource_id
            embedding = self._embedding_score(query, record)
            keyword = bm25_scores.get(rid, 0.0)
            domain_match = self._domain_match_score(intent, record)
            capability_match = self._capability_match_score(intent, record)
            hist_success, latency_score, failure_penalty, _ = self.history_store.get_score(rid)
            latency = max(
                0.0,
                min(1.0, 1 - (record.level1.latency_ms / max(intent.query_constraints.max_latency_ms, 1))),
            )
            history = max(record.history_success_score, hist_success)
            latency = max(latency, latency_score)
            failure = max(record.failure_penalty, failure_penalty)
            final_score = (
                embedding * weights["embedding"]
                + keyword * weights["keyword"]
                + domain_match * weights["domain"]
                + capability_match * weights["capability"]
                + history * weights["history"]
                + latency * weights["latency"]
                - failure * weights["failure"]
            )
            stage_scores = {
                "embedding": round(embedding, 4),
                "keyword": round(keyword, 4),
                "domain": round(domain_match, 4),
                "capability": round(capability_match, 4),
                "history": round(history, 4),
                "latency": round(latency, 4),
                "failure": round(failure, 4),
            }
            scored.append((record, stage_scores, round(max(0.0, min(1.0, final_score)), 6)))
        scored.sort(key=lambda item: item[2], reverse=True)
        return scored

    def _dynamic_weights(self, query: str) -> dict[str, float]:
        """动态权重自适应：短关键词指令 vs 长文本模糊需求。"""
        if len(query) <= self.settings.short_query_threshold:
            return {
                "embedding": self.settings.weight_short_embed,
                "keyword": self.settings.weight_short_bm25,
                "domain": 0.15,
                "capability": 0.25,
                "history": self.settings.weight_history,
                "latency": self.settings.weight_latency,
                "failure": self.settings.weight_failure,
            }
        return {
            "embedding": self.settings.weight_long_embed,
            "keyword": self.settings.weight_long_bm25,
            "domain": 0.17,
            "capability": 0.18,
            "history": self.settings.weight_history,
            "latency": self.settings.weight_latency,
            "failure": self.settings.weight_failure,
        }

    @staticmethod
    def _embedding_score(query: str, record: ResourceRecord) -> float:
        q_tokens = set(query.lower().split())
        r_tokens = set((record.level1.description + " " + " ".join(record.level2.use_cases)).lower().split())
        if not q_tokens or not r_tokens:
            return 0.0
        overlap = len(q_tokens & r_tokens) / len(q_tokens | r_tokens)
        return max(0.0, min(1.0, overlap + record.level1.base_score * 0.2))

    @staticmethod
    def _domain_match_score(intent: ParsedIntent, record: ResourceRecord) -> float:
        primary_domain = intent.primary_capability.split(".")[0]
        if record.level1.domain == primary_domain:
            return 1.0
        if record.level1.domain in intent.domain_candidates:
            return 0.8
        return 0.0

    @staticmethod
    def _capability_match_score(intent: ParsedIntent, record: ResourceRecord) -> float:
        intent_capability = intent.primary_capability.lower()
        intent_action = intent_capability.split(".")[1] if "." in intent_capability else intent_capability
        capabilities = {cap.lower() for cap in record.level1.capability}
        if intent_capability in capabilities:
            return 1.0
        if any(cap.split(".")[-1] == intent_action for cap in capabilities):
            return 0.85
        if any(cap.endswith(".general") for cap in capabilities):
            return 0.3
        return 0.0