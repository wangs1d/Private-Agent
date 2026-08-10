from __future__ import annotations

from tool_router.models import ParsedIntent, ResourceRecord


class RerankingPipeline:
    def rerank(
        self,
        query: str,
        intent: ParsedIntent,
        ranked: list[tuple[ResourceRecord, dict[str, float], float]],
    ) -> list[tuple[ResourceRecord, dict[str, float], float]]:
        filtered = [
            item
            for item in ranked
            if item[0].level1.latency_ms <= intent.query_constraints.max_latency_ms
        ]
        rescored: list[tuple[ResourceRecord, dict[str, float], float]] = []
        for record, stage_scores, score in filtered:
            cross_encoder = self._cross_encoder(query, record)
            llm_business = self._llm_business_score(query, record) if len(rescored) < 10 else 0.0
            blended = score * 0.7 + cross_encoder * 0.2 + llm_business * 0.1
            stage_scores = {
                **stage_scores,
                "cross_encoder": round(cross_encoder, 4),
                "llm_business": round(llm_business, 4),
            }
            rescored.append((record, stage_scores, round(blended, 6)))
        rescored.sort(key=lambda item: item[2], reverse=True)
        return rescored

    @staticmethod
    def _cross_encoder(query: str, record: ResourceRecord) -> float:
        text = " ".join([record.level1.name, record.level1.description, *record.level2.use_cases]).lower()
        hits = sum(1 for token in query.lower().split() if token in text)
        return min(1.0, hits / max(1, len(query.split())))

    @staticmethod
    def _llm_business_score(query: str, record: ResourceRecord) -> float:
        text = " ".join(record.level2.use_cases + record.level2.preconditions).lower()
        hits = sum(1 for token in query.lower().split() if token in text)
        return min(1.0, 0.3 + hits / max(1, len(query.split()) * 2))
