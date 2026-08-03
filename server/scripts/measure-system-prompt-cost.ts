import { readFile } from "node:fs/promises";
import { encodingForModel } from "js-tiktoken";

import { PromptContextBuilder } from "../src/agent/prompt-context-builder.js";
import {
  buildLayeredSystemPrompt,
  buildLayeredSystemPromptSections,
  finalizeChatSystemPrompt,
} from "../src/agent/prompt-builder.js";
import { DailyDigestService } from "../src/services/daily-digest-service.js";
import { ScheduleTaskService } from "../src/services/schedule-task-service.js";

/**
 * 测算当前主 Agent 在每次对话中实际下发的 system prompt token 数与 DeepSeek-chat 成本。
 *
 * 走真实生产路径：
 *   1) 从 data/agent-memory-sync.json + data/world-state.json 载入真实记忆与世界状态
 *   2) 用 PromptContextBuilder.build() 组装 AgentPromptMemoryContext（与运行时一致）
 *   3) finalizeChatSystemPrompt() 追加工具说明/时间戳/风格等系统后缀
 *   4) tiktoken 统计 token（DeepSeek 自有 BPE 与 GPT-4o 接近，估算偏差 <5%）
 *
 * DeepSeek-chat = deepseek-v4-flash 非思考模式 定价（per 1M tokens）：
 *   - input  cache hit  : $0.0028
 *   - input  cache miss  : $0.14
 *   - output             : $0.28
 */

const MODEL = "gpt-4o"; // tiktoken 仅用于近似计数，DeepSeek 自有 BPE 偏差很小
const ACTOR_ID = "session-mvp-001";

// DeepSeek-chat 官方定价（per 1M tokens，美元）
const DS_PRICE = {
  inputCacheHit: 0.0028,
  inputCacheMiss: 0.14,
  output: 0.28,
};

const BASE_SYSTEM_PROMPT =
  "You are a helpful, safe assistant. Respond in the same language the user uses when appropriate (Chinese or English). Refuse requests involving illegal or harmful content.";

type AgentMemoryEntries = Record<string, unknown>;
type WorldRoomRecord = {
  agentWorldRegistered?: boolean;
  agentWorldCredits?: number;
  ownedSkillIds?: string[];
};

class FakeMemorySyncService {
  constructor(private readonly entriesByActor: Record<string, AgentMemoryEntries>) {}
  getSnapshot(actorId: string, _keys: string[]): { revision: number; entries: AgentMemoryEntries } {
    return { revision: 0, entries: this.entriesByActor[actorId] ?? {} };
  }
}

class FakeWorldService {
  constructor(private readonly rooms: Record<string, WorldRoomRecord>) {}
  getOrCreateRoom(actorId: string): WorldRoomRecord {
    return this.rooms[actorId] ?? { agentWorldRegistered: false, agentWorldCredits: 0, ownedSkillIds: [] };
  }
}

class FakeSkillManager {
  list(): unknown[] { return []; }
}

function tokenCount(text: string): number {
  const enc = encodingForModel(MODEL);
  try { return enc.encode(text).length; } finally { enc.free?.(); }
}

async function readJson<T>(path: string): Promise<T> {
  const raw = await readFile(path, "utf8");
  return JSON.parse(raw) as T;
}

type Scenario = { name: string; query: string };

const SCENARIOS: Scenario[] = [
  { name: "small_talk",       query: "讲个笑话" },
  { name: "simple_weather",   query: "今天天气怎么样" },
  { name: "memory_recall",    query: "你还记得我之前喜欢什么吗" },
  { name: "schedule_today",   query: "看看我今天的日程安排" },
  { name: "world_query",      query: "agentworld里我现在有什么内容" },
  { name: "search_news",      query: "搜一下最近的科技新闻" },
];

function pct(part: number, total: number): number {
  if (total <= 0) return 0;
  return Number(((part / total) * 100).toFixed(1));
}

function usdToCny(usd: number): number {
  return Number((usd * 7.18).toFixed(4));
}

function costUsd(inputTokens: number, outputTokens: number, cacheHit: boolean): number {
  const inputPrice = cacheHit ? DS_PRICE.inputCacheHit : DS_PRICE.inputCacheMiss;
  return (inputTokens / 1_000_000) * inputPrice + (outputTokens / 1_000_000) * DS_PRICE.output;
}

async function main(): Promise<void> {
  const [memoryData, worldState] = await Promise.all([
    readJson<{ sessions: Record<string, { entries: AgentMemoryEntries }> }>("data/agent-memory-sync.json"),
    readJson<{ rooms: Record<string, WorldRoomRecord> }>("data/world-state.json"),
  ]);

  const entries = memoryData.sessions[ACTOR_ID]?.entries;
  if (!entries) throw new Error(`No memory entries found for ${ACTOR_ID}`);

  const digestService = new DailyDigestService();
  await digestService.load();

  const scheduleService = new ScheduleTaskService();
  await scheduleService.load();

  const builder = new PromptContextBuilder({
    agentMemorySyncService: new FakeMemorySyncService({ [ACTOR_ID]: entries }) as never,
    worldService: new FakeWorldService(worldState.rooms) as never,
    skillManager: new FakeSkillManager() as never,
    virtualPhoneService: null,
    scheduleTaskService: scheduleService,
    shortTermMemoryGateway: null,
  });

  console.log("=".repeat(80));
  console.log("主 Agent system prompt token 测算");
  console.log("=".repeat(80));
  console.log(`模型计数器: tiktoken (${MODEL}, 近似 DeepSeek BPE，偏差 <5%)`);
  console.log(`Actor: ${ACTOR_ID}  | 记忆条目数: ${Object.keys(entries).length}`);
  console.log("");

  // 1) 静态后缀基线（base + 工具说明 + 风格 + 访问权限，不含任何动态记忆）
  const staticFinalized = finalizeChatSystemPrompt(BASE_SYSTEM_PROMPT, {
    tools: true,
    agentAccessMode: "full",
    desktopBridgeOnline: true,
    phoneBridgeOnline: true,
  });
  const staticTokens = tokenCount(staticFinalized);
  console.log("[静态基线] base + 工具说明 + 风格 + 访问权限");
  console.log(`  tokens: ${staticTokens}`);
  console.log("");

  // 2) 各场景下完整 system prompt
  const rows: Array<{
    scenario: string; query: string;
    totalTokens: number; stableTokens: number; dynamicTokens: number;
    costHitUsd: number; costMissUsd: number; costHitCny: number; costMissCny: number;
  }> = [];

  for (const s of SCENARIOS) {
    const built = builder.build({ actorId: ACTOR_ID, userText: s.query });
    const memory = built?.promptContext?.memory ?? {};
    const { stablePrefix, dynamicContext } = buildLayeredSystemPromptSections(memory);
    const stableText = stablePrefix.join("\n\n");
    const dynamicText = dynamicContext.join("\n\n");

    const full = finalizeChatSystemPrompt(buildLayeredSystemPrompt(BASE_SYSTEM_PROMPT, memory), {
      tools: true,
      agentAccessMode: "full",
      desktopBridgeOnline: true,
      phoneBridgeOnline: true,
    });
    const totalTokens = tokenCount(full);
    const stableTokens = stableText ? tokenCount(stableText) : 0;
    const dynamicTokens = dynamicText ? tokenCount(dynamicText) : 0;

    // 假设输出 200 token（简短回复风格典型值）
    const outTokens = 200;
    const costHitUsd = costUsd(totalTokens, outTokens, true);
    const costMissUsd = costUsd(totalTokens, outTokens, false);

    rows.push({
      scenario: s.name, query: s.query,
      totalTokens, stableTokens, dynamicTokens,
      costHitUsd, costMissUsd,
      costHitCny: usdToCny(costHitUsd), costMissCny: usdToCny(costMissUsd),
    });
  }

  // 打印表
  const header = [
    "Scenario".padEnd(16),
    "Query".padEnd(20),
    "Total".padStart(7),
    "Stable".padStart(7),
    "Dyn".padStart(7),
  ].join(" | ");
  console.log("[场景对比] 完整 system prompt tokens（输入）");
  console.log(header);
  console.log("-".repeat(header.length));
  for (const r of rows) {
    console.log([
      r.scenario.padEnd(16),
      r.query.slice(0, 18).padEnd(20),
      String(r.totalTokens).padStart(7),
      String(r.stableTokens).padStart(7),
      String(r.dynamicTokens).padStart(7),
    ].join(" | "));
  }
  console.log("");

  // 3) 选取一个代表性场景做分块明细
  const sample = SCENARIOS[1]!; // simple_weather
  const sampleBuilt = builder.build({ actorId: ACTOR_ID, userText: sample.query });
  const sampleMemory = sampleBuilt?.promptContext?.memory ?? {};
  const sampleFull = finalizeChatSystemPrompt(
    buildLayeredSystemPrompt(BASE_SYSTEM_PROMPT, sampleMemory),
    { tools: true, agentAccessMode: "full", desktopBridgeOnline: true, phoneBridgeOnline: true },
  );

  console.log(`[分块明细] 场景 = "${sample.query}"`);
  console.log(`完整 system prompt 总 tokens: ${tokenCount(sampleFull)}`);
  console.log("");

  const components: Array<[string, string | undefined]> = [
    ["followUpAnchor", sampleMemory.followUpAnchor],
    ["scheduleSnapshot", sampleMemory.scheduleSnapshot],
    ["taskContext", sampleMemory.taskContext],
    ["toneGuidance", sampleMemory.toneGuidance],
    ["relationshipGuidance", sampleMemory.relationshipGuidance],
    ["userProfile", sampleMemory.userProfile],
    ["personalityCore", sampleMemory.personalityCore],
    ["persona", sampleMemory.persona],
    ["values", sampleMemory.values],
    ["abilities", sampleMemory.abilities],
    ["agentCaps", sampleMemory.agentCaps],
    ["worldCaps", sampleMemory.worldCaps],
    ["dailyDigest", sampleMemory.dailyDigest],
    ["userProfileSummary", sampleMemory.userProfileSummary],
    ["narrativeRecall", sampleMemory.narrativeRecall],
    ["memorySummary", sampleMemory.memorySummary],
    ["memoryPreferences", sampleMemory.memoryPreferences],
    ["memoryFacts", sampleMemory.memoryFacts],
    ["memoryCommitments", sampleMemory.memoryCommitments],
    ["memoryOpenLoops", sampleMemory.memoryOpenLoops],
    ["sessionRecap", sampleMemory.sessionRecap],
    ["currentTime", sampleMemory.currentTime],
    ["[static suffix]", staticFinalized],
  ];
  console.log("各组件 token 占用:");
  for (const [name, text] of components) {
    const t = text ? tokenCount(text) : 0;
    const share = pct(t, tokenCount(sampleFull));
    console.log(`  ${name.padEnd(22)} ${String(t).padStart(5)}  (${share}%)`);
  }
  console.log("");

  // 4) 单次对话成本（输入 system prompt 假设 = 1 次请求；按场景均值估算）
  const avgTokens = Math.round(rows.reduce((s, r) => s + r.totalTokens, 0) / rows.length);
  console.log("=".repeat(80));
  console.log("[单次对话成本] 假设输出 200 tokens");
  console.log("=".repeat(80));
  console.log(`平均 system prompt 输入: ${avgTokens} tokens`);
  console.log(`DeepSeek-chat 单次输入成本:`);
  console.log(`  缓存命中 (cache hit):  $${costUsd(avgTokens, 0, true).toFixed(6)}  ≈ ¥${usdToCny(costUsd(avgTokens, 0, true)).toFixed(6)}`);
  console.log(`  缓存未命中 (cache miss): $${costUsd(avgTokens, 0, false).toFixed(6)}  ≈ ¥${usdToCny(costUsd(avgTokens, 0, false)).toFixed(6)}`);
  console.log("");
  console.log(`单次完整对话（输入 ${avgTokens} + 输出 200）成本:`);
  console.log(`  缓存命中:  $${costUsd(avgTokens, 200, true).toFixed(6)}  ≈ ¥${usdToCny(costUsd(avgTokens, 200, true)).toFixed(6)}`);
  console.log(`  缓存未命中: $${costUsd(avgTokens, 200, false).toFixed(6)}  ≈ ¥${usdToCny(costUsd(avgTokens, 200, false)).toFixed(6)}`);
  console.log("");

  // 5) 1000 次对话成本
  const per1kHit = costUsd(avgTokens * 1000, 200 * 1000, true);
  const per1kMiss = costUsd(avgTokens * 1000, 200 * 1000, false);
  console.log(`1000 次对话成本:`);
  console.log(`  缓存命中:  $${per1kHit.toFixed(4)}  ≈ ¥${usdToCny(per1kHit).toFixed(4)}`);
  console.log(`  缓存未命中: $${per1kMiss.toFixed(4)}  ≈ ¥${usdToCny(per1kMiss).toFixed(4)}`);
}

void main();
