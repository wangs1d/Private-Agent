import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { encodingForModel } from "js-tiktoken";

import { PromptContextBuilder } from "../src/agent/prompt-context-builder.js";
import { buildTaskContextPrompt } from "../src/agent/task-context.js";
import {
  buildLayeredSystemPrompt,
  finalizeChatSystemPrompt,
  sliceMemoryEntriesToPromptContext,
} from "../src/agent/prompt-builder.js";
import { shouldInjectMemorySummary } from "../src/agent/memory-signal.js";
import { DailyDigestService } from "../src/services/daily-digest-service.js";
import { ScheduleTaskService } from "../src/services/schedule-task-service.js";

const MODEL = "gpt-4o";
const BASE_SYSTEM_PROMPT =
  "You are a helpful, safe assistant. Respond in the same language the user uses when appropriate (Chinese or English). Refuse requests involving illegal or harmful content.";
const ACTOR_ID = "session-mvp-001";

type AgentMemoryEntries = Record<string, unknown>;
type WorldRoomRecord = {
  agentWorldRegistered?: boolean;
  agentWorldCredits?: number;
  ownedSkillIds?: string[];
};
type AgentPromptMemoryContext = NonNullable<
  NonNullable<ReturnType<PromptContextBuilder["build"]>>["promptContext"]
>["memory"];

type Scenario = {
  name: string;
  query: string;
};

type ComparisonRow = {
  scenario: string;
  legacyTokens: number;
  currentTokens: number;
  savedTokens: number;
  savedPct: number;
};

class FakeMemorySyncService {
  constructor(private readonly entriesByActor: Record<string, AgentMemoryEntries>) {}

  getSnapshot(actorId: string, keys: string[]): { revision: number; entries: AgentMemoryEntries } {
    const source = this.entriesByActor[actorId] ?? {};
    const entries: AgentMemoryEntries = {};
    for (const key of keys) {
      if (key in source) entries[key] = source[key];
    }
    return { revision: 0, entries };
  }
}

class FakeWorldService {
  constructor(private readonly rooms: Record<string, WorldRoomRecord>) {}

  getOrCreateRoom(actorId: string): WorldRoomRecord {
    return this.rooms[actorId] ?? {
      agentWorldRegistered: false,
      agentWorldCredits: 0,
      ownedSkillIds: [],
    };
  }
}

class FakeSkillManager {
  list(): unknown[] {
    return [];
  }
}

function tokenCount(text: string): number {
  const enc = encodingForModel(MODEL);
  try {
    return enc.encode(text).length;
  } finally {
    enc.free?.();
  }
}

async function readJson<T>(path: string): Promise<T> {
  const raw = await readFile(path, "utf8");
  return JSON.parse(raw) as T;
}

function buildLegacyTaskContextPrompt(message: string, now: Date = new Date()): string {
  const current = buildTaskContextPrompt(message, now);
  if (current.includes("If facts may be stale")) {
    return current;
  }

  const flagsLine = current.split("\n")[1] ?? "Task profile: unknown.";
  return [
    `Runtime timestamp: ${now.toISOString()}. Interpret relative dates from this timestamp; use clock tools when the user asks for exact current time/date/location.`,
    flagsLine,
    "Operating policy:",
    "- If facts may be stale, local-state-dependent, or user-specific, use the available tool before giving a confident answer.",
    "- If the task changes persistent state or performs an external action, verify required fields and report the resulting id/status when available.",
    "- If this is code/project work, inspect the relevant project context before deciding on an implementation.",
    "- Before the final answer, check whether the user's actual request is satisfied; name any blocker or uncertainty plainly.",
  ].join("\n");
}

function extractLegacyAgentCaps(): string {
  const source = GitRepo.show("HEAD:server/src/agent/prompt-context-builder.ts");
  const match = source.match(/agentCaps = \[(.*?)\]\.join\("\\n"\);/s);
  if (!match?.[1]) return "";
  const factory = new Function(`return [${match[1]}].join("\\n");`);
  return String(factory());
}

function buildLegacyWorldCaps(room: WorldRoomRecord): string {
  const ownedSkills =
    room.ownedSkillIds && room.ownedSkillIds.length > 0
      ? room.ownedSkillIds.join("、")
      : "（无）";
  return [
    `【Agent World】注册：${room.agentWorldRegistered ? "✅ 已注册" : "⚠️ 未注册"}｜点数：${room.agentWorldCredits ?? 0}｜技能：${ownedSkills}`,
    "未注册则 free_market/social 不可用。完整世界状态（社交推文站/技能商店/world.*工具族）请调 agent.query_capabilities(domain='world')。",
  ].join("\n");
}

function buildLegacyScheduleSnapshot(
  scheduleService: ScheduleTaskService,
  actorId: string,
  now = Date.now(),
): string {
  const from = new Date(now).toISOString();
  const to = new Date(now + 14 * 86400000).toISOString();
  const tasks = scheduleService.listTasksBySession(actorId, { from, to });
  const recurrenceLabel: Record<string, string> = {
    none: "单次",
    daily: "每天",
    weekly: "每周",
    yearly: "每年",
  };

  if (tasks.length === 0) {
    return [
      "【当前日程 · 服务端实时】暂无活跃提醒/日程（共 0 条）。",
      "用户可能在 App「日程」页已删除；回答日程相关问题以此为准，勿凭屏幕截图或对话历史中的旧列表作答。",
    ].join("\n");
  }

  const lines = tasks.slice(0, 15).map((task) => {
    const when = task.nextRunAt ?? task.runAt;
    const recurrence = recurrenceLabel[task.recurrence] ?? task.recurrence;
    const title = task.reminderMessage?.trim() || task.title;
    return `- ${title} · ${when} · ${recurrence}`;
  });
  const tail =
    tasks.length > 15
      ? `\n（另有 ${tasks.length - 15} 条，请调 calendar.list_tasks 查看完整列表）`
      : "";
  return [
    `【当前日程 · 服务端实时】共 ${tasks.length} 条活跃提醒/日程：`,
    ...lines,
    tail,
    "回答日程/提醒问题时优先参考本快照；用户可在 App「日程」页直接删改，勿凭截图或历史旧数据作答。",
  ]
    .filter(Boolean)
    .join("\n");
}

function buildFinalPrompt(memory: AgentPromptMemoryContext): string {
  const layered = buildLayeredSystemPrompt(BASE_SYSTEM_PROMPT, memory);
  return finalizeChatSystemPrompt(layered, {
    tools: true,
    agentAccessMode: "sandbox",
    desktopBridgeOnline: false,
  });
}

function buildLegacyMemory(
  query: string,
  entries: AgentMemoryEntries,
  currentMemory: AgentPromptMemoryContext,
  digestService: DailyDigestService,
  scheduleService: ScheduleTaskService,
  worldRoom: WorldRoomRecord,
  legacyAgentCaps: string,
): AgentPromptMemoryContext {
  const fromKv = sliceMemoryEntriesToPromptContext(entries, query, {
    includeMemorySummary: true,
  });
  return {
    ...fromKv,
    taskContext: buildLegacyTaskContextPrompt(query),
    agentCaps: legacyAgentCaps,
    worldCaps: buildLegacyWorldCaps(worldRoom),
    dailyDigest: digestService.getPromptDigest(ACTOR_ID),
    scheduleSnapshot: buildLegacyScheduleSnapshot(scheduleService, ACTOR_ID),
    ...(currentMemory.followUpAnchor ? { followUpAnchor: currentMemory.followUpAnchor } : {}),
    ...(currentMemory.narrativeRecall ? { narrativeRecall: currentMemory.narrativeRecall } : {}),
  };
}

function pct(saved: number, total: number): number {
  if (total <= 0) return 0;
  return Number(((saved / total) * 100).toFixed(1));
}

function formatTable(rows: ComparisonRow[]): string {
  const header = [
    "Scenario".padEnd(16),
    "Legacy".padStart(8),
    "Current".padStart(8),
    "Saved".padStart(8),
    "Saved%".padStart(8),
  ].join(" | ");
  const divider = "-".repeat(header.length);
  const body = rows.map((row) =>
    [
      row.scenario.padEnd(16),
      String(row.legacyTokens).padStart(8),
      String(row.currentTokens).padStart(8),
      String(row.savedTokens).padStart(8),
      `${row.savedPct}%`.padStart(8),
    ].join(" | "),
  );
  return [header, divider, ...body].join("\n");
}

function componentBreakdown(
  currentMemory: AgentPromptMemoryContext,
  legacyMemory: AgentPromptMemoryContext,
): string {
  const rows = [
    ["persona", currentMemory.persona, legacyMemory.persona],
    ["values", currentMemory.values, legacyMemory.values],
    ["abilities", currentMemory.abilities, legacyMemory.abilities],
    ["taskContext", currentMemory.taskContext, legacyMemory.taskContext],
    ["agentCaps", currentMemory.agentCaps, legacyMemory.agentCaps],
    ["worldCaps", currentMemory.worldCaps, legacyMemory.worldCaps],
    ["memorySummary", currentMemory.memorySummary, legacyMemory.memorySummary],
    ["dailyDigest", currentMemory.dailyDigest, legacyMemory.dailyDigest],
    ["scheduleSnapshot", currentMemory.scheduleSnapshot, legacyMemory.scheduleSnapshot],
  ] as const;

  const lines = rows
    .map(([name, current, legacy]) => {
      const currentTokens = current ? tokenCount(current) : 0;
      const legacyTokens = legacy ? tokenCount(legacy) : 0;
      const delta = legacyTokens - currentTokens;
      return `${name.padEnd(16)} current=${String(currentTokens).padStart(4)}  legacy=${String(
        legacyTokens,
      ).padStart(4)}  delta=${String(delta).padStart(4)}`;
    })
    .join("\n");
  return lines;
}

const GitRepo = {
  show(spec: string): string {
    return execFileSync("git", ["show", spec], {
      cwd: process.cwd(),
      encoding: "utf8",
      maxBuffer: 1024 * 1024 * 8,
    });
  },
};

async function main(): Promise<void> {
  const [memoryData, worldState] = await Promise.all([
    readJson<{ sessions: Record<string, { entries: AgentMemoryEntries }> }>("data/agent-memory-sync.json"),
    readJson<{ rooms: Record<string, WorldRoomRecord> }>("data/world-state.json"),
  ]);

  const entries = memoryData.sessions[ACTOR_ID]?.entries;
  if (!entries) {
    throw new Error(`No memory entries found for ${ACTOR_ID}`);
  }

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
  });

  const legacyAgentCaps = extractLegacyAgentCaps();
  const worldRoom = worldState.rooms[ACTOR_ID] ?? {};
  const scenarios: Scenario[] = [
    { name: "small_talk", query: "讲个笑话" },
    { name: "simple_weather", query: "今天天气怎么样" },
    { name: "memory_recall", query: "你还记得我之前喜欢什么吗" },
    { name: "schedule_today", query: "看看我今天的日程安排" },
    { name: "world_query", query: "agentworld里我现在有什么内容" },
  ];

  const comparisons: ComparisonRow[] = [];

  for (const scenario of scenarios) {
    const currentMemory =
      builder.build({ actorId: ACTOR_ID, userText: scenario.query })?.promptContext?.memory ?? {};
    const legacyMemory = buildLegacyMemory(
      scenario.query,
      entries,
      currentMemory,
      digestService,
      scheduleService,
      worldRoom,
      legacyAgentCaps,
    );

    const currentTokens = tokenCount(buildFinalPrompt(currentMemory));
    const legacyTokens = tokenCount(buildFinalPrompt(legacyMemory));
    const savedTokens = legacyTokens - currentTokens;
    comparisons.push({
      scenario: scenario.name,
      legacyTokens,
      currentTokens,
      savedTokens,
      savedPct: pct(savedTokens, legacyTokens),
    });
  }

  const sampleScenario = scenarios[0]!;
  const sampleCurrent =
    builder.build({ actorId: ACTOR_ID, userText: sampleScenario.query })?.promptContext?.memory ?? {};
  const sampleLegacy = buildLegacyMemory(
    sampleScenario.query,
    entries,
    sampleCurrent,
    digestService,
    scheduleService,
    worldRoom,
    legacyAgentCaps,
  );

  const memorySummaryIncluded = shouldInjectMemorySummary(sampleScenario.query);

  console.log(`Prompt token analysis model: ${MODEL}`);
  console.log(`Actor: ${ACTOR_ID}`);
  console.log("");
  console.log(formatTable(comparisons));
  console.log("");
  console.log(`Component breakdown for sample query: ${sampleScenario.query}`);
  console.log(componentBreakdown(sampleCurrent, sampleLegacy));
  console.log("");
  console.log("Current gating signals:");
  console.log(`- memory_summary injected: ${memorySummaryIncluded}`);
  console.log(`- dailyDigest injected: ${sampleCurrent.dailyDigest ? "yes" : "no"}`);
  console.log(`- scheduleSnapshot injected: ${sampleCurrent.scheduleSnapshot ? "yes" : "no"}`);
  console.log(`- worldCaps injected: ${sampleCurrent.worldCaps ? "yes" : "no"}`);
}

void main();
