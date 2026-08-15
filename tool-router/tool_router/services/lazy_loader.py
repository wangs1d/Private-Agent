from __future__ import annotations

import time
import threading
from collections import OrderedDict

from tool_router.config import Settings
from tool_router.models import (
    Level3ExecutionSchema,
    ResourceStatus,
    ResourceType,
)
from tool_router.services.knowledge_graph import KnowledgeGraphService
from tool_router.services.registry import RegistryStore


class McpConnectionPool:
    """MCP-Server 连接池：定时心跳探测，复用长连接。"""

    def __init__(self) -> None:
        # endpoint -> {"status": "connected"|"disconnected", "last_heartbeat": ts}
        self._pools: dict[str, dict] = {}
        self._lock = threading.RLock()

    def acquire(self, endpoint: str) -> bool:
        """获取连接（池中有则复用，无则创建）。"""
        with self._lock:
            pool = self._pools.get(endpoint)
            if pool and pool["status"] == "connected":
                pool["last_heartbeat"] = time.time()
                return True
            self._pools[endpoint] = {"status": "connected", "last_heartbeat": time.time()}
            return True

    def release(self, endpoint: str) -> None:
        # 连接池复用，不真正关闭
        pass

    def heartbeat(self, endpoint: str) -> bool:
        with self._lock:
            pool = self._pools.get(endpoint)
            if not pool:
                return False
            pool["last_heartbeat"] = time.time()
            pool["status"] = "connected"
            return True

    def check_health(self) -> dict[str, str]:
        with self._lock:
            result: dict[str, str] = {}
            now = time.time()
            for endpoint, pool in self._pools.items():
                if now - pool["last_heartbeat"] > 60:
                    pool["status"] = "disconnected"
                result[endpoint] = pool["status"]
            return result

    def disconnect(self, endpoint: str) -> None:
        with self._lock:
            if endpoint in self._pools:
                self._pools[endpoint]["status"] = "disconnected"


class LazyLoader:
    """动态延迟加载系统。

    - 命中选中资源后才读取 Level-3 Schema，缓存复用
    - MCP-Server 维护连接池 + 心跳探测
    - Skill 加载时校验依赖 status，依赖下线加载 alternative_to
    - 版本更新触发缓存失效，实现 Schema 热重载
    """

    def __init__(self, registry: RegistryStore, settings: Settings) -> None:
        self.registry = registry
        self.settings = settings
        self.cache: OrderedDict[str, Level3ExecutionSchema] = OrderedDict()
        self.cache_hits = 0
        self.cache_misses = 0
        self._mcp_pool = McpConnectionPool()
        self._graph = KnowledgeGraphService(registry)

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

    def load_with_dependency_check(self, resource_id: str) -> tuple[Level3ExecutionSchema | None, str | None]:
        """加载资源并校验依赖，返回 (schema, fallback_resource_id_or_None)。"""
        record = self.registry.get(resource_id)
        if record is None:
            return None, None
        l1 = record.level1
        # MCP-Server：初始化连接池
        if l1.resource_type == ResourceType.mcp_server:
            schema = self.load(resource_id)
            if schema.mcp_server and schema.mcp_server.endpoint:
                self._mcp_pool.acquire(schema.mcp_server.endpoint)
            return schema, None
        # Skill：校验依赖存活；依赖下线则查图谱加载 alternative_to
        if l1.resource_type == ResourceType.skill:
            dead_deps = [
                dep_id
                for dep_id in record.level2.dependencies
                if (dep := self.registry.get(dep_id)) is None or dep.level1.status != ResourceStatus.online
            ]
            if dead_deps:
                for dead_id in dead_deps:
                    for alt_id, _ in self._graph.get_alternatives(dead_id):
                        alt = self.registry.get(alt_id)
                        if alt is not None and alt.level1.status == ResourceStatus.online:
                            return self.load(resource_id), alt_id
                return self.load(resource_id), None
        return self.load(resource_id), None

    def invalidate(self, resource_id: str) -> None:
        """版本更新后主动失效缓存 key，实现 Schema 热重载。"""
        self.cache.pop(resource_id, None)

    def check_mcp_health(self) -> dict[str, str]:
        return self._mcp_pool.check_health()

    @property
    def mcp_pool(self) -> McpConnectionPool:
        return self._mcp_pool

    def stats(self) -> dict[str, float]:
        total = self.cache_hits + self.cache_misses
        hit_rate = self.cache_hits / total if total else 0.0
        return {
            "cache_hits": float(self.cache_hits),
            "cache_misses": float(self.cache_misses),
            "cache_hit_rate": hit_rate,
            "cache_size": float(len(self.cache)),
        }