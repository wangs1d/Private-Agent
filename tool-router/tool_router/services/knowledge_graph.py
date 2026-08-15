from __future__ import annotations

from collections import defaultdict

from tool_router.models import (
    GraphEdge,
    GraphQueryRequest,
    GraphRelationType,
    ResourceRecord,
)
from tool_router.services.registry import RegistryStore


class KnowledgeGraphService:
    """工具知识图谱：8 种关系 + 根据调用频次动态更新边权重。"""

    def __init__(self, registry: RegistryStore) -> None:
        self.registry = registry
        # (source, target, relation) -> 调用频次
        self._edge_freq: dict[tuple[str, str, str], int] = defaultdict(int)

    def expand_candidates(self, candidates: list[ResourceRecord]) -> list[ResourceRecord]:
        """扩充召回候选集合：遍历 similar_to + combine_with + alternative_to 关系。"""
        out = {candidate.level1.resource_id: candidate for candidate in candidates}
        for candidate in candidates:
            for relation in (GraphRelationType.similar_to, GraphRelationType.combine_with, GraphRelationType.alternative_to):
                for target_id, _ in self.registry.neighbors(candidate.level1.resource_id, relation):
                    target = self.registry.get(target_id)
                    if target is not None:
                        out[target.level1.resource_id] = target
        return list(out.values())

    def query(self, request: GraphQueryRequest) -> list[GraphEdge]:
        relations = {relation.value for relation in request.relation_types}
        return self.registry.list_graph_edges(request.resource_id, relations or None)

    def first_alternative(self, resource_id: str) -> str | None:
        for edge in self.registry.list_graph_edges(resource_id, {GraphRelationType.alternative_to.value}):
            return edge.target_id
        return None

    def get_alternatives(self, resource_id: str) -> list[tuple[str, float]]:
        """获取可替代资源（执行失败时直接读取，无需从头检索）。"""
        return self.registry.neighbors(resource_id, GraphRelationType.alternative_to)

    def get_similar(self, resource_id: str) -> list[tuple[str, float]]:
        return self.registry.neighbors(resource_id, GraphRelationType.similar_to)

    def get_dependencies(self, resource_id: str) -> list[tuple[str, float]]:
        deps = self.registry.neighbors(resource_id, GraphRelationType.depends_on)
        deps.extend(self.registry.neighbors(resource_id, GraphRelationType.requires))
        return deps

    def get_combinations(self, resource_id: str) -> list[tuple[str, float]]:
        return self.registry.neighbors(resource_id, GraphRelationType.combine_with)

    def get_conflicts(self, resource_id: str) -> list[tuple[str, float]]:
        return self.registry.neighbors(resource_id, GraphRelationType.conflict_with)

    def get_superseded(self, resource_id: str) -> list[tuple[str, float]]:
        return self.registry.neighbors(resource_id, GraphRelationType.supersede)

    def get_children(self, resource_id: str) -> list[tuple[str, float]]:
        return self.registry.neighbors(resource_id, GraphRelationType.child_of)

    def record_edge_usage(self, source_id: str, target_id: str, relation: GraphRelationType) -> None:
        """根据历史调用频次动态更新边权重（频次越高权重越高，上限 1.0）。"""
        key = (source_id, target_id, relation.value)
        self._edge_freq[key] += 1
        freq = self._edge_freq[key]
        new_weight = min(1.0, 0.3 + freq * 0.1)
        self.registry.update_edge_weight(source_id, target_id, relation, new_weight)

    def all_neighbors(self, resource_id: str) -> dict[str, list[tuple[str, float]]]:
        return self.registry.all_neighbors(resource_id)