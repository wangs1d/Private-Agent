import { buildInsights } from "./insights.js";
import { RhythmProfileStore, normalizeProfile } from "./profile-store.js";
import {
  EMPTY_FOCUS_STATE,
  FocusDimensionModel,
} from "./dimensions/focus-model.js";
import {
  EMPTY_OVERTIME_STATE,
  OvertimeDimensionModel,
} from "./dimensions/overtime-model.js";
import {
  EMPTY_RECEPTIVITY_STATE,
  ReceptivityDimensionModel,
} from "./dimensions/receptivity-model.js";
import { EMPTY_SLEEP_STATE, SleepDimensionModel } from "./dimensions/sleep-model.js";

import type {
  RhythmConsumer,
  RhythmDimension,
  RhythmDimensionModel,
  RhythmDimensionStates,
  RhythmInsight,
  RhythmObservation,
  RhythmProfile,
  RhythmProfileUpdate,
  RhythmSensor,
  ReminderFeedbackOutcome,
} from "./types.js";

const FEEDBACK_VALUE: Record<ReminderFeedbackOutcome, number> = {
  accepted: 1,
  replied: 1,
  snoozed: 0.5,
  dismissed: 0,
  ignored: 0,
};
const SLOT_EWMA_ALPHA = 0.4;
const MAX_PUSH_BUFFER = 200;

export type LifeRhythmEngineOptions = {
  profileStore: RhythmProfileStore;
  /** 注入自定义模型器（测试用）；缺省注册全部内置四维度模型器 */
  dimensionModels?: RhythmDimensionModel[];
};

/**
 * 生活节律引擎中枢：节律画像的唯一所有者。
 *
 * - 传感器边界：registerSensor()，夜间批处理时拉取观察
 * - 模型层：按维度注册 RhythmDimensionModel，纯统计建模
 * - 消费方边界：subscribe()，画像变更后消费方各自落权（重排提醒 / 回填
 *   receptiveHours / 关怀 candidate / WS 通知）
 *
 * 引擎不做"现在该不该打扰"的决策，也不直接发消息。
 */
export class LifeRhythmEngine {
  private readonly sensors: RhythmSensor[] = [];
  private readonly models = new Map<RhythmDimension, RhythmDimensionModel>();
  private readonly consumers: RhythmConsumer[] = [];
  /** 在线推送的观察缓冲（recordContactOutcome），随下次 runAnalysis 消费 */
  private readonly pushedObservations = new Map<string, RhythmObservation[]>();
  private running = false;

  constructor(private readonly opts: LifeRhythmEngineOptions) {
    const models = opts.dimensionModels ?? [
      new SleepDimensionModel(),
      new FocusDimensionModel(),
      new OvertimeDimensionModel(),
      new ReceptivityDimensionModel(),
    ];
    for (const model of models) {
      this.models.set(model.dimension, model as RhythmDimensionModel);
    }
  }

  registerSensor(sensor: RhythmSensor): void {
    this.sensors.push(sensor);
  }

  subscribe(consumer: RhythmConsumer): () => void {
    this.consumers.push(consumer);
    return () => {
      const idx = this.consumers.indexOf(consumer);
      if (idx >= 0) this.consumers.splice(idx, 1);
    };
  }

  getProfile(actorId: string): RhythmProfile | null {
    return this.opts.profileStore.get(actorId);
  }

  listActorIds(): string[] {
    return this.opts.profileStore.listActorIds();
  }

  // ---- 在线写入接口（无需等夜间分析）----

  /** 触达结果回灌（bootstrap 从 UserPersonalizationService.observeContactOutcome 桥接） */
  recordContactOutcome(actorId: string, outcome: ReminderFeedbackOutcome, at = new Date()): void {
    const value = FEEDBACK_VALUE[outcome];
    if (value === undefined) return;
    this.pushObservation(actorId, {
      dimension: "receptivity",
      at: at.toISOString(),
      value,
      kind: "contact_outcome",
      source: "contact-feedback",
    });
  }

  /** 单个提醒任务的接受度回灌（ EWMA 在线更新，供重排消费方使用） */
  async recordReminderFeedback(
    actorId: string,
    taskId: string,
    outcome: ReminderFeedbackOutcome,
    at = new Date(),
  ): Promise<void> {
    const profile = this.opts.profileStore.ensure(actorId, at);
    const slot = profile.reminderSlots[taskId];
    if (!slot) return;
    const value = FEEDBACK_VALUE[outcome];
    slot.acceptanceEwma =
      slot.acceptanceEwma === null
        ? value
        : slot.acceptanceEwma * (1 - SLOT_EWMA_ALPHA) + value * SLOT_EWMA_ALPHA;
    slot.acceptanceEwma = Math.round(slot.acceptanceEwma * 1000) / 1000;
    slot.attempts += 1;
    profile.updatedAt = at.toISOString();
    await this.opts.profileStore.save(profile);
  }

  /** 重排消费方发现节律任务时登记槽位（originalHour 缺省取当前 hour） */
  async registerReminderSlot(
    actorId: string,
    taskId: string,
    hour: number,
    originalHour?: number,
  ): Promise<void> {
    const profile = this.opts.profileStore.ensure(actorId);
    const existing = profile.reminderSlots[taskId];
    if (existing) {
      existing.hour = hour;
    } else {
      profile.reminderSlots[taskId] = {
        taskId,
        hour,
        originalHour: originalHour ?? hour,
        acceptanceEwma: null,
        attempts: 0,
        lastAdjustedAt: null,
        lastAdjustDirection: null,
        pinnedByUser: false,
      };
    }
    await this.opts.profileStore.save(profile);
  }

  async markSlotAdjusted(
    actorId: string,
    taskId: string,
    newHour: number,
    direction: "earlier" | "later",
    at = new Date(),
  ): Promise<void> {
    const profile = this.opts.profileStore.ensure(actorId, at);
    const slot = profile.reminderSlots[taskId];
    if (!slot) return;
    slot.hour = newHour;
    slot.lastAdjustedAt = at.toISOString();
    slot.lastAdjustDirection = direction;
    await this.opts.profileStore.save(profile);
  }

  async pinReminderTask(actorId: string, taskId: string, pinned: boolean): Promise<void> {
    const profile = this.opts.profileStore.ensure(actorId);
    const slot = profile.reminderSlots[taskId];
    if (!slot) return;
    slot.pinnedByUser = pinned;
    await this.opts.profileStore.save(profile);
  }

  /** 洞察消费方（关怀 candidate）限频记账 */
  async markCandidateSent(actorId: string, dimension: RhythmDimension, at = new Date()): Promise<void> {
    const profile = this.opts.profileStore.ensure(actorId, at);
    profile.lastCandidateAt[dimension] = at.toISOString();
    await this.opts.profileStore.save(profile);
  }

  private pushObservation(actorId: string, obs: RhythmObservation): void {
    const list = this.pushedObservations.get(actorId) ?? [];
    list.push(obs);
    if (list.length > MAX_PUSH_BUFFER) list.splice(0, list.length - MAX_PUSH_BUFFER);
    this.pushedObservations.set(actorId, list);
  }

  // ---- 分析主循环 ----

  /**
   * 完整分析一轮：collect → ingest → insights → 持久化 → 通知消费方。
   * 幂等（观察按日/按事件去重由各模型器保证），可对同一 actor 重复调用。
   */
  async runAnalysis(actorId: string, ctx: { now?: Date; force?: boolean } = {}): Promise<RhythmProfileUpdate | null> {
    const now = ctx.now ?? new Date();
    if (this.running) return null;
    this.running = true;
    try {
      const profile = this.opts.profileStore.ensure(actorId, now);
      const since = profile.lastAnalyzedDay
        ? new Date(`${profile.lastAnalyzedDay}T00:00:00`)
        : new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

      // 1) 传感器拉取（单传感器失败不阻塞整体）
      const collected: RhythmObservation[] = [];
      for (const sensor of this.sensors) {
        try {
          const observations = await sensor.collect(actorId, since);
          if (Array.isArray(observations)) collected.push(...observations);
        } catch (error) {
          console.error(`[RhythmEngine] sensor ${sensor.id} collect failed:`, error);
        }
      }
      // 2) 在线推送的观察一并消费
      const pushed = this.pushedObservations.get(actorId) ?? [];
      this.pushedObservations.delete(actorId);
      collected.push(...pushed);

      // 3) 按维度分组喂给模型器
      const byDimension = new Map<RhythmDimension, RhythmObservation[]>();
      for (const obs of collected) {
        if (!this.models.has(obs.dimension)) continue;
        const list = byDimension.get(obs.dimension) ?? [];
        list.push(obs);
        byDimension.set(obs.dimension, list);
      }

      const changedDimensions: RhythmDimension[] = [];
      const confidences = {} as Record<RhythmDimension, number>;
      for (const [dimension, model] of this.models) {
        const prevState = (profile.dimensions as Record<string, unknown>)[dimension] ?? null;
        const nextState = model.ingest(prevState, byDimension.get(dimension) ?? [], { now });
        (profile.dimensions as Record<string, unknown>)[dimension] = nextState;
        confidences[dimension] = model.confidence(nextState);
        if (JSON.stringify(nextState) !== JSON.stringify(prevState)) {
          changedDimensions.push(dimension);
        }
      }

      // 4) 洞察（有变化的维度才重算；保留历史洞察）
      let insights = profile.insights;
      if (changedDimensions.length > 0 || ctx.force) {
        const fresh = buildInsights(profile.dimensions, { now });
        insights = mergeInsights(profile.insights, fresh);
        profile.insights = insights;
      }

      profile.updatedAt = now.toISOString();
      profile.lastAnalyzedDay = now.toISOString().slice(0, 10);
      await this.opts.profileStore.save(profile);

      const update: RhythmProfileUpdate = {
        actorId,
        changedDimensions,
        confidences,
        insights,
        profile,
      };
      for (const consumer of this.consumers) {
        try {
          await consumer(update);
        } catch (error) {
          console.error("[RhythmEngine] consumer failed:", error);
        }
      }
      return update;
    } finally {
      this.running = false;
    }
  }
}

/** 新洞察并入历史（同维度同 kind 保留最新一条），上限 20 */
function mergeInsights(
  prev: RhythmProfile["insights"],
  fresh: RhythmInsight[],
): RhythmProfile["insights"] {
  const merged = new Map<string, RhythmInsight>();
  for (const insight of prev) {
    merged.set(`${insight.dimension}:${insight.kind}`, insight);
  }
  for (const insight of fresh) {
    merged.set(`${insight.dimension}:${insight.kind}`, insight);
  }
  return [...merged.values()].slice(-20);
}

/** 缺省空状态（测试与诊断用） */
export function emptyDimensionStates(): RhythmDimensionStates {
  return {
    sleep: { ...EMPTY_SLEEP_STATE },
    focus: { ...EMPTY_FOCUS_STATE, hourHistogram: [...EMPTY_FOCUS_STATE.hourHistogram], peakBlocks: [] },
    overtime: {
      ...EMPTY_OVERTIME_STATE,
      byWeekday: [...EMPTY_OVERTIME_STATE.byWeekday],
      weekdayDays: [...EMPTY_OVERTIME_STATE.weekdayDays],
      recentDays: [],
    },
    receptivity: {
      ...EMPTY_RECEPTIVITY_STATE,
      byHour: [...EMPTY_RECEPTIVITY_STATE.byHour],
      byWeekday: [...EMPTY_RECEPTIVITY_STATE.byWeekday],
    },
  };
}

export { normalizeProfile };
