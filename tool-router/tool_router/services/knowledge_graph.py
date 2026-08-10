from __future__ import annotations

from tool_router.models import GraphEdge, GraphQueryRequest, ResourceRecord
from tool_router.services.registry import RegistryStore


class KnowledgeGraphService:
    def __init__(self, registry: RegistryStore) -> None:
        self.registry = registry

    def expand_candidates(self, candidates: list[ResourceRecord]) -> list[ResourceRecord]:
        out = {candidate.level1.resource_id: candidate for candidate in candidates}
        for candidate in candidates:
            for edge in self.registry.list_graph_edges(candidate.level1.resource_id):
                target = self.registry.get(edge.target_id)
                if target is not None:
                    out[target.level1.resource_id] = target
        return list(out.values())

    def query(self, request: GraphQueryRequest) -> list[GraphEdge]:
        relations = {relation.value for relation in request.relation_types}
        return self.registry.list_graph_edges(request.resource_id, relations or None)

    def first_alternative(self, resource_id: str) -> str | None:
        for edge in self.registry.list_graph_edges(resource_id, {"alternative_to"}):
            return edge.target_id
        return None
