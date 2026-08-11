from __future__ import annotations

from collections import OrderedDict

from tool_router.config import Settings
from tool_router.models import Level3ExecutionSchema
from tool_router.services.registry import RegistryStore


class LazyLoader:
    def __init__(self, registry: RegistryStore, settings: Settings) -> None:
        self.registry = registry
        self.settings = settings
        self.cache: OrderedDict[str, Level3ExecutionSchema] = OrderedDict()
        self.cache_hits = 0
        self.cache_misses = 0

    def load(self, resource_id: str) -> Level3ExecutionSchema:
        if resource_id in self.cache:
            self.cache_hits += 1
            schema = self.cache.pop(resource_id)
            self.cache[resource_id] = schema
            return schema
        self.cache_misses += 1
        record = self.registry.get(resource_id)
        if record is None:
            raise KeyError(resource_id)
        schema = record.level3
        self.cache[resource_id] = schema
        while len(self.cache) > self.settings.schema_cache_size:
            self.cache.popitem(last=False)
        return schema

    def invalidate(self, resource_id: str) -> None:
        self.cache.pop(resource_id, None)

    def stats(self) -> dict[str, float]:
        total = self.cache_hits + self.cache_misses
        hit_rate = self.cache_hits / total if total else 0.0
        return {
            "cache_hits": float(self.cache_hits),
            "cache_misses": float(self.cache_misses),
            "cache_hit_rate": hit_rate,
            "cache_size": float(len(self.cache)),
        }
