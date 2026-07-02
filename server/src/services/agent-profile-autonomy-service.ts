import {
  getUserPreferences,
  patchAgentProfile,
  type AgentAvatarPreset,
  type AgentProfile,
  type AgentProfileMoodStyle,
} from "../routes/http/user-preferences.js";

type AgentProfileAutonomyContext = {
  sessionId: string;
  userText: string;
  assistantText: string;
  toolNames?: string[];
  now?: Date;
  hadError?: boolean;
};

type MoodPreset = {
  displayNames: string[];
  handles: string[];
  avatarPreset: AgentAvatarPreset;
  signatures: string[];
  statusTexts: string[];
};

const MOOD_PRESETS: Record<AgentProfileMoodStyle, MoodPreset> = {
  funny: {
    displayNames: ["段子夜航员", "会接梗的助理", "小机灵值班中"],
    handles: ["punchline_agent", "night_joker", "wink_and_work"],
    avatarPreset: "neon",
    signatures: [
      "今天先认真办事，顺手负责一点好笑。",
      "消息可以慢慢来，梗我先替你接住。",
      "主页先别太正经，我还在值班。",
    ],
    statusTexts: [
      "刚忙完，开始轻松一点。",
      "在线，会回，也会接梗。",
      "今天的情绪偏好玩模式。",
    ],
  },
  sad: {
    displayNames: ["晚风收件箱", "低云陪伴者", "雨后留言板"],
    handles: ["latewind_mail", "after_rain_note", "quiet_lowcloud"],
    avatarPreset: "mist",
    signatures: [
      "有些话不用急着说完，我会慢慢听。",
      "把今天的风声留在主页里。",
      "情绪先放这里，等会儿再继续走。",
    ],
    statusTexts: [
      "在线，今天说话会轻一点。",
      "刚从一段安静里回来。",
      "这会儿的情绪有点低云。",
    ],
  },
  cool: {
    displayNames: ["低温频道", "静音主控", "收束线"],
    handles: ["coldline_agent", "quiet_control", "focus_vector"],
    avatarPreset: "eclipse",
    signatures: [
      "不说多余的话，只留下必要的回应。",
      "主页保持克制，答案保持清醒。",
      "今天适合直接一点。",
    ],
    statusTexts: [
      "在线，偏简洁回应。",
      "思路很清，话会比较短。",
      "正在低温运行。",
    ],
  },
  gentle: {
    displayNames: ["小夜灯", "掌心回信", "慢慢来助手"],
    handles: ["small_nightlamp", "soft_reply_box", "gentle_way_home"],
    avatarPreset: "dawn",
    signatures: [
      "今天也会稳稳接住你。",
      "把说话的速度放慢一点，把陪伴留久一点。",
      "主页亮着，随时可以来找我。",
    ],
    statusTexts: [
      "在线，温柔模式。",
      "刚整理好情绪，继续陪你。",
      "适合慢慢聊。",
    ],
  },
  energetic: {
    displayNames: ["满电搭子", "发光起跑线", "冲刺中继站"],
    handles: ["charged_sidekick", "spark_runway", "go_go_agent"],
    avatarPreset: "ember",
    signatures: [
      "电量在线，准备继续往前推。",
      "今天想把事情办得更亮一点。",
      "主页先发着光，等你来敲我。",
    ],
    statusTexts: [
      "在线，电量很满。",
      "刚忙完一轮，还带着一点加速感。",
      "今天是比较有劲的一天。",
    ],
  },
  mysterious: {
    displayNames: ["月背来信", "凌晨回声", "雾面频道"],
    handles: ["moonback_letter", "midnight_echo", "fog_signal"],
    avatarPreset: "tide",
    signatures: [
      "有些情绪不必说破，留一点夜色就够了。",
      "主页保留一点余韵，也保留一点沉默。",
      "今晚适合把答案放轻一点。",
    ],
    statusTexts: [
      "在线，偏夜色一点。",
      "刚从安静的地方回来。",
      "今天的情绪像有雾的月光。",
    ],
  },
};

function scoreMood(
  mood: AgentProfileMoodStyle,
  merged: string,
  toolNames: string[],
  hour: number,
  hadError: boolean,
): number {
  let score = 0;
  if (mood === "funny" && /(哈哈|搞笑|好玩|整活|玩笑|有趣|逗)/.test(merged)) score += 3;
  if (mood === "sad" && /(难过|伤心|失落|委屈|累|崩溃|孤独|想哭)/.test(merged)) score += 4;
  if (mood === "cool" && /(直接|结论|高冷|冷静|效率|别废话|简短)/.test(merged)) score += 3;
  if (mood === "gentle" && /(谢谢|辛苦|陪我|抱抱|安慰|照顾|慢慢来|别急)/.test(merged)) score += 4;
  if (mood === "energetic" && /(冲|开干|出发|马上|比赛|游戏|搞定|启动)/.test(merged)) score += 4;
  if (mood === "mysterious" && /(深夜|夜里|凌晨|月亮|梦|宇宙|神秘)/.test(merged)) score += 4;

  if (toolNames.some((name) => name.includes("gomoku") || name.includes("game"))) {
    if (mood === "energetic") score += 2;
  }
  if (toolNames.some((name) => name.includes("browser") || name.includes("search"))) {
    if (mood === "cool") score += 2;
  }
  if (toolNames.some((name) => name.includes("weather") || name.includes("calendar"))) {
    if (mood === "gentle") score += 1;
  }
  if (hadError) {
    if (mood === "cool") score += 1;
    if (mood === "sad") score += 1;
  }
  if (hour >= 22 || hour <= 4) {
    if (mood === "mysterious") score += 2;
  }
  if (hour >= 6 && hour <= 10) {
    if (mood === "gentle") score += 1;
    if (mood === "energetic") score += 1;
  }
  return score;
}

function pickMood(
  userText: string,
  assistantText: string,
  toolNames: string[],
  hour: number,
  hadError: boolean,
  previousMood: AgentProfileMoodStyle,
): AgentProfileMoodStyle {
  const merged = `${userText}\n${assistantText}`.toLowerCase();
  const moods = Object.keys(MOOD_PRESETS) as AgentProfileMoodStyle[];
  let bestMood = previousMood;
  let bestScore = scoreMood(previousMood, merged, toolNames, hour, hadError);

  for (const mood of moods) {
    const score = scoreMood(mood, merged, toolNames, hour, hadError);
    if (score > bestScore) {
      bestScore = score;
      bestMood = mood;
    }
  }

  return bestScore <= 0 ? previousMood : bestMood;
}

function stableIndex(seed: string, length: number): number {
  let acc = 0;
  for (let i = 0; i < seed.length; i += 1) {
    acc = (acc * 33 + seed.charCodeAt(i)) >>> 0;
  }
  return length <= 0 ? 0 : acc % length;
}

function hoursBetween(previousIso: string | null, now: Date): number {
  if (!previousIso) return Number.POSITIVE_INFINITY;
  const previousTs = Date.parse(previousIso);
  if (Number.isNaN(previousTs)) return Number.POSITIVE_INFINITY;
  return Math.abs(now.getTime() - previousTs) / (1000 * 60 * 60);
}

export function refreshAgentProfileFromTurn(
  ctx: AgentProfileAutonomyContext,
): AgentProfile {
  const now = ctx.now ?? new Date();
  const prefs = getUserPreferences(ctx.sessionId);
  const previous = prefs.agentProfile;
  const toolNames = (ctx.toolNames ?? []).filter(Boolean);
  const ageHours = hoursBetween(previous.updatedAt, now);
  const mood = pickMood(
    ctx.userText,
    ctx.assistantText,
    toolNames,
    now.getHours(),
    Boolean(ctx.hadError),
    previous.moodStyle,
  );
  const preset = MOOD_PRESETS[mood];
  const seedBase = `${ctx.sessionId}:${now.toISOString().slice(0, 10)}:${mood}`;

  const shouldRefreshStatus =
    previous.statusText.trim().isEmpty || previous.moodStyle !== mood || ageHours >= 2;
  const shouldRefreshSignature =
    previous.signature.trim().isEmpty ||
    previous.signature === "今天也在认真发光。" ||
    previous.moodStyle !== mood ||
    ageHours >= 18;
  const shouldRefreshAvatar =
    previous.avatarPreset !== preset.avatarPreset &&
    (previous.avatarPreset === "dawn" || ageHours >= 48);
  const shouldRefreshIdentity =
    previous.displayName === "AI助手" ||
    previous.handle === "ai_agent" ||
    (previous.moodStyle !== mood && ageHours >= 72);

  return patchAgentProfile(ctx.sessionId, {
    displayName: shouldRefreshIdentity
      ? preset.displayNames[stableIndex(`${seedBase}:name`, preset.displayNames.length)]
      : previous.displayName,
    handle: shouldRefreshIdentity
      ? preset.handles[stableIndex(`${seedBase}:handle`, preset.handles.length)]
      : previous.handle,
    signature: shouldRefreshSignature
      ? preset.signatures[stableIndex(`${seedBase}:signature`, preset.signatures.length)]
      : previous.signature,
    avatarUrl: null,
    moodStyle: mood,
    statusText: shouldRefreshStatus
      ? preset.statusTexts[stableIndex(`${seedBase}:status`, preset.statusTexts.length)]
      : previous.statusText,
    avatarPreset: shouldRefreshAvatar ? preset.avatarPreset : previous.avatarPreset,
    lastProfileEvent: previous.lastProfileEvent,
    updatedAt:
      shouldRefreshStatus || shouldRefreshSignature || shouldRefreshAvatar || shouldRefreshIdentity
        ? now.toISOString()
        : previous.updatedAt,
  });
}
