import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  AdaptiveTopPSelector,
  AsyncFeedbackQueue,
  HierarchicalRouter,
  HistoryScoreStore,
  HybridRetrievalEngine,
  IntentRouter,
  McpConnectionPool,
  OnlineLearner,
  RegistryService,
  ResourceLazyLoader,
  ResourceType,
  ToolFailureCircuitBreaker,
  ToolKnowledgeGraphService,
  ToolRegistryStore,
  feedbackReportSchema,
  toolSearchMetrics,
} from "../src/tools/tool-search/index.js";

const tmp = mkdtempSync(join(tmpdir(), "tool-registry-"));
const sqlitePath = join(tmp, "registry.db");

async function main(): Promise<void> {
  const store = new ToolRegistryStore({
    qdrantUrl: "",
    redisUrl: "",
    sqlitePath,
  });
  await store.initialize();

  const registry = new RegistryService(store);
  const history = new HistoryScoreStore({ redisUrl: "", windowMs: 60_000 });
  const graph = new ToolKnowledgeGraphService(store);
  const intentRouter = new IntentRouter({ redisUrl: "" });
  const router = new HierarchicalRouter(store, { redisUrl: "" });
  const retrieval = new HybridRetrievalEngine({ historyStore: history });
  const topP = new AdaptiveTopPSelector();
  const lazyLoader = new ResourceLazyLoader(store, graph, { redisUrl: "" });
  const learner = new OnlineLearner({ redisUrl: "", historyStore: history });
  const feedbackQueue = new AsyncFeedbackQueue();
  feedbackQueue.registerConsumer(async () => undefined);
  const breaker = new ToolFailureCircuitBreaker(store, {
    historyStore: history,
    consecutiveFailureThreshold: 3,
    minSamples: 3,
  });

  const weather = await registry.register({
    resource_id: "res.weather.current",
    resource_type: ResourceType.Tool,
    name: "weather.current",
    description: "查询本地天气、温度和天气预报",
    domain: ["weather"],
    capability: ["weather.query"],
    tags: ["weather", "read"],
    version: "1.0.0",
    embedding: [1, 0, 0, 0],
    level2: {
      resource_id: "",
      input_type: "object:WeatherInput",
      output_type: "object:WeatherBrief",
      use_cases: ["查天气", "天气预报", "temperature forecast"],
      limitations: [],
      preconditions: [],
      dependencies: [],
    },
    level3: {
      resource_id: "",
      parameters: [{ name: "city", type: "string", required: true }],
      required_fields: ["city"],
      validation_rules: {},
      timeout_ms: 2000,
    },
    tenant_id: "tenant-a",
  });
  assert.equal(weather.ok, true);

  const briefing = await registry.register({
    resource_id: "res.weather.briefing",
    resource_type: ResourceType.Skill,
    name: "weather.briefing",
    description: "生成天气简报并组合天气查询结果",
    domain: ["weather"],
    capability: ["weather.query", "weather.briefing"],
    tags: ["weather", "read"],
    version: "1.0.0",
    embedding: [0.9, 0.1, 0, 0],
    level2: {
      resource_id: "",
      input_type: "object:BriefingInput",
      output_type: "text",
      use_cases: ["天气简报", "出门建议"],
      limitations: [],
      preconditions: [],
      dependencies: ["res.weather.current"],
    },
    level3: {
      resource_id: "",
      workflow: { start: "res.weather.current" },
      subtools: ["res.weather.current"],
      branch_conditions: {},
      retry_policy: { max_retries: 1, backoff_ms: 100 },
      fallback_resource_id: null,
    },
    tenant_id: "tenant-a",
  });
  assert.equal(briefing.ok, true);

  const cycleB = await registry.register({
    resource_id: "res.cycle.b",
    resource_type: ResourceType.Skill,
    name: "cycle.b",
    description: "cycle b",
    domain: ["misc"],
    capability: ["misc.general"],
    tags: [],
    version: "1.0.0",
    embedding: [0, 1, 0, 0],
    level2: {
      resource_id: "",
      input_type: "object",
      output_type: "object",
      use_cases: [],
      limitations: [],
      preconditions: [],
      dependencies: ["res.cycle.a"],
    },
    level3: {
      resource_id: "",
      workflow: {},
      subtools: [],
      branch_conditions: {},
      retry_policy: { max_retries: 0, backoff_ms: 0 },
      fallback_resource_id: null,
    },
    tenant_id: "tenant-a",
  });
  assert.equal(cycleB.ok, true);

  const cycleA = await registry.register({
    resource_id: "res.cycle.a",
    resource_type: ResourceType.Skill,
    name: "cycle.a",
    description: "cycle a",
    domain: ["misc"],
    capability: ["misc.general"],
    tags: [],
    version: "1.0.0",
    embedding: [0, 1, 0, 0],
    level2: {
      resource_id: "",
      input_type: "object",
      output_type: "object",
      use_cases: [],
      limitations: [],
      preconditions: [],
      dependencies: ["res.cycle.b"],
    },
    level3: {
      resource_id: "",
      workflow: {},
      subtools: [],
      branch_conditions: {},
      retry_policy: { max_retries: 0, backoff_ms: 0 },
      fallback_resource_id: null,
    },
    tenant_id: "tenant-a",
  });
  assert.equal(cycleA.ok, false);
  assert.equal(cycleA.error_code, "CIRCULAR_DEPENDENCY_DETECTED");

  const intent = await intentRouter.decompose({
    raw_user_query: "查一下今天上海天气",
    agent_context_hash: "test",
  });
  assert.equal(intent.domain_candidates[0], "weather");

  const routed = await router.route({ tenant_id: "tenant-a", parsed_intent: intent });
  assert.ok(routed.resources.some((r) => r.level1.resource_id === "res.weather.current"));

  const retrieved = await retrieval.search({
    query: intent.intent,
    candidates: routed.resources,
    queryVector: [1, 0, 0, 0],
  });
  assert.ok(retrieved.length >= 1);

  const selected = topP.select(
    retrieved.map((item) => ({ item, score: item.final_score })),
    { confidence: intent.confidence },
  );
  assert.ok(selected.selected.length >= 1);

  const firstLoad = await lazyLoader.load("res.weather.current");
  assert.equal(firstLoad.ok, true);
  assert.equal(firstLoad.cache_hit, false);
  const secondLoad = await lazyLoader.load("res.weather.current");
  assert.equal(secondLoad.ok, true);
  assert.equal(secondLoad.cache_hit, true);

  const edges = await graph.query({
    source_resource_id: "res.weather.briefing",
    relation_type: "depends_on",
  });
  assert.equal(edges.length, 1);
  assert.equal(edges[0]!.target_resource_id, "res.weather.current");

  const publish = await registry.publishVersion("res.weather.current", "1.1.0");
  assert.equal(publish.ok, true);
  const rollback = await registry.rollbackVersion("res.weather.current", "1.0.0");
  assert.equal(rollback.ok, true);

  const feedback = feedbackReportSchema.parse({
    raw_query: "查天气",
    parsed_intent: intent,
    resource_id: "res.weather.current",
    resource_type: ResourceType.Tool,
    success: false,
    error_code: "TEST_FAILURE",
    latency_ms: 100,
    result_quality_score: 0,
    user_feedback: null,
    context_hash: "test",
    call_timestamp: new Date().toISOString(),
  });
  await learner.report(feedback);
  feedbackQueue.enqueue(feedback);
  await learner.report({ ...feedback, call_timestamp: new Date().toISOString() });
  await learner.report({ ...feedback, call_timestamp: new Date().toISOString() });
  const decision = await breaker.evaluate("res.weather.current");
  assert.equal(decision.tripped, true);

  const mcpPool = new McpConnectionPool();
  assert.equal(mcpPool.listStates().length, 0);

  toolSearchMetrics.recordSearch();
  toolSearchMetrics.recordFeedback(1);
  toolSearchMetrics.recordHttp(true, 12);
  assert.equal(toolSearchMetrics.snapshot().search_requests_total >= 1, true);
  assert.equal(toolSearchMetrics.toPrometheus().includes("tool_search_http_requests_total"), true);

  await store.close();
  console.log("[tool-registry-test] ok");
}

main()
  .catch((err) => {
    console.error("[tool-registry-test] failed", err);
    process.exitCode = 1;
  })
  .finally(() => {
    rmSync(tmp, { recursive: true, force: true });
  });
