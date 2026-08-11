from __future__ import annotations

import json
import sys
from pathlib import Path
from time import perf_counter

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from tool_router.container import build_container
from tool_router.fixtures import (
    build_benchmark_cases,
    build_fixture_resources,
    build_graph_edges,
    make_synthetic_resources,
)
from tool_router.models import SearchRequest
from tool_router.runtime import ToolRouterRuntime


QUERIES = [
    "weather forecast for my location",
    "list my todo tasks",
    "search web for latest AI news",
    "list browser tabs",
    "call me to remind me",
    "check my wallet balance",
    "run desktop automation task script",
    "register an agent in the world registry",
]


def percentile(values: list[float], ratio: float) -> float:
    sorted_values = sorted(values)
    index = min(len(sorted_values) - 1, int(len(sorted_values) * ratio))
    return sorted_values[index]


def main() -> None:
    container = build_container()
    container.registry.register_many(build_fixture_resources())
    container.registry.register_many(make_synthetic_resources(10000))
    for edge in build_graph_edges():
        container.registry.add_edge(edge)
    runtime = ToolRouterRuntime(container)

    benchmark_cases = build_benchmark_cases()
    recall_top1 = 0
    recall_top5 = 0
    recall_latencies: list[float] = []
    for case in benchmark_cases:
        started = perf_counter()
        result = runtime.search(
            SearchRequest(
                raw_user_query=case.query,
                agent_context_hash="scale-recall",
                tenant_id="default",
                limit=5,
            )
        )
        recall_latencies.append((perf_counter() - started) * 1000)
        names = [candidate.name for candidate in result.response.candidates]
        recall_top1 += int(names[:1] == [case.expected_name])
        recall_top5 += int(case.expected_name in names[:5])

    latencies: list[float] = []
    rounds = 50
    started_all = perf_counter()
    for idx in range(rounds):
        for query in QUERIES:
            started = perf_counter()
            runtime.search(
                SearchRequest(
                    raw_user_query=query,
                    agent_context_hash=f"scale-{idx}",
                    tenant_id="default",
                    limit=5,
                )
            )
            latencies.append((perf_counter() - started) * 1000)
    total_seconds = perf_counter() - started_all
    qps = len(latencies) / total_seconds if total_seconds else 0.0

    summary = {
        "resource_count": 10000 + len(build_fixture_resources()),
        "recall": {
            "cases": len(benchmark_cases),
            "top1": round(recall_top1 / len(benchmark_cases), 4),
            "top5": round(recall_top5 / len(benchmark_cases), 4),
            "latency_ms": {
                "p50": round(percentile(recall_latencies, 0.50), 3),
                "p95": round(percentile(recall_latencies, 0.95), 3),
                "p99": round(percentile(recall_latencies, 0.99), 3),
                "max": round(max(recall_latencies), 3),
            },
        },
        "query_count": len(latencies),
        "throughput_qps": round(qps, 2),
        "latency_ms": {
            "p50": round(percentile(latencies, 0.50), 3),
            "p95": round(percentile(latencies, 0.95), 3),
            "p99": round(percentile(latencies, 0.99), 3),
            "max": round(max(latencies), 3),
        },
    }
    print(json.dumps(summary, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
