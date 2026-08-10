from __future__ import annotations

from typing import Callable, TypeVar

from tool_router.models import ParsedIntent

T = TypeVar("T")


class AdaptiveTopPSelector:
    def __init__(self) -> None:
        self.intent_overrides: dict[str, float] = {}

    def select(self, intent: ParsedIntent, items: list[T], score_getter: Callable[[T], float]) -> tuple[list[T], float]:
        if not items:
            return [], self.top_p_for_intent(intent)
        top_p = self.intent_overrides.get(self._intent_key(intent), self.top_p_for_intent(intent))
        normalized = [max(score_getter(item), 0.0001) for item in items]
        total = sum(normalized) or 1.0
        picked: list[T] = []
        running = 0.0
        for item, score in zip(items, normalized, strict=False):
            picked.append(item)
            running += score / total
            if running >= top_p and len(picked) >= 3:
                break
        return picked[:25], top_p

    def top_p_for_intent(self, intent: ParsedIntent) -> float:
        if intent.confidence > 0.85:
            return 0.7
        if intent.confidence > 0.6:
            return 0.9
        return 0.95

    def increase_for_intent(self, intent: ParsedIntent, delta: float = 0.02) -> None:
        key = self._intent_key(intent)
        self.intent_overrides[key] = min(0.98, self.intent_overrides.get(key, self.top_p_for_intent(intent)) + delta)

    @staticmethod
    def _intent_key(intent: ParsedIntent) -> str:
        return f"{intent.domain_candidates[0] if intent.domain_candidates else 'misc'}::{intent.primary_capability}"
