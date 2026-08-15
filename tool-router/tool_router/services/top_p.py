from __future__ import annotations

from typing import Callable, TypeVar

from tool_router.config import Settings, settings
from tool_router.models import ParsedIntent

T = TypeVar("T")


class AdaptiveTopPSelector:
    """自适应 Top-P 候选召回。

    top-p 阈值绑定意图置信度：
      confidence > 0.85 → top_p = 0.7
      0.6 < confidence ≤ 0.85 → top_p = 0.9
      confidence ≤ 0.6 → top_p = 0.95
    硬边界：min_candidate = 3, max_candidate = 25
    复合任务每条子意图独立执行 Top-P 召回。
    """

    def __init__(self, cfg: Settings | None = None) -> None:
        self.cfg = cfg or settings
        self.intent_overrides: dict[str, float] = {}

    def select(
        self,
        intent: ParsedIntent,
        items: list[T],
        score_getter: Callable[[T], float],
    ) -> tuple[list[T], float]:
        if not items:
            return [], self.top_p_for_intent(intent)
        top_p = self.intent_overrides.get(self._intent_key(intent), self.top_p_for_intent(intent))
        normalized = [max(score_getter(item), 0.0001) for item in items]
        total = sum(normalized) or 1.0
        picked: list[T] = []
        running = 0.0
        for index, (item, score) in enumerate(zip(items, normalized, strict=False)):
            picked.append(item)
            running += score / total
            # 达到 top-p 阈值且已满足最小候选数
            if running >= top_p and len(picked) >= self.cfg.min_candidate:
                break
            # 剩余候选不足以达到 min_candidate 时全选
            remaining = len(items) - index - 1
            if len(picked) + remaining < self.cfg.min_candidate:
                picked = list(items[: self.cfg.min_candidate])
                break
        # 硬边界保护
        if len(picked) < self.cfg.min_candidate:
            picked = items[: self.cfg.min_candidate]
        if len(picked) > self.cfg.max_candidate:
            picked = items[: self.cfg.max_candidate]
        return picked, top_p

    def select_for_compound(
        self,
        sub_results: list[tuple[list[T], float]],
    ) -> list[T]:
        """复合任务：每条子意图独立执行 Top-P 召回后合并去重。"""
        merged: dict[object, T] = {}
        best_score: dict[object, float] = {}
        for items, top_p in sub_results:
            for item in items:
                key = self._key(item)
                score = self._score(item)
                if key not in best_score or score > best_score[key]:
                    best_score[key] = score
                    merged[key] = item
        return list(merged.values())

    def top_p_for_intent(self, intent: ParsedIntent) -> float:
        if intent.confidence > 0.85:
            return self.cfg.top_p_high_conf
        if intent.confidence > 0.6:
            return self.cfg.top_p_mid_conf
        return self.cfg.top_p_low_conf

    def increase_for_intent(self, intent: ParsedIntent, delta: float = 0.02) -> None:
        key = self._intent_key(intent)
        base = self.top_p_for_intent(intent)
        self.intent_overrides[key] = min(0.99, self.intent_overrides.get(key, base) + delta)

    @staticmethod
    def _intent_key(intent: ParsedIntent) -> str:
        return f"{intent.domain_candidates[0] if intent.domain_candidates else 'misc'}::{intent.primary_capability}"

    def _key(self, item: T) -> object:
        return getattr(item, "level1", None).resource_id if hasattr(item, "level1") else id(item)

    def _score(self, item: T) -> float:
        if hasattr(item, "level1"):
            return getattr(item, "history_success_score", 0.0)
        return 0.0