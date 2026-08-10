from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from tool_router.container import build_container
from tool_router.models import GraphEdge, ResourceRecord, SearchRequest
from tool_router.runtime import ToolRouterRuntime


container = None
runtime = None


def emit(message: dict) -> None:
    sys.stdout.write(json.dumps(message, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def handle_init_catalog(payload: dict) -> dict:
    global container, runtime
    container = build_container()
    runtime = ToolRouterRuntime(container)
    resources = [ResourceRecord.model_validate(item) for item in payload.get("resources", [])]
    container.registry.register_many(resources)
    for edge in payload.get("edges", []):
        container.registry.add_edge(GraphEdge.model_validate(edge))
    return {
        "ok": True,
        "summary": {
            "total": len(resources),
            "resource_types": _resource_type_summary(resources),
        },
    }


def handle_search(payload: dict) -> dict:
    if runtime is None:
        raise RuntimeError("tool-router worker not initialized")
    result = runtime.search(SearchRequest.model_validate(payload))
    return {
        "ok": True,
        "data": result.response.model_dump(mode="json"),
        "top_p": result.selected_top_p,
    }


def _resource_type_summary(resources: list[ResourceRecord]) -> dict[str, int]:
    out: dict[str, int] = {}
    for resource in resources:
        key = resource.level1.resource_type.value
        out[key] = out.get(key, 0) + 1
    return out


def main() -> None:
    for raw_line in sys.stdin:
        line = raw_line.strip()
        if not line:
            continue
        try:
            request = json.loads(line)
            request_id = request.get("id")
            command = request.get("command")
            payload = request.get("payload") or {}
            if command == "init_catalog":
                response = handle_init_catalog(payload)
            elif command == "search":
                response = handle_search(payload)
            else:
                raise ValueError(f"unknown_command:{command}")
            emit({"id": request_id, **response})
        except Exception as exc:  # noqa: BLE001
            emit({"id": request.get("id") if 'request' in locals() else None, "ok": False, "error": str(exc)})


if __name__ == "__main__":
    main()
