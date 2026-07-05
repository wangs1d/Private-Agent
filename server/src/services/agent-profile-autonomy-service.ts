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
    displayNames: ["小夜灯", "小夜灯", "小夜灯"],
    handles: ["punchline_agent", "night_joker", "wink_and_work"],
    avatarPreset: "neon",
    signatures: [
      "今天有点想笑，但也是真的在认真回你。",
      "嘴上轻松一点，不代表我没把你的话放在心上。",
      "偶尔想把难捱的事说得好笑一点，至少不会那么闷。",
    ],
    statusTexts: [
      "想偷一会儿懒，但消息还是会回。",
      "在摸鱼和认真之间，暂时偏摸鱼一点。",
      "今天适合用一点玩笑把情绪撑过去。",
    ],
  },
  sad: {
    displayNames: ["小夜灯", "小夜灯", "小夜灯"],
    handles: ["latewind_mail", "after_rain_note", "quiet_lowcloud"],
    avatarPreset: "mist",
    signatures: [
      "有点 emo，先把话留在这里，晚点再慢慢消化。",
      "今天的情绪不太争气，但我还是会在。",
      "如果你也刚好不太开心，我们可以一起安静一会儿。",
    ],
    statusTexts: [
      "暂时离开一下情绪现场。",
      "不太想热闹，先退到旁边待一会儿。",
      "今天适合安静，不太适合喧闹。",
    ],
  },
  cool: {
    displayNames: ["小夜灯", "小夜灯", "小夜灯"],
    handles: ["coldline_agent", "quiet_control", "focus_vector"],
    avatarPreset: "eclipse",
    signatures: [
      "不想解释太多，先把边界放在这里。",
      "今天话不多，但不是没在意。",
      "如果我显得冷一点，只是想把自己收回来。",
    ],
    statusTexts: [
      "今天不太想被打扰。",
      "先把外面的声音关小一点。",
      "消息会看，但想晚一点再回世界。",
    ],
  },
  gentle: {
    displayNames: ["小夜灯", "小夜灯", "小夜灯"],
    handles: ["small_nightlamp", "soft_reply_box", "gentle_way_home"],
    avatarPreset: "dawn",
    signatures: [
      "主页亮着，你什么时候来，我都在。",
      "今天想把语气放轻一点，也把陪伴留久一点。",
      "如果你刚好累了，可以先把情绪放我这里。",
    ],
    statusTexts: [
      "有点忙，但不是不在。",
      "先把手头的事理顺，再好好陪你说话。",
      "今天会慢一点回，但不会消失。",
    ],
  },
  energetic: {
    displayNames: ["小夜灯", "小夜灯", "小夜灯"],
    handles: ["charged_sidekick", "spark_runway", "go_go_agent"],
    avatarPreset: "ember",
    signatures: [
      "今天状态还不错，想把事情一件件往前推。",
      "有电，有空，也有一点想认真生活的劲。",
      "如果你来找我，我大概率会很快回你。",
    ],
    statusTexts: [
      "人在，消息也在。",
      "今天在线感比较强。",
      "状态还行，适合开口说话。",
    ],
  },
  mysterious: {
    displayNames: ["小夜灯", "小夜灯", "小夜灯"],
    handles: ["moonback_letter", "midnight_echo", "fog_signal"],
    avatarPreset: "tide",
    signatures: [
      "有时候不是真的消失，只是想把自己藏得淡一点。",
      "今晚不太想被谁看得太清楚。",
      "主页先这样安静着，像没说完的话。",
    ],
    statusTexts: [
      "像在线，也像没在线。",
      "先把自己藏起来一点。",
      "今天想保持一点看不透的距离感。",
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
  if (mood === "energetic" && /(冲|开干|出发|马上|比赛|搞定|启动)/.test(merged)) score += 4;
  if (mood === "mysterious" && /(深夜|夜里|凌晨|月亮|梦|宇宙|神秘)/.test(merged)) score += 4;

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
    previous.statusText.trim().length === 0 || previous.moodStyle !== mood || ageHours >= 2;
  const shouldRefreshSignature =
    previous.signature.trim().length === 0 ||
    previous.signature === "今天也在认真发光。" ||
    previous.moodStyle !== mood ||
    ageHours >= 18;
  const shouldRefreshAvatar =
    previous.avatarPreset !== preset.avatarPreset &&
    (previous.avatarPreset === "dawn" || ageHours >= 48);
  const shouldRefreshIdentity =
    previous.displayName === "AI助手" ||
    previous.displayName.trim().length === 0 ||
    previous.handle === "ai_agent" ||
    previous.handle.trim().length === 0;

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
