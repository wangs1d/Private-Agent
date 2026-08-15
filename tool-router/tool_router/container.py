from __future__ import annotations

from dataclasses import dataclass

from tool_router.config import Settings, settings
from tool_router.services import (
    AdaptiveTopPSelector,
    FeedbackService,
    HierarchicalRouter,
    HybridRetrievalEngine,
    IntentRouter,
    KnowledgeGraphService,
    LazyLoader,
    MetricsRegistry,
    RegistryStore,
    RerankingPipeline,
    ResourceExecutor,
)


@dataclass
class Container:
    settings: Settings
    metrics: MetricsRegistry
    registry: RegistryStore
    intent_router: IntentRouter
    hierarchical_router: HierarchicalRouter
    retrieval: HybridRetrievalEngine
    top_p: AdaptiveTopPSelector
    graph: KnowledgeGraphService
    reranking: RerankingPipeline
    lazy_loader: LazyLoader
    executor: ResourceExecutor
    feedback: FeedbackService


def build_container() -> Container:
    cfg = settings
    metrics = MetricsRegistry()
    registry = RegistryStore(cfg)
    top_p = AdaptiveTopPSelector(cfg)
    graph = KnowledgeGraphService(registry)
    lazy_loader = LazyLoader(registry, cfg)
    return Container(
        settings=cfg,
        metrics=metrics,
        registry=registry,
        intent_router=IntentRouter(),
        hierarchical_router=HierarchicalRouter(registry, cfg),
        retrieval=HybridRetrievalEngine(registry, cfg),
        top_p=top_p,
        graph=graph,
        reranking=RerankingPipeline(),
        lazy_loader=lazy_loader,
        executor=ResourceExecutor(registry, lazy_loader, graph),
        feedback=FeedbackService(registry, top_p, cfg),
    )
