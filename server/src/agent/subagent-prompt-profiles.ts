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

/** 各子 Agent 类型的 prompt 裁剪策略。 */
export const SUB_AGENT_PROMPT_PROFILES: Record<SubAgentType, SubAgentPromptProfile> = {
  life: {
    ...FULL_PROFILE,
    includeWorldCaps: false,
    includeNarrativeRecall: false,
    includeValues: false,
    includeAbilities: false,
  },
  tech: {
    includeTaskContext: true,
    includeToneGuidance: false,
    includeUserProfile: false,
    includeUserLocation: true,
    includePersona: false,
    includeValues: false,
    includeAbilities: false,
    includeAgentCaps: false,
    includeWorldCaps: false,
    includeNarrativeRecall: false,
    includeMemorySummary: false,
  },
  info: {
    includeTaskContext: true,
    includeToneGuidance: false,
    includeUserProfile: false,
    includeUserLocation: true,
    includePersona: false,
    includeValues: false,
    includeAbilities: false,
    includeAgentCaps: false,
    includeWorldCaps: false,
    includeNarrativeRecall: false,
    includeMemorySummary: false,
  },
  creative: {
    ...FULL_PROFILE,
    includeAgentCaps: false,
    includeWorldCaps: false,
    includeNarrativeRecall: true,
    includeMemorySummary: true,
  },
  security: {
    includeTaskContext: true,
    includeToneGuidance: false,
    includeUserProfile: true,
    includeUserLocation: true,
    includePersona: false,
    includeValues: false,
    includeAbilities: false,
    includeAgentCaps: false,
    includeWorldCaps: false,
    includeNarrativeRecall: false,
    includeMemorySummary: false,
  },
  general: FULL_PROFILE,
};
