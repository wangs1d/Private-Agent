/**
 * 晚间 digest 服务（Task 15 场景A 生活节律）——「今日回顾 + 明日预告」。
 *
 * 与晨报（MorningBriefingService）互补：晨报面向"今天怎么安排"，晚间 digest
 * 面向"今天过了什么 + 明天要准备什么"。全部确定性聚合，零 LLM：
 *   - 今日回顾：journal 当日记录要点（DailyJournalService.readTodayLines）
 *              + 当日账本新增（FinanceDeepService 当日交易笔数/金额）
 *   - 明日预告：明日日程（ScheduleTaskService 次日任务）
 *              + 次日天气与预警（WeatherService.getBrief().tomorrow + 预警检测）
 *
 * 送达链路参考晨报：调度器（EveningDigestScheduler）到点触发 → 装配层
 * onDigestTriggered → WS 推送（ServerEventType.EveningDigest）。
 */

import type { DailyJournalService, JournalHit } from "./daily-journal-service.js";
import type { FinanceDeepService } from "./finance-deep-service.js";
import type { ScheduleTaskService } from "./schedule-task-service.js";
import type { WeatherService } from "./weather-service.js";
import type { WeatherPrefsService } from "./weather-prefs-service.js";
import { detectSevereWeatherAlerts } from "./weather-service.js";

/** 今日回顾：journal 当日要点（最多呈现条数） */
const TODAY_HIGHLIGHT_MAX = 6;

export interface EveningDigestLedger {
  /** 当日新增交易笔数 */
  count: number;
  /** 当日支出合计 */
  expense: number;
  /** 当日收入合计 */
  income: number;
}

export interface EveningDigestScheduleItem {
  id: string;
  title: string;
  time?: string;
}

export interface EveningDigestTomorrowWeather {
  text: string;
  minC: number;
  maxC: number;
  rainPct: number;
  /** 次日预警标签（暴雨/高温/大风/寒潮等；空数组 = 无预警） */
  alerts: string[];
}

export interface EveningDigest {
  date: string;
  /** 今日回顾：journal 当日记录要点（时间 + 角色 + 首句） */
  todayHighlights: JournalHit[];
  /** 今日回顾：当日账本新增（无记录时 null） */
  todayLedger: EveningDigestLedger | null;
  /** 明日预告：日程条目 */
  tomorrowSchedule: EveningDigestScheduleItem[];
  /** 明日预告：次日天气（未配置天气位置时 null） */
  tomorrowWeather: EveningDigestTomorrowWeather | null;
  /** 口语化播报文本（供 TTS / 消息气泡） */
  narrationText: string;
}

export type EveningDigestDeps = {
  journalService?: DailyJournalService | null;
  financeDeepService?: FinanceDeepService | null;
  scheduleTaskService?: ScheduleTaskService;
  weatherService?: WeatherService;
  weatherPrefsService?: WeatherPrefsService;
};

function localDateKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export class EveningDigestService {
  constructor(private readonly deps: EveningDigestDeps = {}) {}

  /** 生成晚间 digest（确定性聚合，零 LLM；任一源缺失/失败 → 该块省略） */
  async generateDigest(sessionId: string): Promise<EveningDigest> {
    const now = new Date();
    const [todayHighlights, todayLedger, tomorrowSchedule, tomorrowWeather] = await Promise.all([
      this.fetchTodayHighlights(sessionId).catch(() => [] as JournalHit[]),
      this.fetchTodayLedger(sessionId, now).catch(() => null),
      this.fetchTomorrowSchedule(sessionId, now).catch(() => [] as EveningDigestScheduleItem[]),
      this.fetchTomorrowWeather(sessionId).catch(() => null),
    ]);

    const digest: EveningDigest = {
      date: localDateKey(now),
      todayHighlights,
      todayLedger,
      tomorrowSchedule,
      tomorrowWeather,
      narrationText: "",
    };
    digest.narrationText = this.composeNarration(digest);
    return digest;
  }

  /** 今日回顾 1/2：journal 当日记录要点（按时间顺序，U/A/fact 行精简） */
  private async fetchTodayHighlights(sessionId: string): Promise<JournalHit[]> {
    if (!this.deps.journalService) return [];
    const lines = await this.deps.journalService.readTodayLines(sessionId);
    // 回顾要点优先保留 user/fact 行（用户做了什么/说了什么），assistant 行次之
    const ranked = [...lines].sort((a, b) => {
      const rank = (h: JournalHit) => (h.role === "user" ? 0 : h.role === "fact" ? 1 : 2);
      return rank(a) - rank(b);
    });
    return ranked.slice(0, TODAY_HIGHLIGHT_MAX);
  }

  /** 今日回顾 2/2：当日账本新增（笔数/支出/收入，确定性聚合） */
  private async fetchTodayLedger(sessionId: string, now: Date): Promise<EveningDigestLedger | null> {
    if (!this.deps.financeDeepService) return null;
    const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const dayEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
    const txs = this.deps.financeDeepService.getTransactions(
      sessionId,
      dayStart.toISOString(),
      dayEnd.toISOString(),
      undefined,
      1000,
    );
    if (txs.length === 0) return null;
    return {
      count: txs.length,
      expense: txs.filter((t) => t.type === "expense").reduce((acc, t) => acc + t.amount, 0),
      income: txs.filter((t) => t.type === "income").reduce((acc, t) => acc + t.amount, 0),
    };
  }

  /** 明日预告 1/2：次日日程（schedule 服务） */
  private async fetchTomorrowSchedule(
    sessionId: string,
    now: Date,
  ): Promise<EveningDigestScheduleItem[]> {
    if (!this.deps.scheduleTaskService) return [];
    const tomorrowStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
    const tomorrowKey = localDateKey(tomorrowStart);
    try {
      const tasks = this.deps.scheduleTaskService.listTasksBySession(sessionId);
      return tasks
        .filter((t) => {
          const ts = Date.parse(t.nextRunAt ?? t.runAt ?? "");
          if (Number.isNaN(ts)) return false;
          return localDateKey(new Date(ts)) === tomorrowKey;
        })
        .slice(0, 5)
        .map((t) => ({
          id: t.taskId,
          title: t.reminderMessage || t.title || "",
          time: (t.nextRunAt ?? t.runAt ?? "").slice(11, 16) || undefined,
        }));
    } catch {
      return [];
    }
  }

  /** 明日预告 2/2：次日天气 + 预警检测（weather-service 每日数据） */
  private async fetchTomorrowWeather(sessionId: string): Promise<EveningDigestTomorrowWeather | null> {
    const { weatherService, weatherPrefsService } = this.deps;
    if (!weatherService || !weatherPrefsService) return null;
    const prefs = weatherPrefsService.get(sessionId);
    if (!prefs) return null;
    const brief = await weatherService.getBrief(
      prefs.latitude,
      prefs.longitude,
      prefs.timezone || "Asia/Shanghai",
      prefs.label,
    );
    if (!brief.tomorrow) return null;
    return {
      text: brief.tomorrow.weatherText,
      minC: brief.tomorrow.minC,
      maxC: brief.tomorrow.maxC,
      rainPct: brief.tomorrow.rainPct,
      alerts: detectSevereWeatherAlerts(brief.tomorrow),
    };
  }

  /** 口语化播报（确定性拼接；块缺失自然省略） */
  private composeNarration(d: EveningDigest): string {
    const parts: string[] = [];
    parts.push("晚上好，简单回顾一下今天。");

    // ── 今日回顾 ──
    if (d.todayHighlights.length > 0) {
      const bits = d.todayHighlights.slice(0, 3).map((h) => h.text.slice(0, 40));
      parts.push(`今天我们聊了${bits.length}件事，比如${bits.join("、")}。`);
    } else {
      parts.push("今天没聊太多。");
    }
    if (d.todayLedger && d.todayLedger.count > 0) {
      parts.push(`记账方面，今天新增${d.todayLedger.count}笔，支出¥${d.todayLedger.expense.toFixed(2)}。`);
    }

    // ── 明日预告 ──
    const tomorrowBits: string[] = [];
    if (d.tomorrowSchedule.length > 0) {
      const first = d.tomorrowSchedule[0]!;
      tomorrowBits.push(
        `明天有${d.tomorrowSchedule.length}件事要办，最早的是${first.time ? `${first.time}的` : ""}${first.title}`,
      );
    }
    if (d.tomorrowWeather) {
      const w = d.tomorrowWeather;
      const rainInfo = w.rainPct >= 40 ? `，降水概率${w.rainPct}%记得带伞` : "";
      tomorrowBits.push(`明天${w.text}，${w.minC.toFixed(0)}到${w.maxC.toFixed(0)}度${rainInfo}`);
      if (w.alerts.length > 0) {
        tomorrowBits.push(`注意明天有${w.alerts.join("和")}预警`);
      }
    }
    if (tomorrowBits.length > 0) {
      parts.push(`提前说下明天：${tomorrowBits.join("；")}。`);
    }

    parts.push("早点休息，晚安。");
    return parts.join("");
  }
}
