from __future__ import annotations

import json
import sys
from pathlib import Path
from statistics import median
from time import perf_counter

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from tool_router.container import build_container
from tool_router.fixtures import build_benchmark_cases, build_fixture_resources, build_graph_edges
from tool_router.models import ExecuteRequest, SearchRequest
from tool_router.runtime import ToolRouterRuntime


def percentile(values: list[float], ratio: float) -> float:
    if not values:
        return 0.0
    sorted_values = sorted(values)
    index = min(len(sorted_values) - 1, int(len(sorted_values) * ratio))
    return sorted_values[index]


def main() -> None:
    container = build_container()
    container.registry.register_many(build_fixture_resources())
    for edge in build_graph_edges():
        container.registry.add_edge(edge)
    runtime = ToolRouterRuntime(container)

    cases = build_benchmark_cases()
    latencies: list[float] = []
    top1 = 0
    top5 = 0
    details: list[dict] = []

    for case in cases:
        started = perf_counter()
        result = runtime.search(
            SearchRequest(
                raw_user_query=case.query,
                agent_context_hash="bench-context",
                tenant_id="default",
                limit=5,
            )
        )
        elapsed_ms = (perf_counter() - started) * 1000
        latencies.append(elapsed_ms)
        names = [candidate.name for candidate in result.response.candidates]
        is_top1 = names[:1] == [case.expected_name]
        is_top5 = case.expected_name in names[:5]
        top1 += int(is_top1)
        top5 += int(is_top5)
        details.append(
            {
                "expected": case.expected_name,
                "query": case.query,
                "top1": is_top1,
                "top5": is_top5,
                "latency_ms": round(elapsed_ms, 3),
                "hits": names[:5],
            }
        )

    execute_result = runtime.execute(
        ExecuteRequest(
            resource_id="calendar.create_task",
            params={"title": "Tomorrow follow-up"},
            dry_run=True,
        )
    )
    for _ in range(20):
        runtime.execute(
            ExecuteRequest(
                resource_id="calendar.create_task",
                params={"title": "Cache warm"},
                dry_run=True,
            )
        )

    summary = {
        "cases": len(cases),
        "top1": {"value": top1, "rate": round(top1 / len(cases), 4)},
        "top5": {"value": top5, "rate": round(top5 / len(cases), 4)},
        "latency_ms": {
            "p50": round(percentile(latencies, 0.50), 3),
            "p95": round(percentile(latencies, 0.95), 3),
            "p99": round(percentile(latencies, 0.99), 3),
            "max": round(max(latencies), 3),
            "median": round(median(latencies), 3),
        },
        "schema_cache": container.lazy_loader.stats(),
        "sample_execute": execute_result.model_dump(mode="json"),
        "details": details,
    }
    print(json.dumps(summary, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
