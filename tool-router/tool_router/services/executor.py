from __future__ import annotations

import threading
import time
from collections import defaultdict

from tool_router.config import Settings, settings
from tool_router.models import ExecuteResponsePayload, ResourceType
from tool_router.services.knowledge_graph import KnowledgeGraphService
from tool_router.services.lazy_loader import LazyLoader
from tool_router.services.registry import RegistryStore


class CircuitBreaker:
    """熔断器：连续失败触达阈值后熔断（open），冷却期后半开（half-open）探测。"""

    def __init__(self, threshold: int = 5, cooldown_ms: int = 60_000) -> None:
        self._threshold = threshold
        self._cooldown_s = cooldown_ms / 1000
        self._failure_counts: dict[str, int] = defaultdict(int)
        self._last_failure: dict[str, float] = {}
        self._states: dict[str, str] = defaultdict(lambda: "closed")
        self._lock = threading.RLock()

    def allow(self, resource_id: str) -> bool:
        with self._lock:
            state = self._states[resource_id]
            if state == "closed":
                return True
            if state == "open":
                if time.time() - self._last_failure.get(resource_id, 0) > self._cooldown_s:
                    self._states[resource_id] = "half_open"
                    return True
                return False
            if state == "half_open":
                return True
            return True

    def record_success(self, resource_id: str) -> None:
        with self._lock:
            self._failure_counts[resource_id] = 0
            self._states[resource_id] = "closed"

    def record_failure(self, resource_id: str) -> None:
        with self._lock:
            self._failure_counts[resource_id] += 1
            self._last_failure[resource_id] = time.time()
            if self._failure_counts[resource_id] >= self._threshold:
                self._states[resource_id] = "open"

    def state(self, resource_id: str) -> str:
        with self._lock:
            return self._states[resource_id]

    def failure_count(self, resource_id: str) -> int:
        with self._lock:
            return self._failure_counts[resource_id]


class ResourceExecutor:
    """资源执行器：熔断 + 超时 + 依赖故障自动切换替代资源。"""

    def __init__(
        self,
        registry: RegistryStore,
        lazy_loader: LazyLoader,
        graph: KnowledgeGraphService,
        cfg: Settings | None = None,
    ) -> None:
        self.registry = registry
        self.lazy_loader = lazy_loader
        self.graph = graph
        self.cfg = cfg or settings
        self._breaker = CircuitBreaker(
            self.cfg.circuit_breaker_threshold,
            self.cfg.circuit_breaker_cooldown_ms,
        )

    def execute(self, resource_id: str, params: dict, dry_run: bool, timeout_ms: int) -> ExecuteResponsePayload:
        return self._execute(resource_id, params, dry_run, timeout_ms, visited=set())

    def _execute(
        self,
        resource_id: str,
        params: dict,
        dry_run: bool,
        timeout_ms: int,
        visited: set[str],
    ) -> ExecuteResponsePayload:
        if resource_id in visited:
            return ExecuteResponsePayload(
                resource_id=resource_id,
                status="failed",
                mode="loop_guard",
                result={"reason": "alternative_cycle_detected"},
            )
        visited.add(resource_id)

        # 熔断检查：熔断时直接读取 alternative_to，无需从头检索
        if not self._breaker.allow(resource_id):
            return self._try_fallback(resource_id, params, dry_run, timeout_ms, visited, "circuit_breaker_open")

        record = self.registry.get(resource_id)
        if record is None:
            raise KeyError(resource_id)
        if record.level1.status.value != "online":
            self._breaker.record_failure(resource_id)
            return self._try_fallback(resource_id, params, dry_run, timeout_ms, visited, f"resource_status={record.level1.status.value}")

        # 延迟加载 Level-3 Schema + 依赖校验（Skill 依赖下线自动切换替代）
        schema, fallback_id = self.lazy_loader.load_with_dependency_check(resource_id)
        if schema is None:
            return self._try_fallback(resource_id, params, dry_run, timeout_ms, visited, "schema_load_failed")
        if fallback_id:
            return self._execute(fallback_id, params, dry_run, timeout_ms, visited)

        validation_error = self._validate_params(record.level1.resource_type, schema, params)
        if validation_error:
            return self._try_fallback(resource_id, params, dry_run, timeout_ms, visited, validation_error)
        if dry_run:
            self._breaker.record_success(resource_id)
            return ExecuteResponsePayload(
                resource_id=resource_id,
                status="ok",
                mode="dry_run",
                result={"schema": schema.model_dump(mode="json"), "params": params, "timeout_ms": timeout_ms},
            )

        if record.level1.resource_type == ResourceType.mcp_server:
            mode = "mcp"
        elif record.level1.resource_type == ResourceType.skill:
            mode = "skill"
        else:
            mode = "tool"

        # 超时校验
        effective_timeout = timeout_ms or (schema.tool.timeout_ms if schema.tool else 15_000)
        if effective_timeout > 0 and record.level1.latency_ms > effective_timeout:
            self._breaker.record_failure(resource_id)
            return self._try_fallback(resource_id, params, dry_run, timeout_ms, visited, "timeout")

        self._breaker.record_success(resource_id)
        return ExecuteResponsePayload(
            resource_id=resource_id,
            status="ok",
            mode=mode,
            result={
                "message": f"Executed {record.level1.name}",
                "params": params,
                "timeout_ms": timeout_ms,
            },
        )

    def _try_fallback(
        self,
        resource_id: str,
        params: dict,
        dry_run: bool,
        timeout_ms: int,
        visited: set[str],
        reason: str,
    ) -> ExecuteResponsePayload:
        alternative = self.graph.first_alternative(resource_id)
        if alternative:
            fallback_result = self._execute(alternative, params, dry_run, timeout_ms, visited)
            fallback_result.fallback_resource_id = alternative
            return fallback_result
        return ExecuteResponsePayload(
            resource_id=resource_id,
            status="degraded",
            mode="fallback",
            result={"reason": reason},
            fallback_resource_id=None,
        )

    def circuit_breaker_state(self, resource_id: str) -> str:
        return self._breaker.state(resource_id)

    @property
    def breaker(self) -> CircuitBreaker:
        return self._breaker

    @staticmethod
    def _validate_params(resource_type: ResourceType, schema, params: dict) -> str | None:
        if resource_type == ResourceType.tool and schema.tool is not None:
            missing = [name for name in schema.tool.required if name not in params]
            if missing:
                return f"missing_required:{','.join(missing)}"
        return None