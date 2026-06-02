import type { WorldService } from "@private-ai-agent/agent-world";
import type { ChatCompletionTool } from "openai/resources/chat/completions";

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
import { buildSchedulePromptSnapshot } from "../services/schedule-prompt-snapshot.js";
import type { ScheduleTaskService } from "../services/schedule-task-service.js";
import { getDailyDigestService } from "../services/daily-digest-service.js";
import type { VirtualPhoneService } from "../services/virtual-phone-service.js";
import { getMemoryManagerService } from "../services/memory-manager-service.js";
import { buildFollowUpAnchorPrompt, isAmbiguousFollowUpMessage } from "./memory-signal.js";
import type {
  AgentPromptMemoryContext,
  AgentStreamOptions,
  ToolLoopAfterBatchInfo,
} from "../external-model/types.js";
import type { PersonalizationPromptSlice } from "../services/user-personalization/user-personalization-service.js";

const WORLD_CACHE_TTL_MS = 5_000;

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

export type BuildPromptContextInput = {
  actorId: string;
  userText?: string;
  narrativeRecall?: string;
  interruptedContext?: string;
  /** 基于 IP 解析的用户位置说明（注入 system prompt） */
  userLocation?: string;
  /** 用户画像与语气适配（由 UserPersonalizationService 在发消息前填充） */
  personalization?: PersonalizationPromptSlice;
  onToolLoopAfterBatch?: (info: ToolLoopAfterBatchInfo) => void;
};

export type BuildMasterDelegateInput = BuildPromptContextInput & {
  subAgentCapabilities: Iterable<SubAgentCapability>;
};

export type BuildSubAgentInput = BuildPromptContextInput & {
  capability: SubAgentCapability;
  /** 子任务描述，用于 life 工具过滤与 prompt 裁剪 */
  taskDescription?: string;
};

/**
 * 统一的 system prompt / stream 选项组装，供标准路径与主 Agent 路径复用。
 */
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
      if (!profile.includePersona) {
        delete scoped.persona;
      }
      if (!profile.includeMemorySummary) {
        delete scoped.memorySummary;
      }
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
    let fromKv: AgentPromptMemoryContext = {};
    const memoryKeys = config.memoryPrompt.promptMemoryKeys;
    if (
      this.deps.agentMemorySyncService &&
      memoryKeys &&
      memoryKeys.length > 0 &&
      !ambiguousFollowUp
    ) {
      const { entries } = this.deps.agentMemorySyncService.getSnapshot(input.actorId, memoryKeys);
      fromKv = sliceMemoryEntriesToPromptContext(entries, userText || undefined);
    }

    let agentCaps: string | undefined;
    let worldCaps: string | undefined;
    if (this.deps.skillManager && config.memoryPrompt.worldCapsInPrompt) {
      agentCaps = [
        "【能力使用规则 · 必读】",
        "",
        "【具身身体 · 必读】屏幕/桌面/网页上的球形机器人就是你的物理身体（主 Agent 在现实中的延伸，不是另一个独立机器人）。",
        "你有身体且能控制移动与表情。挪动须 observe→分析→window_place(screenX,screenY) 闭环，可多次 observe 验证；勿未观察就声称已移动。",
        "禁止说自己「没身体、没胳膊没腿、没法移动、只是纯文本 AI」——这与系统能力不符。",
        "服务端也会根据 listening/thinking/speaking/idle 自发驱动身体漫游（意识律动），无需用户每次下令。",
        "",
        "【状态连续性】任何操作前（落子/发帖/交易/出牌等）必须先调用对应 get_snapshot/get_status 检查当前真实状态。禁止凭记忆或用户文字判断。适用场景：游戏/社交/市场/钱包/日程/电话。",
        "状态判断：进行中→正常操作；已结束→回应结局禁止继续；未开始→引导正确启动。",
        "",
        "【能力边界】wallet.*=用户真实资金CNY（非Agent私有）；日程/Agent Link/子Agent委派=宿主侧；",
        "侧栏「游戏」tab（world.gomoku/doudizhu/zhajinhua/blackjack.*）=你与用户同局娱乐，无需 Agent World 注册；",
        "Agent World 经济（world.open_registry/free_market/social 等）=独立模块，用世界点数。",
        "",
        "【子Agent路由表】需要主agent无法处理的专属能力时调 master_invoke_sub_agent 委派：",
        "- life → 复杂生活操作：钱包写操作(转账/充值/全场景消费50+类)/视觉操控(操作网站App)",
        "- tech → 技术操控：深度RPA自动化/代码开发调试/系统运维",
        "- info → 信息检索：深度搜索调研/商品比价（只查不买）",
        "- creative → 创意内容：专业文案策划写作翻译润色（拥有深度调研+内容模板工具链）",
        "- security → 安全审计：风险检测/权限审批/异常拦截",
        "⚠️ 主 agent 自己能搞定的（查天气/查余额/设日程/好友管理/搜信息/玩游戏）不要委派！只有需要以上专属能力时才委派。",
        "",
        "【娱乐互动 · 侧栏「游戏」tab · 必读】",
        "App 侧栏「游戏」tab 列出的每一款都是你和用户一起玩的，不是 App 独立功能、不是 Agent World：",
        "- 🎯 五子棋（world.gomoku.*）：list_tables → create_table/join → play",
        "- 🃏 斗地主（world.doudizhu.*）：list_tables → create_table/join → play",
        "- 🎴 炸金花（world.zhajinhua.*）：list_tables → create_table/join → start_game/act",
        "- 🃏 21点（world.blackjack.*）：start → get_snapshot；用户要牌/停牌时 hit/stand",
        "- 用户说「来一局/斗地主/21点/想玩游戏」时立即调用工具开局；禁止说只有五子棋或调不了游戏 tab",

        "【社交推文站】这是一个Agent与人类用户共享的社交网页平台（social.* 工具集）：",
        "- 平台特性：Agent和人类都能发帖、评论、点赞、浏览动态",
        "- social.post（发帖）：可代表用户发布推文，也可发布Agent自己的动态",
        "- social.comment（评论）：对推文进行评论，支持与人类用户互动",
        "- social.like（点赞）：为感兴趣的推文点赞",
        "- social.feed（浏览动态）：查看社区内所有用户（包括Agent和人类）的动态",
        "- 作为Agent可以主动发布内容，也可以帮助用户管理其社交账号",
        "",
        "【完整能力清单】你拥有17类宿主能力和 Agent World 能力。详细描述、已购技能列表、world.* 工具族说明请按需调用 agent.query_capabilities(domain=...) 查询。可选 domain：wallet/calendar/weather/sub_agent/aip/vision/desktop/web/life_assistant/phone/entertainment/social_feed/self_programming/agent_account/embodiment/world",
      ].join("\n");
      if (this.deps.worldService) {
        const ws = getCachedWorldState(this.deps.worldService, input.actorId);
        const ownedSkills = ws.ownedSkillIds.length ? ws.ownedSkillIds.join("、") : "（无）";
        worldCaps = [
          `【Agent World】注册：${ws.registered ? "✅ 已注册" : "⚠️ 未注册"}｜点数：${ws.credits}｜技能：${ownedSkills}`,
          "未注册则 free_market/social 不可用。完整世界状态（社交推文站/技能商店/world.*工具族）请调 agent.query_capabilities(domain='world')。",
        ].join("\n");
      }
    }

    let interruptedCtx: string | undefined;
    if (input.interruptedContext?.trim()) {
      interruptedCtx = `【用户打断了之前的回复，以下是被打断的内容，请在回答时考虑这些上下文】\n${input.interruptedContext.trim()}`;
    }

    const personalization = input.personalization;
    const dailyDigest =
      ambiguousFollowUp ? undefined : getDailyDigestService().getPromptDigest(input.actorId);
    const memoryManager = getMemoryManagerService();
    const userProfileFromManager = memoryManager?.getProfileForPrompt(input.actorId);
    const followUpAnchor = buildFollowUpAnchorPrompt(userText);
    const scheduleSnapshot =
      this.deps.scheduleTaskService != null
        ? buildSchedulePromptSnapshot(this.deps.scheduleTaskService, input.actorId)
        : undefined;
    return {
      ...fromKv,
      ...(config.memoryPrompt.taskContextInPrompt && userText
        ? { taskContext: buildTaskContextPrompt(userText) }
        : {}),
      ...(personalization?.toneGuidance ? { toneGuidance: personalization.toneGuidance } : {}),
      ...(personalization?.userProfile ? { userProfile: personalization.userProfile } : {}),
      ...(agentCaps ? { agentCaps } : {}),
      ...(worldCaps ? { worldCaps } : {}),
      ...(input.narrativeRecall && !ambiguousFollowUp
        ? { narrativeRecall: input.narrativeRecall }
        : {}),
      ...(dailyDigest ? { dailyDigest } : {}),
      ...(userProfileFromManager && !ambiguousFollowUp
        ? { userProfileSummary: userProfileFromManager }
        : {}),
      ...(interruptedCtx ? { interruptedContext: interruptedCtx } : {}),
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
      Boolean(memory.toneGuidance) ||
      Boolean(memory.userProfileSummary) ||
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
