from __future__ import annotations

from tool_router.models import ParsedIntent, ResourceRecord, ResourceStatus
from tool_router.services.bm25 import tokenize


class RerankingPipeline:
    """三级重排管线。

    第一层：规则硬过滤 — 在线状态、最大延迟、只读、黑名单
    第二层：Cross-Encoder 精细语义打分
    第三层：LLM-Reranker — 仅接收前 10 条，处理复杂业务上下文匹配
    """

    _blacklist: set[str] = set()

    def rerank(
        self,
        query: str,
        intent: ParsedIntent,
        ranked: list[tuple[ResourceRecord, dict[str, float], float]],
    ) -> list[tuple[ResourceRecord, dict[str, float], float]]:
        # ===== 第一层：规则硬过滤 =====
        stage1 = self._rule_filter(ranked, intent)
        # ===== 第二层：Cross-Encoder 语义打分 =====
        stage2 = self._cross_encoder(query, stage1)
        # ===== 第三层：LLM-Reranker（只接收前 10 条） =====
        return self._llm_rerank(query, intent, stage2[:10])

    def _rule_filter(
        self,
        ranked: list[tuple[ResourceRecord, dict[str, float], float]],
        intent: ParsedIntent,
    ) -> list[tuple[ResourceRecord, dict[str, float], float]]:
        """第一层：规则硬过滤。"""
        filtered: list[tuple[ResourceRecord, dict[str, float], float]] = []
        for record, stage_scores, score in ranked:
            # 在线状态
            if record.level1.status != ResourceStatus.online:
                continue
            # 黑名单
            if record.level1.resource_id in self._blacklist:
                continue
            # 延迟约束
            if record.level1.latency_ms > intent.query_constraints.max_latency_ms:
                continue
            # 只读约束
            if intent.query_constraints.read_only:
                write_keywords = ["delete", "remove", "write", "send", "create", "update",
                                  "transfer", "pay", "删除", "发送", "创建", "更新", "转账", "支付"]
                text = f"{record.level1.name} {record.level1.description} {' '.join(record.level1.tags)}".lower()
                if any(kw in text for kw in write_keywords):
                    continue
            filtered.append((record, stage_scores, score))
        return filtered

    def _cross_encoder(
        self,
        query: str,
        ranked: list[tuple[ResourceRecord, dict[str, float], float]],
    ) -> list[tuple[ResourceRecord, dict[str, float], float]]:
        """第二层：Cross-Encoder 精细语义打分（token 级 Jaccard 模拟）。"""
        q_tokens = set(tokenize(query))
        rescored: list[tuple[ResourceRecord, dict[str, float], float]] = []
        for record, stage_scores, score in ranked:
            doc_text = " ".join([record.level1.name, record.level1.description, *record.level1.capability, *record.level1.tags])
            doc_tokens = set(tokenize(doc_text))
            intersection = q_tokens & doc_tokens
            union = q_tokens | doc_tokens
            jaccard = len(intersection) / len(union) if union else 0.0
            cross_score = 0.5 * score + 0.5 * jaccard
            stage_scores = {**stage_scores, "cross_encoder": round(cross_score, 4)}
            rescored.append((record, stage_scores, round(cross_score, 6)))
        rescored.sort(key=lambda item: item[2], reverse=True)
        return rescored

    def _llm_rerank(
        self,
        query: str,
        intent: ParsedIntent,
        ranked: list[tuple[ResourceRecord, dict[str, float], float]],
    ) -> list[tuple[ResourceRecord, dict[str, float], float]]:
        """第三层：LLM-Reranker，处理复杂业务上下文匹配（业务规则模拟）。"""
        rescored: list[tuple[ResourceRecord, dict[str, float], float]] = []
        for record, stage_scores, score in ranked:
            llm_bonus = 0.0
            # 只读请求偏好 query 类能力
            if intent.query_constraints.read_only:
                caps = " ".join(record.level1.capability).lower()
                if any(k in caps for k in ("query", "search", "get")):
                    llm_bonus += 0.1
            # 高 base_score 奖励
            llm_bonus += (record.level1.base_score - 0.5) * 0.2
            llm_score = score + llm_bonus
            stage_scores = {**stage_scores, "llm_business": round(llm_bonus, 4)}
            rescored.append((record, stage_scores, round(max(0.0, min(1.0, llm_score)), 6)))
        rescored.sort(key=lambda item: item[2], reverse=True)
        return rescored

    def add_to_blacklist(self, resource_id: str) -> None:
        self._blacklist.add(resource_id)

    def remove_from_blacklist(self, resource_id: str) -> None:
        self._blacklist.discard(resource_id)