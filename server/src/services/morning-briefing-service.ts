/**
 * 早间简报聚合服务：将天气、日程、笔记合并为一份「早间简报」。
 *
 * 依赖为可选 —— 当宿主未注入对应服务时返回占位数据，
 * 保证该服务可独立实例化与调用。
 */
import type { ScheduleTaskService } from "./schedule-task-service.js";
import type { WeatherService } from "./weather-service.js";
import type { WeatherPrefsService } from "./weather-prefs-service.js";
import type { NotesService } from "./notes-service.js";

export interface MorningBriefingWeather {
  temperature?: number;
  condition?: string;
  description?: string;
}

export interface MorningBriefingScheduleItem {
  id: string;
  title: string;
  time?: string;
}

export interface MorningBriefingPendingNote {
  id: string;
  title: string;
}

export interface MorningBriefing {
  date: string;
  weather: MorningBriefingWeather | null;
  todaySchedule: MorningBriefingScheduleItem[];
  pendingNotes: MorningBriefingPendingNote[];
  agentGreeting: string;
}

export interface MorningBriefingNarration {
  /** 口语化文本（供 TTS 播报） */
  narrationText: string;
  /** 结构化简报 */
  briefing: MorningBriefing;
}

export type MorningBriefingDeps = {
  weatherService?: WeatherService;
  weatherPrefsService?: WeatherPrefsService;
  scheduleTaskService?: ScheduleTaskService;
  notesService?: NotesService;
};

function todayIsoDate(): string {
  return new Date().toISOString().slice(0, 10);
}

function greetingByHour(hour: number): string {
  if (hour >= 5 && hour < 12) {
    return "早上好！新的一天开始了，这是你的早间简报。";
  }
  if (hour >= 12 && hour < 18) {
    return "下午好！这是你的最新简报。";
  }
  if (hour >= 18 && hour < 23) {
    return "晚上好！这是今晚的简报回顾。";
  }
  return "夜深了，这是为你整理的简报。注意休息。";
}

const WEEKDAY_LABELS_ZH = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

function formatDateLabel(dateIso: string): string {
  const now = new Date();
  const hour = now.getHours();
  let greeting = "早安";
  if (hour >= 12 && hour < 18) greeting = "下午好";
  else if (hour >= 18 && hour < 23) greeting = "晚上好";
  else if (hour >= 23 || hour < 5) greeting = "夜深了";

  const parts = dateIso.split("-");
  if (parts.length !== 3) {
    return `${greeting}，今天${dateIso}。`;
  }
  const [, m, d] = parts;
  const monthNum = Number(m);
  const dayNum = Number(d);
  if (!Number.isFinite(monthNum) || !Number.isFinite(dayNum)) {
    return `${greeting}，今天${dateIso}。`;
  }

  let weekdayLabel = "";
  const probe = new Date(`${dateIso}T00:00:00Z`);
  if (!Number.isNaN(probe.getTime())) {
    weekdayLabel = WEEKDAY_LABELS_ZH[probe.getUTCDay()] ?? "";
  }
  return `${greeting}，今天${monthNum}月${dayNum}日${weekdayLabel}。`;
}

function formatWeatherBit(
  condition: string | undefined,
  temperature: number | undefined,
  description: string | undefined,
): string {
  const segs: string[] = [];
  if (condition) segs.push(condition);
  if (typeof temperature === "number" && Number.isFinite(temperature)) {
    segs.push(`${Math.round(temperature)}度`);
  }
  if (segs.length === 0) {
    return description ? `天气：${description}。` : "";
  }
  let bit = `天气${segs.join("，")}。`;
  if (description) {
    bit = `${bit}${description}。`;
  }
  return bit;
}

function formatScheduleBit(items: MorningBriefingScheduleItem[]): string {
  const top = items.slice(0, 3);
  const rest = items.length - top.length;
  const bits = top.map((item) => {
    if (item.time) {
      return `${item.time}的${item.title}`;
    }
    return item.title;
  });
  let sentence = `今天有${top.length}件事比较重要：${bits.join("、")}。`;
  if (rest > 0) {
    sentence = `${sentence}另外还有${rest}项可以晚点再看。`;
  }
  return sentence;
}

function formatNotesBit(items: MorningBriefingPendingNote[]): string {
  const titles = items.slice(0, 3).map((n) => n.title);
  return `还有${items.length}条笔记没复习，比如${titles.join("、")}，可以抽空看一下。`;
}

function countChineseChars(text: string): number {
  const matches = text.match(/[一-龥]/g);
  return matches ? matches.length : 0;
}

export class MorningBriefingService {
  constructor(private readonly deps: MorningBriefingDeps = {}) {}

  async generateBriefing(sessionId: string): Promise<MorningBriefing> {
    const now = new Date();
    const greeting = greetingByHour(now.getHours());

    const [weather, todaySchedule, pendingNotes] = await Promise.all([
      this.fetchWeather(sessionId).catch(() => null),
      this.fetchTodaySchedule(sessionId),
      this.fetchPendingNotes(sessionId),
    ]);

    return {
      date: todayIsoDate(),
      weather,
      todaySchedule,
      pendingNotes,
      agentGreeting: greeting,
    };
  }

  async narrateBriefing(sessionId: string): Promise<MorningBriefingNarration> {
    const briefing = await this.generateBriefing(sessionId);
    const narrationText = this.composeNarration(briefing);
    return { narrationText, briefing };
  }

  private async fetchWeather(sessionId: string): Promise<MorningBriefingWeather | null> {
    const { weatherService, weatherPrefsService } = this.deps;
    if (!weatherService || !weatherPrefsService) return null;
    const prefs = weatherPrefsService.get(sessionId);
    if (!prefs) return null;
    try {
      const brief = await weatherService.getBrief(
        prefs.latitude,
        prefs.longitude,
        prefs.timezone || "Asia/Shanghai",
        prefs.label,
      );
      return {
        temperature: brief.currentTempC,
        condition: brief.weatherText,
        description: brief.summaryLine,
      };
    } catch {
      return null;
    }
  }

  private async fetchTodaySchedule(sessionId: string): Promise<MorningBriefingScheduleItem[]> {
    const { scheduleTaskService } = this.deps;
    if (!scheduleTaskService) return [];
    try {
      const tasks = scheduleTaskService.listTasksBySession(sessionId);
      return tasks.slice(0, 10).map((t) => ({
        id: t.taskId,
        title: t.title,
        time: t.nextRunAt ?? t.runAt,
      }));
    } catch {
      return [];
    }
  }

  private async fetchPendingNotes(sessionId: string): Promise<MorningBriefingPendingNote[]> {
    const { notesService } = this.deps;
    if (!notesService) return [];
    try {
      const notes = notesService.listNotes({ sessionId, limit: 10 });
      return notes
        .filter((n) => (n.reviewCount ?? 0) === 0)
        .slice(0, 5)
        .map((n) => ({ id: n.id, title: n.title }));
    } catch {
      return [];
    }
  }

  private composeNarration(briefing: MorningBriefing): string {
    const parts: string[] = [];
    const dateLabel = formatDateLabel(briefing.date);
    parts.push(dateLabel);

    if (briefing.weather) {
      const { condition, temperature, description } = briefing.weather;
      const weatherBit = formatWeatherBit(condition, temperature, description);
      if (weatherBit) parts.push(weatherBit);
    }

    if (briefing.todaySchedule.length > 0) {
      parts.push(formatScheduleBit(briefing.todaySchedule));
    }

    if (briefing.pendingNotes.length > 0) {
      parts.push(formatNotesBit(briefing.pendingNotes));
    }

    parts.push("祝你今天顺利。");

    let text = parts.join("").trim();
    if (countChineseChars(text) > 150) {
      text = `${text.slice(0, 149).trimEnd()}…`;
    }
    if (countChineseChars(text) < 80) {
      text = `${text} 我随时在这儿，有需要随时叫我。`;
    }
    return text;
  }
}
