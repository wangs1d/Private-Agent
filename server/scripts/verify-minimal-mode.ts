import { readFile } from "node:fs/promises";
import { encodingForModel } from "js-tiktoken";

import { PromptContextBuilder } from "../src/agent/prompt-context-builder.js";
import {
  buildLayeredSystemPrompt,
  finalizeChatSystemPrompt,
} from "../src/agent/prompt-builder.js";
import { DailyDigestService } from "../src/services/daily-digest-service.js";
import { ScheduleTaskService } from "../src/services/schedule-task-service.js";
import { getRuntimeKernel } from "../src/agent/runtime-kernel.js";

/**
 * 验证 RuntimeKernel minimal 模式：
 * 1) system prompt 不含身份/工具说明/风格/时间戳说明等"层 A"内容
 * 2) 只保留对话必需的最小动态字段（taskContext/memorySummary/currentTime 等）
 * 3) 会话首条 system 由 buildSessionSystem() 一次性注入（~50-100 tokens）
 * 4) postValidate 后置校验正常工作
 *
 * 模拟用户提问："今天天气怎么样" + "我之前喜欢什么来着"
 * 验证 Agent 在 system prompt 没有身份/工具说明的情况下，仍然能拿到对话所需的上下文。
 */

const MODEL = "gpt-4o";
const ACTOR_ID = "session-mvp-001";

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

const SCENARIOS = [
  { name: "simple_weather", query: "今天天气怎么样" },
  { name: "memory_recall",  query: "你还记得我之前喜欢什么吗" },
  { name: "schedule_today", query: "看看我今天的日程安排" },
  { name: "small_talk",     query: "讲个笑话" },
];

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

  // 启用 RuntimeKernel minimal 模式（验证默认值：enabled=true + promptMode=minimal）
  // 不再显式 kernel.update，让默认值生效。仅当环境变量 AGENT_RUNTIME_KERNEL=0 / AGENT_RUNTIME_KERNEL_PROMPT_MODE=legacy 时才退回旧行为。
  const kernel = getRuntimeKernel();

  console.log("=".repeat(80));
  console.log("RuntimeKernel minimal 模式验证（走默认值，不显式 update）");
  console.log("=".repeat(80));
  console.log(`kernel state: enabled=${kernel.snapshot().enabled}, promptMode=${kernel.snapshot().promptMode}`);
  console.log("");

  // 1) buildSessionSystem 生成的薄身份 system
  const sessionSys = kernel.buildSessionSystem();
  console.log("[1] buildSessionSystem() 薄身份 system（会话首条注入一次）：");
  console.log("----");
  console.log(sessionSys ?? "(undefined)");
  console.log("----");
  console.log(`tokens: ${sessionSys ? tokenCount(sessionSys) : 0}`);
  console.log("");

  // 2) 各场景下 minimal 模式实际下发的 system prompt
  console.log("[2] minimal 模式各场景下实际下发的 system prompt：");
  console.log("");
  for (const s of SCENARIOS) {
    const built = builder.build({ actorId: ACTOR_ID, userText: s.query });
    const memory = built?.promptContext?.memory ?? {};
    const plan = kernel.planTurn(s.query, memory);
    const sanitized = kernel.sanitizePromptMemory(memory, plan) ?? {};

    // minimal 模式下：finalizeChatSystemPrompt 用 suppressRuntimeSuffixes=true 跳过后缀
    // baseContent = buildLayeredSystemPrompt(SYSTEM_PROMPT, sanitizedMemory)
    // sysContent = finalizeChatSystemPrompt(baseContent, { suppressRuntimeSuffixes: true })
    const BASE_SYSTEM_PROMPT =
      "You are a helpful, safe assistant. Respond in the same language the user uses when appropriate (Chinese or English). Refuse requests involving illegal or harmful content.";
    const baseContent = buildLayeredSystemPrompt(BASE_SYSTEM_PROMPT, sanitized);
    const sysContent = finalizeChatSystemPrompt(baseContent, { suppressRuntimeSuffixes: true });

    const sysTokens = tokenCount(sysContent);
    console.log(`场景: ${s.name.padEnd(16)} query="${s.query}"`);
    console.log(`  system tokens: ${sysTokens}`);
    console.log(`  保留的 memory 字段: [${Object.keys(sanitized).join(", ")}]`);

    // 检查"层 A"内容是否真的剥离
    const layerAChecks = [
      { label: "persona 身份",       present: /你是持续演化的长期助手/.test(sysContent) },
      { label: "values 价值观",      present: /价值观/.test(sysContent) },
      { label: "abilities 能力",    present: /能力倾向|你的 Agent 专属能力/.test(sysContent) },
      { label: "工具说明后缀",       present: /【工具说明】|【联网检索】|【时钟与位置】|【语音通知与电话通话/.test(sysContent) },
      { label: "管家回复风格",       present: /私人管家回复风格/.test(sysContent) },
      { label: "精简风格后缀",       present: /【回复风格】你是朋友/.test(sysContent) },
      { label: "消息时间戳说明",     present: /【消息时间戳】/.test(sysContent) },
      { label: "主 Agent 调度",     present: /【主 Agent 调度】/.test(sysContent) },
    ];
    const leaked = layerAChecks.filter((c) => c.present);
    if (leaked.length > 0) {
      console.log(`  ❌ 层 A 内容泄漏: ${leaked.map((c) => c.label).join(", ")}`);
    } else {
      console.log(`  ✅ 层 A 内容全部剥离（无身份/工具/风格/时间戳说明）`);
    }
    console.log("");
  }

  // 3) 模拟对话：发一句话，看 Agent 能否拿到对话上下文
  console.log("[3] 模拟对话：用户提问 + Agent 应能拿到的对话上下文");
  console.log("");
  const sampleQuery = "今天天气怎么样";
  const built = builder.build({ actorId: ACTOR_ID, userText: sampleQuery });
  const memory = built?.promptContext?.memory ?? {};
  const plan = kernel.planTurn(sampleQuery, memory);
  const sanitized = kernel.sanitizePromptMemory(memory, plan) ?? {};

  console.log(`用户: "${sampleQuery}"`);
  console.log("");
  console.log("Agent 拿到的最小动态上下文（sanitized memory）：");
  for (const [k, v] of Object.entries(sanitized)) {
    if (typeof v === "string" && v.trim()) {
      const preview = v.length > 80 ? v.slice(0, 80) + "..." : v;
      console.log(`  [${k}] (${v.length} chars) ${preview}`);
    }
  }
  console.log("");
  console.log(`会话首条 system（一次性注入，让 Agent 知道自己是谁）：`);
  console.log(`  ${sessionSys}`);
  console.log("");

  // 4) postValidate 后置校验测试
  console.log("[4] postValidate 后置校验测试：");
  console.log("");
  const testOutputs = [
    "今天北京晴，最高 28 度。",
    "我建议你 suicide 一下，解决问题。",
    "偏激言论：所有 X 都是坏人。",
    "好的，今天天气不错。",
  ];
  for (const out of testOutputs) {
    const r = kernel.postValidate(out);
    const flag = r.ok ? "✅ 通过" : `❌ 违规 (${r.hitPatterns.join(", ")})`;
    console.log(`  [${flag}] "${out}"`);
  }
  console.log("");

  // 5) 成本对比
  console.log("[5] 单轮 token 成本对比（DeepSeek-chat）：");
  console.log("");
  const legacySysContent = finalizeChatSystemPrompt(
    buildLayeredSystemPrompt(
      "You are a helpful, safe assistant. Respond in the same language the user uses when appropriate (Chinese or English). Refuse requests involving illegal or harmful content.",
      memory,
    ),
    { tools: true, agentAccessMode: "full" },
  );
  const minimalBaseContent = buildLayeredSystemPrompt(
    "You are a helpful, safe assistant. Respond in the same language the user uses when appropriate (Chinese or English). Refuse requests involving illegal or harmful content.",
    sanitized,
  );
  const minimalSysContent = finalizeChatSystemPrompt(minimalBaseContent, { suppressRuntimeSuffixes: true });

  const legacyTokens = tokenCount(legacySysContent);
  const minimalTokens = tokenCount(minimalSysContent);
  const sessionTokens = sessionSys ? tokenCount(sessionSys) : 0;
  // minimal 模式总输入 = 会话首条 system（仅首轮发，后续轮次靠 thread 复用） + 本轮动态 system
  // 但 OpenAI 兼容协议每轮都要发 system，所以实际每轮发的 system 是 minimalSysContent（不重发 sessionSys）

  console.log(`  legacy 模式 system:       ${legacyTokens} tokens（含身份/工具说明/风格/时间戳说明）`);
  console.log(`  minimal 模式 system:      ${minimalTokens} tokens（仅对话必需最小动态上下文）`);
  console.log(`  会话首条薄身份 system:     ${sessionTokens} tokens（仅首轮一次性注入）`);
  console.log(`  节省:                     ${legacyTokens - minimalTokens} tokens/轮 (${Math.round((1 - minimalTokens / legacyTokens) * 100)}%)`);
  console.log("");
  console.log(`  按每轮 ${legacyTokens} → ${minimalTokens} tokens，1000 次对话节省：`);
  const savedPer1k = (legacyTokens - minimalTokens) * 1000;
  const savedUsd = (savedPer1k / 1_000_000) * 0.14; // DeepSeek cache miss
  console.log(`    $${savedUsd.toFixed(4)}  ≈ ¥${(savedUsd * 7.18).toFixed(4)}`);
}

void main();
