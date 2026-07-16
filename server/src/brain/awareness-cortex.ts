// Agent Brain Center —— 觉察皮层（AwarenessCortex）
//
// 职责：基于 LifeSignalHub / DesktopPresence / MoodInference / AnticipationEngine
// 子系统提供的信号，按纯规则（无 LLM）推断用户当前的活动状态（UserActivityState），
// 并对外提供 observe / recentActivity / onActivityChange 等查询与订阅入口。
import type { AnticipationCandidate, LifeSignal } from "../services/life-signal-types.js";
import type { BrainDecision, UserActivityKind, UserActivityState } from "./types.js";

// ---- 子系统最小化接口（仅声明 AwarenessCortex 实际用到的方法）------------

/** LifeSignalHub 订阅回调签名 */
type LifeSignalSubscriber = (signal: LifeSignal) => Promise<void> | void;

/** LifeSignalHubService 的最小化结构接口 */
interface LifeSignalHubLike {
  subscribe(subscriber: LifeSignalSubscriber): () => void;
  recentSignals(actorId: string, limit?: number): LifeSignal[];
}

/**
 * DesktopPresenceSignalService 的最小化结构接口。
 *
 * 现阶段该服务仅通过 LifeSignalHub 发布 desktop_presence_* 信号，
 * AwarenessCortex 直接从 hub 中读取这些信号即可，无需直接调用其方法。
 * 保留此接口用于 registerDesktopPresence 的类型约束与未来扩展。
 */
interface DesktopPresenceLike {
  // 占位：当前无直接调用方法
}

/** MoodInferenceService 的最小化结构接口 */
interface MoodInferenceLike {
  listForSession(
    sessionId: string,
    limit?: number,
  ): Array<{
    sentimentScore: number;
    confidence: number;
    emotionTags: string[];
    source: string;
    timestamp: string;
  }>;
  todayMood(sessionId: string): {
    avgSentiment: number;
    dominantTags: string[];
    sampleCount: number;
  } | null;
}

/** AnticipationEngineService 的最小化结构接口 */
interface AnticipationLike {
  recentCandidates(actorId: string, limit?: number): AnticipationCandidate[];
}

/**
 * ScheduleTaskService 的最小化结构接口。
 * AwarenessCortex 仅用到 listTasksBySession：查询当前时间窗内的日历事件，
 * 用于识别 meeting 状态。
 */
interface ScheduleTaskLike {
  listTasksBySession(
    sessionId: string,
    range?: { from?: string; to?: string },
  ): Array<{
    status: "active" | "paused" | "completed" | "cancelled";
    runAt: string;
    nextRunAt: string | null;
    kind: string;
    title?: string;
  }>;
}

/**
 * ProactionCortex 的最小化结构接口。
 * AwarenessCortex 仅用到 recentDecisions：判断最近是否有 speak 类决策打断，
 * 用于识别 in_focus 状态。
 */
interface ProactionLike {
  recentDecisions(actorId: string): BrainDecision[];
}

/**
 * AgentSelfLearningService 的最小化结构接口（Stage 4 Task 3）。
 *
 * assessConfidence 用 getRecentFailureRate 注入「历史失败率」因子：
 * 失败率 > 0.3 → -0.2。未注册时跳过该因子（不扣分）。
 */
interface SelfLearningLike {
  getRecentFailureRate?(): number;
}

// ---- 关键词表 ----------------------------------------------------------

// 出行类关键词（中文 + 英文）
const TRAVEL_KEYWORDS = [
  "出行", "出差", "旅游", "出去玩", "走起", "出发",
  "火车", "飞机", "高铁", "打车", "机场",
  "travel", "trip", "outing", "flight", "train", "taxi", "airport",
];

// 下班 / 切换 / 解锁类关键词
const OFF_WORK_KEYWORDS = [
  "下班", "刚下班", "off_work", "off work", "leave work",
  "解锁", "刚解锁", "unlock",
  "切换应用", "switch_app", "switch app",
];

// 工作应用关键词
const WORK_APP_KEYWORDS = [
  "ide", "vscode", "intellij",
  "office", "word", "excel", "powerpoint",
  "browser", "chrome", "edge",
  "工作应用", "多tab", "多 tab", "multi-tab",
];

// 将关键词数组编译为一条 OR 正则
function buildPattern(keywords: string[]): RegExp {
  const escaped = keywords.map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(escaped.join("|"), "i");
}

const TRAVEL_PATTERN = buildPattern(TRAVEL_KEYWORDS);
const OFF_WORK_PATTERN = buildPattern(OFF_WORK_KEYWORDS);
const WORK_APP_PATTERN = buildPattern(WORK_APP_KEYWORDS);

// 出行候选在 anticipation 候选里的识别正则
const TRAVEL_CANDIDATE_PATTERN =
  /(travel|outing|trip|出行|出差|旅游|出发|火车|飞机|高铁|打车|机场)/i;

// ---- 常量 --------------------------------------------------------------

const RECENT_HISTORY_LIMIT = 20;
const TRAVEL_LOOKBACK_MS = 24 * 60 * 60 * 1000;
const SLEEP_INACTIVE_MS = 30 * 60 * 1000;
const INFERENCE_SIGNAL_SCAN = 50;
/**
 * 深度专注（in_focus）触发阈值：持续 busy 超过 25 分钟且近 25 分钟无 speak 决策打断。
 */
const IN_FOCUS_THRESHOLD_MS = 25 * 60_000;
/**
 * meeting 检测时间窗：±15 分钟。当前时间在该窗口内有 active 日历事件即视为会议中。
 */
const MEETING_WINDOW_MS = 15 * 60_000;

// ---- AwarenessCortex ---------------------------------------------------

type ActivityChangeListener = (state: UserActivityState) => void | Promise<void>;

/**
 * 觉察皮层：聚合多个生命信号子系统，按规则推断用户活动状态。
 *
 * 推断为纯规则实现（无 LLM），按优先级：
 * just_off_work > going_out > busy > sleeping > idle > unknown
 */
export class AwarenessCortex {
  private hub: LifeSignalHubLike | null = null;
  private desktop: DesktopPresenceLike | null = null;
  private mood: MoodInferenceLike | null = null;
  private anticipation: AnticipationLike | null = null;
  private scheduleTask: ScheduleTaskLike | null = null;
  private proaction: ProactionLike | null = null;
  /** AgentSelfLearningService（可选，供 assessConfidence 注入历史失败率因子） */
  private selfLearning: SelfLearningLike | null = null;

  private unsubscribe: (() => void) | null = null;
  private started = false;

  /** 最近一次活动状态缓存 */
  private readonly latest = new Map<string, UserActivityState>();
  /** 最近 RECENT_HISTORY_LIMIT 条活动历史 */
  private readonly history = new Map<string, UserActivityState[]>();
  /** 活动变化订阅者 */
  private readonly listeners = new Set<ActivityChangeListener>();

  // ---- 子系统注册 -------------------------------------------------------

  registerLifeSignalHub(hub: LifeSignalHubLike): void {
    this.hub = hub;
    console.log("[AwarenessCortex] 已注册 LifeSignalHub");
  }

  registerDesktopPresence(svc: DesktopPresenceLike): void {
    this.desktop = svc;
    console.log("[AwarenessCortex] 已注册 DesktopPresenceSignalService");
  }

  registerMoodInference(svc: MoodInferenceLike): void {
    this.mood = svc;
    console.log("[AwarenessCortex] 已注册 MoodInferenceService");
  }

  registerAnticipation(svc: AnticipationLike): void {
    this.anticipation = svc;
    console.log("[AwarenessCortex] 已注册 AnticipationEngineService");
  }

  /** 注册日程任务服务，使 inferActivity 能查询当前进行中的日历事件（meeting 状态） */
  registerScheduleTask(svc: ScheduleTaskLike): void {
    this.scheduleTask = svc;
    console.log("[AwarenessCortex] 已注册 ScheduleTaskService");
  }

  /** 注册主动皮层，使 inferActivity 能查询最近 speak 决策，识别 in_focus 状态 */
  registerProaction(svc: ProactionLike): void {
    this.proaction = svc;
    console.log("[AwarenessCortex] 已注册 ProactionCortex");
  }

  /**
   * 注册自我学习服务（Stage 4 Task 3），供 assessConfidence 注入历史失败率因子。
   * 未注册时跳过该因子（不扣分）。
   */
  registerSelfLearning(svc: SelfLearningLike): void {
    this.selfLearning = svc;
    console.log("[AwarenessCortex] 已注册 AgentSelfLearningService");
  }

  // ---- 生命周期 ---------------------------------------------------------

  async start(): Promise<void> {
    if (this.started) {
      console.log("[AwarenessCortex] 已启动，跳过重复 start");
      return;
    }
    if (this.hub) {
      this.unsubscribe = this.hub.subscribe((signal) => {
        try {
          this.handleSignal(signal);
        } catch (err) {
          console.error("[AwarenessCortex] handleSignal failed:", err);
        }
      });
      console.log("[AwarenessCortex] 已订阅 LifeSignalHub");
    } else {
      console.log("[AwarenessCortex] LifeSignalHub 未注册，跳过订阅");
    }
    this.started = true;
    console.log("[AwarenessCortex] 启动完成");
  }

  async stop(): Promise<void> {
    if (!this.started) {
      console.log("[AwarenessCortex] 未启动，跳过 stop");
      return;
    }
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
    this.latest.clear();
    this.history.clear();
    this.started = false;
    console.log("[AwarenessCortex] 已停止");
  }

  // ---- 外观方法 ---------------------------------------------------------

  /** 返回最近一次活动状态；无缓存则即时推断一次 */
  observe(actorId: string): UserActivityState | null {
    const cached = this.latest.get(actorId);
    if (cached) return cached;
    const state = this.inferActivity(actorId);
    if (state) {
      this.commitState(state, false);
    }
    return state;
  }

  /** 返回最近 N 条活动历史（默认 20） */
  recentActivity(actorId: string, limit = RECENT_HISTORY_LIMIT): UserActivityState[] {
    const list = this.history.get(actorId) ?? [];
    return [...list].slice(-limit);
  }

  /** 订阅活动变化，返回取消订阅函数 */
  onActivityChange(cb: ActivityChangeListener): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  // ---- 元认知置信度评估（Stage 4 Task 3）-------------------------------

  /**
   * 规则兜底置信度评估（仅 cognize LLM 失败降级时使用）。
   *
   * ⚠️ 此方法已退化为「兜底」角色：主路径由 cognize LLM 基于对话内容语义评判
   * confidence（见 brain-center.ts 阶段 2），仅在 cognize 抛异常或未注入认知引擎时
   * 才调用本方法。因此移除了原先的正则消息类型分类（CHAT_ONLY_RE/AMBIGUOUS_RE/
   * TOOL_REQUEST_RE）——那些正则无法理解对话语义，且主路径已不再依赖它。
   *
   * 兜底评分（基础 0.5，加减后 clamp 0-1）：
   *   - recall=0 → -0.15；1-2 → +0.1；3+ → +0.3
   *   - capability 无匹配 → -0.2；命中 → +0.3
   *   - 历史失败率 > 0.3 → -0.2
   */
  assessConfidence(
    query: string,
    recallResult: { items: unknown[] } | null,
    capabilities: unknown[],
  ): { score: number; reason: string } {
    const reasons: string[] = [];
    let score = 0.5;
    reasons.push("rule_fallback(base=0.5)");

    const itemCount = recallResult?.items?.length ?? 0;
    if (itemCount === 0) {
      score -= 0.15;
      reasons.push("recall=0(-0.15)");
    } else if (itemCount <= 2) {
      score += 0.1;
      reasons.push(`recall=${itemCount}(+0.1)`);
    } else {
      score += 0.3;
      reasons.push(`recall=${itemCount}(+0.3)`);
    }

    const matched = this.matchCapability(query, capabilities);
    if (matched) {
      score += 0.3;
      reasons.push(`capability_match=${matched}(+0.3)`);
    } else {
      score -= 0.2;
      reasons.push("capability_match=none(-0.2)");
    }

    if (this.selfLearning && typeof this.selfLearning.getRecentFailureRate === "function") {
      try {
        const failureRate = this.selfLearning.getRecentFailureRate();
        if (failureRate > 0.3) {
          score -= 0.2;
          reasons.push(`failure_rate=${failureRate.toFixed(2)}(-0.2)`);
        } else {
          reasons.push(`failure_rate=${failureRate.toFixed(2)}(0)`);
        }
      } catch (err) {
        console.log(`[AwarenessCortex] assessConfidence getRecentFailureRate 异常（跳过）: ${err}`);
      }
    }

    const finalScore = Math.max(0, Math.min(1, score));
    return { score: finalScore, reason: reasons.join("; ") };
  }

  /**
   * 检查 query 是否命中任一 CapabilityDescriptor 的关键词。
   * 匹配字段：domain / label / description / tools 名（大小写不敏感，子串匹配）。
   * 返回首个命中的 domain；无命中返回 null。
   */
  private matchCapability(query: string, capabilities: unknown[]): string | null {
    if (typeof query !== "string" || query.length === 0) return null;
    const q = query.toLowerCase();
    for (const cap of capabilities ?? []) {
      if (!cap || typeof cap !== "object") continue;
      const c = cap as Record<string, unknown>;
      const domain = typeof c.domain === "string" ? c.domain : "";
      const label = typeof c.label === "string" ? c.label : "";
      const description = typeof c.description === "string" ? c.description : "";
      const tools = Array.isArray(c.tools)
        ? c.tools.filter((t) => typeof t === "string")
        : [];
      const candidates = [domain, label, description, ...tools]
        .filter((s) => s.length > 0)
        .map((s) => s.toLowerCase());
      for (const candidate of candidates) {
        if (candidate && q.includes(candidate)) {
          return domain || candidate;
        }
      }
    }
    return null;
  }

  // ---- 内部：信号处理 ---------------------------------------------------

  private handleSignal(signal: LifeSignal): void {
    const state = this.inferActivity(signal.actorId);
    if (!state) return;
    this.commitState(state, true);
  }

  /** 写入缓存与历史；activity 变化时通知订阅者 */
  private commitState(state: UserActivityState, notify: boolean): void {
    const prev = this.latest.get(state.actorId);
    this.latest.set(state.actorId, state);
    if (!prev || prev.activity !== state.activity) {
      this.appendHistory(state);
      if (notify) this.notifyChange(state);
    }
  }

  private appendHistory(state: UserActivityState): void {
    const list = this.history.get(state.actorId) ?? [];
    list.push(state);
    if (list.length > RECENT_HISTORY_LIMIT) {
      list.splice(0, list.length - RECENT_HISTORY_LIMIT);
    }
    this.history.set(state.actorId, list);
  }

  private notifyChange(state: UserActivityState): void {
    for (const cb of this.listeners) {
      void Promise.resolve(cb(state)).catch((err) => {
        console.error("[AwarenessCortex] onActivityChange listener failed:", err);
      });
    }
  }

  // ---- 推断规则（纯规则，无 LLM）---------------------------------------

  /**
   * 按优先级推断用户活动状态：
   * just_off_work > going_out > meeting > (in_focus | busy) > sleeping > idle > unknown
   *
   * - meeting：schedule-task-service 当前时间窗内有进行中的日历事件
   * - in_focus：工作时间持续 busy 超过 25 分钟且近 25 分钟无 speak 决策打断
   *
   * @returns 推断出的活动状态；actorId 为空时返回 null
   */
  inferActivity(actorId: string): UserActivityState | null {
    if (!actorId) return null;

    const now = new Date();
    const nowMs = now.getTime();
    const hour = now.getHours();
    const minute = now.getMinutes();
    const day = now.getDay(); // 0=周日, 6=周六
    const isWeekday = day >= 1 && day <= 5;
    const hourDecimal = hour + minute / 60;

    const signals = this.hub?.recentSignals(actorId, INFERENCE_SIGNAL_SCAN) ?? [];
    const recent24h = signals.filter((s) => {
      const t = Date.parse(s.occurredAt);
      return Number.isFinite(t) && nowMs - t <= TRAVEL_LOOKBACK_MS;
    });

    // ---- 1. just_off_work（刚下班）----
    if (isWeekday && hourDecimal >= 17.5 && hourDecimal <= 19.5) {
      const matched = recent24h.some((s) => this.signalMatches(s, OFF_WORK_PATTERN));
      if (matched) {
        return this.buildState(actorId, "just_off_work", 0.7, [
          "工作日 17:30-19:30 时间窗",
          "桌面 presence 信号含下班/解锁/切换关键词",
        ], now);
      }
    }

    // ---- 2. going_out（准备出行）----
    const travelSignal = recent24h.find((s) => this.signalMatches(s, TRAVEL_PATTERN));
    const hasTravelCandidate = this.anticipation
      ?.recentCandidates(actorId, 20)
      .some((c) => this.candidateIsTravel(c));
    if (travelSignal || hasTravelCandidate) {
      const evidence: string[] = [];
      let confidence = 0.6;
      const metadata: Record<string, unknown> = {};
      if (travelSignal) {
        evidence.push(`life signal 命中出行关键词: ${travelSignal.title}`);
        confidence = 0.7;
        this.extractTravelMetadata(travelSignal, metadata);
      }
      if (hasTravelCandidate) {
        evidence.push("anticipation engine 候选含 travel/outing 类");
        confidence = Math.min(0.8, confidence + 0.1);
      }
      return this.buildState(actorId, "going_out", confidence, evidence, now, metadata);
    }

    // ---- 3. meeting（会议中）----
    // 查询 schedule-task-service，当前时间 ±15 分钟窗口内有 active 日历事件即视为会议中。
    // 查询失败或服务未注册时降级（不阻塞后续推断）。
    if (this.scheduleTask) {
      try {
        const meetingTask = this.findActiveMeeting(actorId, nowMs);
        if (meetingTask) {
          return this.buildState(actorId, "meeting", 0.7, [
            "schedule-task-service 当前时间窗内有进行中的日历事件",
            `事件: ${meetingTask.title ?? meetingTask.kind}（runAt=${meetingTask.runAt}）`,
          ], now);
        }
      } catch {
        // 查询失败不影响后续推断
      }
    }

    // ---- 4. busy（忙碌）/ in_focus（深度专注）----
    const isWorkHour =
      (hourDecimal >= 9 && hourDecimal <= 12) ||
      (hourDecimal >= 14 && hourDecimal <= 18);
    if (isWorkHour) {
      const busySignal = signals.find((s) => this.signalMatches(s, WORK_APP_PATTERN));
      if (busySignal) {
        // in_focus 细化：持续 busy 超过 25 分钟且近 25 分钟无 speak 决策打断
        const inFocus = this.checkInFocus(actorId, signals, nowMs);
        if (inFocus.inFocus) {
          return this.buildState(actorId, "in_focus", 0.7, [
            "工作时间持续 busy 超过 25 分钟",
            "近 25 分钟无 speak 类决策打断",
            `最早 busy 信号: ${new Date(inFocus.earliestBusyMs).toISOString()}`,
            `桌面 presence 显示活跃工作应用: ${busySignal.title}`,
          ], now);
        }
        return this.buildState(actorId, "busy", 0.65, [
          "工作时间 9:00-12:00 / 14:00-18:00",
          `桌面 presence 显示活跃工作应用: ${busySignal.title}`,
        ], now);
      }
    }

    // ---- 5. sleeping（休息/睡眠）----
    if (hourDecimal >= 23 || hourDecimal <= 6) {
      const inactiveMs = this.inactiveMs(signals, nowMs);
      if (inactiveMs >= SLEEP_INACTIVE_MS) {
        return this.buildState(actorId, "sleeping", 0.8, [
          "夜间 23:00-次日 6:00",
          `桌面无活动超过 30 分钟（约 ${Math.round(inactiveMs / 60_000)} 分钟）`,
        ], now);
      }
    }

    // ---- 6. idle（空闲，默认回退）----
    const hasPresence = signals.some(
      (s) => s.source === "desktop" || s.kind.startsWith("desktop_"),
    );
    if (hasPresence) {
      return this.buildState(actorId, "idle", 0.5, [
        "桌面 presence 显示活动但非工作应用 / 非工作时间",
      ], now);
    }

    // ---- 7. unknown（所有信号都缺失）----
    return this.buildState(actorId, "unknown", 0.3, ["所有信号缺失"], now);
  }

  // ---- 辅助方法 ---------------------------------------------------------

  private buildState(
    actorId: string,
    activity: UserActivityKind,
    confidence: number,
    evidence: string[],
    now: Date,
    metadata?: Record<string, unknown>,
  ): UserActivityState {
    const state: UserActivityState = {
      actorId,
      activity,
      confidence,
      evidence,
      occurredAt: now.toISOString(),
    };
    if (metadata && Object.keys(metadata).length > 0) {
      state.metadata = metadata;
    }
    return state;
  }

  /** 判断单条 life signal 是否命中给定正则（扫描 title/summary/description/tags/kind） */
  private signalMatches(signal: LifeSignal, pattern: RegExp): boolean {
    const text = `${signal.title} ${signal.summary} ${signal.description ?? ""} ${signal.tags.join(" ")} ${signal.kind}`;
    return pattern.test(text);
  }

  /** 判断 anticipation 候选是否属于出行/外出类 */
  private candidateIsTravel(c: AnticipationCandidate): boolean {
    const text = `${c.title} ${c.rationale} ${c.suggestedAction} ${c.tags.join(" ")} ${c.category}`;
    return TRAVEL_CANDIDATE_PATTERN.test(text);
  }

  /** 从出行信号中提取 destination / time 元数据（如有） */
  private extractTravelMetadata(signal: LifeSignal, out: Record<string, unknown>): void {
    const md = signal.metadata;
    if (md && typeof md === "object") {
      if (typeof md.destination === "string") out.destination = md.destination;
      if (typeof md.time === "string") out.time = md.time;
    }
  }

  /** 计算距上一次桌面 presence 信号的毫秒数；无桌面信号返回 Infinity */
  private inactiveMs(signals: LifeSignal[], nowMs: number): number {
    const desktopSignals = signals.filter(
      (s) => s.source === "desktop" || s.kind.startsWith("desktop_"),
    );
    if (desktopSignals.length === 0) return Number.POSITIVE_INFINITY;
    let lastT = -Infinity;
    for (const s of desktopSignals) {
      const t = Date.parse(s.occurredAt);
      if (Number.isFinite(t) && t > lastT) lastT = t;
    }
    if (!Number.isFinite(lastT)) return Number.POSITIVE_INFINITY;
    return Math.max(0, nowMs - lastT);
  }

  /**
   * 查询 schedule-task-service，返回当前时间窗（±MEETING_WINDOW_MS）内的
   * 第一条 active 日历事件，无则返回 null。
   *
   * listTasksBySession 已过滤 cancelled，但可能仍含 completed（取 lastRunAt）。
   * 这里只识别尚未结束的 active 事件作为「进行中会议」。
   */
  private findActiveMeeting(actorId: string, nowMs: number): {
    title?: string;
    kind: string;
    runAt: string;
    nextRunAt: string | null;
  } | null {
    if (!this.scheduleTask) return null;
    const from = new Date(nowMs - MEETING_WINDOW_MS).toISOString();
    const to = new Date(nowMs + MEETING_WINDOW_MS).toISOString();
    const tasks = this.scheduleTask.listTasksBySession(actorId, { from, to });
    return tasks.find((t) => t.status === "active") ?? null;
  }

  /**
   * 检查 in_focus 条件：
   *  1. 找到 signals 中最早的「工作应用」信号（命中 WORK_APP_PATTERN）
   *  2. 该信号距今超过 IN_FOCUS_THRESHOLD_MS（25 分钟）
   *  3. 近 25 分钟内无 speak 类 recentDecisions（proaction 未注册或查询失败时视为无打断）
   *
   * 返回 { inFocus, earliestBusyMs }，earliestBusyMs 仅在 inFocus=true 时有意义。
   */
  private checkInFocus(
    actorId: string,
    signals: LifeSignal[],
    nowMs: number,
  ): { inFocus: boolean; earliestBusyMs: number } {
    let earliestBusyMs = Number.POSITIVE_INFINITY;
    for (const s of signals) {
      if (this.signalMatches(s, WORK_APP_PATTERN)) {
        const t = Date.parse(s.occurredAt);
        if (Number.isFinite(t) && t < earliestBusyMs) earliestBusyMs = t;
      }
    }
    if (!Number.isFinite(earliestBusyMs)) {
      return { inFocus: false, earliestBusyMs: 0 };
    }
    if (nowMs - earliestBusyMs < IN_FOCUS_THRESHOLD_MS) {
      return { inFocus: false, earliestBusyMs: 0 };
    }
    // 检查近 25 分钟内是否有 speak 类决策打断
    const cutoff = nowMs - IN_FOCUS_THRESHOLD_MS;
    const decisions = this.proaction?.recentDecisions(actorId) ?? [];
    const hasSpeak = decisions.some((d) => {
      if (d.outcome !== "speak") return false;
      const t = Date.parse(d.decidedAt);
      return Number.isFinite(t) && t >= cutoff;
    });
    if (hasSpeak) {
      return { inFocus: false, earliestBusyMs: 0 };
    }
    return { inFocus: true, earliestBusyMs };
  }
}
