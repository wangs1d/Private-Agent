// 注意力仲裁器 V2（ArbiterV2）—— 五层主动性架构 L3 的落地。
//
// 核心立场：LLM 不参与裁决。仲裁 = 打断成本(确定性公式) × 事件紧迫度 的矩阵，
// 加上「pause 语义」——用户从专注/对话/会议中走出来的那一刻才投递挂起的事件，
// 这是「贾维斯等 Tony 停下来才开口」的工程实现。
//
// 与旧 arbiter.ts 的分工：旧仲裁器管管道内的静态规则（离线挂起/静默时段/去重），
// 本模块管「要不要现在打扰」这个更前置的问题；两个都过才真正发出去。
// ReachRouter（通道升级）与 AttentionStore（台账/ack 归一）保持不变。
import { ALERT_COST_BASE } from "./cost-calibrator.js";
import { isQuietHourNow, nextQuietEnd } from "./arbiter.js";
import type { PresenceService } from "./presence-service.js";
import type { ScreenFocusKind } from "./sensors/types.js";

/** 事件紧迫度（比 pipeline importance 更贴近"打断语义"的输入维度） */
export type AttentionUrgency = "interrupt" | "alert" | "normal" | "log";

export type ContextSnapshot = {
  now: Date;
  presence: "active" | "idle" | "offline";
  inConversation: boolean;
  /** null = 屏幕感知不可用（走无屏幕先验兜底） */
  screenFocus: ScreenFocusKind | null;
  /** 距下一个日程的分钟数；null = 今天没有日程 */
  nextEventMin: number | null;
  quietHours: boolean;
  /** 接受度 0-1（rhythm receptivity；无数据 0.5） */
  receptivity: number;
  /** 近 30min 已主动投递次数 */
  recentBurst: number;
};

export type ArbiterV2Deps = {
  presence: PresenceService;
  /** 最近一次对话轮时刻（ms）；null = 从未对话 */
  lastConversationAt: () => number | null;
  /** 当前屏幕专注分类（screen_sensor.latest()；不可用返回 null） */
  screenFocus: () => ScreenFocusKind | null;
  /** 距下一个日程分钟数（schedule_sensor.latest()） */
  nextEventMin: () => number | null;
  /** 接受度读取（rhythm receptivity；缺省 0.5） */
  receptivity?: (actorId: string) => number;
  /** pause 轮询的目标用户（缺省取当前在线列表首位） */
  primaryActorId?: () => string | null;
  /** alert 档中等成本阈值（CostCalibrator 动态提供；缺省 4.5 恒定） */
  alertMidThreshold?: () => number;
  /** 测试注入时钟 */
  nowFn?: () => number;
};

/** 打断成本各项权重（先验拍定；上线两周后可用 outcome 数据回归校准） */
export const COST_WEIGHTS = {
  inConversation: 3,
  meetingSoonMin: 3,
  meetingFocus: 4,
  coding: 3,
  chat: 2,
  video: 2,
  browsing: 1,
  office: 2,
  game: 2,
  music: 1,
  terminal: 3,
  idle: 0,
  absent: 0,
  lateNight: 3,
  /** (1 - receptivity) 的放大系数 */
  receptivityAmp: 2,
  /** 每次 recentBurst 的边际成本 */
  burst: 1,
  /** 离线时成本视为满分（投递本来就到不了，交给管道挂起） */
  offline: 10,
} as const;

const BURST_WINDOW_MS = 30 * 60_000;
/** burst 熔断：30min 内超过该次数后，alert/normal 全部只挂起不直投 */
const BURST_BREAKER = 5;
/** 挂起条目默认保质期 */
export const PARK_TTL: Record<Exclude<AttentionUrgency, "interrupt" | "log">, number> = {
  alert: 8 * 3600_000,
  normal: 2 * 3600_000,
};

/** 打断成本 0-10（纯函数，导出供单测与校准脚本） */
export function interruptCost(s: ContextSnapshot): number {
  if (s.presence === "offline") return 10;
  let cost = 0;
  if (s.inConversation) cost += COST_WEIGHTS.inConversation;
  switch (s.screenFocus) {
    case "meeting": cost += COST_WEIGHTS.meetingFocus; break;
    case "coding":
    case "terminal": cost += COST_WEIGHTS.coding; break;
    case "chat": cost += COST_WEIGHTS.chat; break;
    case "video": cost += COST_WEIGHTS.video; break;
    case "office":
    case "game": cost += COST_WEIGHTS.office; break;
    case "browsing":
    case "music": cost += COST_WEIGHTS.browsing; break;
    default: break; // idle/absent/null → 0
  }
  if (s.nextEventMin !== null && s.nextEventMin >= 0 && s.nextEventMin <= 10) {
    cost += COST_WEIGHTS.meetingSoonMin;
  }
  if (s.quietHours) cost += COST_WEIGHTS.lateNight;
  cost += (1 - clamp01(s.receptivity)) * COST_WEIGHTS.receptivityAmp;
  cost += s.recentBurst * COST_WEIGHTS.burst;
  return Math.max(0, Math.min(10, Math.round(cost * 10) / 10));
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, Number.isFinite(v) ? v : 0.5));
}

export type ArbiterAction = {
  action: "deliver_now" | "wait_for_pause" | "log";
  cost: number;
  reason: string;
};

/**
 * 纯裁决函数（导出供单测/selftest 预览，无副作用）。
 * alertMid：alert 档中等成本直投边界（默认 4.5；CostCalibrator 按 outcome
 * 接受率让它上下呼吸 ±0.5——用户接得积极就更敢说，连续忽略就收敛）。
 */
export function decideAction(
  urgency: AttentionUrgency,
  cost: number,
  burst: number,
  alertMid: number = ALERT_COST_BASE,
): ArbiterAction {
  if (urgency === "log") return { action: "log", cost, reason: "log_only" };
  if (burst >= BURST_BREAKER && urgency !== "interrupt") {
    return { action: "wait_for_pause", cost, reason: `burst_breaker(${burst})` };
  }
  if (urgency === "interrupt" || cost <= 3) {
    return { action: "deliver_now", cost, reason: cost <= 3 ? `low_cost(${cost})` : "interrupt" };
  }
  // alert（健康关怀/临会提醒/守约催办）：中等成本也放行——错过时机的关心没有价值；
  // normal（闲聊/兴趣/心跳）才严格等 pause。
  if (urgency === "alert" && cost <= alertMid) {
    return { action: "deliver_now", cost, reason: `alert_mid_cost(${cost})` };
  }
  return { action: "wait_for_pause", cost, reason: `high_cost(${cost})` };
}

export type ParkedEntry = {
  id: string;
  actorId: string;
  urgency: AttentionUrgency;
  label: string;
  deliver: () => void;
  expireAt: number;
  parkedAt: number;
};

export class ArbiterV2 {
  private readonly parked: ParkedEntry[] = [];
  private readonly deliveredAt: number[] = [];
  private lastCost = -1;
  /** 每 actor 的上下文基线（pause 跃迁检测的比对起点） */
  private readonly actorBaselines = new Map<
    string,
    {
      cost: number;
      inConversation: boolean;
      quietHours: boolean | null;
      screenFocus: ScreenFocusKind | null;
      presence: "active" | "idle" | "offline";
    }
  >();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly deps: ArbiterV2Deps) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), 30_000);
    if (typeof this.timer.unref === "function") this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** 当前上下文快照（诊断接口展示"为什么现在打扰/不打扰"） */
  snapshot(actorId: string, now: Date = new Date()): ContextSnapshot {
    const hour = now.getHours();
    const lastConv = this.deps.lastConversationAt();
    return {
      now,
      presence: this.deps.presence.getPresence(actorId, now.getTime()),
      inConversation:
        this.deps.presence.getPresence(actorId, now.getTime()) === "active" &&
        lastConv !== null &&
        now.getTime() - lastConv <= 90_000,
      screenFocus: this.deps.screenFocus(),
      nextEventMin: this.deps.nextEventMin(),
      quietHours: hour >= 23 || hour < 7,
      receptivity: this.deps.receptivity?.(actorId) ?? 0.5,
      recentBurst: this.recentBurstCount(),
    };
  }

  /**
   * 事件裁决入口：决定立即投递 / 挂起等 pause / 只记台账。
   * deliver 回调由调用方注入（通常 = pipeline.submitProposal）。
   */
  admit(input: {
    actorId: string;
    urgency: AttentionUrgency;
    label: string;
    deliver: () => void;
  }): ArbiterAction {
    const now = this.deps.nowFn?.() ?? Date.now();
    const s = this.snapshot(input.actorId, new Date(now));
    const cost = interruptCost(s);

    if (input.urgency === "log") {
      return { action: "log", cost, reason: "log_only" };
    }

    const decision = decideAction(input.urgency, cost, s.recentBurst, this.alertMid());
    if (decision.action === "deliver_now") {
      this.recordDelivery(now);
      input.deliver();
      return decision;
    }
    if (decision.action === "wait_for_pause") {
      // 挂起等 pause（alert 8h / normal 2h 保质期；静默时段顺延到静默结束）。
      // 同时建立该 actor 的上下文基线：pause 检测需要"挂起时的状态"作比对起点，
      // 否则下一次 tick 缺少前值，"会议散场才开口"永远差一拍。
      this.lastCost = cost;
      this.actorBaselines.set(input.actorId, {
        cost,
        inConversation: s.inConversation,
        quietHours: s.quietHours,
        screenFocus: s.screenFocus,
        presence: s.presence,
      });
      this.park(
        { ...input, id: `park_${now.toString(36)}_${input.label.slice(0, 24)}` },
        now,
      );
    }
    return decision;
  }

  /** 挂起队列（诊断展示） */
  parkedEntries(): Array<{ id: string; urgency: AttentionUrgency; label: string; parkedAt: number; expireAt: number }> {
    return this.parked.map((p) => ({
      id: p.id,
      urgency: p.urgency,
      label: p.label,
      parkedAt: p.parkedAt,
      expireAt: p.expireAt,
    }));
  }

  /** 立即执行一次 pause 检测（集成测试/诊断用；正常由 start 的定时器驱动） */
  forceTick(): void {
    this.tick();
  }

  /** 上次快照成本（诊断） */
  lastCostValue(): number {
    return this.lastCost;
  }

  /** 无副作用预览：当前上下文下某紧迫度事件的裁决（selftest/诊断用） */
  previewDecision(urgency: AttentionUrgency, actorId: string, now: Date = new Date()): ArbiterAction {
    const s = this.snapshot(actorId, now);
    const cost = interruptCost(s);
    return decideAction(urgency, cost, s.recentBurst, this.alertMid());
  }

  private alertMid(): number {
    return this.deps.alertMidThreshold?.() ?? ALERT_COST_BASE;
  }

  /**
   * pause 检测：上下文状态跃迁（对话结束/会议散场/专注降档/静默时段结束/
   * 成本从高跌破 3）时投递挂起队列的队首一条——"用户停下来的那一刻才开口"。
   */
  private tick(): void {
    const now = this.deps.nowFn?.() ?? Date.now();
    // 过期清理（全队列扫描；过期即作废，沉默由调用方台账承担）
    for (let i = this.parked.length - 1; i >= 0; i--) {
      if (this.parked[i].expireAt <= now) this.parked.splice(i, 1);
    }
    // 多 actor pause 检测：按挂起队列中出现的 distinct actor 逐个快照判定
    // （家庭/多设备场景下不同用户的上下文互不干扰）；单用户时等价原行为。
    const actorIds = [...new Set(this.parked.map((p) => p.actorId))];
    if (actorIds.length === 0) return;
    for (const actorId of actorIds) {
      this.detectPauseFor(actorId, now);
    }
  }

  /** 单 actor 的 pause 检测与放行（tick 的每-actor 体） */
  private detectPauseFor(actorId: string, now: number): void {
    const prev = this.actorBaselines.get(actorId) ?? {
      cost: -1,
      inConversation: false,
      quietHours: null as boolean | null,
      screenFocus: null as ScreenFocusKind | null,
      presence: "active" as "active" | "idle" | "offline",
    };
    const s = this.snapshot(actorId, new Date(now));
    const cost = interruptCost(s);

    const paused =
      (prev.inConversation && !s.inConversation) ||
      (prev.screenFocus === "meeting" && s.screenFocus !== "meeting") ||
      (prev.quietHours === true && !s.quietHours) ||
      // 用户离开后回归（idle/offline → active）：回来本身就是开口时机
      ((prev.presence === "idle" || prev.presence === "offline") && s.presence === "active") ||
      (prev.cost > 4.5 && cost <= 3);

    this.actorBaselines.set(actorId, {
      cost,
      inConversation: s.inConversation,
      quietHours: s.quietHours,
      screenFocus: s.screenFocus,
      presence: s.presence,
    });
    // 兼容旧诊断字段（lastCostValue）
    this.lastCost = cost;

    if (paused && cost <= 4.5) {
      // 取该 actor 紧迫度最高的队首一条投递（同紧迫度 FIFO），其余等下一次 pause
      const mine = this.parked
        .map((p, idx) => ({ p, idx }))
        .filter(({ p }) => p.actorId === actorId);
      if (mine.length === 0) return;
      const rank = { interrupt: 3, alert: 2, normal: 1, log: 0 } as const;
      let best = mine[0];
      for (const m of mine) {
        if (rank[m.p.urgency] > rank[best.p.urgency]) best = m;
      }
      this.parked.splice(best.idx, 1);
      this.recordDelivery(now);
      try {
        best.p.deliver();
      } catch {
        /* 投递回调失败不阻塞队列 */
      }
    }
  }

  private park(
    input: { actorId: string; urgency: AttentionUrgency; label: string; deliver: () => void; id: string },
    now: number,
  ): void {
    const ttl =
      input.urgency === "alert" ? PARK_TTL.alert : input.urgency === "normal" ? PARK_TTL.normal : 3600_000;
    let expireAt = now + ttl;
    // 静默时段挂起的事件留到静默结束（对齐管道 quiet_hours defer 语义）：
    // 晚上理好的事早上说，而不是 2h 后悄悄作废
    if (isQuietHourNow(new Date(now))) {
      expireAt = Math.max(expireAt, nextQuietEnd(new Date(now)));
    }
    this.parked.push({
      id: input.id,
      actorId: input.actorId,
      urgency: input.urgency,
      label: input.label,
      deliver: input.deliver,
      parkedAt: now,
      expireAt,
    });
    if (this.parked.length > 50) this.parked.shift(); // 防膨胀
  }

  private recordDelivery(now: number): void {
    this.deliveredAt.push(now);
    while (this.deliveredAt.length && now - this.deliveredAt[0] > BURST_WINDOW_MS) this.deliveredAt.shift();
  }

  private recentBurstCount(): number {
    const now = this.deps.nowFn?.() ?? Date.now();
    while (this.deliveredAt.length && now - this.deliveredAt[0] > BURST_WINDOW_MS) this.deliveredAt.shift();
    return this.deliveredAt.length;
  }

  private primaryActorId(): string | null {
    return this.deps.primaryActorId?.() ?? this.deps.presence.listOnline()[0] ?? null;
  }
}
