from __future__ import annotations

from collections import deque

from tool_router.config import Settings
from tool_router.models import FeedbackEntry, ResourceStatus
from tool_router.services.registry import RegistryStore
from tool_router.services.top_p import AdaptiveTopPSelector


class FeedbackService:
    def __init__(self, registry: RegistryStore, top_p_selector: AdaptiveTopPSelector, settings: Settings) -> None:
        self.registry = registry
        self.top_p_selector = top_p_selector
        self.settings = settings
        self.queue: deque[FeedbackEntry] = deque()

    def report(self, entry: FeedbackEntry) -> None:
        record = self.registry.get(entry.resource_id)
        if record is None:
            return
        self.queue.append(entry)

        if entry.success:
            record.history_success_score = min(1.0, record.history_success_score * 0.7 + entry.result_quality_score * 0.3)
            record.failure_penalty = max(0.0, record.failure_penalty * 0.6)
            record.consecutive_failures = 0
        else:
            record.failure_penalty = min(1.0, record.failure_penalty + 0.15)
            record.history_success_score = max(0.0, record.history_success_score - 0.1)
            record.consecutive_failures += 1
            self.top_p_selector.increase_for_intent(entry.parsed_intent)
            if record.consecutive_failures >= self.settings.rate_limited_failure_threshold:
                record.level1.status = ResourceStatus.rate_limited

        if entry.latency_ms > 0:
            record.level1.latency_ms = entry.latency_ms
            record.latency_score = max(0.0, min(1.0, 1 - entry.latency_ms / 1000))

    def report_batch(self, entries: list[FeedbackEntry]) -> int:
        for entry in entries:
            self.report(entry)
        return len(entries)
