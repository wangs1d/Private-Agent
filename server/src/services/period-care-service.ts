import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { decryptWellnessJson, encryptWellnessJson } from "./wellness-crypto.js";
import type { ProactiveProposal } from "../proactivity/pipeline-types.js";

/**
 * 生理周期关怀 service（方案见 docs/women-care-proposal.md §B）。
 *
 * 存储模型：每 actor 一个独立文件 `data/period-care/{actorId}.json`，
 * 文件内容为 AES-256-GCM 加密后的完整 store（密钥见 wellness-crypto.ts）。
 * 内存态 + 防抖落盘 + 启动全量加载，模式与 HealthFitnessService 一致。
 *
 * 预测口径（M1）：滚动统计——最近至多 6 个周期长度（相邻两次开始日之差，
 * 保留 15-90 天的合理值）取中位数，输出区间而非单点；周期数不足 2 时置信度
 * 标记为 low 且提醒降级。所有对外文案带「估算、非医学结论」边界（合规红线）。
 *
 * 主动提醒：每分钟 tick（`start()`），命中「预测开始日前 N 天的本地提醒时刻」
 * 时经 proactivity 管道直投（tier=must + directText 零 LLM）；同一天同 actor
 * 只发一次（sentReminderKeys 去重）。
 */

/** 单次经期记录。 */
export interface PeriodCycleRecord {
  id: string;
  /** 经期开始日（本地日历日 YYYY-MM-DD） */
  startDate: string;
  /** 经期结束日（可选；缺省表示尚未记录结束） */
  endDate?: string;
  /** 经期第一天流量：light / medium / heavy */
  flow?: "light" | "medium" | "heavy";
  /** 痛经程度 0-10（用户自评，非医学分级） */
  pain?: number;
  /** 症状标签（cramps / headache / bloating / fatigue / mood_swings / acne / ...） */
  symptoms?: string[];
  note?: string;
  createdAt: string;
}

/** 单日状态记录（症状 / 情绪打卡）。 */
export interface PeriodDailyLog {
  id: string;
  /** 本地日历日 YYYY-MM-DD */
  date: string;
  pain?: number;
  /** 情绪标签（如 平静 / 烦躁 / 低落 / 愉悦），原样保存 */
  mood?: string;
  symptoms?: string[];
  note?: string;
  createdAt: string;
}

/** 提醒与预测偏好。 */
export interface PeriodCareSettings {
  reminderEnabled: boolean;
  /** 经期预计开始日前多少天提醒（0-7，0=当天早上提醒） */
  reminderDaysBefore: number;
  /** 提醒时刻（服务器本地小时 0-23） */
  reminderHour: number;
  /** 用户自报平均周期天数（覆盖统计预测） */
  cycleLengthOverride?: number;
  /** 用户自报经期持续天数（用于「是否仍在经期」判定） */
  periodLengthOverride?: number;
}

/** 单个 actor 的存储结构（加密落盘）。 */
interface PeriodCareStore {
  version: 1;
  cycles: PeriodCycleRecord[];
  logs: PeriodDailyLog[];
  settings: PeriodCareSettings;
  /** 已发送提醒指纹（`pre:{actorId}:{date}`），保留最近 20 条 */
  sentReminderKeys: string[];
}

/** 周期当前状态 + 预测（period.status 工具返回体）。 */
export interface PeriodCycleStatus {
  hasData: boolean;
  /** 是否处于经期（最近一次开始日未结束，且在经期天数窗口内） */
  inPeriod: boolean;
  /** 当前周期第几天（自最近一次开始日起算，第 1 天 = 开始日） */
  cycleDay?: number;
  latestStart?: string;
  latestEnd?: string;
  /** 最近一次完整周期长度（天；无完整周期则缺省） */
  latestCycleLengthDays?: number;
  /** 统计用平均周期长度（中位数） */
  averageCycleLengthDays?: number;
  /** 预测置信度：样本 <2 低 / 2-3 中 / ≥4 高；用户显式覆盖则直接 high */
  confidence: "low" | "medium" | "high";
  /** 预测下次经期开始（本地日历日） */
  predictedNextStart?: string;
  /** 预测区间半径（± 天） */
  predictedRangeDays?: number;
  /** 距预测开始还有几天（可为负 = 已过预测日） */
  daysUntilPredictedStart?: number;
  /** 温和异常提示（非诊断，仅建议就医聊一聊） */
  anomalyHint?: string;
  disclaimer: string;
}

/** 主动通知端口：经 proactivity 管道直投（wiring 注入，测试注入 spy）。 */
export interface PeriodNotifyPort {
  submitProposal(p: ProactiveProposal): unknown;
}

export interface PeriodCareDeps {
  dataDir: string;
  /** 取 proactivity 管道（启动期尚未创建时返回 null，tick 时跳过本轮） */
  getPipeline: () => PeriodNotifyPort | null;
  now?: () => Date;
}

const DEFAULT_SETTINGS: PeriodCareSettings = {
  reminderEnabled: true,
  reminderDaysBefore: 2,
  reminderHour: 9,
};

/** 周期长度合理区间（天）；超出视为异常值，不进统计。 */
const CYCLE_LENGTH_MIN = 15;
const CYCLE_LENGTH_MAX = 90;
/** 参与统计的最多历史周期数 */
const STATS_WINDOW = 6;
/** 无结束记录时「仍在经期」的兜底窗口（天） */
const DEFAULT_PERIOD_LENGTH = 5;

function toLocalDateKey(d: Date): string {
  const local = new Date(d.getTime() - d.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 10);
}

/** 日历日加 N 天（key 视为 UTC 日做纯日历运算，与时区无关）。 */
function addDaysKey(key: string, days: number): string {
  const t = Date.parse(`${key}T00:00:00Z`);
  if (Number.isNaN(t)) return key;
  return new Date(t + days * 86_400_000).toISOString().slice(0, 10);
}

function daysBetween(fromKey: string, toKey: string): number {
  const a = Date.parse(`${fromKey}T00:00:00Z`);
  const b = Date.parse(`${toKey}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return Math.round((b - a) / 86_400_000);
}

/** 把 LLM 传入的日期（YYYY-MM-DD 或完整 ISO 8601）规范为本地日历日。 */
function normalizeDateKey(input: string | undefined, fallback: Date): string | undefined {
  const raw = input?.trim();
  if (!raw) return toLocalDateKey(fallback);
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return undefined;
  return toLocalDateKey(parsed);
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : Math.round(((sorted[mid - 1] + sorted[mid]) / 2) * 10) / 10;
}

export class PeriodCareService {
  private readonly stores = new Map<string, PeriodCareStore>();
  private readonly dirty = new Set<string>();
  private persistTimer: NodeJS.Timeout | null = null;
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private readonly now: () => Date;

  constructor(private readonly deps: PeriodCareDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  /** 启动加载：解密并载入 `dataDir` 下所有 actor 文件。 */
  async load(): Promise<void> {
    let files: string[];
    try {
      files = await readdir(this.deps.dataDir);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes("ENOENT")) {
        console.error("[PeriodCare] load readdir failed:", error);
      }
      return;
    }
    for (const f of files.filter((f) => f.endsWith(".json"))) {
      const actorId = f.slice(0, -5);
      try {
        const raw = await readFile(join(this.deps.dataDir, f), "utf8");
        this.stores.set(actorId, this.normalizeStore(decryptWellnessJson<PeriodCareStore>(raw)));
      } catch (error) {
        // 密钥轮换 / 文件损坏：跳过该文件并告警，不做静默覆盖（数据无价）
        console.error(`[PeriodCare] load file ${f} failed（密钥不匹配或数据损坏?）:`, error);
      }
    }
  }

  /** 全量落盘脏数据（关停 / 防抖触发）。 */
  async flush(): Promise<void> {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    const ids = Array.from(this.dirty);
    this.dirty.clear();
    for (const actorId of ids) {
      const store = this.stores.get(actorId);
      if (!store) continue;
      try {
        await mkdir(this.deps.dataDir, { recursive: true });
        await writeFile(
          join(this.deps.dataDir, `${actorId}.json`),
          encryptWellnessJson(store),
          "utf8",
        );
      } catch (error) {
        console.error(`[PeriodCare] flush ${actorId} failed:`, error);
      }
    }
  }

  /** 清除某 actor 的全部关怀数据（「一键清除」隐私承诺，文件级删除）。 */
  async purge(actorId: string): Promise<void> {
    this.stores.delete(actorId);
    this.dirty.delete(actorId);
    try {
      await rm(join(this.deps.dataDir, `${actorId}.json`), { force: true });
    } catch (error) {
      console.error(`[PeriodCare] purge ${actorId} failed:`, error);
    }
  }

  // ─── 写入 ───────────────────────────────────────────────────────────

  /**
   * 记录经期开始。若最近一次开始日在 ±1 天内已存在未结束记录，视为同一次
   * 经期做字段补全（用户先说「来了」再说「今天量比较大」的常见连击）。
   */
  async logPeriodStart(
    actorId: string,
    input: { date?: string; flow?: string; pain?: number; symptoms?: string[]; note?: string } = {},
  ): Promise<{ cycle: PeriodCycleRecord; merged: boolean }> {
    const now = this.now();
    const date = normalizeDateKey(input.date, now);
    if (!date) {
      throw new Error(`无法解析日期：${input.date}`);
    }
    const store = this.getStore(actorId);
    const latest = this.sortedCycles(store).at(-1);
    let merged = false;
    let cycle: PeriodCycleRecord;
    if (
      latest &&
      !latest.endDate &&
      Math.abs(daysBetween(latest.startDate, date)) <= 1
    ) {
      if (input.flow) latest.flow = this.normalizeFlow(input.flow);
      if (typeof input.pain === "number") latest.pain = clampPain(input.pain);
      if (input.symptoms?.length) latest.symptoms = dedupe([...(latest.symptoms ?? []), ...input.symptoms]);
      if (input.note) latest.note = input.note;
      cycle = latest;
      merged = true;
    } else {
      cycle = {
        id: randomUUID(),
        startDate: date,
        ...(input.flow ? { flow: this.normalizeFlow(input.flow) } : {}),
        ...(typeof input.pain === "number" ? { pain: clampPain(input.pain) } : {}),
        ...(input.symptoms?.length ? { symptoms: dedupe(input.symptoms) } : {}),
        ...(input.note ? { note: input.note } : {}),
        createdAt: now.toISOString(),
      };
      store.cycles.push(cycle);
    }
    this.schedulePersist(actorId);
    return { cycle, merged };
  }

  /** 记录经期结束（补到最近一次未结束的记录上）。 */
  async logPeriodEnd(
    actorId: string,
    input: { date?: string } = {},
  ): Promise<PeriodCycleRecord | null> {
    const date = normalizeDateKey(input.date, this.now());
    if (!date) return null;
    const store = this.getStore(actorId);
    const open = this.sortedCycles(store)
      .reverse()
      .find((c) => !c.endDate);
    if (!open) return null;
    open.endDate = daysBetween(open.startDate, date) < 0 ? open.startDate : date;
    this.schedulePersist(actorId);
    return open;
  }

  /** 单日状态打卡（症状 / 情绪 / 疼痛），同日 upsert。 */
  async logDaily(
    actorId: string,
    input: { date?: string; pain?: number; mood?: string; symptoms?: string[]; note?: string } = {},
  ): Promise<PeriodDailyLog> {
    const date = normalizeDateKey(input.date, this.now());
    if (!date) {
      throw new Error(`无法解析日期：${input.date}`);
    }
    const store = this.getStore(actorId);
    let log = store.logs.find((l) => l.date === date);
    if (!log) {
      log = {
        id: randomUUID(),
        date,
        createdAt: this.now().toISOString(),
      };
      store.logs.push(log);
      if (store.logs.length > 2_000) {
        store.logs.splice(0, store.logs.length - 2_000);
      }
    }
    if (typeof input.pain === "number") log.pain = clampPain(input.pain);
    if (input.mood) log.mood = input.mood;
    if (input.symptoms?.length) log.symptoms = dedupe([...(log.symptoms ?? []), ...input.symptoms]);
    if (input.note) log.note = input.note;
    this.schedulePersist(actorId);
    return log;
  }

  /** 更新提醒与预测偏好（传 undefined 的字段保持不变）。 */
  async updateSettings(
    actorId: string,
    patch: Partial<PeriodCareSettings>,
  ): Promise<PeriodCareSettings> {
    const store = this.getStore(actorId);
    if (patch.reminderEnabled != null) store.settings.reminderEnabled = Boolean(patch.reminderEnabled);
    if (patch.reminderDaysBefore != null) {
      store.settings.reminderDaysBefore = Math.max(0, Math.min(7, Math.round(patch.reminderDaysBefore)));
    }
    if (patch.reminderHour != null) {
      store.settings.reminderHour = Math.max(0, Math.min(23, Math.round(patch.reminderHour)));
    }
    if (patch.cycleLengthOverride != null) {
      const v = Math.round(patch.cycleLengthOverride);
      store.settings.cycleLengthOverride =
        v >= CYCLE_LENGTH_MIN && v <= CYCLE_LENGTH_MAX ? v : undefined;
    }
    if (patch.periodLengthOverride != null) {
      const v = Math.round(patch.periodLengthOverride);
      store.settings.periodLengthOverride = v >= 1 && v <= 14 ? v : undefined;
    }
    this.schedulePersist(actorId);
    return { ...store.settings };
  }

  // ─── 查询 ───────────────────────────────────────────────────────────

  getStatus(actorId: string): PeriodCycleStatus {
    const store = this.getStore(actorId);
    return this.computeStatus(store, this.now());
  }

  getHistory(actorId: string, limit = 12): PeriodCycleRecord[] {
    const store = this.getStore(actorId);
    return this.sortedCycles(store)
      .reverse()
      .slice(0, Math.max(1, Math.min(60, limit)));
  }

  getSettings(actorId: string): PeriodCareSettings {
    return { ...this.getStore(actorId).settings };
  }

  // ─── 预测核心（导出供测试） ──────────────────────────────────────────

  computeStatus(store: PeriodCareStore, now: Date): PeriodCycleStatus {
    const today = toLocalDateKey(now);
    const cycles = this.sortedCycles(store);
    const latest = cycles.at(-1);
    const settings = store.settings;

    // 周期长度样本：相邻开始日之差（与是否记录结束无关）
    const lengths: number[] = [];
    for (let i = 1; i < cycles.length; i += 1) {
      const len = daysBetween(cycles[i - 1].startDate, cycles[i].startDate);
      if (len >= CYCLE_LENGTH_MIN && len <= CYCLE_LENGTH_MAX) lengths.push(len);
    }
    const recentLengths = lengths.slice(-STATS_WINDOW);
    const medianLen = recentLengths.length > 0 ? median(recentLengths) : undefined;
    const effectiveLen = settings.cycleLengthOverride ?? medianLen;
    const confidence: PeriodCycleStatus["confidence"] = settings.cycleLengthOverride
      ? "high"
      : recentLengths.length >= 4
        ? "high"
        : recentLengths.length >= 2
          ? "medium"
          : "low";

    const status: PeriodCycleStatus = {
      hasData: cycles.length > 0,
      inPeriod: false,
      confidence,
      disclaimer:
        "以上为基于历史记录的估算，存在个体波动，非医学结论；如有持续不适请咨询专业医生。",
    };
    if (!latest) return status;

    status.latestStart = latest.startDate;
    status.latestEnd = latest.endDate;
    if (recentLengths.length > 0) {
      status.latestCycleLengthDays = recentLengths.at(-1);
      status.averageCycleLengthDays = medianLen;
    }

    const dayOffset = daysBetween(latest.startDate, today);
    if (dayOffset >= 0) status.cycleDay = dayOffset + 1;

    // 是否仍在经期：有结束日以结束日为准；否则用经期长度窗口兜底
    const periodLen = settings.periodLengthOverride ?? DEFAULT_PERIOD_LENGTH;
    status.inPeriod = latest.endDate
      ? today >= latest.startDate && today <= latest.endDate
      : dayOffset >= 0 && dayOffset < periodLen;

    if (effectiveLen != null) {
      const predicted = addDaysKey(latest.startDate, Math.round(effectiveLen));
      const spread =
        confidence === "low"
          ? 4
          : recentLengths.length >= 3
            ? Math.min(7, Math.max(1, Math.round((Math.max(...recentLengths) - Math.min(...recentLengths)) / 2)))
            : 2;
      status.predictedNextStart = predicted;
      status.predictedRangeDays = spread;
      status.daysUntilPredictedStart = daysBetween(today, predicted);
    }

    // 温和异常提示（非诊断；只提示「和平时不一样」，建议就医聊一聊）
    if (dayOffset > 60) {
      status.anomalyHint =
        "距离上次记录已经超过 60 天了。如果这不是换季/压力等已知原因，建议找妇科医生聊一聊——只是提醒，不代表有问题。";
    } else if (status.latestCycleLengthDays != null && (status.latestCycleLengthDays < 21 || status.latestCycleLengthDays > 45)) {
      status.anomalyHint =
        "最近这次周期长度和常见的 21-45 天范围不太一样。偶尔波动很常见，但如果连续几次都这样，可以考虑记录下来给医生看看（仅提醒，非诊断）。";
    }
    return status;
  }

  // ─── 主动提醒调度 ────────────────────────────────────────────────────

  /** 启动每分钟 tick（幂等；定时器 unref 不吊进程）。 */
  start(): void {
    if (this.timer || this.running) return;
    this.running = true;
    this.timer = setInterval(() => {
      if (!this.running) return;
      void this.runDue(this.now()).catch((e) =>
        console.error("[PeriodCare] runDue failed:", e),
      );
    }, 60_000);
    this.timer.unref?.();
  }

  stop(): void {
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * 扫描到期的经期临近提醒。公开便于测试直接注入时间。
   * @returns 实际发送的提醒条数
   */
  async runDue(now: Date): Promise<number> {
    const pipeline = this.deps.getPipeline();
    if (!pipeline) return 0;
    const today = toLocalDateKey(now);
    let fired = 0;
    for (const [actorId, store] of this.stores) {
      const settings = store.settings;
      if (!settings.reminderEnabled) continue;
      const status = this.computeStatus(store, now);
      if (!status.predictedNextStart) continue;
      if ((status.daysUntilPredictedStart ?? 99) > settings.reminderDaysBefore) continue;
      // 提醒日 = 预测开始日前 N 天；仅当天、且到点后发（过点补发当日内有效）
      const reminderDate = addDaysKey(status.predictedNextStart, -settings.reminderDaysBefore);
      if (today !== reminderDate) continue;
      if (now.getHours() < settings.reminderHour) continue;
      const key = `pre:${actorId}:${reminderDate}`;
      if (store.sentReminderKeys.includes(key)) continue;

      const text = this.buildReminderText(settings.reminderDaysBefore, status);
      pipeline.submitProposal({
        proposalId: `p_${Date.now().toString(36)}_periodcare`,
        actorId,
        kind: "period_care",
        tier: "must",
        importance: "medium",
        dedupKey: key,
        title: "贴心提醒",
        summary: text,
        evidence: [
          `predictedNextStart=${status.predictedNextStart}`,
          `confidence=${status.confidence}`,
        ],
        directText: text,
        createdAt: now.getTime(),
        expiresAt: now.getTime() + 12 * 3_600_000,
        source: "time",
      });
      store.sentReminderKeys.push(key);
      if (store.sentReminderKeys.length > 20) {
        store.sentReminderKeys.splice(0, store.sentReminderKeys.length - 20);
      }
      this.schedulePersist(actorId);
      fired += 1;
    }
    return fired;
  }

  /** 提醒文案：给选项不给指令，不说教；置信度低时附带校准邀请。 */
  private buildReminderText(daysBefore: number, status: PeriodCycleStatus): string {
    const when =
      daysBefore <= 0 ? "可能就是这几天" : `预计 ${daysBefore} 天后（${status.predictedNextStart} 前后）`;
    const parts = [
      `根据最近的记录，你的生理期${when}可能开始。需要的话我可以帮你留意，也要不要提前备点常用的东西？`,
    ];
    if (status.confidence === "low") {
      parts.push("另外现在记录还不多，预测未必准——之后每次经期的开始和结束随手告诉我一声，会越估越准。");
    }
    return parts.join("");
  }

  // ─── 内部 ───────────────────────────────────────────────────────────

  private getStore(actorId: string): PeriodCareStore {
    let store = this.stores.get(actorId);
    if (!store) {
      store = {
        version: 1,
        cycles: [],
        logs: [],
        settings: { ...DEFAULT_SETTINGS },
        sentReminderKeys: [],
      };
      this.stores.set(actorId, store);
      this.schedulePersist(actorId);
    }
    return store;
  }

  private normalizeStore(raw: Partial<PeriodCareStore>): PeriodCareStore {
    return {
      version: 1,
      cycles: Array.isArray(raw.cycles) ? raw.cycles : [],
      logs: Array.isArray(raw.logs) ? raw.logs : [],
      settings: { ...DEFAULT_SETTINGS, ...(raw.settings ?? {}) },
      sentReminderKeys: Array.isArray(raw.sentReminderKeys) ? raw.sentReminderKeys : [],
    };
  }

  private sortedCycles(store: PeriodCareStore): PeriodCycleRecord[] {
    return [...store.cycles].sort((a, b) => a.startDate.localeCompare(b.startDate));
  }

  private normalizeFlow(flow: string): "light" | "medium" | "heavy" {
    const v = flow.trim().toLowerCase();
    if (v === "light" || v === "少" || v === "偏少") return "light";
    if (v === "heavy" || v === "多" || v === "偏多" || v === "量大") return "heavy";
    return "medium";
  }

  private schedulePersist(actorId: string): void {
    this.dirty.add(actorId);
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      void this.flush();
    }, 1_000);
    this.persistTimer.unref?.();
  }
}

function clampPain(pain: number): number {
  return Math.max(0, Math.min(10, Math.round(pain)));
}

function dedupe(values: string[]): string[] {
  return Array.from(new Set(values.map((v) => v.trim()).filter(Boolean)));
}
