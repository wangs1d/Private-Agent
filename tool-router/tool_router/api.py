from __future__ import annotations

from time import perf_counter

from fastapi import APIRouter, FastAPI, HTTPException

from tool_router.container import Container
from tool_router.models import (
    ApiEnvelope,
    ExecuteRequest,
    FeedbackBatchRequest,
    FeedbackEntry,
    GraphQueryRequest,
    IntentDecomposeRequest,
    LoadRequest,
    ResourceHealthPayload,
    ResourceRegisterRequest,
    SearchCandidate,
    SearchRequest,
    SearchResponsePayload,
)
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


def create_router(container: Container) -> APIRouter:
    router = APIRouter()

    def wrap(tenant_id: str, data, started_at: float) -> ApiEnvelope:
        return ApiEnvelope(
            ok=True,
            tenant_id=tenant_id,
            environment=container.settings.env,
            elapsed_ms=round((perf_counter() - started_at) * 1000, 3),
            data=data,
        )

    @router.post("/api/resource/register")
    async def register_resource(payload: ResourceRegisterRequest) -> ApiEnvelope:
        started = perf_counter()
        record = container.registry.register(payload.resource)
        container.metrics.inc("resource.register")
        return wrap(record.level1.tenant_id, {"resource_id": record.level1.resource_id}, started)

    @router.post("/api/resource/search")
    async def search_resource(payload: SearchRequest) -> ApiEnvelope:
        started = perf_counter()
        parsed = container.intent_router.decompose(payload.raw_user_query, payload.agent_context_hash)
        per_intent = parsed.sub_intents or [parsed]
        merged: list[SearchCandidate] = []
        last_route = None

        for intent in per_intent:
            route = container.hierarchical_router.route(payload.tenant_id, payload.environment, intent)
            ranked = container.retrieval.rank(intent.intent, intent, route.resources)
            expanded_records = container.graph.expand_candidates([item[0] for item in ranked])
            expanded_ranked = container.retrieval.rank(intent.intent, intent, expanded_records)
            reranked = container.reranking.rerank(intent.intent, intent, expanded_ranked)
            selected, _ = container.top_p.select(intent, reranked, lambda item: item[2])

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

        response = SearchResponsePayload(
            parsed_intent=parsed,
            domain_groups=last_route.domain_groups if last_route else [],
            domains=last_route.domains if last_route else [],
            capabilities=last_route.capabilities if last_route else [],
            candidates=candidates,
            search_path=SEARCH_PATH,
        )
        container.metrics.inc("resource.search")
        return wrap(payload.tenant_id, response.model_dump(mode="json"), started)

    @router.post("/api/resource/load")
    async def load_resource(payload: LoadRequest) -> ApiEnvelope:
        started = perf_counter()
        try:
            schema = container.lazy_loader.load(payload.resource_id)
        except KeyError:
            raise HTTPException(status_code=404, detail="resource_not_found")
        container.metrics.inc("resource.load")
        return wrap(payload.tenant_id, schema.model_dump(mode="json"), started)

    @router.post("/api/resource/execute")
    async def execute_resource(payload: ExecuteRequest) -> ApiEnvelope:
        started = perf_counter()
        try:
            result = container.executor.execute(payload.resource_id, payload.params, payload.dry_run, payload.timeout_ms)
        except KeyError:
            raise HTTPException(status_code=404, detail="resource_not_found")
        container.metrics.inc("resource.execute")
        return wrap(payload.tenant_id, result.model_dump(mode="json"), started)

    @router.post("/api/feedback/report")
    async def report_feedback(payload: FeedbackEntry) -> ApiEnvelope:
        started = perf_counter()
        container.feedback.report(payload)
        container.metrics.inc("feedback.report")
        return wrap(container.settings.default_tenant, {"accepted": True}, started)

    @router.post("/api/feedback/batch")
    async def report_feedback_batch(payload: FeedbackBatchRequest) -> ApiEnvelope:
        started = perf_counter()
        count = container.feedback.report_batch(payload.items)
        container.metrics.inc("feedback.batch", count)
        return wrap(container.settings.default_tenant, {"accepted": count}, started)

    @router.get("/api/resource/health-check")
    async def health_check() -> ApiEnvelope:
        started = perf_counter()
        payload = ResourceHealthPayload(
            backends={
                "redis": "configured" if container.settings.redis_url else "disabled",
                "qdrant": "configured" if container.settings.qdrant_url else "disabled",
                "postgres": "configured" if container.settings.postgres_dsn else "disabled",
                "neo4j": "configured" if container.settings.neo4j_uri else "disabled",
                "rabbitmq": "configured" if container.settings.rabbitmq_url else "disabled",
            },
            resources=container.registry.health_snapshot(),
        )
        return wrap(container.settings.default_tenant, payload.model_dump(mode="json"), started)

    @router.post("/api/graph/query")
    async def query_graph(payload: GraphQueryRequest) -> ApiEnvelope:
        started = perf_counter()
        edges = container.graph.query(payload)
        container.metrics.inc("graph.query")
        return wrap(container.settings.default_tenant, [edge.model_dump(mode="json") for edge in edges], started)

    @router.post("/api/intent/decompose")
    async def decompose_intent(payload: IntentDecomposeRequest) -> ApiEnvelope:
        started = perf_counter()
        intent = container.intent_router.decompose(payload.raw_user_query, payload.agent_context_hash)
        container.metrics.inc("intent.decompose")
        return wrap(container.settings.default_tenant, intent.model_dump(mode="json"), started)

    return router
