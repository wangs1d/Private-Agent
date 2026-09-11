/**
 * 早间简报聚合服务：将天气、日程、笔记、兴趣热搜命中合并为一份「早间简报」（四源）。
 *
 * 依赖为可选 —— 当宿主未注入对应服务时返回占位数据，
 * 保证该服务可独立实例化与调用。
 *
 * 第四源「兴趣热搜命中」（2026-08-29）：读 data/interest-watch.json 中该 actor 的
 * 兴趣列表（字段结构见 proactivity/interest-watcher.ts），结合 hot-rankings.ts 的
 * 实时热搜聚合做简单 includes 匹配，最多取 3 条；无命中则整体省略该块，
 * 不影响现有三源（天气/日程/笔记）的逻辑与结构。
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type { ScheduleTaskService } from "./schedule-task-service.js";
import type { WeatherService } from "./weather-service.js";
import type { WeatherPrefsService } from "./weather-prefs-service.js";
import type { NotesService } from "./notes-service.js";
import { detectSevereWeatherAlerts } from "./weather-service.js";
import { fetchHotRankings } from "./hot-rankings.js";
import { normalizeFp } from "../proactivity/interest-watcher.js";
import { resolvePoliteAppellation } from "./user-personalization/appellation.js";
import { fetchIPLocation } from "./ip-geolocation.js";
import type { UserPreferences } from "../routes/http/user-preferences.js";

export interface MorningBriefingWeather {
  temperature?: number;
  condition?: string;
  description?: string;
  /** WMO 天气码（Task 15 预警检测要素） */
  weatherCode?: number;
  /** 当日最高/最低温（预警检测要素） */
  maxC?: number;
  minC?: number;
  /** 风速 km/h（预警检测要素） */
  windKmh?: number;
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

/**
 * 待办跟进（可选块）：今日简报不只播新闻，还要回报"之前交代的事"。
 *  - pending：记忆 KV memory_open_loops（待办/承诺槽位）里还没完成的事，
 *    最新在前，最多 3 条（已剥掉时间戳/话题前缀）；
 *  - doneTodayCount：今天已办结的日程/提醒数。
 * 全空 → 省略该字段。
 */
export interface MorningBriefingTodoFollowups {
  pending: string[];
  doneTodayCount: number;
}

/**
 * 兴趣热搜命中条目（第四源）：用户关注的话题撞上当日热搜。
 * interest 是命中的兴趣名，title/platform/url/hot 来自热搜聚合条目。
 */
export interface MorningBriefingInterestHit {
  interest: string;
  title: string;
  platform: string;
  url?: string;
  hot?: string;
}

/**
 * 近期重要日子条目（第五源）：用户经 care.set_important_date 录入的
 * 生日/纪念日（KV key: important_dates），7 天窗口内按剩余天数升序。
 * 字段结构与 care-reminder-tools.ts 的 ImportantDateRecord 对齐。
 */
export interface MorningBriefingImportantDay {
  id: string;
  /** 人物或事件名称，如"妈妈"、"结婚纪念日" */
  name: string;
  /** MM-DD 格式（年度周期） */
  date: string;
  type: "birthday" | "anniversary" | "custom";
  /** 关系标签，如"母亲"、"配偶" */
  relationship?: string;
  /** 备注（交往摘要，供祝福草稿参考） */
  notes?: string;
  /** 距今天数：0=今天，1=明天…… */
  daysUntil: number;
}

export interface MorningBriefingOutfitTip {
  suggestion: string;
  reason: string;
}

export interface MorningBriefing {
  date: string;
  weather: MorningBriefingWeather | null;
  outfitTip: MorningBriefingOutfitTip | null;
  todaySchedule: MorningBriefingScheduleItem[];
  pendingNotes: MorningBriefingPendingNote[];
  /** 兴趣热搜命中（可选块）：无命中时省略该字段，三源结构不受影响 */
  interestHits?: MorningBriefingInterestHit[];
  /** 待办跟进（可选块）：之前交代的未完成事项 + 今日已办结数；全空时省略 */
  todoFollowups?: MorningBriefingTodoFollowups;
  /** 近期重要日子（可选块，7 天窗口）：无记录时省略该字段 */
  upcomingImportantDays?: MorningBriefingImportantDay[];
  /** 用户称呼（可选）：记忆「称呼」行的得体称呼（用户指定优先，大名→「王先生」式）；问候语用 */
  appellation?: string;
  agentGreeting: string;
}

export interface MorningBriefingNarration {
  /** 口语化文本（供 TTS 播报） */
  narrationText: string;
  /** 结构化简报 */
  briefing: MorningBriefing;
}

/** AgentMemorySyncService 的最小依赖接口（读 important_dates KV，避免重类型耦合） */
export interface ImportantDaysStoreLike {
  getSnapshot(sessionId: string, keys?: string[]): {
    revision: number;
    entries: Record<string, unknown>;
  };
}

export type MorningBriefingDeps = {
  weatherService?: WeatherService;
  weatherPrefsService?: WeatherPrefsService;
  scheduleTaskService?: ScheduleTaskService;
  notesService?: NotesService;
  getSessionPrefs?: (sessionId: string) => UserPreferences;
  /**
   * 客户端定位（GPS，比 IP 准）：用户未配置天气城市时的优先兜底。
   * 装配层接 LocationCoordinator（requestLocation 优先新鲜缓存，
   * 客户端在线时按需向设备要一次实时定位，离线/拒绝 → null）。
   */
  requestClientLocation?: (
    sessionId: string,
  ) => Promise<
    | {
        latitude: number;
        longitude: number;
        label?: string;
        city?: string;
        timezone?: string;
      }
    | null
  >;
  /** 兴趣池文件路径（第四源；默认 data/interest-watch.json，与 InterestWatcher 一致） */
  interestWatchPath?: string;
  /** 重要日子存储（第五源；读 care.set_important_date 写入的 important_dates KV） */
  agentMemorySyncService?: ImportantDaysStoreLike;
  /**
   * 当天命中重要日子回调（Task 17 人情关系）：每日扫描挂晨报调度，
   * 当天命中（daysUntil=0）且当日未触发过时回调一次（内部按 sessionId|id 去重）。
   * 装配层接：单次 LLM 祝福草稿 → ProactivityHub life_reminder 主动提醒。
   */
  onImportantDayToday?: (sessionId: string, day: MorningBriefingImportantDay) => void;
  /**
   * 恶劣天气预警联动回调（Task 15 生活节律）：晨报生成时检测当日预警
   * （暴雨/高温/大风/寒潮等确定性规则），预警命中且当日有日程时回调一次
   * （内部按日去重）。装配层接 ProactivityHub weather_alert kind 合并提醒。
   */
  onSevereWeatherAlert?: (sessionId: string, alerts: string[], scheduleCount: number) => void;
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

function formatWeatherBit(
  condition: string | undefined,
  temperature: number | undefined,
  _description: string | undefined,
): string {
  const segs: string[] = [];
  if (condition) segs.push(condition);
  if (typeof temperature === "number" && Number.isFinite(temperature)) {
    segs.push(`${Math.round(temperature)}度`);
  }
  // 用户要求：不要天气状况的文字描述（description 冗长且与卡片 meta 重复），
  // 只播「天气晴，24度」式短句
  if (segs.length === 0) return "";
  return `天气${segs.join("，")}。`;
}

function buildOutfitTip(weather: MorningBriefingWeather | null): MorningBriefingOutfitTip | null {
  const temp = weather?.temperature;
  if (typeof temp !== "number" || !Number.isFinite(temp)) {
    return null;
  }
  if (temp >= 30) {
    return {
      suggestion: "建议穿轻薄透气的夏装，外出注意防晒补水。",
      reason: "今天体感偏热。",
    };
  }
  if (temp >= 22) {
    return {
      suggestion: "短袖或薄款上衣就比较合适，早晚可备一件薄外套。",
      reason: "温度整体比较舒适。",
    };
  }
  if (temp >= 15) {
    return {
      suggestion: "建议长袖加薄外套，通勤时会更从容。",
      reason: "今天稍微有点凉。",
    };
  }
  if (temp >= 8) {
    return {
      suggestion: "建议穿上外套或针织层，早晚注意保暖。",
      reason: "气温偏凉。",
    };
  }
  return {
    suggestion: "建议厚外套或保暖层一起穿，出门别忘了护颈保暖。",
    reason: "今天明显偏冷。",
  };
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

/** 兴趣热搜块最多呈现条数（无命中则整块省略） */
const INTEREST_HITS_MAX = 3;
/** 兴趣匹配的热搜抓取条数（与 InterestWatcher 的 HOT_FETCH_LIMIT 对齐，覆盖各平台榜单头部） */
const INTEREST_HITS_FETCH_LIMIT = 50;

function formatInterestHitsBit(items: MorningBriefingInterestHit[]): string {
  const titles = items.map((h) => h.title);
  return `你关注的话题上热搜了：${titles.join("、")}。`;
}

/** 重要日子扫描窗口（天）：晨报只呈现 7 天内的近期日子 */
const UPCOMING_DAYS_WINDOW = 7;
/** 晨报"近期重要日子"块最多呈现条数 */
const UPCOMING_DAYS_MAX = 5;

/** 重要日子类型中文标签 */
export function importantDayTypeLabel(type: MorningBriefingImportantDay["type"]): string {
  switch (type) {
    case "birthday":
      return "生日";
    case "anniversary":
      return "纪念日";
    default:
      return "特殊日子";
  }
}

/**
 * 计算 MM-DD 距今天数（0=今天；今年的日期已过则按明年计，年度周期日子永不为负）。
 * 格式非法返回 -1（调用方过滤）。
 */
export function daysUntilMMdd(mmdd: string, now: Date = new Date()): number {
  const m = mmdd.match(/^(\d{1,2})-(\d{1,2})$/);
  if (!m) return -1;
  const month = Number(m[1]);
  const day = Number(m[2]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return -1;
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  let target = new Date(now.getFullYear(), month - 1, day);
  if (target.getTime() < todayStart.getTime()) {
    target = new Date(now.getFullYear() + 1, month - 1, day);
  }
  return Math.round((target.getTime() - todayStart.getTime()) / 86_400_000);
}

function formatImportantDaysBit(items: MorningBriefingImportantDay[]): string {
  const bits = items.slice(0, 3).map((d) => {
    const label = importantDayTypeLabel(d.type);
    if (d.daysUntil === 0) return `今天就是${d.name}的${label}`;
    if (d.daysUntil === 1) return `明天是${d.name}的${label}`;
    return `${d.name}的${label}（${d.date}）还有${d.daysUntil}天`;
  });
  return `近期重要日子：${bits.join("、")}。`;
}

function countChineseChars(text: string): number {
  const matches = text.match(/[一-龥]/g);
  return matches ? matches.length : 0;
}

/** 待办跟进块上限：未完成事项最多播报条数 */
const TODO_FOLLOWUPS_MAX = 3;
/** 单条未完成事项的展示截断长度 */
const TODO_FOLLOWUPS_ITEM_MAX_CHARS = 30;

/**
 * 剥掉记忆槽位行的元信息前缀（「[时间戳] [话题] 」×2 段），只留正文。
 * 没有前缀的行原样返回。
 */
function stripMemoryLineMeta(line: string): string {
  return line
    .replace(/^\[[^\]]*\]\s*/, "")
    .replace(/^\[[^\]]*\]\s*/, "")
    .trim();
}

function formatTodoFollowupsBit(todo: MorningBriefingTodoFollowups): string {
  const bits: string[] = [];
  if (todo.pending.length > 0) {
    bits.push(`你之前交代的事还有 ${todo.pending.length} 件没办：${todo.pending.join("、")}`);
  }
  if (todo.doneTodayCount > 0) {
    bits.push(`今天已完成 ${todo.doneTodayCount} 件安排`);
  }
  return bits.length > 0 ? `${bits.join("；")}。` : "";
}

export class MorningBriefingService {
  /** 当天命中回调去重表：sessionId|id → 最后触发日期（每日至多回调一次） */
  private readonly importantDayFired = new Map<string, string>();
  /** 恶劣天气预警去重表：sessionId → 最后触发日期（每日至多回调一次） */
  private readonly severeWeatherFired = new Map<string, string>();

  constructor(private readonly deps: MorningBriefingDeps = {}) {}

  async generateBriefing(sessionId: string): Promise<MorningBriefing> {
    const now = new Date();
    const greeting = greetingByHour(now.getHours());
    const prefs = this.deps.getSessionPrefs?.(sessionId);
    const sections = prefs?.morningBriefing.sections ?? {
      weather: true,
      outfit: true,
      schedule: true,
      notes: true,
    };

    const [weather, todaySchedule, pendingNotes, interestHits] = await Promise.all([
      sections.weather || sections.outfit
        ? this.fetchWeather(sessionId).catch(() => null)
        : Promise.resolve(null),
      sections.schedule ? this.fetchTodaySchedule(sessionId) : Promise.resolve([]),
      sections.notes ? this.fetchPendingNotes(sessionId) : Promise.resolve([]),
      // 第四源：兴趣热搜命中（可选块；失败/无命中 → 空数组 → 省略该块）
      this.fetchInterestHits(sessionId).catch(() => [] as MorningBriefingInterestHit[]),
    ]);
    const outfitTip = sections.outfit ? buildOutfitTip(weather) : null;

    // 恶劣天气预警联动（Task 15 生活节律）：晨报生成时检测当日预警
    // （确定性规则：暴雨/雷暴/冻雨/大雪/高温/寒潮/大风）→ 预警命中且
    // 当日有日程时回调一次（装配层接 ProactivityHub weather_alert 合并提醒，
    // 内部按日去重，30min 频控冷却由 FrequencyGovernor 兜底）。
    if (weather) {
      const alerts = detectSevereWeatherAlerts({
        weatherCode: weather.weatherCode,
        weatherText: weather.condition,
        maxC: weather.maxC,
        minC: weather.minC,
        windKmh: weather.windKmh,
      });
      if (alerts.length > 0 && todaySchedule.length > 0) {
        this.fireSevereWeatherAlert(sessionId, alerts, todaySchedule.length);
      }
    }

    // 第五源：近期重要日子（7 天窗口，确定性读取 KV，无 LLM）。
    // 当天命中（daysUntil=0）→ onImportantDayToday 回调（装配层接祝福草稿 +
    // ProactivityHub life_reminder），内部按日去重保证每日至多触发一次。
    const upcomingImportantDays = this.fetchUpcomingImportantDays(sessionId);
    for (const day of upcomingImportantDays) {
      if (day.daysUntil === 0) this.fireImportantDayToday(sessionId, day);
    }

    // 用户称呼（确定性读取 KV，无 LLM）：问候语用
    const appellation = this.resolveAppellation(sessionId);

    // 待办跟进（确定性读取，无 LLM）：之前交代未完成 + 今日已办结
    const todoFollowups = this.fetchTodoFollowups(sessionId);

    return {
      date: todayIsoDate(),
      weather: sections.weather ? weather : null,
      outfitTip,
      todaySchedule,
      pendingNotes,
      // 无命中时省略该字段，保持现有三源结构与接口签名不变
      ...(interestHits.length > 0 ? { interestHits } : {}),
      // 待办跟进（可选块）：全空时省略
      ...(todoFollowups ? { todoFollowups } : {}),
      // 无近期日子时省略该字段（可选块）
      ...(upcomingImportantDays.length > 0 ? { upcomingImportantDays } : {}),
      // 用户称呼（可选）：无称呼时省略该字段
      ...(appellation ? { appellation } : {}),
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
    if (!weatherService) return null;

    // 坐标来源优先级：用户配置的天气城市 > 客户端 GPS（实时/缓存） >
    // 出口 IP 定位（后端直接拉取；均确定性 HTTP/WS，无 LLM）。
    const prefs = weatherPrefsService?.get(sessionId);
    let latitude: number;
    let longitude: number;
    let timezone: string;
    let label: string | undefined;
    const clientLocation = prefs ? null : await this.fetchClientLocation(sessionId);
    if (prefs) {
      latitude = prefs.latitude;
      longitude = prefs.longitude;
      timezone = prefs.timezone || "Asia/Shanghai";
      label = prefs.label;
    } else if (clientLocation) {
      latitude = clientLocation.latitude;
      longitude = clientLocation.longitude;
      timezone = clientLocation.timezone || "Asia/Shanghai";
      label = clientLocation.label || clientLocation.city || undefined;
    } else {
      const ipLocation = await fetchIPLocation();
      if (!ipLocation) return null;
      latitude = ipLocation.latitude;
      longitude = ipLocation.longitude;
      timezone = ipLocation.timezone;
      label = ipLocation.label || undefined;
    }

    try {
      const brief = await weatherService.getBrief(latitude, longitude, timezone, label);
      return {
        temperature: brief.currentTempC,
        condition: brief.weatherText,
        description: brief.summaryLine,
        // Task 15 预警检测要素（weather-code / 温度极值 / 风速）
        weatherCode: brief.weatherCode,
        maxC: brief.todayMaxC,
        minC: brief.todayMinC,
        windKmh: brief.windKmh,
      };
    } catch {
      return null;
    }
  }

  /** 客户端定位（GPS）：失败/离线/拒绝 → null（调用方继续走 IP 兜底） */
  private async fetchClientLocation(
    sessionId: string,
  ): Promise<
    | { latitude: number; longitude: number; label?: string; city?: string; timezone?: string }
    | null
  > {
    try {
      return (await this.deps.requestClientLocation?.(sessionId)) ?? null;
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
        title: t.reminderMessage || t.title || "",
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

  /**
   * 待办跟进（确定性读取，无 LLM）：
   *  - pending：记忆 KV memory_open_loops（待办/承诺槽位，行格式
   *    「[时间戳] [话题] 正文」，追加序尾部最新）最新 3 条，剥前缀只留正文；
   *  - doneTodayCount：今日已办结的日程/提醒数（status=completed 且
   *    完成时间在今天）。
   * 两项全空 → null（省略该块）。
   */
  private fetchTodoFollowups(sessionId: string): MorningBriefingTodoFollowups | null {
    const pending = this.fetchOpenLoops(sessionId);
    const doneTodayCount = this.fetchDoneTodayCount(sessionId);
    if (pending.length === 0 && doneTodayCount <= 0) return null;
    return { pending, doneTodayCount };
  }

  private fetchOpenLoops(sessionId: string): string[] {
    const { agentMemorySyncService } = this.deps;
    if (!agentMemorySyncService) return [];
    try {
      const { entries } = agentMemorySyncService.getSnapshot(sessionId, [
        "memory_open_loops",
      ]);
      const raw = typeof entries.memory_open_loops === "string" ? entries.memory_open_loops : "";
      return raw
        .split("\n")
        .filter(Boolean)
        .slice(-TODO_FOLLOWUPS_MAX)
        .reverse()
        .map((line) => stripMemoryLineMeta(line).slice(0, TODO_FOLLOWUPS_ITEM_MAX_CHARS))
        .filter(Boolean);
    } catch {
      return [];
    }
  }

  private fetchDoneTodayCount(sessionId: string): number {
    const { scheduleTaskService } = this.deps;
    if (!scheduleTaskService) return 0;
    try {
      const today = todayIsoDate();
      return scheduleTaskService
        .listAllTasks()
        .filter((t) => {
          if (t.sessionId !== sessionId || t.status !== "completed") return false;
          const doneAt = t.lastRunAt ?? t.runAt ?? "";
          return doneAt.startsWith(today);
        })
        .length;
    } catch {
      return 0;
    }
  }

  /**
   * 第五源：近期重要日子（确定性，无 LLM）。
   * 读 KV important_dates（care.set_important_date 写入），过滤 7 天窗口内
   * 的年度周期日子，按剩余天数升序取前 5 条。存储缺失/格式异常 → 空数组（省略该块）。
   */
  private fetchUpcomingImportantDays(sessionId: string): MorningBriefingImportantDay[] {
    const { agentMemorySyncService } = this.deps;
    if (!agentMemorySyncService) return [];
    try {
      const { entries } = agentMemorySyncService.getSnapshot(sessionId, ["important_dates"]);
      const records = Array.isArray(entries.important_dates) ? entries.important_dates : [];
      const now = new Date();
      const days: MorningBriefingImportantDay[] = [];
      for (const r of records) {
        const rec = r as {
          id?: unknown;
          name?: unknown;
          date?: unknown;
          type?: unknown;
          relationship?: unknown;
          notes?: unknown;
        };
        if (typeof rec.name !== "string" || !rec.name.trim()) continue;
        if (typeof rec.date !== "string") continue;
        const daysUntil = daysUntilMMdd(rec.date, now);
        if (daysUntil < 0 || daysUntil > UPCOMING_DAYS_WINDOW) continue;
        days.push({
          id: typeof rec.id === "string" && rec.id ? rec.id : `${rec.name}|${rec.date}`,
          name: rec.name.trim(),
          date: rec.date,
          type:
            rec.type === "anniversary" || rec.type === "custom" ? rec.type : "birthday",
          ...(typeof rec.relationship === "string" && rec.relationship.trim()
            ? { relationship: rec.relationship.trim() }
            : {}),
          ...(typeof rec.notes === "string" && rec.notes.trim() ? { notes: rec.notes.trim() } : {}),
          daysUntil,
        });
      }
      return days.sort((a, b) => a.daysUntil - b.daysUntil).slice(0, UPCOMING_DAYS_MAX);
    } catch {
      return [];
    }
  }

  /**
   * 用户称呼：读记忆同步 KV 的 user_profile「称呼」行，交给共享的
   * resolvePoliteAppellation 做得体化（用户指定的称呼优先；大名转
   * 「王先生」式称呼——问候绝不直呼大名）。缺失/异常 → 空串
   * （省略该字段，问候不带称呼，也绝不回退成大名）。
   */
  private resolveAppellation(sessionId: string): string {
    const { agentMemorySyncService } = this.deps;
    if (!agentMemorySyncService) return "";
    try {
      const { entries } = agentMemorySyncService.getSnapshot(sessionId, [
        "user_profile",
      ]);
      const profile = entries.user_profile;
      if (typeof profile !== "string") return "";
      const m = profile.match(/^\s*(?:[-*]\s*)?称呼[：:]\s*(.+)$/m);
      if (!m) return "";
      return resolvePoliteAppellation(m[1]);
    } catch {
      return "";
    }
  }

  /** 当天命中回调（每日去重）：sessionId|id → 今日已触发则跳过，防止多次生成简报重复打扰 */
  private fireImportantDayToday(sessionId: string, day: MorningBriefingImportantDay): void {
    const key = `${sessionId}|${day.id}`;
    const today = todayIsoDate();
    if (this.importantDayFired.get(key) === today) return;
    this.importantDayFired.set(key, today);
    try {
      this.deps.onImportantDayToday?.(sessionId, day);
    } catch (err) {
      console.log(`[MorningBriefing] 重要日子回调失败（忽略）: ${err}`);
    }
  }

  /** 恶劣天气预警回调（每日去重）：同日多次生成简报只提醒一次 */
  private fireSevereWeatherAlert(
    sessionId: string,
    alerts: string[],
    scheduleCount: number,
  ): void {
    const today = todayIsoDate();
    if (this.severeWeatherFired.get(sessionId) === today) return;
    this.severeWeatherFired.set(sessionId, today);
    try {
      this.deps.onSevereWeatherAlert?.(sessionId, alerts, scheduleCount);
    } catch (err) {
      console.log(`[MorningBriefing] 恶劣天气预警回调失败（忽略）: ${err}`);
    }
  }

  /**
   * 第四源：当日兴趣热搜命中。
   * 读 data/interest-watch.json 中该 actor 的兴趣列表（字段结构同
   * proactivity/interest-watcher.ts 的 WatchInterest；actorId 缺省时与 sessionId
   * 同值，见 agent/actor-id.ts 的回退规则），拉一次实时热搜聚合后做简单
   * includes 匹配（归一化后 title 包含兴趣名），按榜单顺序最多取 3 条。
   * 用户要求：不要今日热搜兜底——未配置兴趣/当日无命中/拉取失败 →
   * 空数组（省略该块）。
   */
  private async fetchInterestHits(sessionId: string): Promise<MorningBriefingInterestHit[]> {
    const path =
      this.deps.interestWatchPath ??
      process.env.INTEREST_WATCH_FILE ??
      join(process.cwd(), "data", "interest-watch.json");

    // 兴趣池文件不存在（用户从未设置兴趣）→ 直接省略，不触发网络请求
    let raw: string;
    try {
      raw = await readFile(path, "utf8");
    } catch {
      return [];
    }

    const interests = this.readInterestNames(raw, sessionId);
    if (interests.length === 0) return [];

    const { items } = await fetchHotRankings(INTEREST_HITS_FETCH_LIMIT);
    if (items.length === 0) return [];

    const hits: MorningBriefingInterestHit[] = [];
    const seenTitles = new Set<string>();
    for (const item of items) {
      if (hits.length >= INTEREST_HITS_MAX) break;
      const titleFp = normalizeFp(item.title);
      if (!titleFp || seenTitles.has(titleFp)) continue;
      const matched = interests.find((name) => {
        const fp = normalizeFp(name);
        return fp.length >= 2 && titleFp.includes(fp);
      });
      if (!matched) continue;
      seenTitles.add(titleFp);
      hits.push({
        interest: matched,
        title: item.title,
        platform: item.platform,
        ...(item.url ? { url: item.url } : {}),
        ...(item.hot ? { hot: item.hot } : {}),
      });
    }
    return hits;
  }

  /** 解析兴趣池文件，取该 actor 启用中的兴趣名（列表按 lastSeenAt 倒序，近期兴趣优先命中） */
  private readInterestNames(rawJson: string, actorId: string): string[] {
    try {
      const data = JSON.parse(rawJson) as {
        interests?: Array<{
          actorId?: string;
          name?: unknown;
          enabled?: boolean;
          lastSeenAt?: number;
        }>;
      };
      return (data.interests ?? [])
        .filter(
          (i) =>
            i &&
            i.actorId === actorId &&
            i.enabled !== false &&
            typeof i.name === "string" &&
            i.name.trim().length >= 2,
        )
        .sort((a, b) => (b.lastSeenAt ?? 0) - (a.lastSeenAt ?? 0))
        .map((i) => (i.name as string).trim());
    } catch {
      return [];
    }
  }

  private composeNarration(briefing: MorningBriefing): string {
    const parts: string[] = [];
    // 播报稿对齐设计稿（design/daily-briefing-floating.html）：问候与日期由
    // 卡片头（greeting/meta 行）展示，正文直接从内容开始，不再重复
    // 「下午好，今天9月10日周四」。

    if (briefing.weather) {
      const { condition, temperature, description } = briefing.weather;
      const weatherBit = formatWeatherBit(condition, temperature, description);
      if (weatherBit) parts.push(weatherBit);
    }

    if (briefing.outfitTip) {
      parts.push(`穿衣建议：${briefing.outfitTip.suggestion}`);
    }

    if (briefing.todaySchedule.length > 0) {
      parts.push(formatScheduleBit(briefing.todaySchedule));
    }

    // 待办跟进（可选块）：之前交代未完成 + 今日已办结——简报不只播新闻，
    // 还要回报用户交办事宜的进展
    const todo = briefing.todoFollowups;
    if (todo) {
      const todoBit = formatTodoFollowupsBit(todo);
      if (todoBit) parts.push(todoBit);
    }

    if (briefing.pendingNotes.length > 0) {
      parts.push(formatNotesBit(briefing.pendingNotes));
    }

    // 第四源：兴趣热搜命中（可选块，无命中时整体省略）
    const interestHits = briefing.interestHits ?? [];
    if (interestHits.length > 0) {
      parts.push(formatInterestHitsBit(interestHits));
    }

    // 第五源：近期重要日子（可选块，无记录时整体省略）
    const upcomingDays = briefing.upcomingImportantDays ?? [];
    if (upcomingDays.length > 0) {
      parts.push(formatImportantDaysBit(upcomingDays));
    }

    // 全空（个人数据源都没配置/没命中）→ 明确说明，不输出空荡荡的纯问候
    if (parts.length === 0) {
      parts.push("今天暂无日程和待办。");
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

/**
 * 祝福草稿生成（Task 17 人情关系管家）：单次 LLM 调用，
 * 输入 = 关系标签 + 交往摘要（notes）+ 日子类型；LLM 未注入/失败时
 * 退化为确定性模板草稿（克制原则：草稿一次 LLM，绝不阻塞提醒主链路）。
 * 生成后由装配层作为 life_reminder 提醒内容附带，供用户改写后发送。
 */
export async function generateImportantDayBlessing(
  day: MorningBriefingImportantDay,
  llmComplete?: (prompt: string) => Promise<string>,
): Promise<string> {
  const label = importantDayTypeLabel(day.type);
  const rel = day.relationship?.trim() || "亲友";
  const deterministic = `祝${day.name}${label}快乐！愿你往后的日子平安顺遂，开心的事源源不断。`;

  if (!llmComplete) return deterministic;
  try {
    const prompt =
      `你是用户的私人生活管家。今天（${day.date}）是用户${rel}「${day.name}」的${label}。` +
      `请以用户的口吻代拟一条发给${day.name}的祝福，要求：` +
      `1）1 到 3 句话，真诚自然，不用华丽套话；` +
      `2）尽量结合这份背景信息（没有就自然带过）：${day.notes ?? "（无备注）"}；` +
      `3）直接输出祝福正文，不要任何解释、引号或前后缀。`;
    const text = (await llmComplete(prompt))?.trim();
    return text || deterministic;
  } catch (err) {
    console.log(`[MorningBriefing] 祝福草稿 LLM 生成失败（退化为模板）: ${err}`);
    return deterministic;
  }
}
