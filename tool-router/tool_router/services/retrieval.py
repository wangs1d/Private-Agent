from __future__ import annotations

from tool_router.models import ParsedIntent, ResourceRecord


class HybridRetrievalEngine:
    def rank(
        self,
        query: str,
        intent: ParsedIntent,
        candidates: list[ResourceRecord],
    ) -> list[tuple[ResourceRecord, dict[str, float], float]]:
        if not candidates:
            return []
        weights = self._weights(query)
        scored: list[tuple[ResourceRecord, dict[str, float], float]] = []
        for record in candidates:
            embedding = self._embedding_score(query, record)
            keyword = self._keyword_score(query, record)
            domain_match = self._domain_match_score(intent, record)
            capability_match = self._capability_match_score(intent, record)
            history = record.history_success_score
            latency = max(
                0.0,
                min(1.0, 1 - (record.level1.latency_ms / max(intent.query_constraints.max_latency_ms, 1))),
            )
            failure = record.failure_penalty
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

    @staticmethod
    def _weights(query: str) -> dict[str, float]:
        token_count = len(query.split())
        if token_count <= 4:
            return {
                "embedding": 0.20,
                "keyword": 0.25,
                "domain": 0.15,
                "capability": 0.25,
                "history": 0.10,
                "latency": 0.03,
                "failure": 0.02,
            }
        return {
            "embedding": 0.35,
            "keyword": 0.18,
            "domain": 0.17,
            "capability": 0.18,
            "history": 0.07,
            "latency": 0.03,
            "failure": 0.02,
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
    def _keyword_score(query: str, record: ResourceRecord) -> float:
        q = query.lower()
        haystack = " ".join([record.level1.name, record.level1.description, *record.level1.tags]).lower()
        hits = sum(1 for token in q.split() if token in haystack)
        return max(0.0, min(1.0, hits / max(1, len(q.split()))))

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
