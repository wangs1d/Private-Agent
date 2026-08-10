import "../src/config/load-server-env.js";

import assert from "node:assert/strict";

import type { ChatCompletionTool } from "openai/resources/chat/completions";

import { skillManifestToChatTool } from "../src/skills/skill-openai-bridge.js";
import {
  executeToolSearchBridge,
  prepareToolsWithToolSearch,
} from "../src/tools/tool-search/index.js";
import { shutdownToolRouterWorker } from "../src/tools/tool-search/tool-router-adapter.js";

const EXPECTED_SEARCH_PATH = [
  "intent_router",
  "hierarchical_router",
  "hybrid_retrieval",
  "adaptive_top_p",
  "knowledge_graph_expansion",
  "tool_reranking",
];

function tool(name: string, description: string): ChatCompletionTool {
  return {
    type: "function",
    function: {
      name,
      description,
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "User query or task text." },
        },
        required: ["query"],
        additionalProperties: false,
      },
    },
  };
}

const builtinTool = tool(
  "weather.get_local",
  "Get local weather, forecast, temperature, rain and wind conditions.",
);

const customSkill = skillManifestToChatTool({
  name: "travel.plan_trip",
  version: "1.0.0",
  displayName: "Trip planner",
  description: "Plan travel itinerary, hotels, flights and daily route schedules.",
  kind: "builtin",
  parameters: [
    {
      name: "destination",
      type: "string",
      required: true,
      description: "Trip destination.",
    },
  ],
  permissions: ["network:external"],
  enabled: true,
  trusted: true,
});

const mcpTool = tool(
  "mcp.github.search_repositories",
  "Search GitHub repositories through an external MCP server integration.",
);

async function discover(query: string) {
  const prepared = prepareToolsWithToolSearch([], [builtinTool, customSkill, mcpTool]);
  const result = await executeToolSearchBridge(
    "tool_discover",
    { query, limit: 3 },
    prepared.deferredCatalog,
  );
  assert.equal(result.kind, "discover");
  assert.equal(result.ok, true);
  return result.result as {
    search_path?: string[];
    matches?: Array<{
      name: string;
      resource_type?: string;
      routing?: {
        domain_groups?: string[];
        domain_candidates?: string[];
        primary_capability?: string;
      };
    }>;
  };
}

async function assertTop(
  query: string,
  name: string,
  resourceType: string,
  expectedDomainGroup: string,
): Promise<void> {
  const result = await discover(query);
  assert.deepEqual(result.search_path, EXPECTED_SEARCH_PATH);
  const first = result.matches?.[0];
  assert.equal(first?.name, name);
  assert.equal(first?.resource_type, resourceType);
  assert.ok(first?.routing?.domain_groups?.includes(expectedDomainGroup));
}

await assertTop("what is the weather forecast and temperature", "weather.get_local", "tool", "signals");
await assertTop(
  "use my custom skill to plan a travel itinerary for Tokyo",
  "travel.plan_trip",
  "skill",
  "productivity",
);
await assertTop(
  "use mcp github to search repositories",
  "mcp.github.search_repositories",
  "mcp_server",
  "integration",
);

console.log("[adaptive-resource-type-routing] ok");
shutdownToolRouterWorker();
