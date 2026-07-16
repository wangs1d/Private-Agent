// Agent 自身风格指纹（句长 / 用词偏好 / 语气词）
// 与 user-personalization-service 的 StyleProfileState（用户偏好/容忍度）不同，
// 这里描述的是 Agent 自己说话的风格特征，用于话术生成时注入 system prompt
// 并在生成后做风格一致性校验（非阻塞）。
import type { AgentMemorySyncService } from "../services/agent-memory-sync-service.js";

export type AgentStyleProfile = {
  /** 平均句长（字/句） */
  avgSentenceLength: number;
  /** 常用语气词，如 ["呢","吧","哦"] */
  favoriteParticles: string[];
  /** 用词偏好，如 ["简洁","清晰"] */
  vocabularyPreference: string[];
  /** 语气标记，如 ["温和","友善"] */
  toneMarkers: string[];
};

/** KV key：持久化到 AgentMemorySyncService（全局 agent 级，非按用户） */
export const AGENT_STYLE_PROFILE_KEY = "agent_style_profile";

/** 全局 agent 级 sessionId：风格指纹不区分用户，统一存一个 */
const AGENT_STYLE_PROFILE_SESSION_ID = "__agent__";

/** 默认风格指纹 */
export const DEFAULT_AGENT_STYLE_PROFILE: AgentStyleProfile = {
  avgSentenceLength: 15,
  favoriteParticles: ["呢", "吧", "哦"],
  vocabularyPreference: ["简洁", "清晰"],
  toneMarkers: ["温和", "友善"],
};

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

/** 从 KV 反序列化时做容错归一化 */
export function toAgentStyleProfile(v: unknown): AgentStyleProfile {
  if (!v || typeof v !== "object") return { ...DEFAULT_AGENT_STYLE_PROFILE };
  const o = v as Record<string, unknown>;
  const avgLen = Number(o.avgSentenceLength);
  return {
    avgSentenceLength:
      Number.isFinite(avgLen) && avgLen > 0 ? avgLen : DEFAULT_AGENT_STYLE_PROFILE.avgSentenceLength,
    favoriteParticles: isStringArray(o.favoriteParticles)
      ? o.favoriteParticles.slice()
      : DEFAULT_AGENT_STYLE_PROFILE.favoriteParticles.slice(),
    vocabularyPreference: isStringArray(o.vocabularyPreference)
      ? o.vocabularyPreference.slice()
      : DEFAULT_AGENT_STYLE_PROFILE.vocabularyPreference.slice(),
    toneMarkers: isStringArray(o.toneMarkers)
      ? o.toneMarkers.slice()
      : DEFAULT_AGENT_STYLE_PROFILE.toneMarkers.slice(),
  };
}

/** 读取风格指纹；memory 为空时返回默认值 */
export function loadAgentStyleProfile(
  memory: AgentMemorySyncService | null,
): AgentStyleProfile {
  if (!memory) return { ...DEFAULT_AGENT_STYLE_PROFILE };
  const entries = memory.getSnapshot(AGENT_STYLE_PROFILE_SESSION_ID, [
    AGENT_STYLE_PROFILE_KEY,
  ]).entries;
  return toAgentStyleProfile(entries[AGENT_STYLE_PROFILE_KEY]);
}

/** 写入风格指纹（乐观锁重试，沿用 UserPersonalizationService 的持久化模式） */
export function saveAgentStyleProfile(
  memory: AgentMemorySyncService,
  profile: AgentStyleProfile,
): void {
  void (async () => {
    for (let i = 0; i < 8; i++) {
      const { revision } = memory.getSnapshot(AGENT_STYLE_PROFILE_SESSION_ID, [
        AGENT_STYLE_PROFILE_KEY,
      ]);
      const r = await memory.applyPatch(
        AGENT_STYLE_PROFILE_SESSION_ID,
        revision,
        [{ key: AGENT_STYLE_PROFILE_KEY, op: "put", value: profile }],
      );
      if (r.ok) return;
    }
  })();
}

/**
 * 将风格指纹格式化为可读文本，供注入 system prompt。
 * 例：说话风格：平均句长约 15 字，常用语气词：呢/吧/哦，用词偏好：简洁清晰，语气基调：温和、友善。
 */
export function formatAgentStylePrompt(profile: AgentStyleProfile): string {
  return [
    "说话风格：",
    `平均句长约 ${profile.avgSentenceLength} 字，`,
    `常用语气词：${profile.favoriteParticles.join("/")}，`,
    `用词偏好：${profile.vocabularyPreference.join("")}，`,
    `语气基调：${profile.toneMarkers.join("、")}。`,
  ].join("");
}

export type StyleConsistencyResult = {
  passed: boolean;
  deviation: number;
  reason?: string;
};

/**
 * 校验话术句长是否落在风格指纹 avgSentenceLength 的 ±30% 范围内。
 * 按句末标点（。！？!?）分句后取平均句长，计算相对偏离度。
 * 偏离超过 30% 视为不通过（仅记录警告，不阻塞输出）。
 */
export function validateStyleConsistency(
  text: string,
  profile: AgentStyleProfile,
): StyleConsistencyResult {
  const sentences = text
    .split(/[。！？!?]/u)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const avgLen =
    sentences.reduce((sum, s) => sum + s.length, 0) /
    (sentences.length || 1);
  const deviation =
    Math.abs(avgLen - profile.avgSentenceLength) / profile.avgSentenceLength;
  const rounded = Number(deviation.toFixed(2));
  return {
    passed: rounded <= 0.3,
    deviation: rounded,
    reason:
      rounded > 0.3
        ? `句长偏离 ${(rounded * 100).toFixed(0)}%`
        : undefined,
  };
}
