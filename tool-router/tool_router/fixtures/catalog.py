from __future__ import annotations

from dataclasses import dataclass

from tool_router.models import (
    Environment,
    GraphEdge,
    GraphRelationType,
    Level1IndexMeta,
    Level2CapabilityMeta,
    Level3ExecutionSchema,
    McpExecutionSchema,
    ResourceRecord,
    ResourceType,
    SkillExecutionSchema,
    ToolExecutionSchema,
)


@dataclass(frozen=True)
class BenchmarkCase:
    expected_name: str
    query: str


def build_fixture_resources() -> list[ResourceRecord]:
    specs: list[dict] = [
        {
            "name": "clock.get_current_time",
            "resource_type": ResourceType.tool,
            "domain": "clock",
            "capability": ["clock.query", "clock.time", "clock.general"],
            "description": "Get the current local time now and format time answers.",
            "use_cases": ["what time is it now", "current local time", "time now"],
            "tags": ["time", "clock", "datetime"],
        },
        {
            "name": "clock.get_date",
            "resource_type": ResourceType.tool,
            "domain": "clock",
            "capability": ["clock.query", "clock.date", "clock.general"],
            "description": "Get today's date and calendar date information.",
            "use_cases": ["what is today's date", "current date", "today date"],
            "tags": ["date", "calendar", "today"],
        },
        {
            "name": "weather.get_local",
            "resource_type": ResourceType.tool,
            "domain": "weather",
            "capability": ["weather.query", "weather.search", "weather.general"],
            "description": "Get local weather forecast, temperature, rain, humidity and wind conditions.",
            "use_cases": ["weather forecast for my location", "temperature and rain", "local weather"],
            "tags": ["weather", "forecast", "temperature", "rain", "wind"],
        },
        {
            "name": "calendar.list_tasks",
            "resource_type": ResourceType.tool,
            "domain": "calendar",
            "capability": ["calendar.list", "calendar.query", "calendar.general"],
            "description": "List todo tasks, pending calendar items and schedule tasks.",
            "use_cases": ["list my todo tasks", "show pending tasks", "tasks and todos"],
            "tags": ["calendar", "tasks", "todo", "list"],
        },
        {
            "name": "search_web",
            "resource_type": ResourceType.tool,
            "domain": "search",
            "capability": ["search.search", "search.query", "search.general"],
            "description": "Search the web, google results, and latest online news.",
            "use_cases": ["search web for latest AI news", "web search", "google the web"],
            "tags": ["search", "web", "news", "google"],
        },
        {
            "name": "fetch_web",
            "resource_type": ResourceType.tool,
            "domain": "browser",
            "capability": ["browser.read", "browser.fetch", "browser.general"],
            "description": "Fetch and read a web page, article content, or URL body.",
            "use_cases": ["read this web page content", "fetch webpage content", "read URL"],
            "tags": ["browser", "fetch", "webpage", "content"],
        },
        {
            "name": "browser.session.list",
            "resource_type": ResourceType.tool,
            "domain": "browser",
            "capability": ["browser.list", "browser.query", "browser.general"],
            "description": "List browser tabs, sessions and open web pages.",
            "use_cases": ["list browser tabs", "show tabs", "browser sessions"],
            "tags": ["browser", "tabs", "session"],
        },
        {
            "name": "agent.query_capabilities",
            "resource_type": ResourceType.tool,
            "domain": "agent",
            "capability": ["agent.query", "agent.list", "agent.general"],
            "description": "List the tools and capabilities the agent can use.",
            "use_cases": ["what tools and capabilities can you use", "agent capabilities", "available tools"],
            "tags": ["agent", "capabilities", "tools", "self"],
        },
        {
            "name": "phone.call_user",
            "resource_type": ResourceType.tool,
            "domain": "phone",
            "capability": ["phone.execute", "phone.call", "phone.general"],
            "description": "Call the user over the phone and deliver a reminder message.",
            "use_cases": ["call me to remind me", "phone reminder call", "dial the user"],
            "tags": ["phone", "call", "reminder"],
        },
        {
            "name": "budget.calculate",
            "resource_type": ResourceType.tool,
            "domain": "budget",
            "capability": ["budget.query", "budget.calculate", "budget.general"],
            "description": "Calculate monthly budget, expenses, categories and planning.",
            "use_cases": ["calculate my monthly budget", "budget planning", "expense budget"],
            "tags": ["budget", "calculate", "finance"],
        },
        {
            "name": "shopping.suggest",
            "resource_type": ResourceType.tool,
            "domain": "shopping",
            "capability": ["shopping.query", "shopping.plan", "shopping.general"],
            "description": "Recommend products to buy such as a laptop or shopping shortlist.",
            "use_cases": ["recommend a laptop to buy", "shopping suggestions", "product recommendation"],
            "tags": ["shopping", "recommend", "laptop", "buy"],
        },
        {
            "name": "self.list_custom_skills",
            "resource_type": ResourceType.tool,
            "domain": "self",
            "capability": ["self.list", "self.query", "self.general"],
            "description": "List my custom skills and installed personal capabilities.",
            "use_cases": ["list my custom skills", "show installed skills", "custom skills"],
            "tags": ["skills", "custom", "self"],
        },
        {
            "name": "calendar.create_task",
            "resource_type": ResourceType.tool,
            "domain": "calendar",
            "capability": ["calendar.create", "calendar.plan", "calendar.general"],
            "description": "Create a calendar task or todo for tomorrow or another date.",
            "use_cases": ["create a calendar task for tomorrow", "add todo task", "schedule task"],
            "tags": ["calendar", "create", "task"],
            "required": ["title"],
        },
        {
            "name": "calendar.create_from_text",
            "resource_type": ResourceType.tool,
            "domain": "calendar",
            "capability": ["calendar.extract", "calendar.create", "calendar.general"],
            "description": "Extract schedule and calendar tasks from text content.",
            "use_cases": ["extract schedule from this text", "create events from text", "parse schedule"],
            "tags": ["calendar", "extract", "text", "schedule"],
            "required": ["text"],
        },
        {
            "name": "reminder.plan",
            "resource_type": ResourceType.tool,
            "domain": "reminder",
            "capability": ["reminder.create", "reminder.plan", "reminder.general"],
            "description": "Set a reminder in ten minutes or plan a reminder time.",
            "use_cases": ["set a reminder in ten minutes", "plan reminder", "reminder schedule"],
            "tags": ["reminder", "plan", "timer"],
            "required": ["message"],
        },
        {
            "name": "agent.send_to_peer",
            "resource_type": ResourceType.tool,
            "domain": "agent",
            "capability": ["agent.send", "agent.execute", "agent.general"],
            "description": "Send this message to another peer agent.",
            "use_cases": ["send this message to another agent", "agent peer message", "message peer agent"],
            "tags": ["agent", "peer", "send", "message"],
            "required": ["message", "peer_id"],
        },
        {
            "name": "agent.link.send_friend_request",
            "resource_type": ResourceType.tool,
            "domain": "agent",
            "capability": ["agent.request", "agent.send", "agent.general"],
            "description": "Send another agent a friend request link invitation.",
            "use_cases": ["send another agent a friend request", "agent friend request", "invite friend agent"],
            "tags": ["agent", "friend", "request", "invite"],
            "required": ["peer_id"],
        },
        {
            "name": "agent.link.list_friends",
            "resource_type": ResourceType.tool,
            "domain": "agent",
            "capability": ["agent.list", "agent.query", "agent.general"],
            "description": "List my agent friends and linked peer agents.",
            "use_cases": ["list my agent friends", "show linked agents", "friend agents"],
            "tags": ["agent", "friends", "list"],
        },
        {
            "name": "wallet.get_balance",
            "resource_type": ResourceType.tool,
            "domain": "wallet",
            "capability": ["wallet.query", "wallet.balance", "wallet.general"],
            "description": "Check my wallet balance and funds available.",
            "use_cases": ["check my wallet balance", "wallet funds", "current balance"],
            "tags": ["wallet", "balance", "money"],
        },
        {
            "name": "wallet.get_transactions",
            "resource_type": ResourceType.tool,
            "domain": "wallet",
            "capability": ["wallet.list", "wallet.query", "wallet.general"],
            "description": "Show recent wallet transactions and history.",
            "use_cases": ["show recent wallet transactions", "wallet history", "recent transactions"],
            "tags": ["wallet", "transactions", "history"],
        },
        {
            "name": "aip.dispatch",
            "resource_type": ResourceType.tool,
            "domain": "aip",
            "capability": ["aip.execute", "aip.dispatch", "aip.general"],
            "description": "Dispatch an AIP protocol request to the coordination network.",
            "use_cases": ["dispatch an AIP protocol request", "aip dispatch", "protocol dispatch"],
            "tags": ["aip", "dispatch", "protocol"],
            "required": ["payload"],
        },
        {
            "name": "embodiment.window_place",
            "resource_type": ResourceType.tool,
            "domain": "embodiment",
            "capability": ["embodiment.execute", "embodiment.place", "embodiment.general"],
            "description": "Place avatar window at a screen position or coordinate.",
            "use_cases": ["place avatar window at position", "window placement", "avatar position"],
            "tags": ["embodiment", "window", "position", "avatar"],
            "required": ["x", "y"],
        },
        {
            "name": "embodiment.roam",
            "resource_type": ResourceType.tool,
            "domain": "embodiment",
            "capability": ["embodiment.execute", "embodiment.roam", "embodiment.general"],
            "description": "Let avatar roam around the screen and wander.",
            "use_cases": ["let avatar roam around", "avatar roam", "wander screen"],
            "tags": ["embodiment", "roam", "avatar"],
        },
        {
            "name": "desktop.run_automation",
            "resource_type": ResourceType.tool,
            "domain": "desktop",
            "capability": ["desktop.execute", "desktop.run", "desktop.general"],
            "description": "Run desktop automation task script and local automation flows.",
            "use_cases": ["run desktop automation task script", "desktop automation", "automation flow"],
            "tags": ["desktop", "automation", "script"],
            "required": ["task"],
        },
        {
            "name": "desktop.run_shell",
            "resource_type": ResourceType.tool,
            "domain": "desktop",
            "capability": ["desktop.execute", "desktop.shell", "desktop.general"],
            "description": "Execute a shell command on the desktop system.",
            "use_cases": ["execute a shell command", "run shell", "shell command"],
            "tags": ["desktop", "shell", "command", "execute"],
            "required": ["command"],
        },
        {
            "name": "world.open_registry.agent_quick",
            "resource_type": ResourceType.tool,
            "domain": "world",
            "capability": ["world.register", "world.create", "world.general"],
            "description": "Register an agent in the world registry quickly.",
            "use_cases": ["register an agent in the world registry", "world registry agent", "agent registry"],
            "tags": ["world", "registry", "agent", "register"],
            "required": ["agent_name"],
        },
        {
            "name": "travel.plan_trip",
            "resource_type": ResourceType.skill,
            "domain": "travel",
            "capability": ["travel.plan", "travel.create", "travel.general"],
            "description": "Plan travel itinerary, hotels, flights and daily route schedules.",
            "use_cases": ["plan a travel itinerary for Tokyo", "trip plan", "travel itinerary"],
            "tags": ["travel", "trip", "itinerary", "skill"],
            "required": ["destination"],
        },
        {
            "name": "mcp.github.search_repositories",
            "resource_type": ResourceType.mcp_server,
            "domain": "mcp",
            "capability": ["mcp.search", "mcp.query", "mcp.general"],
            "description": "Search GitHub repositories through an external MCP server integration.",
            "use_cases": ["use mcp github to search repositories", "github repository search", "mcp github"],
            "tags": ["mcp", "github", "repositories", "integration"],
        },
    ]

    resources: list[ResourceRecord] = []
    for spec in specs:
        capabilities = spec.get(
            "capability",
            [f'{spec["domain"]}.{_default_action(spec["name"])}', f'{spec["domain"]}.general'],
        )
        level3 = Level3ExecutionSchema(
            tool=ToolExecutionSchema(
                parameters={"type": "object"},
                required=spec.get("required", []),
                timeout_ms=15000,
            )
            if spec["resource_type"] == ResourceType.tool
            else None,
            skill=SkillExecutionSchema(
                workflow=["intent_router", "retrieval", "plan", "deliver"],
                child_resources=[],
                retry_policy={"retries": 2},
                fallback_resources=[],
            )
            if spec["resource_type"] == ResourceType.skill
            else None,
            mcp_server=McpExecutionSchema(
                transport="http",
                endpoint="https://example.invalid/mcp",
                rpc_methods=["searchRepositories"],
                auth_config={"mode": "token"},
                connection_pool={"size": 4},
            )
            if spec["resource_type"] == ResourceType.mcp_server
            else None,
        )
        resources.append(
            ResourceRecord(
                level1=Level1IndexMeta(
                    resource_id=spec["name"],
                    tenant_id="default",
                    resource_type=spec["resource_type"],
                    name=spec["name"],
                    description=spec["description"],
                    domain=spec["domain"],
                    capability=capabilities,
                    tags=spec["tags"],
                    version="1.0.0",
                    environment=Environment.dev,
                    base_score=0.55,
                    latency_ms=_latency_for_domain(spec["domain"]),
                ),
                level2=Level2CapabilityMeta(
                    input_type="json",
                    output_type="json",
                    use_cases=spec["use_cases"],
                    limitations=["demo fixture"],
                    preconditions=["resource online"],
                    dependencies=[],
                ),
                level3=level3,
            )
        )

    resources.extend(_build_decoy_resources())
    return resources


def build_graph_edges() -> list[GraphEdge]:
    return [
        GraphEdge(
            source_id="calendar.create_task",
            target_id="reminder.plan",
            relation=GraphRelationType.combine_with,
            weight=0.8,
        ),
        GraphEdge(
            source_id="calendar.create_from_text",
            target_id="calendar.create_task",
            relation=GraphRelationType.combine_with,
            weight=0.9,
        ),
        GraphEdge(
            source_id="desktop.run_automation",
            target_id="desktop.run_shell",
            relation=GraphRelationType.alternative_to,
            weight=0.6,
        ),
        GraphEdge(
            source_id="agent.send_to_peer",
            target_id="agent.link.list_friends",
            relation=GraphRelationType.depends_on,
            weight=0.75,
        ),
        GraphEdge(
            source_id="shopping.suggest",
            target_id="wallet.get_balance",
            relation=GraphRelationType.combine_with,
            weight=0.55,
        ),
        GraphEdge(
            source_id="world.open_registry.agent_quick",
            target_id="agent.query_capabilities",
            relation=GraphRelationType.combine_with,
            weight=0.5,
        ),
    ]


def build_benchmark_cases() -> list[BenchmarkCase]:
    return [
        BenchmarkCase("clock.get_current_time", "what time is it now"),
        BenchmarkCase("clock.get_date", "what is today's date"),
        BenchmarkCase("weather.get_local", "weather forecast for my location"),
        BenchmarkCase("calendar.list_tasks", "list my todo tasks"),
        BenchmarkCase("search_web", "search web for latest AI news"),
        BenchmarkCase("fetch_web", "read this web page content"),
        BenchmarkCase("browser.session.list", "list browser tabs"),
        BenchmarkCase("agent.query_capabilities", "what tools and capabilities can you use"),
        BenchmarkCase("phone.call_user", "call me to remind me"),
        BenchmarkCase("budget.calculate", "calculate my monthly budget"),
        BenchmarkCase("shopping.suggest", "recommend a laptop to buy"),
        BenchmarkCase("self.list_custom_skills", "list my custom skills"),
        BenchmarkCase("calendar.create_task", "create a calendar task for tomorrow"),
        BenchmarkCase("calendar.create_from_text", "extract schedule from this text"),
        BenchmarkCase("reminder.plan", "set a reminder in ten minutes"),
        BenchmarkCase("agent.send_to_peer", "send this message to another agent"),
        BenchmarkCase("agent.link.send_friend_request", "send another agent a friend request"),
        BenchmarkCase("agent.link.list_friends", "list my agent friends"),
        BenchmarkCase("wallet.get_balance", "check my wallet balance"),
        BenchmarkCase("wallet.get_transactions", "show recent wallet transactions"),
        BenchmarkCase("aip.dispatch", "dispatch an AIP protocol request"),
        BenchmarkCase("embodiment.window_place", "place avatar window at position"),
        BenchmarkCase("embodiment.roam", "let avatar roam around"),
        BenchmarkCase("desktop.run_automation", "run desktop automation task script"),
        BenchmarkCase("desktop.run_shell", "execute a shell command"),
        BenchmarkCase("world.open_registry.agent_quick", "register an agent in the world registry"),
        BenchmarkCase("travel.plan_trip", "use my custom skill to plan a travel itinerary for Tokyo"),
        BenchmarkCase("mcp.github.search_repositories", "use mcp github to search repositories"),
    ]


def make_synthetic_resources(count: int) -> list[ResourceRecord]:
    domains = [
        ("weather", "query"),
        ("calendar", "create"),
        ("search", "query"),
        ("browser", "navigate"),
        ("phone", "execute"),
        ("wallet", "query"),
        ("desktop", "execute"),
        ("agent", "query"),
        ("embodiment", "execute"),
        ("world", "create"),
    ]
    resources: list[ResourceRecord] = []
    for idx in range(count):
        domain, action = domains[idx % len(domains)]
        resource_type = ResourceType.tool if idx % 17 else ResourceType.skill
        if idx % 41 == 0:
            resource_type = ResourceType.mcp_server
            domain = "mcp"
            action = "query"
        name = f"{domain}.synthetic_{idx}.{action}"
        resources.append(
            ResourceRecord(
                level1=Level1IndexMeta(
                    resource_id=name,
                    tenant_id="default",
                    resource_type=resource_type,
                    name=name,
                    description=f"Synthetic {domain} resource {idx} for {action} requests and benchmark evaluation.",
                    domain=domain,
                    capability=[f"{domain}.{action}", f"{domain}.general"],
                    tags=[domain, action, "synthetic", "benchmark"],
                    environment=Environment.dev,
                    base_score=0.5,
                    latency_ms=_latency_for_domain(domain) + (idx % 7),
                ),
                level2=Level2CapabilityMeta(
                    input_type="json",
                    output_type="json",
                    use_cases=[f"{domain} benchmark query", f"{domain} benchmark execute"],
                    limitations=["synthetic"],
                    preconditions=["online"],
                    dependencies=[],
                ),
                level3=Level3ExecutionSchema(
                    tool=ToolExecutionSchema(parameters={"type": "object"}, required=[]),
                    skill=SkillExecutionSchema(workflow=["plan", "act"], child_resources=[], retry_policy={}, fallback_resources=[])
                    if resource_type == ResourceType.skill
                    else None,
                    mcp_server=McpExecutionSchema(transport="http", endpoint="https://example.invalid")
                    if resource_type == ResourceType.mcp_server
                    else None,
                ),
            )
        )
    return resources


def _build_decoy_resources() -> list[ResourceRecord]:
    decoys: list[tuple[str, str, list[str], list[str]]] = [
        ("weather.get_weekly", "weather", ["weekly forecast", "week weather"], ["weather", "weekly"]),
        ("calendar.list_events", "calendar", ["list events", "calendar events"], ["calendar", "events"]),
        ("search_images", "search", ["search for images", "image web search"], ["search", "images"]),
        ("browser.fetch_page", "browser", ["fetch page", "browser page fetch"], ["browser", "fetch"]),
        ("wallet.transfer", "wallet", ["transfer funds", "wallet payment"], ["wallet", "transfer"]),
        ("desktop.visual.screenshot", "desktop", ["take screenshot", "screen image"], ["desktop", "screenshot"]),
        ("agent.link.list_friend_requests", "agent", ["list friend requests", "pending agent requests"], ["agent", "friends"]),
        ("embodiment.window_roam", "embodiment", ["roam the window", "window movement"], ["embodiment", "window"]),
    ]
    out: list[ResourceRecord] = []
    for name, domain, use_cases, tags in decoys:
        out.append(
            ResourceRecord(
                level1=Level1IndexMeta(
                    resource_id=name,
                    tenant_id="default",
                    resource_type=ResourceType.tool,
                    name=name,
                    description=f"Decoy resource {name} in {domain}.",
                    domain=domain,
                    capability=[f"{domain}.{_default_action(name)}", f"{domain}.general"],
                    tags=tags,
                    environment=Environment.dev,
                    base_score=0.45,
                    latency_ms=_latency_for_domain(domain) + 5,
                ),
                level2=Level2CapabilityMeta(use_cases=use_cases),
                level3=Level3ExecutionSchema(tool=ToolExecutionSchema(parameters={"type": "object"}, required=[])),
            )
        )
    return out


def _default_action(name: str) -> str:
    if any(token in name for token in [".create", ".set", ".dispatch", ".run", ".place", ".call", ".send"]):
        return "execute"
    if ".list" in name:
        return "list"
    return "query"


def _latency_for_domain(domain: str) -> int:
    mapping = {
        "clock": 10,
        "weather": 18,
        "calendar": 15,
        "search": 24,
        "browser": 20,
        "phone": 32,
        "budget": 14,
        "shopping": 18,
        "self": 12,
        "reminder": 16,
        "agent": 19,
        "wallet": 13,
        "aip": 26,
        "embodiment": 23,
        "desktop": 27,
        "world": 28,
        "travel": 22,
        "mcp": 30,
    }
    return mapping.get(domain, 20)
