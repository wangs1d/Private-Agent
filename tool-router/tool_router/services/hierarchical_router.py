from __future__ import annotations

import time

from tool_router.config import Settings
from tool_router.models import Environment, ParsedIntent, ResourceRecord, ResourceType
from tool_router.services.bm25 import Bm25Index
from tool_router.services.registry import RegistryStore, clean_domain, infer_domain_groups, DOMAIN_GROUPS


class HierarchicalRouteResult:
    def __init__(
        self,
        domain_groups: list[str],
        domains: list[str],
        capabilities: list[str],
        resources: list[ResourceRecord],
    ) -> None:
        self.domain_groups = domain_groups
        self.domains = domains
        self.capabilities = capabilities
        self.resources = resources


class HierarchicalRouter:
    """四级分层路由器：DomainGroup → Domain → Capability → Resource。

    检索空间逐层缩小，禁止全量遍历：
      Level-1 DomainGroup（BM25 降级兜底）
      Level-2 Domain（BM25 降级兜底）
      Level-3 Capability
      Level-4 Resource（前置过滤 + 跨域图谱扩展）
    """

    def __init__(self, registry: RegistryStore, settings: Settings) -> None:
        self.registry = registry
        self.settings = settings
        self.route_cache: dict[tuple[str, str, str, str, str], tuple[float, list[str]]] = {}
        # DomainGroup 级 BM25（Level-1 路由降级用）
        self._group_bm25 = Bm25Index()
        for group, domains in DOMAIN_GROUPS.items():
            self._group_bm25.add(group, " ".join(domains))
        # Domain 级 BM25（Level-2 路由降级用）
        self._domain_bm25 = Bm25Index()
        for group, domains in DOMAIN_GROUPS.items():
            for domain in domains:
                self._domain_bm25.add(domain, domain)

    def route(self, tenant_id: str, environment: Environment, intent: ParsedIntent) -> HierarchicalRouteResult:
        # ===== Level-1: DomainGroup =====
        groups = self._route_to_group(intent)
        # ===== Level-2: Domain =====
        domains = self._route_to_domain(intent, groups)
        # ===== Neo4j 跨领域依赖跳转 =====
        domains = list(dict.fromkeys(domains + self._graph_expand(domains)))
        # ===== Level-3: Capability =====
        capabilities = self._resolve_capabilities(intent, domains)

        cache_key = (
            tenant_id,
            environment.value,
            ",".join(groups),
            ",".join(domains),
            ",".join(capabilities),
        )
        cached = self.route_cache.get(cache_key)
        if cached is not None and cached[0] > time.time():
            cached_resources = [
                record
                for resource_id in cached[1]
                if (record := self.registry.get(resource_id)) is not None
            ]
            if cached_resources:
                return HierarchicalRouteResult(groups, domains, capabilities, cached_resources)

        # ===== Level-4: Resource（按 domain 分片 + 前置过滤 + 图谱补全） =====
        resources = self.registry.route_search(
            tenant_id=tenant_id,
            environment=environment.value,
            domain_groups=groups,
            domains=domains,
            capabilities=capabilities,
            read_only=intent.query_constraints.read_only,
            auth_level=intent.query_constraints.auth_level,
            file_type=intent.query_constraints.file_type,
        )
        # 精确 capability 无结果时，同 domain 降级（保证不返回空）
        if not resources and capabilities:
            resources = self.registry.route_search(
                tenant_id=tenant_id,
                environment=environment.value,
                domain_groups=groups,
                domains=domains,
                capabilities=[],
                read_only=intent.query_constraints.read_only,
                auth_level=intent.query_constraints.auth_level,
                file_type=intent.query_constraints.file_type,
            )
        self.route_cache[cache_key] = (
            time.time() + self.settings.route_cache_ttl_seconds,
            [resource.level1.resource_id for resource in resources],
        )
        return HierarchicalRouteResult(groups, domains, capabilities, resources)

    # ===== Level-1: DomainGroup 路由（BM25 降级） =====
    def _route_to_group(self, intent: ParsedIntent) -> list[str]:
        """从 domain_candidates 上推到 DomainGroup；无命中时用 BM25 兜底。"""
        groups: list[str] = []
        for domain in intent.domain_candidates:
            for group in infer_domain_groups(domain, ResourceType.tool):
                if group not in groups:
                    groups.append(group)
        if groups:
            return groups
        # 降级：BM25 在 DomainGroup 索引上匹配
        hits = self._group_bm25.search(intent.intent, top_k=2)
        return [h[0] for h in hits] if hits else ["general"]

    # ===== Level-2: Domain 路由（BM25 降级） =====
    def _route_to_domain(self, intent: ParsedIntent, groups: list[str]) -> list[str]:
        """从 DomainGroup 下推到具体 Domain；优先 intent 命中的 domain。"""
        domains: list[str] = []
        for group in groups:
            for domain in DOMAIN_GROUPS.get(group, []):
                if domain not in domains:
                    domains.append(domain)
        if intent.domain_candidates:
            intersection = [d for d in intent.domain_candidates if d in domains]
            if intersection:
                return intersection
            return intent.domain_candidates
        if domains:
            return domains
        # 降级：BM25 在 Domain 索引上匹配
        hits = self._domain_bm25.search(intent.intent, top_k=3)
        return [h[0] for h in hits] if hits else ["misc"]

    # ===== Level-3: Capability 解析 =====
    @staticmethod
    def _resolve_capabilities(intent: ParsedIntent, domains: list[str]) -> list[str]:
        suffix = intent.primary_capability.split(".", 1)[1] if "." in intent.primary_capability else "general"
        out = [intent.primary_capability.lower()]
        for domain in domains:
            candidate = f"{domain}.{suffix}".lower()
            if candidate not in out:
                out.append(candidate)
            general = f"{domain}.general"
            if general not in out:
                out.append(general)
        return out

    # ===== Neo4j 跨领域依赖跳转 =====
    def _graph_expand(self, domains: list[str]) -> list[str]:
        """通过 combine_with 关系发现关联领域，补齐跨域候选。"""
        expanded: list[str] = []
        for record in self.registry.list_records():
            if clean_domain(record.level1.domain) not in domains:
                continue
            for edge in self.registry.list_graph_edges(record.level1.resource_id, {"combine_with"}):
                target = self.registry.get(edge.target_id)
                if target is None:
                    continue
                cleaned = clean_domain(target.level1.domain)
                if cleaned not in domains and cleaned not in expanded:
                    expanded.append(cleaned)
        return expanded