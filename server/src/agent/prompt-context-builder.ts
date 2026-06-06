import type { WorldService } from "@private-ai-agent/agent-world";
import type { ChatCompletionTool } from "openai/resources/chat/completions";

import { CAPABILITY_DOMAINS, type CapabilityDomain } from "./agent-capabilities.js";
import { getAgentRuntimeConfig } from "./agent-runtime-config.js";
import {
  sliceMemoryEntriesToPromptContext,
  sliceSubAgentMemoryEntries,
} from "./prompt-builder.js";
import { buildTaskContextPrompt } from "./task-context.js";
import { buildMasterAgentChatTools, buildSubAgentChatTools } from "../services/master-agent-tool-filter.js";
import { buildSessionSkillChatTools } from "../skills/skill-openai-bridge.js";
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
import type {
  AgentPromptMemoryContext,
  AgentStreamOptions,
  ToolLoopAfterBatchInfo,
} from "../external-model/types.js";
import type { PersonalizationPromptSlice } from "../services/user-personalization/user-personalization-service.js";

const WORLD_CACHE_TTL_MS = 5_000;

function buildCompactAgentCapsPrompt(): string {
  const cfg = getAgentRuntimeConfig();
  const lines = [
    "【能力概览】你是主 Agent，可直接处理日常对话，并按需调用时间、天气、搜索、日程、钱包、社交与 Agent World 相关工具。",
    "【调度原则】简单问题直接回答；需要实时信息时先查再答；复杂或多步骤任务可派专业小弟（子 Agent）执行。",
    "【执行约束】涉及消费、转账、桌面高权限操作或状态敏感任务时，必须先读取对应工具返回的实时状态，不凭记忆假设。",
  ];
  if (cfg.masterDelegation.enabled) {
    lines.push(
      `【你的小弟】life / tech / info / creative 四类子 Agent 听你的调度；互不依赖的子任务可在同一轮并行委派（最多 ${cfg.masterDelegation.maxParallelSubAgents} 个同时进行）。`,
      "【工具】master_invoke_sub_agent 派活；master_list_sub_agents 看名册；master_poll_sub_agent_tasks 查后台小弟进度。",
    );
  }
  lines.push("需要完整能力明细时调用 agent.query_capabilities。");
  return lines.join("\n");
}

const WORLD_DOMAIN_RULES: Array<{ domains: CapabilityDomain[]; pattern: RegExp }> = [
  { domains: ["world"], pattern: /agent world|world\.|free_market|open_registry|世界点数|点数|技能商店|注册|市场/i },
  { domains: ["social_feed", "world"], pattern: /社交|推文|帖子|动态|评论|点赞|social/i },
  { domains: ["entertainment"], pattern: /游戏|五子棋|斗地主|炸金花|21点|blackjack|gomoku|doudizhu|zhajinhua/i },
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

export type BuildPromptContextInput = {
  actorId: string;
  userText?: string;
  narrativeRecall?: string;
  interruptedContext?: string;
  userLocation?: string;
  personalization?: PersonalizationPromptSlice;
  onToolLoopAfterBatch?: (info: ToolLoopAfterBatchInfo) => void;
};

export type BuildMasterDelegateInput = BuildPromptContextInput & {
  subAgentCapabilities: Iterable<SubAgentCapability>;
};

export type BuildSubAgentInput = BuildPromptContextInput & {
  capability: SubAgentCapability;
  taskDescription?: string;
};

export class PromptContextBuilder {
  constructor(
    private readonly deps: {
      agentMemorySyncService: AgentMemorySyncService | null;
      worldService: WorldService | null;
      skillManager: SkillManager | null;
      virtualPhoneService: VirtualPhoneService | null;
      scheduleTaskService?: ScheduleTaskService | null;
    },
  ) {}

  build(input: BuildPromptContextInput): AgentStreamOptions | undefined {
    const memory = this.assembleMemory(input);
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
    if (
      this.deps.agentMemorySyncService &&
      memoryKeys &&
      memoryKeys.length > 0 &&
      !ambiguousFollowUp
    ) {
      const includeMemorySummary = shouldInjectMemorySummary(userText);
      const snapshotKeys = includeMemorySummary
        ? memoryKeys
        : memoryKeys.filter((key) => key !== "memory_summary");
      const { entries } = this.deps.agentMemorySyncService.getSnapshot(input.actorId, snapshotKeys);
      fromKv = sliceMemoryEntriesToPromptContext(entries, userText || undefined, {
        includeMemorySummary,
      });
    }

    const agentCaps =
      this.deps.skillManager || config.masterDelegation.enabled
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
      ? `【用户打断了之前的回复，以下是被打断的内容，请在回答时考虑这些上下文】\n${input.interruptedContext.trim()}`
      : undefined;

    const dailyDigest =
      ambiguousFollowUp || !userText
        ? undefined
        : digestService.getRelevantPromptDigest(input.actorId, userText);
    const userProfileFromManager =
      ambiguousFollowUp ? null : memoryManager?.getProfileForPrompt(input.actorId) ?? null;
    const memoryContinuity =
      ambiguousFollowUp ? null : memoryManager?.getContinuityForPrompt(input.actorId) ?? null;
    const relationshipMemory =
      ambiguousFollowUp ? null : memoryManager?.getRelationshipMemoryForPrompt(input.actorId) ?? null;
    const lifeThemeMemory =
      ambiguousFollowUp ? null : memoryManager?.getLifeThemeMemoryForPrompt(input.actorId) ?? null;
    const followUpAnchor = buildFollowUpAnchorPrompt(userText);
    const scheduleSnapshot =
      this.deps.scheduleTaskService != null && shouldInjectScheduleSnapshot(userText)
        ? buildSchedulePromptSnapshot(this.deps.scheduleTaskService, input.actorId, userText)
        : undefined;

    return {
      ...fromKv,
      ...(config.memoryPrompt.taskContextInPrompt && userText
        ? { taskContext: buildTaskContextPrompt(userText) }
        : {}),
      ...(input.personalization?.toneGuidance
        ? { toneGuidance: input.personalization.toneGuidance }
        : {}),
      ...(input.personalization?.userProfile
        ? { userProfile: input.personalization.userProfile }
        : {}),
      ...(input.personalization?.relationshipGuidance
        ? { relationshipGuidance: input.personalization.relationshipGuidance }
        : {}),
      ...(agentCaps ? { agentCaps } : {}),
      ...(worldCaps ? { worldCaps } : {}),
      ...(input.narrativeRecall && !ambiguousFollowUp
        ? { narrativeRecall: input.narrativeRecall }
        : {}),
      ...(dailyDigest ? { dailyDigest } : {}),
      ...(userProfileFromManager ? { userProfileSummary: userProfileFromManager } : {}),
      ...(memoryContinuity ? { memoryContinuity } : {}),
      ...(relationshipMemory ? { relationshipMemory } : {}),
      ...(lifeThemeMemory ? { lifeThemeMemory } : {}),
      ...(interruptedContext ? { interruptedContext } : {}),
      ...(followUpAnchor ? { followUpAnchor } : {}),
      ...(scheduleSnapshot ? { scheduleSnapshot } : {}),
    };
  }

  private hasMemoryContent(memory: AgentPromptMemoryContext): boolean {
    return (
      Boolean(memory.persona) ||
      Boolean(memory.values) ||
      Boolean(memory.abilities) ||
      Boolean(memory.memorySummary) ||
      Boolean(memory.agentCaps) ||
      Boolean(memory.worldCaps) ||
      Boolean(memory.narrativeRecall) ||
      Boolean(memory.dailyDigest) ||
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
      Boolean(memory.followUpAnchor) ||
      Boolean(memory.scheduleSnapshot)
    );
  }

  private sessionSkillTools(actorId: string): ChatCompletionTool[] | undefined {
    if (!this.deps.worldService || !this.deps.skillManager) return undefined;
    const tools = buildSessionSkillChatTools(actorId, this.deps.worldService, this.deps.skillManager);
    return tools.length ? tools : undefined;
  }
}
