import type { AgentMemorySyncService } from "../agent-memory-sync-service.js";
import type { ExternalChatProvider } from "../../external-model/types.js";
import {
  buildToneGuidance,
  defaultEmotionState,
  detectEmotionFromText,
  detectPreferredToneFromText,
  dominantRecentEmotion,
  pushEmotion,
  type EmotionState,
  type PreferredTone,
} from "./emotion-tone.js";
import {
  applyProfilePatches,
  extractProfilePatches,
  syncPreferredToneInProfile,
} from "./profile-heuristics.js";
import { UserProfileStore } from "./user-profile-store.js";

const EMOTION_STATE_KEY = "emotion_state";
const USER_PROFILE_KV_KEY = "user_profile";

const TONE_ZH: Record<PreferredTone, string> = {
  humor: "幽默轻松",
  formal: "正式专业",
  warm: "温馨亲切",
  balanced: "自然均衡",
};

export function isUserPersonalizationEnabled(): boolean {
  const raw = process.env.AGENT_USER_PERSONALIZATION_ENABLED?.trim().toLowerCase();
  if (!raw) return true;
  if (raw === "0" || raw === "off" || raw === "false") return false;
  return true;
}

function profileLlmEveryNTurns(): number {
  const n = Number.parseInt(process.env.AGENT_USER_PROFILE_LLM_EVERY_N ?? "8", 10);
  return Number.isFinite(n) && n >= 0 ? n : 8;
}

function toEmotionState(v: unknown): EmotionState {
  if (!v || typeof v !== "object") return defaultEmotionState();
  const o = v as Record<string, unknown>;
  const recent = Array.isArray(o.recent)
    ? o.recent.filter((x): x is EmotionState["recent"][number] =>
        x === "positive" || x === "neutral" || x === "negative" || x === "stressed",
      )
    : [];
  const preferredTone =
    o.preferredTone === "humor" ||
    o.preferredTone === "formal" ||
    o.preferredTone === "warm" ||
    o.preferredTone === "balanced"
      ? o.preferredTone
      : "balanced";
  return {
    recent: recent.slice(-6),
    preferredTone,
    lastUpdatedAt:
      typeof o.lastUpdatedAt === "string" && o.lastUpdatedAt
        ? o.lastUpdatedAt
        : new Date().toISOString(),
    turnCount: Number(o.turnCount) || 0,
  };
}

export type PersonalizationPromptSlice = {
  userProfile?: string;
  toneGuidance?: string;
};

/**
 * 用户画像（USER_PROFILE.md）+ 情感语气自适应。
 * - 每轮前：根据当前用户话更新情绪状态并生成语气指引
 * - 每轮后：规则更新 MD；可选每 N 轮用轻量 LLM 精炼画像
 */
export class UserPersonalizationService {
  private readonly store = new UserProfileStore();

  constructor(
    private readonly memory: AgentMemorySyncService | null,
    private readonly externalChat: ExternalChatProvider | null = null,
  ) {}

  async getPromptSlice(actorId: string, userText?: string): Promise<PersonalizationPromptSlice> {
    if (!isUserPersonalizationEnabled()) return {};

    let state = this.loadEmotionState(actorId);
    if (userText?.trim()) {
      state = this.applyUserSignals(actorId, userText, state);
    }

    const profile = await this.store.read(actorId);
    const maxChars = Number.parseInt(process.env.AGENT_USER_PROFILE_PROMPT_MAX_CHARS ?? "3500", 10);
    const cap = Number.isFinite(maxChars) && maxChars > 400 ? maxChars : 3500;
    const userProfile =
      profile.length > cap ? `…（较早内容已截断）\n${profile.slice(-cap)}` : profile;

    return {
      userProfile,
      toneGuidance: buildToneGuidance(state),
    };
  }

  /** 对话结束后异步更新画像文件与 KV 镜像 */
  observeTurn(actorId: string, userText: string, _assistantText: string): void {
    if (!isUserPersonalizationEnabled()) return;
    void this.observeTurnAsync(actorId, userText).catch(() => {});
  }

  private async observeTurnAsync(actorId: string, userText: string): Promise<void> {
    const patches = extractProfilePatches(userText);
    let md = await this.store.read(actorId);
    if (patches.length > 0) {
      md = applyProfilePatches(md, patches);
    }

    const state = this.loadEmotionState(actorId);
    md = syncPreferredToneInProfile(md, TONE_ZH[state.preferredTone]);
    await this.store.write(actorId, md);
    this.syncProfileKv(actorId, md);

    const everyN = profileLlmEveryNTurns();
    if (everyN > 0 && state.turnCount > 0 && state.turnCount % everyN === 0) {
      await this.refineProfileWithLlm(actorId, userText, md);
    }
  }

  private applyUserSignals(actorId: string, userText: string, state: EmotionState): EmotionState {
    const emotion = detectEmotionFromText(userText);
    let next = pushEmotion(state, emotion);
    const tone = detectPreferredToneFromText(userText);
    if (tone) next = { ...next, preferredTone: tone };
    this.saveEmotionState(actorId, next);
    return next;
  }

  private loadEmotionState(actorId: string): EmotionState {
    if (!this.memory) return defaultEmotionState();
    const { entries } = this.memory.getSnapshot(actorId, [EMOTION_STATE_KEY]);
    return toEmotionState(entries[EMOTION_STATE_KEY]);
  }

  private saveEmotionState(actorId: string, state: EmotionState): void {
    if (!this.memory) return;
    for (let i = 0; i < 8; i++) {
      const { revision } = this.memory.getSnapshot(actorId, [EMOTION_STATE_KEY]);
      const r = this.memory.applyPatch(actorId, revision, [
        { key: EMOTION_STATE_KEY, op: "put", value: state },
      ]);
      if (r.ok) return;
    }
  }

  private syncProfileKv(actorId: string, md: string): void {
    if (!this.memory) return;
    for (let i = 0; i < 8; i++) {
      const { revision } = this.memory.getSnapshot(actorId, [USER_PROFILE_KV_KEY]);
      const r = this.memory.applyPatch(actorId, revision, [
        { key: USER_PROFILE_KV_KEY, op: "put", value: md },
      ]);
      if (r.ok) return;
    }
  }

  private async refineProfileWithLlm(
    actorId: string,
    latestUserText: string,
    currentMd: string,
  ): Promise<void> {
    if (!this.externalChat?.isEnabled()) return;

    const mood = dominantRecentEmotion(this.loadEmotionState(actorId).recent);
    const prompt = [
      "你是用户画像整理助手。根据现有 USER_PROFILE.md 与用户最近一句话，输出更新后的完整 Markdown。",
      "要求：保留原有有效信息；合并重复；不要编造用户未提及的事实；章节保持：基本信息、兴趣与习惯、沟通偏好、备注。",
      `用户最近说：${latestUserText.slice(0, 300)}`,
      `近期情绪倾向（供沟通偏好参考，勿当医疗诊断）：${mood}`,
      "",
      "当前 USER_PROFILE.md：",
      currentMd.slice(-4000),
    ].join("\n");

    let out = "";
    await this.externalChat.streamCompletion(
      `profile-refine:${actorId}:${Date.now()}`,
      { text: prompt },
      (delta) => {
        out += delta;
      },
      undefined,
      {
        ephemeralTurn: true,
        systemPromptOverride:
          "只输出 Markdown 正文，不要代码围栏，不要解释。以 # 用户画像 开头。",
        maxThreadMessages: 1,
        disableThinking: true,
      },
    );

    const trimmed = out.trim();
    if (!trimmed.startsWith("#")) return;
    await this.store.write(actorId, trimmed);
    this.syncProfileKv(actorId, trimmed);
  }
}
