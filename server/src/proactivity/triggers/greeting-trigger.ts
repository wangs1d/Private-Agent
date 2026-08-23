// ProactivityHub —— 时段问候触发器
//
// 周期 tick 检查：早安（7-10 点且 >10h 未聊）、久别重逢（>48h 未聊）。
// importance=low（最低打扰档），由频控的 24h 冷却保证每天最多一次问候。
import type { ProactiveIntent } from "../proactivity-types.js";

export type GreetingKind = "morning" | "long_absence";

export type GreetingJudgement = {
  kind: GreetingKind;
  title: string;
  summary: string;
};

const MORNING_WINDOW_START = 7;
const MORNING_WINDOW_END = 10;
const MORNING_SILENCE_MS = 10 * 60 * 60 * 1000;   // 早安：>10h 未聊才发（刚聊过就问好很怪）
const LONG_ABSENCE_MS = 48 * 60 * 60 * 1000;      // 久别：>48h 未聊

/**
 * 判定当前是否值得发问候。
 * @param lastInteractionAt 最近一次用户交互时间戳（ms）；null 表示从未聊过（首轮对话不发问候）
 */
export function judgeGreeting(
  lastInteractionAt: number | null,
  now: Date = new Date(),
): GreetingJudgement | null {
  if (lastInteractionAt === null) return null; // 从未交互过：等用户先开口，不冷启动打扰
  const silenceMs = now.getTime() - lastInteractionAt;
  if (silenceMs < MORNING_SILENCE_MS) return null;

  const hour = now.getHours();
  if (silenceMs >= LONG_ABSENCE_MS) {
    return {
      kind: "long_absence",
      title: "好久没和用户聊天了，可以主动问候近况",
      summary: `距上次对话已超过 ${Math.floor(silenceMs / 3600000)} 小时。像老朋友久别重逢，自然问一句近况，别查户口。`,
    };
  }
  if (hour >= MORNING_WINDOW_START && hour < MORNING_WINDOW_END) {
    return {
      kind: "morning",
      title: "早上好时段到了，可以自然问个早",
      summary: "现在是一天开始（7-10 点）且昨晚之后没聊过。自然问个早即可，别加日程播报。",
    };
  }
  return null;
}

export function buildGreetingIntent(actorId: string, judgement: GreetingJudgement): ProactiveIntent {
  return {
    actorId,
    kind: "greeting",
    importance: "low",
    title: judgement.title,
    summary: judgement.summary,
    mode: "speak",
    source: "time",
  };
}
