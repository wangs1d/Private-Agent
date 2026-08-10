from __future__ import annotations

from tool_router.models import ExecuteResponsePayload, ResourceType
from tool_router.services.knowledge_graph import KnowledgeGraphService
from tool_router.services.lazy_loader import LazyLoader
from tool_router.services.registry import RegistryStore


class ResourceExecutor:
    def __init__(self, registry: RegistryStore, lazy_loader: LazyLoader, graph: KnowledgeGraphService) -> None:
        self.registry = registry
        self.lazy_loader = lazy_loader
        self.graph = graph

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
        record = self.registry.get(resource_id)
        if record is None:
            raise KeyError(resource_id)
        if record.level1.status.value != "online":
            alternative = self.graph.first_alternative(resource_id)
            if alternative:
                fallback_result = self._execute(alternative, params, dry_run, timeout_ms, visited)
                fallback_result.fallback_resource_id = alternative
                return fallback_result
            return ExecuteResponsePayload(
                resource_id=resource_id,
                status="degraded",
                mode="fallback",
                result={"reason": f"resource_status={record.level1.status.value}"},
                fallback_resource_id=alternative,
            )
        schema = self.lazy_loader.load(resource_id)
        validation_error = self._validate_params(record.level1.resource_type, schema, params)
        if validation_error:
            alternative = self.graph.first_alternative(resource_id)
            if alternative:
                fallback_result = self._execute(alternative, params, dry_run, timeout_ms, visited)
                fallback_result.fallback_resource_id = alternative
                return fallback_result
            return ExecuteResponsePayload(
                resource_id=resource_id,
                status="failed",
                mode="validation",
                result={"reason": validation_error},
            )
        if dry_run:
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

    @staticmethod
    def _validate_params(resource_type: ResourceType, schema, params: dict) -> str | None:
        if resource_type == ResourceType.tool and schema.tool is not None:
            missing = [name for name in schema.tool.required if name not in params]
            if missing:
                return f"missing_required:{','.join(missing)}"
        return None
