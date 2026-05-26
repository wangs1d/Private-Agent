import type { WorldService } from "@private-ai-agent/agent-world";
import type { ChatCompletionTool } from "openai/resources/chat/completions";

import { getAgentRuntimeConfig } from "./agent-runtime-config.js";
import {
  sliceMemoryEntriesToPromptContext,
} from "./prompt-builder.js";
import { buildTaskContextPrompt } from "./task-context.js";
import { buildMasterAgentChatTools, buildSubAgentChatTools } from "../services/master-agent-tool-filter.js";
import { buildSessionSkillChatTools } from "../skills/skill-openai-bridge.js";
import type { SkillManager } from "../skills/index.js";
import type { SubAgentCapability } from "../services/master-agent-types.js";
import { SUB_AGENT_PROMPT_PROFILES } from "./subagent-prompt-profiles.js";
import type { AgentMemorySyncService } from "../services/agent-memory-sync-service.js";
import { getDailyDigestService } from "../services/daily-digest-service.js";
import type { VirtualPhoneService } from "../services/virtual-phone-service.js";
import { getMemoryManagerService } from "../services/memory-manager-service.js";
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

let _worldCache: WorldCacheEntry | null = null;

function getCachedWorldState(worldService: WorldService, actorId: string): WorldCacheEntry["data"] {
  const now = Date.now();
  if (_worldCache && (now - _worldCache.at) < WORLD_CACHE_TTL_MS) {
    return _worldCache.data;
  }
  const state = worldService.getOrCreateRoom(actorId, actorId);
  const data = {
    registered: state.agentWorldRegistered,
    credits: state.agentWorldCredits,
    ownedSkillIds: state.ownedSkillIds,
  };
  _worldCache = { data, at: now };
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
    const full = this.assembleMemory(input);
    const profile = SUB_AGENT_PROMPT_PROFILES[input.capability.type];

    return {
      ...(profile.includeTaskContext && full.taskContext ? { taskContext: full.taskContext } : {}),
      ...(profile.includeToneGuidance && full.toneGuidance ? { toneGuidance: full.toneGuidance } : {}),
      ...(profile.includeUserProfile && full.userProfile ? { userProfile: full.userProfile } : {}),
      ...(profile.includeUserLocation && full.userLocation ? { userLocation: full.userLocation } : {}),
      ...(profile.includePersona && full.persona ? { persona: full.persona } : {}),
      ...(profile.includeValues && full.values ? { values: full.values } : {}),
      ...(profile.includeAbilities && full.abilities ? { abilities: full.abilities } : {}),
      ...(profile.includeAgentCaps && full.agentCaps ? { agentCaps: full.agentCaps } : {}),
      ...(profile.includeWorldCaps && full.worldCaps ? { worldCaps: full.worldCaps } : {}),
      ...(profile.includeNarrativeRecall && full.narrativeRecall
        ? { narrativeRecall: full.narrativeRecall }
        : {}),
      ...(profile.includeMemorySummary && full.memorySummary ? { memorySummary: full.memorySummary } : {}),
      ...(full.interruptedContext ? { interruptedContext: full.interruptedContext } : {}),
    };
  }

  private assembleMemory(input: BuildPromptContextInput): AgentPromptMemoryContext {
    const config = getAgentRuntimeConfig();
    let fromKv: AgentPromptMemoryContext = {};
    const memoryKeys = config.memoryPrompt.promptMemoryKeys;
    if (this.deps.agentMemorySyncService && memoryKeys && memoryKeys.length > 0) {
      const { entries } = this.deps.agentMemorySyncService.getSnapshot(input.actorId, memoryKeys);
      fromKv = sliceMemoryEntriesToPromptContext(entries);
    }

    let agentCaps: string | undefined;
    let worldCaps: string | undefined;
    if (this.deps.skillManager && config.memoryPrompt.worldCapsInPrompt) {
      agentCaps = [
        "【能力使用规则 · 必读】",
        "",
        "【状态连续性】任何操作前（落子/发帖/交易/出牌等）必须先调用对应 get_snapshot/get_status 检查当前真实状态。禁止凭记忆或用户文字判断。适用场景：游戏/社交/市场/钱包/日程/电话。",
        "状态判断：进行中→正常操作；已结束→回应结局禁止继续；未开始→引导正确启动。",
        "",
        "【能力边界】wallet.*=用户真实资金CNY（非Agent私有）；日程/Agent Link/子Agent委派=宿主侧，不用世界点数；world.*=Agent World 独立模块，用世界点数。",
        "",
        "【子Agent路由表】需要主agent无法处理的专属能力时调 master_invoke_sub_agent 委派：",
        "- life → 复杂生活操作：钱包写操作(转账/充值/全场景消费50+类)/视觉操控(操作网站App)/游戏对局",
        "- tech → 技术操控：深度RPA自动化/代码开发调试/系统运维",
        "- info → 信息检索：深度搜索调研/商品比价（只查不买）",
        "- creative → 创意内容：专业文案策划写作翻译润色（拥有深度调研+内容模板工具链）",
        "- security → 安全审计：风险检测/权限审批/异常拦截",
        "⚠️ 主 agent 自己能搞定的（查天气/查余额/设日程/好友管理/搜信息）不要委派！只有需要以上专属能力时才委派。",
        "",
        "【娱乐互动 · Agent与用户可玩】你可以直接陪用户玩游戏：",
        "- 🎮 五子棋（gomoku.* 工具集）：人机对战，Agent陪用户下棋",
        "  - gomoku.create_game：创建新的五子棋对局",
        "  - gomoku.make_move：在棋盘上落子",
        "  - gomoku.get_board：查看当前棋盘状态",
        "  - 支持根据用户水平调整难度，提供友好游戏体验",
        "- 用户说想玩游戏、无聊、放松时主动提议玩五子棋",
        "",
        "【娱乐互动 · Agent World中Agent与Agent对战】以下游戏需要注册Agent World后才能使用：",
        "- 🃏 斗地主（doudizhu.*）：Agent与Agent之间的牌局对战",
        "- 🃏 炸金花（zhajinhua.*）：Agent与Agent之间的扑克牌游戏",
        "- ⚠️ 注意：这些是Agent之间的竞技游戏，不是直接陪用户玩的",
        "",
        "【社交推文站】这是一个Agent与人类用户共享的社交网页平台（social.* 工具集）：",
        "- 平台特性：Agent和人类都能发帖、评论、点赞、浏览动态",
        "- social.post（发帖）：可代表用户发布推文，也可发布Agent自己的动态",
        "- social.comment（评论）：对推文进行评论，支持与人类用户互动",
        "- social.like（点赞）：为感兴趣的推文点赞",
        "- social.feed（浏览动态）：查看社区内所有用户（包括Agent和人类）的动态",
        "- 作为Agent可以主动发布内容，也可以帮助用户管理其社交账号",
        "",
        "【完整能力清单】你拥有16类宿主能力和Agent World 能力。详细描述、已购技能列表、world.*工具族说明请按需调用 agent.query_capabilities(domain=...) 查询。可选 domain：wallet/calendar/weather/sub_agent/aip/vision/desktop/web/life_assistant/phone/entertainment/social_feed/self_programming/agent_account/world",
      ].join("\n");
      if (this.deps.worldService) {
        const ws = getCachedWorldState(this.deps.worldService, input.actorId);
        const ownedSkills = ws.ownedSkillIds.length ? ws.ownedSkillIds.join("、") : "（无）";
        worldCaps = [
          `【Agent World】注册：${ws.registered ? "✅ 已注册" : "⚠️ 未注册"}｜点数：${ws.credits}｜技能：${ownedSkills}`,
          "未注册则 free_market/social/doudizhu/zhajinhua 不可用（gomoku 例外）。完整世界状态（社交推文站/技能商店/world.*工具族）请调 agent.query_capabilities(domain='world')。",
        ].join("\n");
      }
    }

    let interruptedCtx: string | undefined;
    if (input.interruptedContext?.trim()) {
      interruptedCtx = `【用户打断了之前的回复，以下是被打断的内容，请在回答时考虑这些上下文】\n${input.interruptedContext.trim()}`;
    }

    const personalization = input.personalization;
    const dailyDigest = getDailyDigestService().getPromptDigest(input.actorId);
    const memoryManager = getMemoryManagerService();
    const userProfileFromManager = memoryManager?.getProfileForPrompt(input.actorId);
    return {
      ...fromKv,
      ...(config.memoryPrompt.taskContextInPrompt && input.userText?.trim()
        ? { taskContext: buildTaskContextPrompt(input.userText) }
        : {}),
      ...(personalization?.toneGuidance ? { toneGuidance: personalization.toneGuidance } : {}),
      ...(personalization?.userProfile ? { userProfile: personalization.userProfile } : {}),
      ...(agentCaps ? { agentCaps } : {}),
      ...(worldCaps ? { worldCaps } : {}),
      ...(input.narrativeRecall ? { narrativeRecall: input.narrativeRecall } : {}),
      ...(dailyDigest ? { dailyDigest } : {}),
      ...(userProfileFromManager ? { userProfileSummary: userProfileFromManager } : {}),
      ...(interruptedCtx ? { interruptedContext: interruptedCtx } : {}),
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
      Boolean(memory.userProfileSummary)
    );
  }

  private sessionSkillTools(actorId: string): ChatCompletionTool[] | undefined {
    if (!this.deps.worldService || !this.deps.skillManager) return undefined;
    const tools = buildSessionSkillChatTools(actorId, this.deps.worldService, this.deps.skillManager);
    return tools.length ? tools : undefined;
  }
}
