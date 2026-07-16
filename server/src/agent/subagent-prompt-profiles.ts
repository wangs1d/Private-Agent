import type { SubAgentType } from "../services/master-agent-types.js";
import type { CapabilityDomain } from "./agent-capabilities.js";

/** 子 Agent system prompt 注入字段开关（裁剪体积、聚焦任务）。 */
export type SubAgentPromptProfile = {
  includeTaskContext: boolean;
  includeToneGuidance: boolean;
  includeUserProfile: boolean;
  includeUserLocation: boolean;
  includePersona: boolean;
  includeValues: boolean;
  includeAbilities: boolean;
  includeAgentCaps: boolean;
  includeWorldCaps: boolean;
  includeNarrativeRecall: boolean;
  includeMemorySummary: boolean;
};

const FULL_PROFILE: SubAgentPromptProfile = {
  includeTaskContext: true,
  includeToneGuidance: true,
  includeUserProfile: true,
  includeUserLocation: true,
  includePersona: true,
  includeValues: true,
  includeAbilities: true,
  includeAgentCaps: true,
  includeWorldCaps: true,
  includeNarrativeRecall: true,
  includeMemorySummary: true,
};

/**
 * 各子 Agent 类型的 prompt 裁剪策略。
 *
 * 设计原则（2026-07 优化）：
 * - 所有子 Agent 都保留 userProfile + memorySummary，避免"失忆"
 * - 裁掉与任务无关的元数据，减少 token 占用
 * - info/tech 不注入 taskContext（子 Agent 通过 directive 获取任务上下文）
 * - info/tech 不注入 userLocation（非地域相关任务不需要）
 */
export const SUB_AGENT_PROMPT_PROFILES: Record<SubAgentType, SubAgentPromptProfile> = {
  // life：生活全能助手，需要完整上下文做个性化决策（消费/转账涉及地域和偏好）
  life: {
    ...FULL_PROFILE,
    includeWorldCaps: false,
    includeValues: false,
    includeAbilities: false,
  },
  // tech：技术操控助手，只需 userProfile（谁的电脑）+ memorySummary（上次任务）
  tech: {
    includeTaskContext: false,       // 通过 directive 获取任务上下文，不重复注入
    includeToneGuidance: false,
    includeUserProfile: true,
    includeUserLocation: false,     // 技术任务非地域相关
    includePersona: false,
    includeValues: false,
    includeAbilities: false,
    includeAgentCaps: false,
    includeWorldCaps: false,
    includeNarrativeRecall: false,  // 技术任务不依赖上次叙事
    includeMemorySummary: true,
  },
  // info：信息助手，只需 userProfile（偏好/预算）+ memorySummary（上次调研）
  info: {
    includeTaskContext: false,       // 通过 directive 获取任务上下文
    includeToneGuidance: false,
    includeUserProfile: true,
    includeUserLocation: false,     // 比价调研非地域相关
    includePersona: false,
    includeValues: false,
    includeAbilities: false,
    includeAgentCaps: false,
    includeWorldCaps: false,
    includeNarrativeRecall: false,
    includeMemorySummary: true,
  },
};
