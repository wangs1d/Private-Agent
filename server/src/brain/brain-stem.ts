// Agent Brain Center — BrainStem（脑干）
//
// 职责：自主节律调度。像脑干维持呼吸/心跳一样,维持 Agent 的持续感知节律。
// 不调 LLM,纯规则 + 定时器,产出合成 LifeSignal 回流 hub,触发 ProactionCortex 决策。
//
// 核心机制：
//  1. 心跳扫描（45s,unref 不阻塞进程退出）：遍历所有已知 actor,复查持续状态。
//  2. 持续状态检测（应当察觉但无显式外部信号的模式）：
//     - sustained_busy：用户持续忙碌超过 90 分钟（该提醒休息了）
//     - late_night_active：深夜仍在使用电脑
//  3. 趋势消费：读取 LifeSignalHub 的 evidenceWindow,当出现 turningPoints + 翻转时,
//     产出 trend_reversal 信号（如市场从 rising 翻转到 falling）。
//  4. 合成信号回流：以上检测命中时,以 source: "agent_inference" 发布回 hub,
//     由 LifeSignalHub 分发给 AwarenessCortex / ProactionCortex,形成"自己察觉"的闭环。
//  5. 重复抑制：同 actor 同 kind 合成信号在 30 分钟内不重复发布。
//
// 设计要点：
//  - 脑干不负责认知决策（皮层职责）,只负责"维持节律 + 察觉异常 + 回流信号"。
//  - busy 持续时间由脑干自己维护（busySince 映射）,不依赖 AwarenessCortex 的 occurredAt。
//  - 已知 actor 集合通过订阅 hub 自动累积,无需外部注册。

import type { LifeSignal, LifeSignalEvidenceWindow } from "../services/life-signal-types.js";
import type { BehaviorBaseline } from "../services/user-personalization/user-personalization-service.js";
import type {
  SensoryLookResult,
  UserActivityKind,
  UserActivityState,
  VisualInput,
} from "./types.js";

// ---- 子系统最小化接口 --------------------------------------------------

type LifeSignalSubscriber = (signal: LifeSignal) => Promise<void> | void;

/** LifeSignalHubService 的最小化结构接口（BrainStem 实际用到的方法） */
export interface BrainStemHubLike {
  subscribe(subscriber: LifeSignalSubscriber): () => void;
  recentSignals(actorId: string, limit?: number): LifeSignal[];
  getEvidenceWindow(actorId: string): LifeSignalEvidenceWindow;
  publish(signal: LifeSignal): void;
}

/** AwarenessCortex 的最小化结构接口（BrainStem 只需 observe 读当前活动状态） */
export interface BrainStemAwarenessLike {
  observe(actorId: string): UserActivityState | null;
}

/**
 * SensoryCortex 的最小化结构接口。
 * BrainStem 周期性视觉感知只用到 look()：触发截屏 + VLM 描述。
 */
export interface BrainStemSensoryLike {
  look(opts?: VisualInput): Promise<SensoryLookResult>;
}

/** UserPersonalizationService 的最小化结构接口（BrainStem 只需 getBehaviorBaseline 读行为基线） */
export interface BrainStemUserPersonalizationLike {
  getBehaviorBaseline(actorId: string): BehaviorBaseline;
}

/** 行为预测结果：基于行为基线推断用户即将执行的动作 */
export type PredictedAction = {
  action: string;
  confidence: number;
  predictedTime: string;
};

// ---- 常量 --------------------------------------------------------------

/** 心跳扫描间隔（45 秒）—— idle 默认采样率 */
const SWEEP_INTERVAL_MS = 45_000;
/** busy 状态下降采样间隔（90 秒）—— 用户忙碌时降低打扰 */
const BUSY_SAMPLE_MS = 90_000;
/** meeting / in_focus 状态采样间隔（120 秒）—— 会议/深度专注时适度降采样 */
const FOCUS_SAMPLE_MS = 120_000;
/** sleeping 状态深度降采样间隔（300 秒）—— 用户睡眠时大幅降低采样 */
const SLEEPING_SAMPLE_MS = 300_000;
/**
 * 持续 busy 阈值：超过该时长 → sustained_busy 信号。默认 90 分钟。
 * 可通过 BRAIN_STEM_SUSTAINED_BUSY_MS 环境变量覆盖（毫秒，测试用）。
 * 运行时读取，便于测试在 sweep 前动态调整。
 */
function getSustainedBusyMs(): number {
  const env = process.env.BRAIN_STEM_SUSTAINED_BUSY_MS;
  const parsed = env != null ? parseInt(env, 10) : NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 90 * 60_000;
}
/** 深夜活动判定：最近桌面信号在 10 分钟内 */
const LATE_NIGHT_RECENT_MS = 10 * 60_000;
/** 同 kind 合成信号重复抑制窗口（30 分钟） */
const SUPPRESS_SAME_KIND_MS = 30 * 60_000;
/** recentSignals 拉取条数 */
const SWEEP_SIGNAL_LIMIT = 50;
/**
 * 周期性视觉感知最小间隔（5 分钟）。
 * busy 时每 5 分钟调一次 SensoryCortex.look() + describe() 获取屏幕描述，
 * sleeping/idle 不调（节省 VLM 成本）。
 */
const VISUAL_CHECK_INTERVAL_MS = 5 * 60_000;

// ---- BrainStem ---------------------------------------------------------

/**
 * 脑干：自主节律调度层。
 *
 * 维持 Agent 的持续感知节律,不依赖外部信号触发——像脑干维持呼吸一样,
 * 周期性扫描用户状态与信号趋势,察觉"应当被发现但无显式信号"的模式,
 * 产出合成 LifeSignal 回流 hub,让 Agent 具备自发的持续感知能力。
 */
export class BrainStem {
  private hub: BrainStemHubLike | null = null;
  private awareness: BrainStemAwarenessLike | null = null;
  private sensory: BrainStemSensoryLike | null = null;
  private userPersonalizationService: BrainStemUserPersonalizationLike | null = null;
  private unsubscribe: (() => void) | null = null;
  private sweepTimer: NodeJS.Timeout | null = null;
  private started = false;
  /** 当前心跳采样间隔（ms）—— 由 adjustSampleRate 按用户活动状态动态调整 */
  private currentSampleInterval: number = SWEEP_INTERVAL_MS;

  /** 已知 actor 集合（通过订阅 hub 自动累积） */
  private readonly knownActors = new Set<string>();
  /** actor → busy 状态开始时间戳（ms）;非 busy 时清除 */
  private readonly busySince = new Map<string, number>();
  /** "actorId:kind" → 上次合成信号时间戳（ms）;用于重复抑制 */
  private readonly lastSyntheticAt = new Map<string, number>();
  /** "actorId:action" → 上次预测时间戳（ms）;用于预测信号按动作去重（30 分钟） */
  private readonly lastPredictionTime = new Map<string, number>();
  /** actor → 上次周期性视觉感知时间戳（ms）;用于控制 look() 调用频率（5 分钟） */
  private readonly lastVisualCheck = new Map<string, number>();
  /** 统计：累计发出的合成信号数 */
  private syntheticEmitted = 0;
  /** 最近一次扫描时间 */
  private lastSweepAt: string | null = null;

  // ---- 注册 ------------------------------------------------------------

  registerLifeSignalHub(hub: BrainStemHubLike): void {
    this.hub = hub;
    console.log("[BrainStem] 已注册 LifeSignalHub");
  }

  registerAwareness(a: BrainStemAwarenessLike): void {
    this.awareness = a;
    console.log("[BrainStem] 已注册 AwarenessCortex");
  }

  /** 注册感官皮层，使心跳扫描时能调 look() 获取屏幕描述 */
  registerSensory(s: BrainStemSensoryLike): void {
    this.sensory = s;
    console.log("[BrainStem] 已注册 SensoryCortex");
  }

  registerUserPersonalization(s: BrainStemUserPersonalizationLike): void {
    this.userPersonalizationService = s;
    console.log("[BrainStem] 已注册 UserPersonalizationService");
  }

  // ---- 生命周期 --------------------------------------------------------

  async start(): Promise<void> {
    if (this.started) {
      console.log("[BrainStem] 已启动,跳过重复 start");
      return;
    }
    if (this.hub) {
      this.unsubscribe = this.hub.subscribe((signal) => {
        if (signal.actorId) this.knownActors.add(signal.actorId);
      });
      console.log("[BrainStem] 已订阅 LifeSignalHub（累积已知 actor）");
    } else {
      console.log("[BrainStem] LifeSignalHub 未注册,心跳仍运行但无已知 actor");
    }
    this.currentSampleInterval = SWEEP_INTERVAL_MS;
    this.sweepTimer = setInterval(() => {
      void this.sweepOnce().catch((e) => {
        console.error("[BrainStem] sweep 异常:", e);
      });
    }, this.currentSampleInterval);
    this.sweepTimer.unref?.();
    this.started = true;
    console.log("[BrainStem] 启动完成（心跳间隔 %ds）", this.currentSampleInterval / 1000);
  }

  async stop(): Promise<void> {
    if (!this.started) {
      console.log("[BrainStem] 未启动,跳过 stop");
      return;
    }
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.sweepTimer) {
      clearTimeout(this.sweepTimer);
      this.sweepTimer = null;
    }
    this.busySince.clear();
    this.lastVisualCheck.clear();
    this.started = false;
    console.log("[BrainStem] 已停止");
  }

  // ---- 心跳扫描 --------------------------------------------------------

  /** 立即触发一次全量扫描（测试/外部触发用） */
  async sweepOnce(): Promise<void> {
    this.lastSweepAt = new Date().toISOString();
    if (this.knownActors.size === 0) return;
    for (const actorId of this.knownActors) {
      try {
        this.sweepActor(actorId);
      } catch (e) {
        console.error(`[BrainStem] sweepActor ${actorId} 失败:`, e);
      }
    }
    // 感知预算：扫描结束后根据用户活动状态动态调整心跳采样率。
    this.observeAndAdjustSampleRate();
  }

  /**
   * 扫描结束后观察用户活动状态并调整心跳采样率。
   * awareness 未注册或 observe 返回 null 时保持当前 interval 不变（降级安全）。
   * 与 sweepActor 内部的 awareness.observe 用法保持一致：遍历所有已知 actor。
   */
  private observeAndAdjustSampleRate(): void {
    if (!this.awareness) return;
    // 多 actor 场景取最近一次非空状态作为采样率依据（典型场景下单 actor）。
    let latestState: UserActivityState | null = null;
    for (const actorId of this.knownActors) {
      try {
        const state = this.awareness.observe(actorId);
        if (state) latestState = state;
      } catch (e) {
        console.error(`[BrainStem] awareness.observe ${actorId} 失败:`, e);
      }
    }
    if (latestState) {
      this.adjustSampleRate(latestState.activity);
    }
  }

  /**
   * 根据用户活动状态调整心跳采样率（感知预算机制）。
   *  - busy → 90s（BUSY_SAMPLE_MS）：降采样,避免打扰
   *  - meeting / in_focus → 120s（FOCUS_SAMPLE_MS）：会议/深度专注时适度降采样
   *  - sleeping → 300s（SLEEPING_SAMPLE_MS）：深度降采样
   *  - idle / unknown / just_off_work / going_out → 45s（SWEEP_INTERVAL_MS）
   *
   * 状态对应间隔未变化时跳过重排,避免无谓的 clearInterval/setInterval。
   * 未启动或无 sweepTimer 时仅更新 currentSampleInterval,下次 start 生效。
   */
  adjustSampleRate(activityState: UserActivityKind): void {
    const newInterval =
      activityState === "busy" ? BUSY_SAMPLE_MS :
      activityState === "meeting" || activityState === "in_focus" ? FOCUS_SAMPLE_MS :
      activityState === "sleeping" ? SLEEPING_SAMPLE_MS :
      SWEEP_INTERVAL_MS;
    if (newInterval === this.currentSampleInterval) return;
    const prev = this.currentSampleInterval;
    this.currentSampleInterval = newInterval;
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = setInterval(() => {
        void this.sweepOnce().catch((e) => {
          console.error("[BrainStem] sweep 异常:", e);
        });
      }, newInterval);
      this.sweepTimer.unref?.();
    }
    console.log(
      "[BrainStem] 采样率调整: %ds -> %ds (activity=%s)",
      prev / 1000,
      newInterval / 1000,
      activityState,
    );
  }

  /** 单个 actor 的扫描：持续状态 + 深夜 + 趋势翻转 */
  private sweepActor(actorId: string): void {
    if (!this.hub) return;
    const now = Date.now();
    const signals = this.hub.recentSignals(actorId, SWEEP_SIGNAL_LIMIT);
    if (signals.length === 0) {
      this.busySince.delete(actorId);
      return;
    }

    // 1. 持续 busy 检测（自己维护 busy 开始时间,不依赖 awareness.occurredAt）
    const activity = this.awareness?.observe(actorId);
    if (activity?.activity === "busy") {
      if (!this.busySince.has(actorId)) {
        this.busySince.set(actorId, now);
      }
      const since = this.busySince.get(actorId);
      const sustainedBusyMs = getSustainedBusyMs();
      if (since !== undefined && now - since >= sustainedBusyMs) {
        const minutes = Math.round((now - since) / 60_000);
        this.emitSynthetic(actorId, {
          kind: "sustained_busy",
          title: "持续工作较久",
          summary: `用户已持续忙碌约 ${minutes} 分钟,该歇会儿了`,
          importance: "medium",
          tags: ["sustained_busy", "care", "break_reminder"],
          evidence: [`busy 状态持续 ${minutes} 分钟`, `阈值 ${sustainedBusyMs / 60_000} 分钟`],
        });
      }
    } else {
      this.busySince.delete(actorId);
    }

    // 2. 深夜活动检测（23:00-5:00 + 最近桌面信号在 10 分钟内）
    const hour = new Date().getHours();
    if (hour >= 23 || hour <= 5) {
      const recentDesktop = signals.filter(
        (s) => s.source === "desktop" || s.kind.startsWith("desktop_"),
      );
      if (recentDesktop.length > 0) {
        const lastT = Date.parse(recentDesktop[recentDesktop.length - 1].occurredAt);
        if (Number.isFinite(lastT) && now - lastT < LATE_NIGHT_RECENT_MS) {
          this.emitSynthetic(actorId, {
            kind: "late_night_active",
            title: "深夜仍在活动",
            summary: "用户深夜仍在使用电脑,留意休息",
            importance: "medium",
            tags: ["late_night", "care"],
            evidence: [`当前时段 ${hour}:00`, "最近桌面信号在 10 分钟内"],
          });
        }
      }
    }

    // 3. 趋势翻转检测（消费 evidenceWindow,这是 hub 已算出但未被消费的数据）
    try {
      const win = this.hub.getEvidenceWindow(actorId);
      if (win.turningPoints > 0 && win.reversalDirection) {
        this.emitSynthetic(actorId, {
          kind: `trend_reversal_${win.reversalDirection}`,
          title: "信号趋势翻转",
          summary: `检测到趋势翻转（${win.reversalDirection}）,转折点 ${win.turningPoints} 个`,
          importance: "high",
          tags: ["trend_reversal", win.reversalDirection],
          evidence: [
            `turningPoints=${win.turningPoints}`,
            `reversalDirection=${win.reversalDirection}`,
            `slopeScore=${win.slopeScore}`,
          ],
        });
      }
    } catch {
      // getEvidenceWindow 失败不阻塞扫描
    }

    // 4. 行为预测：基于行为基线预测用户下一步动作,命中则合成 predicted_action 信号回流。
    //    重复抑制由 predictNextAction（按 action 去重）+ emitSynthetic（按 kind 去重）共同保证。
    const prediction = this.predictNextAction(actorId);
    if (prediction) {
      const emitted = this.emitSynthetic(actorId, {
        kind: "predicted_action",
        title: "预测用户即将动作",
        summary: `预测：${prediction.action}（置信度 ${(prediction.confidence * 100).toFixed(0)}%），预计 ${prediction.predictedTime}`,
        importance: "medium",
        tags: ["predicted_action", "agent_inference"],
        evidence: [
          `action=${prediction.action}`,
          `confidence=${prediction.confidence.toFixed(2)}`,
          `predictedTime=${prediction.predictedTime}`,
        ],
        metadata: {
          action: prediction.action,
          confidence: prediction.confidence,
          predictedTime: prediction.predictedTime,
        },
      });
      if (!emitted) {
        // emitSynthetic 因 kind 级抑制未发布时,回退本次 predictNextAction 标记,允许下次重试。
        this.lastPredictionTime.delete(`${actorId}:${prediction.action}`);
      }
    }

    // 5. 周期性视觉感知：busy 时调 SensoryCortex.look() + describe() 获取屏幕描述，
    //    发布为 desktop_app_focus 信号；sleeping/idle 不调（节省 VLM 成本）。
    //    同 actor 在 VISUAL_CHECK_INTERVAL_MS（5 分钟）内不重复调用。
    //    异步触发不阻塞本次扫描。
    void this.periodicVisualCheck(actorId, activity?.activity).catch((e) => {
      console.error(`[BrainStem] periodicVisualCheck ${actorId} 异常:`, e);
    });
  }

  // ---- 合成信号回流 ----------------------------------------------------

  /**
   * 发布合成 LifeSignal 回流 hub。
   * 重复抑制：同 actor 同 kind 在 SUPPRESS_SAME_KIND_MS 内不重复发布。
   * 返回是否实际发布（未注册 hub 或被重复抑制时返回 false）。
   */
  private emitSynthetic(
    actorId: string,
    def: {
      kind: string;
      title: string;
      summary: string;
      importance: "low" | "medium" | "high" | "critical";
      tags: string[];
      evidence: string[];
      metadata?: Record<string, unknown>;
    },
  ): boolean {
    if (!this.hub) return false;
    const key = `${actorId}:${def.kind}`;
    const last = this.lastSyntheticAt.get(key);
    if (last !== undefined && Date.now() - last < SUPPRESS_SAME_KIND_MS) {
      return false; // 重复抑制
    }
    const signal: LifeSignal = {
      id: `brainstem:${actorId}:${def.kind}:${Date.now()}`,
      actorId,
      source: "agent_inference",
      kind: def.kind,
      title: def.title,
      summary: def.summary,
      tags: def.tags,
      importance: def.importance,
      evidence: def.evidence,
      metadata: def.metadata,
      occurredAt: new Date().toISOString(),
    };
    this.hub.publish(signal);
    this.lastSyntheticAt.set(key, Date.now());
    this.syntheticEmitted += 1;
    console.log(`[BrainStem] 合成信号回流: ${def.kind} -> ${actorId} (${def.title})`);
    return true;
  }

  // ---- 周期性视觉感知 --------------------------------------------------

  /**
   * 周期性视觉感知：busy 时调 SensoryCortex.look() 获取屏幕截图 + VLM 描述，
   * 将描述发布为 desktop_app_focus 信号回流 hub。
   *
   * 调用频率控制：
   *  - busy 时每 VISUAL_CHECK_INTERVAL_MS（5 分钟）调一次
   *  - sleeping / idle / unknown 等非 busy 状态不调（节省 VLM 成本）
   *  - sensoryCortex 未注册或 look() 失败时不阻塞后续扫描
   *
   * 发布的信号 source="desktop"（区别于 agent_inference 合成信号），
   * kind="desktop_app_focus"，metadata 携带 VLM 描述。
   */
  private async periodicVisualCheck(
    actorId: string,
    activityState: UserActivityKind | undefined,
  ): Promise<void> {
    if (!this.sensory) return;
    // 仅 busy 时触发视觉感知；sleeping / idle 等不调，节省 VLM 成本
    if (activityState !== "busy") return;
    const now = Date.now();
    const last = this.lastVisualCheck.get(actorId);
    if (last !== undefined && now - last < VISUAL_CHECK_INTERVAL_MS) {
      return; // 5 分钟内已调过
    }
    this.lastVisualCheck.set(actorId, now);

    let result: SensoryLookResult;
    try {
      result = await this.sensory.look();
    } catch (e) {
      console.error(`[BrainStem] sensory.look 调用失败 ${actorId}:`, e);
      return;
    }
    if (result.error) {
      console.log(`[BrainStem] periodicVisualCheck ${actorId} look 失败: ${result.error}`);
      return;
    }
    const description = result.description?.trim();
    if (!description) return; // 无 VLM 描述，无可发布内容
    if (!this.hub) return;

    const signal: LifeSignal = {
      id: `brainstem:${actorId}:desktop_app_focus:${now}`,
      actorId,
      source: "desktop",
      kind: "desktop_app_focus",
      title: "桌面应用焦点",
      summary: description,
      tags: ["desktop_app_focus", "visual"],
      importance: "low",
      evidence: [`visual_description=${description.slice(0, 200)}`],
      metadata: {
        description,
        ...(result.screenshot ? { screenshot: result.screenshot } : {}),
      },
      occurredAt: new Date().toISOString(),
    };
    this.hub.publish(signal);
    console.log(`[BrainStem] 周期视觉感知: desktop_app_focus -> ${actorId}`);
  }

  // ---- 行为预测 --------------------------------------------------------

  /**
   * 基于行为基线预测用户下一步动作。
   *
   * 读取 UserPersonalizationService 的行为基线（activePeriods /
   * hourlyActivityProbability），在"预测窗口"（当前时间到未来 5 分钟）内
   * 查找高概率动作：
   *  - 当前小时最后 5 分钟（minute >= 55）且下一小时是某个活跃时段起点
   *    → 预测"进入活跃工作时段"，预测时间点为下一整点
   *  - 当前小时是某个活跃时段起点且 minute < 5
   *    → 预测"开始工作"，预测时间点为当前时间
   *
   * 重复抑制：同 actor 同 action 在 SUPPRESS_SAME_KIND_MS 内只预测一次
   * （通过 lastPredictionTime 维护，按动作去重）。
   * 数据不足（sampleCount < 7）时不预测，避免噪声。
   */
  private predictNextAction(actorId: string): PredictedAction | null {
    const baseline = this.userPersonalizationService?.getBehaviorBaseline(actorId);
    if (!baseline || baseline.sampleCount < 7) return null;
    const now = new Date();
    const currentHour = now.getHours();
    const currentMinute = now.getMinutes();

    let action = "";
    let confidence = 0;
    let predictedTime = "";
    for (const period of baseline.activePeriods) {
      if (period.start === currentHour + 1 && currentMinute >= 55) {
        // 下一小时是活跃时段起点，当前 55+ 分钟 → 预测即将进入活跃时段
        const next = new Date(now);
        next.setHours(period.start, 0, 0, 0);
        action = "进入活跃工作时段";
        confidence = baseline.hourlyActivityProbability[period.start] ?? 0;
        predictedTime = next.toISOString();
        break;
      }
      if (period.start === currentHour && currentMinute < 5) {
        // 当前小时刚开始活跃时段（前 5 分钟）→ 预测开始工作
        action = "开始工作";
        confidence = baseline.hourlyActivityProbability[period.start] ?? 0;
        predictedTime = now.toISOString();
        break;
      }
    }
    if (!action) return null;

    // 重复抑制：同 actor 同 action 30 分钟内不重复预测
    const key = `${actorId}:${action}`;
    const last = this.lastPredictionTime.get(key);
    if (last !== undefined && Date.now() - last < SUPPRESS_SAME_KIND_MS) {
      return null;
    }
    this.lastPredictionTime.set(key, Date.now());

    return { action, confidence, predictedTime };
  }

  // ---- 快照 ------------------------------------------------------------

  /** 返回脑干状态快照（供 BrainCenter.snapshot 使用） */
  snapshot(): {
    lastSweepAt: string | null;
    syntheticSignalsEmitted: number;
    activeActors: number;
  } {
    return {
      lastSweepAt: this.lastSweepAt,
      syntheticSignalsEmitted: this.syntheticEmitted,
      activeActors: this.knownActors.size,
    };
  }
}
