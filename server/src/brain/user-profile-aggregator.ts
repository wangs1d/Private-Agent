/**
 * 用户画像聚合器（User Profile Aggregator）
 *
 * 目标：让 agent 真正"越来越了解用户"。
 *
 * 现状问题：
 *   - data/user_profiles/{actorId}/USER_PROFILE.md 只读不写，画像永远是初始模板；
 *   - OnlineLearningCortex 纯规则画像只存内存（重启即失），且关键词匹配太浅；
 *   - KV user_profile（agent/USER.md 播种）同样静态。
 *
 * 设计（以 USER_PROFILE.md 为唯一画像事实源，动态更新读取）：
 *   1. 快速路径（纯规则，每轮）：观察每轮对话，识别"强画像信号"
 *      （记住/我喜欢/我叫/我是/我在/我讨厌…），立即增量追加到 USER_PROFILE.md
 *      对应 section——用户说"记住我对花生过敏"下一轮就生效。
 *   2. 深度路径（LLM，低频）：每 N 轮（默认 12）或距上次合成超过 30 分钟时，
 *      把【现有画像 + OnlineLearningCortex 规则增量 + 最近对话轮】交给 LLM 融合，
 *      输出更新后的完整画像 markdown 写回文件——规则抓不准的隐性偏好
 *      （语气、专业度、决策习惯）由 LLM 提炼。
 *   3. 巩固钩子：MemoryManager.consolidateNow 完成后（夜间 dreaming / 白天 idle）
 *      触发一次深度合成，让"记忆整理"同时反哺画像。
 *
 * 安全约束：
 *   - LLM 失败静默降级（画像保持旧版，不影响主链路）；
 *   - 画像文件保持既定 markdown 结构（基本信息/兴趣与习惯/沟通偏好/备注），
 *     UserPersonalizationService.getPromptSlice 的消费格式不变；
 *   - 单 actor 同一时刻仅一个合成在跑（in-flight 去重）。
 */

import OpenAI from "openai";

import { resolvePrimaryLlmClientConfig, bypassChatRequestExtras } from "../external-model/resolve-provider.js";
import { UserProfileStore } from "../services/user-personalization/user-profile-store.js";

/** 规则画像的最小接口（OnlineLearningCortex 子集，避免硬依赖） */
export interface OnlineLearningLike {
  getProfile(actorId: string): {
    preferences: Array<{ key: string; value: string; stability: number }>;
    habits: Array<{ key: string; value: string; stability: number }>;
    taboos: Array<{ key: string; value: string; stability: number }>;
    topics: string[];
    totalObservations: number;
  };
}

export interface ProfileAggregatorConfig {
  enabled: boolean;
  /** 每 N 轮触发一次 LLM 深度合成 */
  synthesisTurnThreshold: number;
  /** 距上次合成超过该毫秒数才允许再次合成 */
  minSynthesisIntervalMs: number;
  model: string;
  maxTokens: number;
}

function parseIntEnv(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function parseFloatEnv(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const n = parseFloat(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function loadProfileAggregatorConfig(): ProfileAggregatorConfig {
  const enabledRaw = process.env.MEMORY_PROFILE_AGGREGATOR_ENABLED;
  return {
    enabled:
      enabledRaw === undefined ? true : !(enabledRaw === "0" || enabledRaw.toLowerCase() === "false"),
    synthesisTurnThreshold: parseIntEnv(process.env.MEMORY_PROFILE_SYNTHESIS_TURNS, 12),
    minSynthesisIntervalMs: parseFloatEnv(process.env.MEMORY_PROFILE_SYNTHESIS_INTERVAL_MS, 30 * 60 * 1000),
    model:
      process.env.MEMORY_PROFILE_SYNTHESIS_MODEL?.trim() ||
      resolvePrimaryLlmClientConfig()?.model ||
      "gpt-4.1-mini",
    maxTokens: parseIntEnv(process.env.MEMORY_PROFILE_SYNTHESIS_MAX_TOKENS, 1200),
  };
}

/** 强画像信号 → 目标 section（快速路径用） */
const STRONG_SIGNAL_RULES: Array<{
  re: RegExp;
  section: "basic" | "interest" | "communication" | "note";
  template: (captured: string) => string;
}> = [
  { re: /(?:记住|请记住)[:：]?\s*(.{2,40})/, section: "note", template: (c) => c },
  { re: /(?:我叫|我的名字[是叫])\s*([^\s，。！？]{1,20})/, section: "basic", template: (c) => `称呼：${c}` },
  { re: /(?:我在|我住在|我位于)\s*([^\s，。！？]{2,20})/, section: "basic", template: (c) => `所在地：${c}` },
  { re: /我(?:很)?喜欢\s*([^\s，。！？]{2,30})/, section: "interest", template: (c) => `喜欢：${c}` },
  { re: /我(?:很)?讨厌\s*([^\s，。！？]{2,30})/, section: "interest", template: (c) => `讨厌：${c}` },
  { re: /我(?:不|不太)喜欢\s*([^\s，。！？]{2,30})/, section: "interest", template: (c) => `不喜欢：${c}` },
  { re: /我是做\s*([^\s，。！？]{2,20})(?:的|工作)?/, section: "basic", template: (c) => `职业：${c}` },
  { re: /我(?:正在|在)学\s*([^\s，。！？]{2,20})/, section: "interest", template: (c) => `正在学习：${c}` },
  { re: /(?:回复|回答)(?:要|请)(?:再)?(短一点|简洁|详细|口语化|正式)/, section: "communication", template: (c) => `回复偏好：${c}` },
];

/** 画像 md 的 section 标题（与 UserProfileStore 默认模板一致） */
const SECTION_HEADINGS: Record<string, { basic: string; interest: string; communication: string; note: string }> = {
  zh: {
    basic: "## 基本信息",
    interest: "## 兴趣与习惯",
    communication: "## 沟通偏好",
    note: "## 备注",
  },
};

/** 把一条信号追加进画像 markdown 的对应 section（无该 section 时追加到末尾） */
function appendLineToProfileSection(profile: string, section: keyof typeof SECTION_HEADINGS.zh, line: string): string {
  const heading = SECTION_HEADINGS.zh[section];
  const clean = line.trim();
  if (!clean) return profile;
  // 幂等：已有相同行则跳过
  if (profile.includes(clean)) return profile;
  const lines = profile.split("\n");
  const headingIdx = lines.findIndex((l) => l.trim() === heading);
  if (headingIdx < 0) {
    // 无该 section：追加到末尾
    return `${profile.replace(/\s+$/, "")}\n\n${heading}\n\n- ${clean}\n`;
  }
  // 找 section 末尾（下一个 ## 或文件尾）
  let insertIdx = lines.length;
  for (let i = headingIdx + 1; i < lines.length; i++) {
    if (/^##\s/.test(lines[i].trim())) {
      insertIdx = i;
      break;
    }
  }
  lines.splice(insertIdx, 0, `- ${clean}`);
  return lines.join("\n");
}

/** 规则画像 → 供 LLM 的文本块（只取 stability 较高的稳定条目） */
function formatOnlineLearningForPrompt(profile: OnlineLearningLike["getProfile"] extends never ? never : ReturnType<OnlineLearningLike["getProfile"]>): string {
  const parts: string[] = [];
  const fmt = (list: Array<{ key: string; value: string; stability: number }>, label: string) => {
    const stable = list.filter((e) => e.stability >= 0.35).slice(0, 8);
    if (stable.length > 0) {
      parts.push(`${label}: ${stable.map((e) => `${e.key}=${e.value}(${(e.stability * 100).toFixed(0)}%)`).join("；")}`);
    }
  };
  fmt(profile.preferences, "偏好");
  fmt(profile.habits, "习惯");
  fmt(profile.taboos, "禁忌");
  if (profile.topics.length > 0) {
    parts.push(`近期关注话题: ${profile.topics.slice(0, 8).join("、")}`);
  }
  parts.push(`累计观察轮数: ${profile.totalObservations}`);
  return parts.join("\n");
}

function buildSynthesisMessages(
  currentProfile: string,
  onlineLearningBlock: string,
  recentTurns: string,
): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
  const system = [
    "你是用户画像维护器。根据「现有画像」「规则引擎提取的画像信号」「最近对话轮」，输出更新后的完整用户画像 markdown。",
    "",
    "要求：",
    "1. 保持 markdown 结构：# 用户画像 标题 + ## 基本信息 / ## 兴趣与习惯 / ## 沟通偏好 / ## 备注 四个 section；",
    "2. 只在有足够置信度时写入新信息（用户明确表达过，或多次出现）；冲突时以最新信息为准（人会改变）；",
    "3. 删除已被新信息取代的旧条目和过期的「（待了解）」占位符；",
    "4. 从对话中提炼隐性偏好：语气偏好、专业领域深度、决策风格、常用语言、活跃时段；",
    "5. 每条信息一行，以「- 」开头，精炼不啰嗦；不要编造对话中没有的依据；",
    "6. 画像开头保留一行引用块：`> 本文件由 Agent 在与你的对话中持续更新。最后更新：{ISO时间}`；",
    "7. 直接输出 markdown 全文，不要任何解释或代码围栏。",
  ].join("\n");
  const user = [
    "【现有画像】",
    currentProfile || "（空，首次生成）",
    "",
    "【规则引擎画像信号】",
    onlineLearningBlock || "（无）",
    "",
    "【最近对话轮（供提炼隐性偏好）】",
    recentTurns || "（无）",
    "",
    "请输出更新后的完整画像 markdown：",
  ].join("\n");
  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}

/** 容错提取 LLM 输出中的 markdown 正文（去围栏） */
function cleanProfileMarkdownOutput(output: string): string {
  let text = output.trim();
  text = text.replace(/^```(?:markdown|md)?\s*/i, "").replace(/```\s*$/, "");
  // 必须看起来像画像（含二级标题），否则视为无效输出
  if (!/^#\s*用户画像/m.test(text) || !/##\s/.test(text)) return "";
  return text.trim();
}

export class UserProfileAggregator {
  private readonly store = new UserProfileStore();
  private readonly config: ProfileAggregatorConfig;
  private readonly client: OpenAI | null;
  private onlineLearning: OnlineLearningLike | null = null;

  /** actorId → 自上次深度合成以来的轮计数 */
  private readonly turnCounters = new Map<string, number>();
  /** actorId → 最近轮文本环形缓冲（供 LLM 合成，最多 12 轮） */
  private readonly recentTurns = new Map<string, string[]>();
  /** actorId → 上次深度合成时间戳 */
  private readonly lastSynthesisAt = new Map<string, number>();
  /** in-flight 深度合成去重 */
  private readonly synthesizing = new Set<string>();

  constructor(config?: Partial<ProfileAggregatorConfig>, apiKey?: string) {
    this.config = { ...loadProfileAggregatorConfig(), ...config };
    const llm = resolvePrimaryLlmClientConfig();
    const key = apiKey?.trim() || llm?.apiKey?.trim() || process.env.OPENAI_API_KEY?.trim();
    this.client = key ? new OpenAI(llm?.baseURL?.trim() ? { apiKey: key, baseURL: llm.baseURL.trim() } : { apiKey: key }) : null;
  }

  /** 是否具备 LLM 深度合成能力（无 key 时只剩快速路径） */
  get canSynthesize(): boolean {
    return this.client !== null;
  }

  /** 注入规则画像源（OnlineLearningCortex） */
  registerOnlineLearning(svc: OnlineLearningLike | null): void {
    this.onlineLearning = svc;
  }

  /**
   * 每轮 cognize 完成后调用（brain-center 阶段 3 后置）。
   * - 快速路径：强信号立即追加进画像文件；
   * - 计数达到阈值时异步触发 LLM 深度合成（不阻塞调用方）。
   */
  observeTurn(actorId: string, userText: string, assistantText: string): void {
    if (!this.config.enabled) return;
    const user = (userText ?? "").trim();
    const assistant = (assistantText ?? "").trim();
    if (!user && !assistant) return;

    // 1. 强画像信号 → 快速路径立即落盘
    if (user) {
      void this.applyStrongSignals(actorId, user).catch(() => {
        /* 快速路径失败静默，等深度合成兜底 */
      });
    }

    // 2. 累积轮缓冲 + 计数
    const turns = this.recentTurns.get(actorId) ?? [];
    turns.push(`用户: ${user.slice(0, 200)}\n助手: ${assistant.slice(0, 200)}`);
    if (turns.length > 12) turns.shift();
    this.recentTurns.set(actorId, turns);

    const count = (this.turnCounters.get(actorId) ?? 0) + 1;
    this.turnCounters.set(actorId, count);

    // 3. 达到阈值 → 异步深度合成
    if (count >= this.config.synthesisTurnThreshold) {
      this.turnCounters.set(actorId, 0);
      void this.synthesizeDeepProfile(actorId).catch(() => {
        /* 深度合成失败静默降级 */
      });
    }
  }

  /** 深度合成外部触发口（MemoryManager 巩固完成后调用） */
  triggerSynthesis(actorId: string): void {
    if (!this.config.enabled) return;
    void this.synthesizeDeepProfile(actorId).catch(() => {
      /* 静默 */
    });
  }

  /** 强画像信号快速路径：识别 + 追加到画像文件 */
  private async applyStrongSignals(actorId: string, userText: string): Promise<void> {
    const signals: Array<{ section: keyof typeof SECTION_HEADINGS.zh; line: string }> = [];
    for (const rule of STRONG_SIGNAL_RULES) {
      const m = userText.match(rule.re);
      if (m?.[1]) {
        const line = rule.template(m[1].trim());
        if (line) signals.push({ section: rule.section, line });
      }
    }
    if (signals.length === 0) return;

    let profile = await this.store.read(actorId);
    let changed = false;
    for (const sig of signals.slice(0, 3)) {
      const next = appendLineToProfileSection(profile, sig.section, sig.line);
      if (next !== profile) {
        profile = next;
        changed = true;
      }
    }
    if (changed) {
      await this.store.write(actorId, profile);
      console.log(`[ProfileAggregator] 强信号快速路径更新画像: ${actorId} (+${signals.length} 条)`);
    }
  }

  /**
   * LLM 深度画像合成：现有画像 + 规则增量 + 最近轮 → 更新后的画像 markdown。
   * in-flight 去重 + 最小间隔控制；失败静默保持旧画像。
   */
  async synthesizeDeepProfile(actorId: string): Promise<boolean> {
    if (!this.config.enabled || !this.client) return false;
    if (this.synthesizing.has(actorId)) return false;

    const last = this.lastSynthesisAt.get(actorId) ?? 0;
    if (Date.now() - last < this.config.minSynthesisIntervalMs) return false;

    this.synthesizing.add(actorId);
    try {
      const currentProfile = await this.store.read(actorId);
      const onlineBlock = this.onlineLearning
        ? formatOnlineLearningForPrompt(this.onlineLearning.getProfile(actorId))
        : "";
      const recentTurns = (this.recentTurns.get(actorId) ?? []).join("\n\n");

      const messages = buildSynthesisMessages(currentProfile, onlineBlock, recentTurns);
      const response = await this.client.chat.completions.create({
        model: this.config.model,
        temperature: 0.2,
        max_tokens: this.config.maxTokens,
        messages,
        ...bypassChatRequestExtras(),
      });
      const content = response.choices[0]?.message?.content?.trim();
      if (content) {
        const { recordLlmUsageByChars } = await import("../services/llm-token-audit.js");
        recordLlmUsageByChars({
          stage: "user_profile_aggregate",
          inputChars: JSON.stringify(messages).length,
          outputChars: content.length,
          model: this.config.model,
        });
      }
      if (!content) return false;

      const cleaned = cleanProfileMarkdownOutput(content);
      if (!cleaned) {
        console.warn("[ProfileAggregator] LLM 输出不符合画像格式，保持旧画像");
        return false;
      }

      await this.store.write(actorId, cleaned);
      this.lastSynthesisAt.set(actorId, Date.now());
      this.recentTurns.set(actorId, []); // 已消费的轮清空
      console.log(`[ProfileAggregator] 深度画像合成完成: ${actorId} (${cleaned.length} chars)`);
      return true;
    } catch (err) {
      console.warn(
        `[ProfileAggregator] LLM 深度画像合成失败（保持旧画像）: ${err instanceof Error ? err.message : err}`,
      );
      return false;
    } finally {
      this.synthesizing.delete(actorId);
    }
  }

  /** 诊断：当前累积状态 */
  getStats(actorId: string): {
    turnsSinceSynthesis: number;
    bufferedTurns: number;
    lastSynthesisAt: string | null;
    canSynthesize: boolean;
  } {
    return {
      turnsSinceSynthesis: this.turnCounters.get(actorId) ?? 0,
      bufferedTurns: (this.recentTurns.get(actorId) ?? []).length,
      lastSynthesisAt: this.lastSynthesisAt.has(actorId)
        ? new Date(this.lastSynthesisAt.get(actorId)!).toISOString()
        : null,
      canSynthesize: this.canSynthesize,
    };
  }
}

/** 工厂：始终返回实例（无 key 时退化为纯快速路径） */
export function createUserProfileAggregator(): UserProfileAggregator {
  return new UserProfileAggregator();
}
