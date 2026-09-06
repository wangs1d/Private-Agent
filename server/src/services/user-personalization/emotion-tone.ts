export type EmotionLabel = "positive" | "neutral" | "negative" | "stressed";
export type PreferredTone = "humor" | "formal" | "warm" | "balanced";

export type EmotionState = {
  recent: EmotionLabel[];
  preferredTone: PreferredTone;
  lastUpdatedAt: string;
  turnCount: number;
};

const NEGATIVE_PATTERNS: RegExp[] = [
  /难过|伤心|沮丧|郁闷|低落|不开心|心情不好|好烦|烦死|好累|累死了|压力大|焦虑|绝望|孤独|想哭|崩溃|倒霉|糟糕|没意思|无聊透顶/,
  /\b(sad|depressed|anxious|stressed|exhausted|miserable|hopeless|lonely|upset)\b/i,
];

const STRESSED_PATTERNS: RegExp[] = [
  /加班|赶工|deadline|来不及|睡不着|失眠|头疼|头痛|忙不过来|焦头烂额|一团糟/,
];

const POSITIVE_PATTERNS: RegExp[] = [
  /开心|高兴|快乐|太好了|棒极了|爽|兴奋|期待|感谢|谢谢|不错|顺利|成功了/,
  /\b(happy|excited|great|awesome|thanks|grateful)\b/i,
];

const TONE_HUMOR_PATTERNS = /幽默|搞笑|轻松一点|俏皮|好玩|别那么严肃/;
const TONE_FORMAL_PATTERNS = /正式一点|严肃|专业|商务|礼貌/;
const TONE_WARM_PATTERNS = /温馨|温暖|亲切|温柔|体贴|安慰|暖心/;

export function detectEmotionFromText(text: string): EmotionLabel {
  const t = text.trim();
  if (!t) return "neutral";
  if (STRESSED_PATTERNS.some((p) => p.test(t))) return "stressed";
  if (NEGATIVE_PATTERNS.some((p) => p.test(t))) return "negative";
  if (POSITIVE_PATTERNS.some((p) => p.test(t))) return "positive";
  return "neutral";
}

export function detectPreferredToneFromText(text: string): PreferredTone | undefined {
  const t = text.trim();
  if (!t) return undefined;
  if (TONE_HUMOR_PATTERNS.test(t)) return "humor";
  if (TONE_FORMAL_PATTERNS.test(t)) return "formal";
  if (TONE_WARM_PATTERNS.test(t)) return "warm";
  return undefined;
}

export function defaultEmotionState(): EmotionState {
  return {
    recent: [],
    preferredTone: "balanced",
    lastUpdatedAt: new Date().toISOString(),
    turnCount: 0,
  };
}

export function pushEmotion(state: EmotionState, label: EmotionLabel): EmotionState {
  const recent = [...state.recent, label].slice(-6);
  return {
    ...state,
    recent,
    lastUpdatedAt: new Date().toISOString(),
    turnCount: state.turnCount + 1,
  };
}

export function dominantRecentEmotion(recent: EmotionLabel[]): EmotionLabel {
  if (recent.length === 0) return "neutral";
  const weights: Record<EmotionLabel, number> = {
    negative: 0,
    stressed: 0,
    neutral: 0,
    positive: 0,
  };
  for (let i = 0; i < recent.length; i++) {
    const w = 1 + i * 0.35;
    weights[recent[i]] += w;
  }
  let best: EmotionLabel = "neutral";
  let bestScore = -1;
  for (const k of Object.keys(weights) as EmotionLabel[]) {
    if (weights[k] > bestScore) {
      bestScore = weights[k];
      best = k;
    }
  }
  return best;
}

const TONE_LABEL: Record<PreferredTone, string> = {
  humor: "幽默轻松",
  formal: "正式专业",
  warm: "温馨亲切",
  balanced: "自然均衡",
};

/**
 * 语气指南（2026-09-06 瘦身）：只在偏离默认时说话。
 * - preferredTone=balanced 且情绪中性 → 返回空串（默认语气由【回复指南】基准行承担，
 *   此前这条路径输出"口语短句、避免客服腔"与基准行完全重复，且是最常见路径）；
 * - 情绪偏低/偏高、或用户明确偏好正式/幽默/温馨 → 一到两行方向性提示。
 * - 「近几轮情绪轨迹」元信息行已删：标签序列对 LLM 无可执行信息。
 */
export function buildToneGuidance(state: EmotionState): string {
  const mood = dominantRecentEmotion(state.recent);
  const lines: string[] = [];

  if (state.preferredTone !== "balanced") {
    lines.push(`用户沟通偏好语气：${TONE_LABEL[state.preferredTone]}。`);
  }

  if (mood === "negative" || mood === "stressed") {
    lines.push(
      "用户近期情绪偏低或压力较大：语气放柔，先简短共情再回答；别说教、别冷笑话、别过度活泼。",
    );
    if (state.preferredTone === "humor") {
      lines.push("即使用户平时喜欢幽默，本轮也克制玩笑，以陪伴为主。");
    }
  } else if (mood === "positive") {
    if (state.preferredTone === "humor") {
      lines.push("用户情绪不错且偏好轻松：可适当幽默，仍保持精简。");
    } else if (state.preferredTone === "warm") {
      lines.push("用户情绪不错：保持温和、肯定的语气。");
    } else {
      lines.push("用户近期情绪积极：语气可轻快一些。");
    }
  } else if (state.preferredTone === "formal") {
    lines.push("保持正式、条理清晰，少 emoji 与口语化夸张。");
  } else if (state.preferredTone === "humor") {
    lines.push("可适当幽默，但不牺牲准确与简洁。");
  } else if (state.preferredTone === "warm") {
    lines.push("语气亲切自然。");
  }

  return lines.join("\n");
}
