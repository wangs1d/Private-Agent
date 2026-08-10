from __future__ import annotations

from collections import Counter


class MetricsRegistry:
    def __init__(self) -> None:
        self.counters: Counter[str] = Counter()

    def inc(self, key: str, value: int = 1) -> None:
        self.counters[key] += value

    def snapshot(self) -> dict[str, int]:
        return dict(self.counters)
