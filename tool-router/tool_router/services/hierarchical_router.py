from __future__ import annotations

import time

from tool_router.config import Settings
from tool_router.models import Environment, ParsedIntent, ResourceRecord, ResourceType
from tool_router.services.registry import RegistryStore, clean_domain, infer_domain_groups


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
    def __init__(self, registry: RegistryStore, settings: Settings) -> None:
        self.registry = registry
        self.settings = settings
        self.route_cache: dict[tuple[str, str, str, str, str], tuple[float, list[str]]] = {}

    def route(self, tenant_id: str, environment: Environment, intent: ParsedIntent) -> HierarchicalRouteResult:
        domains = self._resolve_domains(intent)
        groups = self._resolve_domain_groups(domains)
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
        self.route_cache[cache_key] = (
            time.time() + self.settings.route_cache_ttl_seconds,
            [resource.level1.resource_id for resource in resources],
        )
        return HierarchicalRouteResult(groups, domains, capabilities, resources)

    @staticmethod
    def _resolve_domains(intent: ParsedIntent) -> list[str]:
        out = [clean_domain(value) for value in intent.domain_candidates if value]
        primary_domain = clean_domain(intent.primary_capability.split(".")[0])
        if primary_domain not in out:
            out.insert(0, primary_domain)
        return out or ["misc"]

    @staticmethod
    def _resolve_domain_groups(domains: list[str]) -> list[str]:
        out: list[str] = []
        for domain in domains:
            for group in infer_domain_groups(domain, ResourceType.tool):
                if group not in out:
                    out.append(group)
        return out or ["general"]

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
