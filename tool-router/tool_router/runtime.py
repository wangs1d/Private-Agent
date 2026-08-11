from __future__ import annotations

from dataclasses import dataclass

from tool_router.container import Container
from tool_router.models import ExecuteRequest, SearchCandidate, SearchRequest, SearchResponsePayload
from tool_router.services.registry import infer_domain_groups


SEARCH_PATH = [
    "intent_router",
    "hierarchical_router",
    "hybrid_retrieval",
    "adaptive_top_p",
    "knowledge_graph_expansion",
    "tool_reranking",
    "dynamic_lazy_loading",
    "resource_execute",
    "feedback_learning",
]


@dataclass
class SearchResult:
    response: SearchResponsePayload
    selected_top_p: list[float]


class ToolRouterRuntime:
    def __init__(self, container: Container) -> None:
        self.container = container

    def search(self, payload: SearchRequest) -> SearchResult:
        parsed = self.container.intent_router.decompose(payload.raw_user_query, payload.agent_context_hash)
        per_intent = parsed.sub_intents or [parsed]
        merged: list[SearchCandidate] = []
        last_route = None
        selected_top_p: list[float] = []

        for intent in per_intent:
            route = self.container.hierarchical_router.route(payload.tenant_id, payload.environment, intent)
            ranked = self.container.retrieval.rank(intent.intent, intent, route.resources)
            expanded_records = self.container.graph.expand_candidates([item[0] for item in ranked])
            expanded_ranked = self.container.retrieval.rank(intent.intent, intent, expanded_records)
            reranked = self.container.reranking.rerank(intent.intent, intent, expanded_ranked)
            selected, top_p = self.container.top_p.select(intent, reranked, lambda item: item[2])
            selected_top_p.append(top_p)

            for record, stage_scores, score in selected:
                merged.append(
                    SearchCandidate(
                        resource_id=record.level1.resource_id,
                        name=record.level1.name,
                        resource_type=record.level1.resource_type,
                        domain_group=infer_domain_groups(record.level1.domain, record.level1.resource_type)[0],
                        domain=record.level1.domain,
                        capabilities=record.level1.capability,
                        score=score,
                        stage_scores=stage_scores,
                    )
                )
            last_route = route

        deduped: dict[str, SearchCandidate] = {}
        for candidate in sorted(merged, key=lambda item: item.score, reverse=True):
            deduped.setdefault(candidate.resource_id, candidate)
        candidates = list(deduped.values())[: payload.limit]

        return SearchResult(
            response=SearchResponsePayload(
                parsed_intent=parsed,
                domain_groups=last_route.domain_groups if last_route else [],
                domains=last_route.domains if last_route else [],
                capabilities=last_route.capabilities if last_route else [],
                candidates=candidates,
                search_path=SEARCH_PATH,
            ),
            selected_top_p=selected_top_p,
        )

    def execute(self, payload: ExecuteRequest):
        return self.container.executor.execute(
            payload.resource_id,
            payload.params,
            payload.dry_run,
            payload.timeout_ms,
        )
