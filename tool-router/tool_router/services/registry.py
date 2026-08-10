from __future__ import annotations

from collections import defaultdict
from typing import Iterable

from tool_router.config import Settings
from tool_router.models import (
    AuthLevel,
    GraphEdge,
    GraphRelationType,
    ResourceRecord,
    ResourceStatus,
    ResourceType,
)


DOMAIN_GROUPS: dict[str, set[str]] = {
    "information": {"search", "browser"},
    "productivity": {"calendar", "reminder", "self", "travel", "notes", "file"},
    "communication": {"phone", "agent"},
    "coordination": {"world", "aip"},
    "commerce": {"wallet", "budget", "shopping"},
    "execution": {"desktop", "embodiment", "device", "smart_home", "vision"},
    "signals": {"weather", "clock"},
    "integration": {"mcp"},
    "general": {"misc"},
}


def clean_domain(value: str) -> str:
    return value.strip().lower().replace(" ", "_") if value else "misc"


def infer_domain_groups(domain: str, resource_type: ResourceType) -> list[str]:
    if resource_type == ResourceType.mcp_server:
        return ["integration"]
    cleaned = clean_domain(domain)
    groups = [group for group, domains in DOMAIN_GROUPS.items() if cleaned in domains]
    return groups or ["general"]


class RegistryStore:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self.records: dict[str, ResourceRecord] = {}
        self.edges: list[GraphEdge] = []
        self.by_domain_group: dict[tuple[str, str, str], set[str]] = defaultdict(set)
        self.by_domain_group_domain: dict[tuple[str, str, str, str], set[str]] = defaultdict(set)
        self.by_domain: dict[tuple[str, str, str], set[str]] = defaultdict(set)
        self.by_capability: dict[tuple[str, str, str], set[str]] = defaultdict(set)
        self.by_domain_capability: dict[tuple[str, str, str, str], set[str]] = defaultdict(set)

    def register(self, record: ResourceRecord) -> ResourceRecord:
        if not record.level1.capability:
            record.level1.capability = [f"{record.level1.domain}.general"]
        if record.level1.base_score == 0:
            record.level1.base_score = self.settings.default_base_score
        self._assert_no_circular_dependency(record)
        self.records[record.level1.resource_id] = record
        self._index_record(record)
        self._index_dependency_edges(record)
        return record

    def register_many(self, records: Iterable[ResourceRecord]) -> list[ResourceRecord]:
        return [self.register(record) for record in records]

    def get(self, resource_id: str) -> ResourceRecord | None:
        return self.records.get(resource_id)

    def list_records(self) -> list[ResourceRecord]:
        return list(self.records.values())

    def add_edge(self, edge: GraphEdge) -> None:
        self.edges.append(edge)

    def list_graph_edges(self, resource_id: str, relations: set[str] | None = None) -> list[GraphEdge]:
        return [
            edge
            for edge in self.edges
            if edge.source_id == resource_id and (not relations or edge.relation.value in relations)
        ]

    def route_search(
        self,
        *,
        tenant_id: str,
        environment: str,
        domain_groups: list[str],
        domains: list[str],
        capabilities: list[str],
        read_only: bool,
        auth_level: AuthLevel,
        file_type: str | None,
    ) -> list[ResourceRecord]:
        ids: set[str] = set()
        for group in domain_groups:
            for domain in domains:
                grouped = self.by_domain_group_domain.get((tenant_id, environment, group, domain), set())
                if not grouped:
                    continue
                for capability in capabilities:
                    ids.update(grouped & self.by_domain_capability.get((tenant_id, environment, domain, capability), set()))
        if not ids:
            for group in domain_groups:
                ids.update(self.by_domain_group.get((tenant_id, environment, group), set()))
        if not ids:
            for domain in domains:
                ids.update(self.by_domain.get((tenant_id, environment, domain), set()))
        if not ids:
            for capability in capabilities:
                ids.update(self.by_capability.get((tenant_id, environment, capability), set()))
        return [
            record
            for record in (self.records[rid] for rid in ids)
            if self._allows(record, read_only=read_only, auth_level=auth_level, file_type=file_type)
        ]

    def health_snapshot(self) -> list[dict[str, str]]:
        return [
            {
                "resource_id": record.level1.resource_id,
                "status": record.level1.status.value,
                "environment": record.level1.environment.value,
            }
            for record in self.records.values()
        ]

    def _index_record(self, record: ResourceRecord) -> None:
        tenant_id = record.level1.tenant_id
        environment = record.level1.environment.value
        domain = clean_domain(record.level1.domain)
        groups = infer_domain_groups(domain, record.level1.resource_type)

        for group in groups:
            self.by_domain_group[(tenant_id, environment, group)].add(record.level1.resource_id)
            self.by_domain_group_domain[(tenant_id, environment, group, domain)].add(record.level1.resource_id)

        self.by_domain[(tenant_id, environment, domain)].add(record.level1.resource_id)
        for capability in record.level1.capability:
            cleaned_capability = capability.strip().lower()
            self.by_capability[(tenant_id, environment, cleaned_capability)].add(record.level1.resource_id)
            self.by_domain_capability[(tenant_id, environment, domain, cleaned_capability)].add(record.level1.resource_id)

    def _allows(
        self,
        record: ResourceRecord,
        *,
        read_only: bool,
        auth_level: AuthLevel,
        file_type: str | None,
    ) -> bool:
        if record.level1.status in {ResourceStatus.offline, ResourceStatus.maintenance, ResourceStatus.rate_limited}:
            return False
        if not self._auth_allows(record.auth_level, auth_level):
            return False
        if read_only and self._likely_write_record(record):
            return False
        if file_type and record.level1.tags and file_type.lower() not in {tag.lower() for tag in record.level1.tags}:
            return False
        return True

    @staticmethod
    def _auth_allows(resource_auth: AuthLevel, requested_auth: AuthLevel) -> bool:
        if resource_auth == AuthLevel.guest:
            return True
        if resource_auth == AuthLevel.default:
            return requested_auth != AuthLevel.guest
        return requested_auth == AuthLevel.admin

    @staticmethod
    def _likely_write_record(record: ResourceRecord) -> bool:
        haystack = " ".join(
            [
                record.level1.name,
                record.level1.description,
                *record.level1.tags,
                *record.level2.use_cases,
            ]
        ).lower()
        return any(
            token in haystack
            for token in ["create", "update", "delete", "remove", "send", "transfer", "pay", "write", "upload"]
        )

    def _assert_no_circular_dependency(self, new_record: ResourceRecord) -> None:
        graph: dict[str, list[str]] = defaultdict(list)
        for record in self.records.values():
            graph[record.level1.resource_id].extend(record.level2.dependencies)
        graph[new_record.level1.resource_id].extend(new_record.level2.dependencies)

        visiting: set[str] = set()
        visited: set[str] = set()

        def dfs(node: str) -> None:
            if node in visiting:
                raise ValueError("CIRCULAR_DEPENDENCY_DETECTED")
            if node in visited:
                return
            visiting.add(node)
            for nxt in graph.get(node, []):
                dfs(nxt)
            visiting.remove(node)
            visited.add(node)

        dfs(new_record.level1.resource_id)

    def _index_dependency_edges(self, record: ResourceRecord) -> None:
        seen = {(edge.source_id, edge.target_id, edge.relation.value) for edge in self.edges}
        for dependency in record.level2.dependencies:
            key = (record.level1.resource_id, dependency, "depends_on")
            if key in seen:
                continue
            self.edges.append(
                GraphEdge(
                    source_id=record.level1.resource_id,
                    target_id=dependency,
                    relation=GraphRelationType.depends_on,
                )
            )

    def resource_ids(self) -> Iterable[str]:
        return self.records.keys()
