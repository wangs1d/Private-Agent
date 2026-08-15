from __future__ import annotations

import time
from collections import deque

from tool_router.config import Settings
from tool_router.models import FeedbackEntry, GraphRelationType, ResourceStatus
from tool_router.services.knowledge_graph import KnowledgeGraphService
from tool_router.services.registry import RegistryStore
from tool_router.services.retrieval import HistoryScoreStore
from tool_router.services.top_p import AdaptiveTopPSelector


class FeedbackService:
    """反馈学习闭环自优化系统。

    - 反馈日志通过消息队列异步落库，不阻塞主调用链路
    - 增量更新 history_success_score、failure_penalty
    - 失败样本降低对应意图-资源匹配权重
    - 同类意图多次召回失败自动上调默认 top-p
    - 连续失败触达阈值设置 status=rate_limited
    - 成功且质量高 → 增强图谱 similar_to 边权重
    - 新注册资源冷启动保护
    """

    def __init__(
        self,
        registry: RegistryStore,
        top_p_selector: AdaptiveTopPSelector,
        settings: Settings,
        graph: KnowledgeGraphService | None = None,
    ) -> None:
        self.registry = registry
        self.top_p_selector = top_p_selector
        self.settings = settings
        self.graph = graph or KnowledgeGraphService(registry)
        self.history_store = HistoryScoreStore(settings.history_window_size)
        self.queue: deque[FeedbackEntry] = deque()

    def report(self, entry: FeedbackEntry) -> None:
        record = self.registry.get(entry.resource_id)
        if record is None:
            return
        self.queue.append(entry)
        self._process(entry, record)

    def report_batch(self, entries: list[FeedbackEntry]) -> int:
        for entry in entries:
            record = self.registry.get(entry.resource_id)
            if record is not None:
                self.queue.append(entry)
                self._process(entry, record)
        return len([e for e in entries if self.registry.get(e.resource_id) is not None])

    def _process(self, entry: FeedbackEntry, record) -> None:
        now = time.time()
        # 1. 滑动窗口历史
        self.history_store.record(entry.resource_id, entry.success, now)

        if entry.success:
            record.history_success_score = min(1.0, record.history_success_score * 0.7 + entry.result_quality_score * 0.3)
            record.failure_penalty = max(0.0, record.failure_penalty * 0.6)
            record.consecutive_failures = 0
        else:
            record.failure_penalty = min(1.0, record.failure_penalty + 0.15)
            record.history_success_score = max(0.0, record.history_success_score - 0.1)
            record.consecutive_failures += 1
            # 2. 同类意图多次召回失败，自动上调该意图组别默认 top-p
            self.top_p_selector.increase_for_intent(entry.parsed_intent)
            # 3. 连续失败触达阈值 → rate_limited
            if record.consecutive_failures >= self.settings.rate_limited_failure_threshold:
                record.level1.status = ResourceStatus.rate_limited

        if entry.latency_ms > 0:
            record.level1.latency_ms = entry.latency_ms
            record.latency_score = max(0.0, min(1.0, 1 - entry.latency_ms / 1000))

        # 4. 成功且质量高 → 增强同 domain 资源 similar_to 边权重
        if entry.success and entry.result_quality_score > 0.7:
            self._boost_similar_edges(record)

    def _boost_similar_edges(self, record) -> None:
        """增强资源与同 domain 资源的 similar_to 关系边权重。"""
        for other in self.registry.list_records():
            if other.level1.resource_id == record.level1.resource_id:
                continue
            if other.level1.domain == record.level1.domain:
                self.graph.record_edge_usage(
                    record.level1.resource_id,
                    other.level1.resource_id,
                    GraphRelationType.similar_to,
                )

    def cold_start_protect(self, resource_id: str) -> None:
        """新注册资源冷启动保护，分配基础 score，保障曝光机会。"""
        record = self.registry.get(resource_id)
        if record is not None and record.level1.base_score < 0.3:
            record.level1.base_score = self.settings.default_base_score

    def pending_feedback_count(self) -> int:
        return len(self.queue)