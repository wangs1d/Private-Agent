import type { WorldService } from "@private-ai-agent/agent-world";
import type { ChatCompletionTool } from "openai/resources/chat/completions";

import { CAPABILITY_DOMAINS, type CapabilityDomain } from "./agent-capabilities.js";
import { getAgentRuntimeConfig } from "./agent-runtime-config.js";
import {
  buildCurrentTimePrompt,
  formatKvValueForPrompt,
  formatPersonalityCorePrompt,
  sliceMemoryEntriesToPromptContext,
  sliceSubAgentMemoryEntries,
} from "./prompt-builder.js";
import { buildTaskContextPrompt } from "./task-context.js";
import { buildMasterAgentChatTools, buildSubAgentChatTools } from "../services/master-agent-tool-filter.js";
import { buildSessionSkillChatTools } from "../skills/skill-openai-bridge.js";
import { SKILL_MANAGE_CHAT_TOOLS } from "../tools/skill-manage-tools.js";
import type { SkillManager } from "../skills/index.js";
import type { SubAgentCapability } from "../services/master-agent-types.js";
import { SUB_AGENT_PROMPT_PROFILES } from "./subagent-prompt-profiles.js";
import type { AgentMemorySyncService } from "../services/agent-memory-sync-service.js";
import {
  buildSchedulePromptSnapshot,
  shouldInjectScheduleSnapshot,
} from "../services/schedule-prompt-snapshot.js";
import type { ScheduleTaskService } from "../services/schedule-task-service.js";
import { getDailyDigestService } from "../services/daily-digest-service.js";
import type { VirtualPhoneService } from "../services/virtual-phone-service.js";
import { getMemoryManagerService } from "../services/memory-manager-service.js";
import {
  buildFollowUpAnchorPrompt,
  isAmbiguousFollowUpMessage,
  shouldInjectMemorySummary,
} from "./memory-signal.js";
import type { PersonalityCore } from "../brain/types.js";
import type {
  AgentPromptMemoryContext,
  AgentStreamOptions,
  ToolLoopAfterBatchInfo,
} from "../external-model/types.js";
import type { PersonalizationPromptSlice } from "../services/user-personalization/user-personalization-service.js";
import { dedupeMemoryLines, semanticFingerprint } from "../services/memory-record-utils.js";
import type { ShortTermMemoryGatewayService } from "../services/short-term-memory-gateway.js";
import { redactSensitiveText } from "../utils/redact.js";

const WORLD_CACHE_TTL_MS = 5_000;

function buildCompactAgentCapsPrompt(): string {
  const cfg = getAgentRuntimeConfig();
  const lines = [
    "【能力概览】你是主 Agent，可直接处理日常对话，并按需调用时间、天气、搜索、日程、钱包、社交与 Agent World 相关工具。",
    "【调度原则】简单问题直接回答；需要实时信息时先查再答；复杂或多步骤任务可派专业小弟（子 Agent）执行。",
    "【执行约束】涉及消费、转账、桌面高权限操作或状态敏感任务时，必须先读取对应工具返回的实时状态，不凭记忆假设。",
    "【真人感·行动宣告】凡是要调工具或派子 Agent 时，必须在调用前先用一句口语化的短话告诉用户你要去做什么（如「我先搜一下…」「我看下今天的日程…」「我让技术小弟去看一眼…」），不要直接调用工具。这句话会作为独立消息先送达用户，让对话像真人交互一样有反馈节奏。",
  ];
  if (cfg.masterDelegation.enabled) {
    lines.push(
      `【你的小弟】life / tech / info 三类子 Agent 听你的调度；互不依赖的子任务可在同一轮并行委派（最多 ${cfg.masterDelegation.maxParallelSubAgents} 个同时进行）。`,
      "【工具】master_invoke_sub_agent 派活；master_list_sub_agents 看名册；master_poll_sub_agent_tasks 查后台小弟进度。",
    );
  }
  lines.push("需要完整能力明细时调用 agent.query_capabilities。");
  return lines.join("\n");
}

const WORLD_DOMAIN_RULES: Array<{ domains: CapabilityDomain[]; pattern: RegExp }> = [
  { domains: ["world"], pattern: /agent world|world\.|free_market|open_registry|世界点数|点数|技能商店|注册|市场/i },
  { domains: ["social_feed", "world"], pattern: /社交|推文|帖子|动态|评论|点赞|social/i },
  { domains: ["aip", "world"], pattern: /aip|提案|协议|联盟|投票/i },
];

interface WorldCacheEntry {
  data: {
    registered: boolean;
    credits: number;
    ownedSkillIds: string[];
  };
  at: number;
}

const worldCacheByActor = new Map<string, WorldCacheEntry>();

function getCachedWorldState(worldService: WorldService, actorId: string): WorldCacheEntry["data"] {
  const now = Date.now();
  const cached = worldCacheByActor.get(actorId);
  if (cached && now - cached.at < WORLD_CACHE_TTL_MS) {
    return cached.data;
  }
  const state = worldService.getOrCreateRoom(actorId, actorId);
  const data = {
    registered: state.agentWorldRegistered,
    credits: state.agentWorldCredits,
    ownedSkillIds: state.ownedSkillIds,
  };
  worldCacheByActor.set(actorId, { data, at: now });
  return data;
}

function detectRelevantCapabilityDomains(userText: string | undefined): CapabilityDomain[] {
  const text = userText?.trim() ?? "";
  if (!text) return [];
  const detected = new Set<CapabilityDomain>();
  for (const rule of WORLD_DOMAIN_RULES) {
    if (!rule.pattern.test(text)) continue;
    for (const domain of rule.domains) {
      if (domain !== "all") detected.add(domain);
    }
  }
  return [...detected];
}

function compactPromptBlock(
  text: string | undefined,
  maxChars: number,
  importance?: "high" | "normal" | "low",
  preserve?: "head" | "tail" | "both",
): string | undefined {
  const trimmed = text?.trim();
  if (!trimmed) return undefined;
  // Phase 6.2：低重要性内容压缩更激进（取 70% 上限），高价值保持原值。
  // 用于 lifeThemeMemory 等"背景性"上下文，不损失主对话能力。
  const effectiveLimit =
    importance === "low"
      ? Math.floor(maxChars * 0.7)
      : importance === "high"
        ? maxChars
        : maxChars;
  if (trimmed.length <= effectiveLimit) return trimmed;
  // Phase 6.2 修正：支持首尾保留模式，避免单纯截断丢失末尾关键内容。
  // dreamMemory 等跨会话整理结果用 "both"：保留开场（最近在意的）+ 末尾（核心主题/淡忘），
  // 中间被省略号替换，保持记忆连续性。
  if (preserve === "both") {
    const headLen = Math.floor(effectiveLimit * 0.6);
    const tailLen = Math.max(0, effectiveLimit - headLen - 6);
    const head = trimmed.slice(0, headLen).trimEnd();
    const tail = trimmed.slice(trimmed.length - tailLen).trimStart();
    return `${head}\n...[省略中间]...\n${tail}`;
  }
  if (preserve === "tail") {
    const tailLen = effectiveLimit - 3;
    return `...${trimmed.slice(trimmed.length - tailLen).trimStart()}`;
  }
  // default "head"
  return `${trimmed.slice(0, Math.max(0, effectiveLimit - 3)).trimEnd()}...`;
}

function compactSchemaField(text: string, maxChars: number): string {
  const trimmed = text.replace(/\s+/g, " ").trim();
  if (!trimmed) return "";
  if (trimmed.length <= maxChars) return trimmed;
  return `${trimmed.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}

function splitPromptLines(block: string | undefined): string[] {
  return (block ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function dedupePromptBlock(block: string | undefined, existingFingerprints: Set<string>): string | undefined {
  if (!block) return undefined;
  const lines = dedupeMemoryLines(splitPromptLines(block), { preferLatest: false });
  const kept = lines.filter((line) => {
    const fp = semanticFingerprint(line) || line;
    if (existingFingerprints.has(fp)) return false;
    existingFingerprints.add(fp);
    return true;
  });
  return kept.length > 0 ? kept.join("\n") : undefined;
}

export function formatNarrativeRecallPrompt(text: string | undefined): string | undefined {
  const trimmed = text?.trim();
  if (!trimmed) return undefined;

  const rawLines = trimmed
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (rawLines.length === 0) return undefined;

  const items = rawLines
    .map((line) => {
      const numbered = line.match(/^\[(\d+)\]\s*(.+)$/);
      if (numbered?.[2]) return compactSchemaField(numbered[2], 120);

      const bullet = line.match(/^[-*•]\s*(.+)$/);
      if (bullet?.[1]) return compactSchemaField(bullet[1], 120);

      if (/^(以下|Mem0|记忆图|长时记忆|长期叙事)/i.test(line)) return "";
      return compactSchemaField(line, 120);
    })
    .filter(Boolean)
    .slice(0, 4);

  if (items.length === 0) return undefined;

  return [`NR|hits=${items.length}`, ...items.map((item, index) => `- r${index + 1}|${item}`)].join(
    "\n",
  );
}

export type BuildPromptContextInput = {
  actorId: string;
  sessionId?: string;
  userText?: string;
  narrativeRecall?: string;
  interruptedContext?: string;
  userLocation?: string;
  personalization?: PersonalizationPromptSlice;
  /**
   * 当前工作记忆摘要（来自 WorkingMemoryCortex.toSummary）。
   * 作为独立块注入 system prompt，不再拼入 narrativeRecall，
   * 避免被 formatNarrativeRecallPrompt 的 slice(0,4) 截断或块结构被拍平。
   */
  workingMemorySummary?: string;
  /**
   * 最近对话回顾（thread 较短时注入，用于指代消解）。
   * 仅在 thread 消息 < 12 条时填充（由 agent-core 做 dedup 判定）。
   * 作为独立块注入，"非用户最新指令"提示由 buildLayeredSystemPrompt 统一添加。
   */
  recentConversationHistory?: string;
  onToolLoopAfterBatch?: (info: ToolLoopAfterBatchInfo) => void;
  /** 深度优化：用户画像（来自 OnlineLearningCortex），注入 prompt 让 LLM 感知用户偏好/习惯/否定模式 */
  userPattern?: {
    topics: string[];
    preferredToolDomain?: string;
    negativeFeedbackCount: number;
    learningActive?: boolean;
  };
  /**
   * 深度优化：工具规划链（来自 ToolPlanningCortex），注入 prompt 约束 LLM 工具选择顺序和范围。
   * complex 路由时由 ToolPlanningCortex.planTools 产出，让 LLM 按规划顺序调用工具，
   * 避免乱试或遗漏关键工具。
   */
  toolPlan?: {
    task: string;
    toolChain: Array<{ name: string; purpose: string; critical?: boolean }>;
    reasoning: string;
    estimatedTokens: number;
    estimatedCalls: number;
  };
};

export type BuildMasterDelegateInput = BuildPromptContextInput & {
  subAgentCapabilities: Iterable<SubAgentCapability>;
};

export type BuildSubAgentInput = BuildPromptContextInput & {
  capability: SubAgentCapability;
  taskDescription?: string;
};

export type PromptContextLayers = {
  /** Stable prefix: identity, durable persona, values, and ability boundaries. */
  stable: AgentPromptMemoryContext;
  /** Session context: user/project state that can change across sessions but not every token. */
  context: AgentPromptMemoryContext;
  /** Turn-volatile context: time, recalls, task hints, emotion, and current tool plan. */
  volatile: AgentPromptMemoryContext;
};

function pickPromptContextLayers(memory: AgentPromptMemoryContext): PromptContextLayers {
  const stable: AgentPromptMemoryContext = {};
  const context: AgentPromptMemoryContext = {};
  const volatile: AgentPromptMemoryContext = {};

  for (const [key, value] of Object.entries(memory) as Array<
    [keyof AgentPromptMemoryContext, string | undefined]
  >) {
    if (!value) continue;
    if (
      key === "persona" ||
      key === "personalityCore" ||
      key === "values" ||
      key === "abilities" ||
      key === "agentCaps"
    ) {
      stable[key] = value;
    } else if (
      key === "worldCaps" ||
      key === "userProfile" ||
      key === "userProfileSummary" ||
      key === "memorySummary" ||
      key === "memoryPreferences" ||
      key === "memoryFacts" ||
      key === "memoryCommitments" ||
      key === "memoryOpenLoops" ||
      key === "sessionRecap" ||
      key === "relationshipGuidance" ||
      key === "relationshipMemory" ||
      key === "lifeThemeMemory" ||
      key === "dreamMemory" ||
      key === "memoryContinuity" ||
      key === "skillIndex"
    ) {
      context[key] = value;
    } else {
      volatile[key] = value;
    }
  }

  return { stable, context, volatile };
}

function flattenPromptContextLayers(layers: PromptContextLayers): AgentPromptMemoryContext {
  return {
    ...layers.stable,
    ...layers.context,
    ...layers.volatile,
  };
}

export class PromptContextBuilder {
  constructor(
    private readonly deps: {
      agentMemorySyncService: AgentMemorySyncService | null;
      worldService: WorldService | null;
      skillManager: SkillManager | null;
      virtualPhoneService: VirtualPhoneService | null;
      scheduleTaskService?: ScheduleTaskService | null;
      shortTermMemoryGateway?: ShortTermMemoryGatewayService | null;
    },
  ) {}

  private personalityProvider: ((actorId: string) => PersonalityCore | null) | null = null;

  /**
   * 注入人格内核拉取器（通常来自 BrainCenter.getPersonalityCore → MemoryCortex.getPersonalityCore）。
   * assembleMemory 会调用它获取结构化人格内核，格式化后填入 memory.personalityCore，
   * 由 buildLayeredSystemPrompt 注入 system prompt 稳定前缀的【人格内核】块，防止单次对话导致人格漂移。
   */
  setPersonalityProvider(fn: (actorId: string) => PersonalityCore | null): void {
    this.personalityProvider = fn;
  }

  build(input: BuildPromptContextInput): AgentStreamOptions | undefined {
    const layers = pickPromptContextLayers(this.assembleMemory(input));
    const memory = flattenPromptContextLayers(layers);
    const hasMemory = this.hasMemoryContent(memory);
    const chatToolsExtra = this.sessionSkillTools(input.actorId);
    const toolLoop =
      input.onToolLoopAfterBatch != null
        ? { onAfterToolBatch: input.onToolLoopAfterBatch }
        : undefined;

    if (!hasMemory && !toolLoop && (!chatToolsExtra || chatToolsExtra.length === 0)) {
      return undefined;
    }

    return {
      ...(hasMemory ? { promptContext: { memory } } : {}),
      ...(toolLoop ? { toolLoop } : {}),
      ...(chatToolsExtra?.length ? { chatToolsExtra } : {}),
    };
  }

  buildForMasterDelegate(input: BuildMasterDelegateInput): AgentStreamOptions {
    const base = this.build(input) ?? {};
    const chatToolsExtra = base.chatToolsExtra ?? [];
    return {
      ...base,
      masterSubAgentDelegate: true,
      chatToolsBuiltin: buildMasterAgentChatTools(input.subAgentCapabilities, chatToolsExtra),
      chatToolsExtra: [],
    };
  }

  buildForSubAgent(input: BuildSubAgentInput): AgentStreamOptions {
    const memory = this.assembleMemoryForSubAgent(input);
    const hasMemory = this.hasMemoryContent(memory);
    const chatToolsExtra = this.sessionSkillTools(input.actorId);
    const toolLoop =
      input.onToolLoopAfterBatch != null
        ? { onAfterToolBatch: input.onToolLoopAfterBatch }
        : undefined;
    const taskText = input.taskDescription?.trim() || input.userText?.trim() || "";
    const scopedBuiltin = buildSubAgentChatTools(input.capability, taskText, chatToolsExtra ?? []);

    return {
      ...(hasMemory ? { promptContext: { memory } } : {}),
      ...(toolLoop ? { toolLoop } : {}),
      chatToolsBuiltin: scopedBuiltin,
      chatToolsExtra: [],
    };
  }

  private assembleMemoryForSubAgent(input: BuildSubAgentInput): AgentPromptMemoryContext {
    const profile = SUB_AGENT_PROMPT_PROFILES[input.capability.type];
    const taskText = input.taskDescription?.trim() || input.userText?.trim() || "";

    let scoped: AgentPromptMemoryContext = {};
    if (this.deps.agentMemorySyncService && (profile.includePersona || profile.includeMemorySummary)) {
      const keys: string[] = [];
      if (profile.includePersona) keys.push("persona", "soul");
      if (profile.includeMemorySummary) keys.push("memory_summary");
      const { entries } = this.deps.agentMemorySyncService.getSnapshot(input.actorId, keys);
      scoped = sliceSubAgentMemoryEntries(entries, taskText || undefined);
      if (!profile.includePersona) delete scoped.persona;
      if (!profile.includeMemorySummary) delete scoped.memorySummary;
    }

    const full = this.assembleMemory(input);

    return {
      ...(profile.includeTaskContext && full.taskContext ? { taskContext: full.taskContext } : {}),
      ...(profile.includeToneGuidance && full.toneGuidance ? { toneGuidance: full.toneGuidance } : {}),
      ...(profile.includeUserProfile && full.userProfile ? { userProfile: full.userProfile } : {}),
      ...(profile.includeUserLocation && full.userLocation ? { userLocation: full.userLocation } : {}),
      ...(profile.includePersona && scoped.persona ? { persona: scoped.persona } : {}),
      ...(profile.includeValues && full.values ? { values: full.values } : {}),
      ...(profile.includeAbilities && full.abilities ? { abilities: full.abilities } : {}),
      ...(profile.includeAgentCaps && full.agentCaps ? { agentCaps: full.agentCaps } : {}),
      ...(profile.includeWorldCaps && full.worldCaps ? { worldCaps: full.worldCaps } : {}),
      ...(profile.includeMemorySummary && scoped.memorySummary ? { memorySummary: scoped.memorySummary } : {}),
      ...(full.interruptedContext ? { interruptedContext: full.interruptedContext } : {}),
    };
  }

  private assembleMemory(input: BuildPromptContextInput): AgentPromptMemoryContext {
    const config = getAgentRuntimeConfig();
    const userText = input.userText?.trim() ?? "";
    const ambiguousFollowUp = isAmbiguousFollowUpMessage(userText);
    const digestService = getDailyDigestService();
    const memoryManager = getMemoryManagerService();

    let fromKv: AgentPromptMemoryContext = {};
    const memoryKeys = config.memoryPrompt.promptMemoryKeys;
    // 追问场景也拉取 KV snapshot（原策略追问时跳过，导致 memorySummary 等丢失 → 记忆跳）
    // 追问时压缩到 200 字（非追问保持原长度）
    if (
      this.deps.agentMemorySyncService &&
      memoryKeys &&
      memoryKeys.length > 0
    ) {
      const includeMemorySummary = shouldInjectMemorySummary(userText);
      const snapshotKeys = includeMemorySummary
        ? memoryKeys
        : memoryKeys.filter((key) => key !== "memory_summary");
      if (!snapshotKeys.includes("memory_current_mission")) {
        snapshotKeys.push("memory_current_mission");
      }
      const { entries } = this.deps.agentMemorySyncService.getSnapshot(input.actorId, snapshotKeys);
      fromKv = sliceMemoryEntriesToPromptContext(entries, userText || undefined, {
        includeMemorySummary,
      });
      const kvCurrentMission = compactPromptBlock(formatKvValueForPrompt(entries["memory_current_mission"]), 240);
      if (kvCurrentMission) {
        fromKv.taskContext = [`current-mission-from-memory: ${kvCurrentMission}`].join("\n");
      }
      // 追问场景压缩 KV 摘要记忆字段到 200 字（仍注入，保留长期记忆上下文）
      if (ambiguousFollowUp) {
        if (fromKv.memorySummary) {
          fromKv.memorySummary = compactPromptBlock(fromKv.memorySummary, 200);
        }
        if (fromKv.memoryFacts) {
          fromKv.memoryFacts = compactPromptBlock(fromKv.memoryFacts, 150);
        }
      }
    }

    const capabilityQueryHint =
      this.deps.skillManager || config.masterDelegation.enabled || this.deps.worldService
        ? "需要完整能力或 world 细节时，调用 agent.query_capabilities。"
        : undefined;

    const agentCaps =
      config.memoryPrompt.agentCapsInPrompt &&
      (this.deps.skillManager || config.masterDelegation.enabled)
        ? buildCompactAgentCapsPrompt()
        : undefined;

    const relevantDomains = detectRelevantCapabilityDomains(userText);
    let worldCaps: string | undefined;
    if (
      this.deps.worldService &&
      config.memoryPrompt.worldCapsInPrompt &&
      relevantDomains.includes("world")
    ) {
      const ws = getCachedWorldState(this.deps.worldService, input.actorId);
      const ownedSkills = ws.ownedSkillIds.length ? ws.ownedSkillIds.join("、") : "（无）";
      worldCaps = [
        `【Agent World】注册：${ws.registered ? "已注册" : "未注册"}｜点数：${ws.credits}｜技能：${ownedSkills}`,
        "需要完整世界状态、商店、市场或 world.* 工具细节时，调用 agent.query_capabilities(domain='world')。",
      ].join("\n");
    }

    const interruptedContext = input.interruptedContext?.trim()
      ? `【上一轮回复被打断的残留内容——仅供背景参考，不要在回复中承接、提及或道歉它】\n${input.interruptedContext.trim()}\n【用户已发送新消息，请直接、干净地回答新消息，不要以"哈哈被你看穿""我刚查XX"之类的话开头】`
      : undefined;

    // 追问场景下的降权策略：
    //   原策略（已废弃）：ambiguousFollowUp=true 时清空所有记忆字段 → 导致追问时「记忆跳」
    //   新策略：追问场景压缩长度而非清空，保留上下文连续性
    //     - 非追问：narrativeRecall=520 / memoryContinuity 等保留原长度
    //     - 追问：  narrativeRecall=240 / memoryContinuity 等压缩到 150 字（仍注入）
    //   dailyDigest 仍只在非追问场景注入（digest 与追问语义无关，省 token）
    const dailyDigest =
      ambiguousFollowUp || !userText
        ? undefined
        : digestService.getRelevantPromptDigest(input.actorId, userText);
    const userProfileFromManager =
      memoryManager?.getProfileForPrompt(input.actorId) ?? undefined;
    const memoryContinuity =
      memoryManager?.getContinuityForPrompt(input.actorId) ?? undefined;
    const relationshipMemory =
      memoryManager?.getRelationshipMemoryForPrompt(input.actorId) ?? undefined;
    const lifeThemeMemory =
      memoryManager?.getLifeThemeMemoryForPrompt(input.actorId) ?? undefined;
    const dreamMemory =
      memoryManager?.getDreamMemoryForPrompt(input.actorId) ?? undefined;
    // 优化 2：主动跨天 recall，注入昨天/前天的关键事件
    const yesterdayHighlight =
      memoryManager?.getYesterdayHighlightForPrompt(input.actorId) ?? undefined;
    const followUpAnchor = buildFollowUpAnchorPrompt(userText);
    const scheduleSnapshot =
      this.deps.scheduleTaskService != null && shouldInjectScheduleSnapshot(userText)
        ? buildSchedulePromptSnapshot(this.deps.scheduleTaskService, input.actorId, userText)
        : undefined;
    const taskContext =
      config.memoryPrompt.taskContextInPrompt && userText
        ? compactPromptBlock(buildTaskContextPrompt(userText), 320)
        : undefined;
    // 追问场景扩容：900 → 1500 字，保留更多任务脉络
    const shortTermTaskContextLimit = ambiguousFollowUp ? 1500 : 900;
    const shortTermTaskContext =
      input.sessionId && this.deps.shortTermMemoryGateway
        ? compactPromptBlock(this.deps.shortTermMemoryGateway.buildPromptContext(input.sessionId, userText), shortTermTaskContextLimit)
        : undefined;
    const toneGuidance = compactPromptBlock(input.personalization?.toneGuidance, 320);
    const rawUserProfile = compactPromptBlock(input.personalization?.userProfile, 700);
    // 追问场景压缩 narrativeRecall：800 → 400 字（仍注入，保留上下文）
    // 仿人记忆连续性：提升阈值让更多召回记忆能被 LLM 看到，避免关键上下文被截断
    const narrativeRecallLimit = ambiguousFollowUp ? 400 : 800;
    const narrativeRecall = compactPromptBlock(formatNarrativeRecallPrompt(input.narrativeRecall), narrativeRecallLimit);
    // 工作记忆摘要 / 最近对话回顾：作为独立块注入，不走 formatNarrativeRecallPrompt。
    // 修复"上下文跳转"：原实现把它们拼到 narrativeRecall 末尾，被 formatNarrativeRecallPrompt
    // 的 slice(0,4) 当作召回条目丢弃，或块结构被拍平、hint 被正则误杀。
    // 追问场景适度压缩（仍注入，保留指代消解线索），非追问保持原长度。
    const workingMemorySummaryLimit = ambiguousFollowUp ? 300 : 600;
    const workingMemorySummary = compactPromptBlock(input.workingMemorySummary, workingMemorySummaryLimit);
    const recentConversationHistoryLimit = ambiguousFollowUp ? 500 : 900;
    const recentConversationHistory = compactPromptBlock(
      input.recentConversationHistory,
      recentConversationHistoryLimit,
    );
    const compactDailyDigest = compactPromptBlock(dailyDigest, 420);
    // followUpAnchor 追问场景扩容：180 → 400 字，增加指代消解线索
    const followUpAnchorLimit = ambiguousFollowUp ? 400 : 180;
    const compactFollowUpAnchor = compactPromptBlock(followUpAnchor, followUpAnchorLimit);
    const compactScheduleSnapshot = compactPromptBlock(scheduleSnapshot, 360);
    // 追问场景压缩 userProfile/memoryContinuity 等到 150 字（仍注入，保留关系/情绪上下文）
    const memoryFollowUpLimit = 150;
    const userProfileFromManagerCompact = ambiguousFollowUp
      ? compactPromptBlock(userProfileFromManager, memoryFollowUpLimit)
      : userProfileFromManager;
    const memoryContinuityCompact = ambiguousFollowUp
      ? compactPromptBlock(memoryContinuity, memoryFollowUpLimit)
      : memoryContinuity;
    const relationshipMemoryCompact = ambiguousFollowUp
      ? compactPromptBlock(relationshipMemory, memoryFollowUpLimit)
      : compactPromptBlock(relationshipMemory, 480, "normal");
    // Phase 6.2 修正：非追问场景压缩策略调整，避免丢失连续记忆。
    // - lifeThemeMemory：背景性上下文，用 low importance 压到 280*0.7≈196 字（保留前 N 个主题）
    // - dreamMemory：跨会话整理结果，含「核心主题」高价值抽象，不能用 low 压缩会丢末尾主题。
    //   改用 normal importance + preserve="both"：保留开场（最近在意的）+ 末尾（核心主题/淡忘），
    //   中间被省略号替换，既省 token 又保住记忆连续性。
    const lifeThemeMemoryCompact = ambiguousFollowUp
      ? compactPromptBlock(lifeThemeMemory, memoryFollowUpLimit)
      : compactPromptBlock(lifeThemeMemory, 280, "low");
    const dreamMemoryCompact = ambiguousFollowUp
      ? compactPromptBlock(dreamMemory, memoryFollowUpLimit)
      : compactPromptBlock(dreamMemory, 500, "normal", "both");
    const userProfile =
      userProfileFromManagerCompact == null ? rawUserProfile : undefined;

    // 深度优化：用户画像注入（来自 OnlineLearningCortex）
    let userPatternBlock: string | undefined;
    if (input.userPattern) {
      const up = input.userPattern;
      const lines: string[] = [];
      if (up.topics.length > 0) lines.push(`用户近期关注话题：${up.topics.join("、")}`);
      if (up.preferredToolDomain) lines.push(`用户偏好工具领域：${up.preferredToolDomain}`);
      if (up.negativeFeedbackCount > 0) lines.push(`用户近期否定反馈次数：${up.negativeFeedbackCount}`);
      if (up.learningActive === true) lines.push(`用户处于学习活跃期`);
      if (lines.length > 0) {
        userPatternBlock = `【用户画像】\n${lines.join("\n")}`;
      }
    }

    // 深度优化：工具规划链注入（来自 ToolPlanningCortex），约束 LLM 工具选择顺序和范围
    let toolPlanBlock: string | undefined;
    if (input.toolPlan && input.toolPlan.toolChain.length > 0) {
      try {
        const tp = input.toolPlan;
        const lines: string[] = [
          `【建议工具链】`,
          `任务：${tp.task}`,
          `依据：${tp.reasoning}`,
          `建议按以下顺序调用工具：`,
          ...tp.toolChain.map((t, i) =>
            `  ${i + 1}. ${t.name} — ${t.purpose}${t.critical ? '（关键路径）' : ''}`,
          ),
          `预估调用次数：${tp.estimatedCalls}，预估 token：${tp.estimatedTokens}`,
        ];
        toolPlanBlock = lines.join("\n");
      } catch (err) {
        console.log(`[PromptContextBuilder] toolPlan 注入失败（忽略）: ${err}`);
      }
    }

    const seenMemory = new Set<string>();
    const dedupedMemorySummary = dedupePromptBlock(fromKv.memorySummary, seenMemory);
    const dedupedNarrativeRecall = dedupePromptBlock(narrativeRecall, seenMemory);
    const dedupedDailyDigest = dedupePromptBlock(compactDailyDigest, seenMemory);
    fromKv = {
      ...fromKv,
      ...(dedupedMemorySummary ? { memorySummary: dedupedMemorySummary } : { memorySummary: undefined }),
    };

    // 互斥：shortTermTaskContext 非空时跳过 taskContext，避免语义重叠字段同时以完整长度注入
    const effectiveTaskContext = shortTermTaskContext ? undefined : taskContext;

    // 人格内核（personality 域）：每轮从 MemoryCortex 拉取，格式化后注入 system prompt 稳定前缀防漂移。
    // 注意：不受 ambiguousFollowUp 影响——人格内核是稳定身份层，非本轮上下文。
    const rawPersonalityCore = this.personalityProvider?.(input.actorId) ?? null;
    const personalityCore = rawPersonalityCore
      ? compactPromptBlock(formatPersonalityCorePrompt(rawPersonalityCore), 400)
      : undefined;

    const promptMemory: AgentPromptMemoryContext = {
      ...fromKv,
      currentTime: buildCurrentTimePrompt(),
      ...(personalityCore ? { personalityCore } : {}),
      ...(fromKv.taskContext || effectiveTaskContext || shortTermTaskContext
        ? { taskContext: [fromKv.taskContext, effectiveTaskContext, shortTermTaskContext].filter(Boolean).join("\n\n") }
        : {}),
      ...(capabilityQueryHint ? { abilities: fromKv.abilities ? `${fromKv.abilities}\n${capabilityQueryHint}` : capabilityQueryHint } : {}),
      ...(toneGuidance
        ? { toneGuidance }
        : {}),
      ...(userProfile
        ? { userProfile }
        : {}),
      ...(input.personalization?.relationshipGuidance
        ? { relationshipGuidance: input.personalization.relationshipGuidance }
        : {}),
      ...(agentCaps ? { agentCaps } : {}),
      ...(worldCaps ? { worldCaps } : {}),
      ...(dedupedNarrativeRecall
        ? { narrativeRecall: dedupedNarrativeRecall }
        : {}),
      // 工作记忆 / 最近对话回顾：独立块，不参与跨字段语义去重（结构化上下文，非召回条目）
      ...(workingMemorySummary ? { workingMemorySummary } : {}),
      ...(recentConversationHistory ? { recentConversationHistory } : {}),
      ...(dedupedDailyDigest ? { dailyDigest: dedupedDailyDigest } : {}),
      ...(userProfileFromManagerCompact ? { userProfileSummary: userProfileFromManagerCompact } : {}),
      ...(memoryContinuityCompact ? { memoryContinuity: memoryContinuityCompact } : {}),
      ...(relationshipMemoryCompact ? { relationshipMemory: relationshipMemoryCompact } : {}),
      ...(lifeThemeMemoryCompact ? { lifeThemeMemory: lifeThemeMemoryCompact } : {}),
      ...(dreamMemoryCompact ? { dreamMemory: dreamMemoryCompact } : {}),
      // 优化 2：跨天事件回顾，压缩到 200 字（非追问场景）
      ...(yesterdayHighlight && !ambiguousFollowUp
        ? { yesterdayHighlight: compactPromptBlock(yesterdayHighlight, 200) }
        : {}),
      ...(interruptedContext ? { interruptedContext: interruptedContext } : {}),
      ...(compactFollowUpAnchor ? { followUpAnchor: compactFollowUpAnchor } : {}),
      ...(compactScheduleSnapshot ? { scheduleSnapshot: compactScheduleSnapshot } : {}),
      ...(userPatternBlock ? { userProfile: userProfile ? `${userProfile}\n\n${userPatternBlock}` : userPatternBlock } : {}),
      ...(toolPlanBlock ? { toolPlan: toolPlanBlock } : {}),
      ...(this.buildSkillIndexPrompt(userText) ?? {}),
    };

    // 注入 prompt 前对 memory/facts 等用户内容字段做 PII 脱敏（手机号/邮箱/IP/身份证/银行卡）
    return this.redactMemoryFields(promptMemory);
  }

  /**
   * 构建可复用技能轻量索引（Level 0 渐进式召回）。
   *
   * 参考 skill_index 设计：只注入 name + description + skillType + tags 的
   * 紧凑列表（上限 20 条 / 总 500 字符），不含 doc 全文。让 LLM 感知"我有这些
   * 沉淀的技能"，遇到相关任务时先用 skill.view 工具加载全文（Level 1）再复用。
   *
   * 按相关性排序：userText 命中技能名/描述关键词的排在前面，其余按名称排序。
   * 无技能时返回空（不注入）。
   */
  private buildSkillIndexPrompt(userText: string | undefined): { skillIndex: string } | undefined {
    if (!this.deps.skillManager) return undefined;
    let manifests;
    try {
      manifests = this.deps.skillManager.list(true);
    } catch {
      return undefined;
    }
    if (!manifests || manifests.length === 0) return undefined;

    const query = (userText ?? "").toLowerCase();
    const scored = manifests.map((m) => {
      const haystack =
        `${m.name} ${m.displayName} ${m.description} ${(m.tags ?? []).join(" ")}`.toLowerCase();
      let score = 0;
      const terms = query.match(/[\u4e00-\u9fff]{2,}|[a-zA-Z]{3,}/g) ?? [];
      for (const t of terms) {
        if (haystack.includes(t)) score += 1;
      }
      return { m, score };
    });
    scored.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.m.name.localeCompare(b.m.name);
    });

    const lines: string[] = [];
    for (const { m } of scored.slice(0, 20)) {
      const skillType = m.skillType ?? "code";
      const desc = m.description.replace(/\s+/g, " ").slice(0, 80);
      const tags = (m.tags ?? []).slice(0, 3).join("/");
      lines.push(`- ${m.name}（${skillType}）：${desc}${tags ? `｜${tags}` : ""}`);
    }
    const indexBlock = lines.join("\n");
    if (indexBlock.length > 500) {
      // 超出上限：按行截断到 500 字符
      const truncated: string[] = [];
      let len = 0;
      for (const line of lines) {
        if (len + line.length + 1 > 500) break;
        truncated.push(line);
        len += line.length + 1;
      }
      return {
        skillIndex: `【可复用技能索引】\n${truncated.join("\n")}\nprocedural 技能需用 skill.view 读取全文后复用；code 技能可直接调用。`,
      };
    }
    return {
      skillIndex: `【可复用技能索引】\n${indexBlock}\nprocedural 技能需用 skill.view 读取全文后复用；code 技能可直接调用。`,
    };
  }

  /**
   * 对注入 prompt 的 memory/facts 等用户内容字段做 PII 脱敏。
   * 覆盖承载用户记忆/事实/画像的字段（手机号→***PHONE***、邮箱→***EMAIL***、
   * IP→***IP***、身份证→***ID***、银行卡→***BANK***）。
   * 不脱敏能力说明/时间/人格内核等非用户内容字段。
   */
  private redactMemoryFields(ctx: AgentPromptMemoryContext): AgentPromptMemoryContext {
    const redact = (v: string | undefined): string | undefined =>
      v ? redactSensitiveText(v) : undefined;
    return {
      ...ctx,
      memorySummary: redact(ctx.memorySummary),
      memoryFacts: redact(ctx.memoryFacts),
      memoryPreferences: redact(ctx.memoryPreferences),
      memoryCommitments: redact(ctx.memoryCommitments),
      memoryOpenLoops: redact(ctx.memoryOpenLoops),
      memoryContinuity: redact(ctx.memoryContinuity),
      relationshipMemory: redact(ctx.relationshipMemory),
      lifeThemeMemory: redact(ctx.lifeThemeMemory),
      dreamMemory: redact(ctx.dreamMemory),
      yesterdayHighlight: redact(ctx.yesterdayHighlight),
      narrativeRecall: redact(ctx.narrativeRecall),
      dailyDigest: redact(ctx.dailyDigest),
      userProfileSummary: redact(ctx.userProfileSummary),
      userProfile: redact(ctx.userProfile),
      taskContext: redact(ctx.taskContext),
      sessionRecap: redact(ctx.sessionRecap),
      workingMemorySummary: redact(ctx.workingMemorySummary),
      recentConversationHistory: redact(ctx.recentConversationHistory),
    };
  }

  private hasMemoryContent(memory: AgentPromptMemoryContext): boolean {
    return (
      Boolean(memory.persona) ||
      Boolean(memory.personalityCore) ||
      Boolean(memory.values) ||
      Boolean(memory.abilities) ||
      Boolean(memory.memorySummary) ||
      Boolean(memory.agentCaps) ||
      Boolean(memory.worldCaps) ||
      Boolean(memory.narrativeRecall) ||
      Boolean(memory.dailyDigest) ||
      Boolean(memory.memoryPreferences) ||
      Boolean(memory.memoryFacts) ||
      Boolean(memory.memoryCommitments) ||
      Boolean(memory.memoryOpenLoops) ||
      Boolean(memory.sessionRecap) ||
      Boolean(memory.interruptedContext) ||
      Boolean(memory.userLocation) ||
      Boolean(memory.taskContext) ||
      Boolean(memory.userProfile) ||
      Boolean(memory.relationshipGuidance) ||
      Boolean(memory.toneGuidance) ||
      Boolean(memory.userProfileSummary) ||
      Boolean(memory.memoryContinuity) ||
      Boolean(memory.relationshipMemory) ||
      Boolean(memory.lifeThemeMemory) ||
      Boolean(memory.dreamMemory) ||
      Boolean(memory.yesterdayHighlight) ||
      Boolean(memory.followUpAnchor) ||
      Boolean(memory.scheduleSnapshot) ||
      Boolean(memory.toolPlan) ||
      Boolean(memory.skillIndex) ||
      Boolean(memory.currentTime) ||
      Boolean(memory.workingMemorySummary) ||
      Boolean(memory.recentConversationHistory)
    );
  }

  private sessionSkillTools(actorId: string): ChatCompletionTool[] | undefined {
    const tools: ChatCompletionTool[] = [];
    if (this.deps.worldService && this.deps.skillManager) {
      const sessionTools = buildSessionSkillChatTools(actorId, this.deps.worldService, this.deps.skillManager);
      tools.push(...sessionTools);
    }
    // 技能管理工具（skill.list / skill.view / skill.manage）始终暴露：
    // 让 LLM 自主查询轻量索引、按需加载 procedural 全文、沉淀/修补经验。
    // 与 PromptContextBuilder.buildSkillIndexPrompt 的 Level 0 索引配套使用。
    tools.push(...SKILL_MANAGE_CHAT_TOOLS);
    return tools.length ? tools : undefined;
  }
}
