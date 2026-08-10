from __future__ import annotations

import re
from hashlib import sha1

from tool_router.models import ParsedIntent, QueryConstraints


class IntentRouter:
    def __init__(self) -> None:
        self.cache: dict[str, ParsedIntent] = {}

    def decompose(self, raw_user_query: str, agent_context_hash: str) -> ParsedIntent:
        cache_key = self._cache_key(raw_user_query, agent_context_hash)
        cached = self.cache.get(cache_key)
        if cached is not None:
            return cached.model_copy(deep=True)

        query = raw_user_query.strip()
        parts = self._split_compound(query)
        if len(parts) > 1:
            sub_intents = [self._route_single(part) for part in parts]
            intent = ParsedIntent(
                intent=query,
                domain_candidates=self._unique([d for item in sub_intents for d in item.domain_candidates]) or ["misc"],
                primary_capability=sub_intents[0].primary_capability,
                confidence=min(0.95, max(item.confidence for item in sub_intents)),
                query_constraints=sub_intents[0].query_constraints,
                param_extract={},
                is_compound_task=True,
                sub_intents=sub_intents,
            )
            self.cache[cache_key] = intent
            return intent.model_copy(deep=True)
        intent = self._route_single(query)
        self.cache[cache_key] = intent
        return intent.model_copy(deep=True)

    def _route_single(self, query: str) -> ParsedIntent:
        domains = self._domains_from_query(query)
        primary_domain = domains[0] if domains else "misc"
        primary_capability = f"{primary_domain}.{self._infer_action(query)}"
        confidence = 0.9 if len(query.split()) > 5 else 0.7
        return ParsedIntent(
            intent=query,
            domain_candidates=domains or ["misc"],
            primary_capability=primary_capability,
            confidence=confidence,
            query_constraints=self._infer_constraints(query),
            param_extract=self._extract_params(query),
            is_compound_task=False,
            sub_intents=[],
        )

    @staticmethod
    def _split_compound(query: str) -> list[str]:
        parts = [part.strip() for part in re.split(r"\b(?:and|then|同时|然后|并且|以及)\b|[;,，；]", query) if part.strip()]
        return [part for part in parts if len(part) >= 2]

    @staticmethod
    def _domains_from_query(query: str) -> list[str]:
        q = query.lower()
        rules: list[tuple[re.Pattern[str], list[str]]] = [
            (re.compile(r"\bmcp\b|\bintegration\b|\bexternal\b"), ["mcp"]),
            (re.compile(r"\bweather\b|\bforecast\b|\btemperature\b"), ["weather"]),
            (re.compile(r"\brain\b|\bwind\b|\bhumidity\b"), ["weather"]),
            (re.compile(r"\bcalendar\b|\bschedule\b|\bmeeting\b|\btask\b|\btodo\b"), ["calendar", "reminder"]),
            (re.compile(r"\bremind\b|\breminder\b"), ["reminder"]),
            (re.compile(r"\bsearch\b|\bgoogle\b|\bnews\b|\bfind\b"), ["search"]),
            (re.compile(r"\bread\b|\bfetch\b|\bcontent\b"), ["browser", "search"]),
            (re.compile(r"\bweb\b|\bbrowser\b|\burl\b|\bpage\b"), ["browser", "search"]),
            (re.compile(r"\btab\b|\btabs\b"), ["browser"]),
            (re.compile(r"\bphone\b|\bcall\b|\bsms\b|\bmessage\b"), ["phone"]),
            (re.compile(r"\bfriend request\b|\bpeer\b"), ["agent"]),
            (re.compile(r"\bwallet\b|\bpayment\b|\bbalance\b|\bshopping\b|\bbudget\b"), ["wallet", "budget", "shopping"]),
            (re.compile(r"\brecommend\b|\bbuy\b|\blaptop\b"), ["shopping"]),
            (re.compile(r"\bdesktop\b|\bshell\b|\bautomation\b|\bwindow\b"), ["desktop"]),
            (re.compile(r"\bavatar\b|\bembodiment\b|\broam\b"), ["embodiment"]),
            (re.compile(r"\bskill\b|\bcapabilit(?:y|ies)\b|\bcustom\b"), ["self", "agent"]),
            (re.compile(r"\bworld\b|\bregistry\b|\bagent\b"), ["world", "agent"]),
            (re.compile(r"\btravel\b|\btrip\b|\bitinerary\b"), ["travel"]),
            (re.compile(r"\btime\b|\bclock\b|\bdate\b"), ["clock"]),
            (re.compile(r"\baip\b|\bprotocol\b"), ["aip"]),
        ]
        out: list[str] = []
        for pattern, domains in rules:
            if pattern.search(q):
                out.extend(domains)
        return IntentRouter._unique(out)

    @staticmethod
    def _infer_action(query: str) -> str:
        q = query.lower()
        if re.search(r"\bfriend request\b|\binvite\b", q):
            return "request"
        if re.search(r"\bregister\b", q):
            return "register"
        if re.search(r"\bextract\b|\bparse\b", q):
            return "extract"
        if re.search(r"\bsearch\b|\bgoogle\b|\blookup\b", q):
            return "search"
        if re.search(r"\bread\b|\bfetch\b", q):
            return "read"
        if re.search(r"\bplan\b", q):
            return "plan"
        if re.search(r"\bsend\b", q):
            return "send"
        if re.search(r"\bcreate\b|\badd\b|\bschedule\b|\bset\b", q):
            return "create"
        if re.search(r"\brun\b|\bexecute\b|\bcall\b|\bdispatch\b", q):
            return "execute"
        if re.search(r"\bopen\b|\bnavigate\b|\bbrowse\b", q):
            return "navigate"
        if re.search(r"\blist\b|\bshow\b", q):
            return "list"
        return "query"

    @staticmethod
    def _infer_constraints(query: str) -> QueryConstraints:
        q = query.lower()
        return QueryConstraints(
            max_latency_ms=100 if "fast" in q or "quick" in q else 200,
            read_only=not bool(
                re.search(r"\bcreate\b|\bupdate\b|\bdelete\b|\bsend\b|\bexecute\b|\bextract\b|\bparse\b|\bplan\b|\bschedule\b|\bset\b", q)
            ),
            file_type="pdf" if "pdf" in q else None,
        )

    @staticmethod
    def _extract_params(query: str) -> dict[str, str]:
        words = query.split()
        return {"query_text": query, "keyword": words[-1] if words else ""}

    @staticmethod
    def _unique(values: list[str]) -> list[str]:
        out: list[str] = []
        for value in values:
            if value not in out:
                out.append(value)
        return out

    @staticmethod
    def _cache_key(raw_user_query: str, agent_context_hash: str) -> str:
        return sha1(f"{raw_user_query}\0{agent_context_hash}".encode("utf-8")).hexdigest()
