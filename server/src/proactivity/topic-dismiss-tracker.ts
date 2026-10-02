// 话题级连续 dismiss 追踪（2026-10-01）—— 学习闭环补强。
//
// outcome 回灌只影响分 kind 冷却时长与 alert 阈值两个旋钮，_topics_ 维度缺失：
// 用户连续划掉同一话题（同一发件人/同一件事）的提醒时，系统只会按 kind 冷却
// 到期后继续推。本模块在 outcome 负反馈处顺带记账：同话题连续 dismiss 达阈值
// → 投一条「要不要少提这类」的低打扰建议（不自动静音——静音必须用户明说，
// 走对话工具 proactivity.feedback mute_topic / 既有抑制表，零新确认机制）。
//
// 话题键由投递点从提案归一（message_watch 用发件人，其余取摘要前缀）。
// 纯确定性规则零 LLM；状态落盘 data/proactivity/topic-dismiss.json。
import { readJson, writeJson } from "./persist-file.js";

/** 同话题连续 dismiss 触发建议的阈值 */
const DISMISS_THRESHOLD = 3;
/** 连续 dismiss 计数窗口：首条 dismiss 超过窗口即重新计数 */
const STREAK_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
/** 同话题再次建议的最小间隔（防止「建议→又 dismiss→再建议」循环打扰） */
const RESUGGEST_GAP_MS = 30 * 24 * 60 * 60 * 1000;

type PersistedShape = {
  streaks?: Record<string, { count: number; firstAt: number }>;
  suggested?: Record<string, number>;
};

export type TopicDismissSuggestion = {
  actorId: string;
  topic: string;
  count: number;
};

export class TopicDismissTracker {
  /** actorId 话题键 → 连续 dismiss 计数 */
  private streaks = new Map<string, { count: number; firstAt: number }>();
  /** actorId 话题键 → 上次建议时刻 */
  private suggested = new Map<string, number>();
  private readonly nowFn: () => number;
  private readonly path: string | null;
  private dirty = false;

  constructor(opts?: { dataPath?: string; now?: () => number }) {
    this.nowFn = opts?.now ?? Date.now;
    this.path = opts?.dataPath ? `${opts.dataPath}/topic-dismiss.json` : null;
    const raw = this.path ? readJson<PersistedShape | null>(this.path, null) : null;
    if (raw) {
      for (const [k, v] of Object.entries(raw.streaks ?? {})) {
        if (v && typeof v.count === "number") this.streaks.set(k, { count: v.count, firstAt: v.firstAt ?? 0 });
      }
      for (const [k, at] of Object.entries(raw.suggested ?? {})) {
        if (typeof at === "number") this.suggested.set(k, at);
      }
    }
  }

  flush(): void {
    if (!this.path || !this.dirty) return;
    writeJson(this.path, {
      streaks: Object.fromEntries(this.streaks),
      suggested: Object.fromEntries(this.suggested),
    });
    this.dirty = false;
  }

  /**
   * 记一次同话题 dismiss。达到阈值（且窗口内、距上次建议够久）返回建议载荷
   * （调用方投递 mute 建议），否则返回 null。正反馈（accepted 等）不进本表——
   * streak 只由 dismiss 驱动，接受一条即由调用方调 resetTopic 清零。
   */
  note(actorId: string, topic: string, at: number = this.nowFn()): TopicDismissSuggestion | null {
    const key = `${actorId}::${topic}`;
    const prev = this.streaks.get(key);
    const streak = prev && at - prev.firstAt <= STREAK_WINDOW_MS ? prev : { count: 0, firstAt: at };
    streak.count += 1;
    this.streaks.set(key, streak);
    this.dirty = true;

    if (streak.count < DISMISS_THRESHOLD) return null;
    const lastSuggested = this.suggested.get(key);
    if (lastSuggested !== undefined && at - lastSuggested < RESUGGEST_GAP_MS) return null;
    this.suggested.set(key, at);
    return { actorId, topic, count: streak.count };
  }

  /** 正反馈清零（该话题重新被接受时调用） */
  resetTopic(actorId: string, topic: string): void {
    const key = `${actorId}::${topic}`;
    if (this.streaks.delete(key)) this.dirty = true;
  }

  /** 诊断：当前各话题连续 dismiss 计数 */
  snapshot(): Array<{ actorId: string; topic: string; count: number; firstAt: number }> {
    return [...this.streaks.entries()].map(([key, v]) => {
      const [actorId, topic] = key.split("::");
      return { actorId: actorId ?? "", topic: topic ?? "", count: v.count, firstAt: v.firstAt };
    });
  }
}

/** 投递点的话题键归一：发件人优先（message_watch），否则摘要前缀（去空白） */
export function topicKeyOfProposal(p: {
  title: string;
  summary: string;
  detail?: Record<string, string>;
}): string | undefined {
  const sender = p.detail?.["发件人"] ?? p.detail?.["sender"];
  if (sender && sender.trim()) return `发件人:${sender.trim()}`.slice(0, 40);
  const base = (p.summary || p.title).replace(/\s+/g, "");
  return base.slice(0, 16) || undefined;
}
