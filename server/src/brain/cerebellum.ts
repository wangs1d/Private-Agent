// Agent Brain Center — Cerebellum（小脑）
//
// 职责：时序协调层。像小脑协调运动时序一样,协调主动决策的"什么时候执行、被打断怎么办"。
// 不做认知决策（皮层职责）,只管时序：defer / 复查 / 打断抑制。
//
// 核心机制：
//  1. schedule(decision, signal, fire)：皮层 ProactionCortex 决策 speak 后调用。
//     - 用户 busy/sleeping → defer 进队列,等 reaper 复查
//     - 抑制窗口内（用户刚开口）→ defer
//     - 否则 → 犹豫 0.8-2.5s 后执行（模拟真人"要不要说"的犹豫期）
//     - 执行前再查一次抑制窗口,若期间被打断则取消（"被打断就不说了"）
//  2. reaper 定时器（2 分钟）：复查 defer 队列
//     - 超时（30 分钟）未触发 → 降级 silent,记日志
//     - 用户状态变好（idle/just_off_work/...）→ 重新触发执行
//  3. interrupt(actorId)：用户开口打断
//     - 清空该 actor 的 defer 队列
//     - 设 60s 抑制窗口,期间 schedule 直接 defer 不执行
//
// 设计要点：
//  - 小脑不产出话术/不做 value 评分,只搬运 ProactionCortex 已决策的 speak 到合适时机。
//  - fire 回调由 create-app-services 注入（指向 executeProactiveDecision）,小脑不知道执行细节。
//  - 抑制窗口让"用户开口时 Agent 不抢话"从注释变成可执行逻辑。

import type {
  BrainDecision,
  BrainSignalInput,
  PendingDecision,
  UserActivityState,
} from "./types.js";

// ---- 子系统最小化接口 --------------------------------------------------

/** AwarenessCortex 的最小化结构接口（Cerebellum 只需 observe 读当前活动状态） */
export interface CerebellumAwarenessLike {
  observe(actorId: string): UserActivityState | null;
}

// ---- 常量 --------------------------------------------------------------

/** reaper 复查间隔（2 分钟） */
const REAPER_INTERVAL_MS = 2 * 60_000;
/** defer 超时阈值（30 分钟）,超时未触发则降级 silent */
const DEFER_TTL_MS = 30 * 60_000;
/** 打断后抑制窗口（60 秒）,期间主动决策直接 defer 不执行 */
const SUPPRESS_WINDOW_MS = 60_000;
/** 立即执行前的犹豫延迟下限/上限（模拟真人"要不要说"的犹豫期） */
const HESITATE_MIN_MS = 800;
const HESITATE_MAX_MS = 2500;

/** 不适合立即开口的活动状态 → defer */
const DEFER_ACTIVITIES = new Set<string>(["busy", "sleeping"]);

// ---- Cerebellum --------------------------------------------------------

/**
 * 小脑：时序协调层。
 *
 * 协调主动决策的执行时机——皮层决定"说/不说",小脑决定"什么时候说"。
 * 用户忙时 defer,用户空了再说;用户开口时清空 defer 并抑制一段时间,避免抢话。
 */
export class Cerebellum {
  private awareness: CerebellumAwarenessLike | null = null;
  private reaperTimer: NodeJS.Timeout | null = null;
  private started = false;

  /** actorId → 待复查的 defer 队列 */
  private readonly pending = new Map<string, PendingDecision[]>();
  /** actorId → 打断抑制截止时间戳（ms） */
  private readonly suppressUntil = new Map<string, number>();
  /** 统计：被打断次数 */
  private interruptedCount = 0;
  /** 最近一次打断时间 */
  private lastInterruptAt: string | null = null;

  // ---- 注册 ------------------------------------------------------------

  registerAwareness(a: CerebellumAwarenessLike): void {
    this.awareness = a;
    console.log("[Cerebellum] 已注册 AwarenessCortex");
  }

  // ---- 生命周期 --------------------------------------------------------

  async start(): Promise<void> {
    if (this.started) {
      console.log("[Cerebellum] 已启动,跳过重复 start");
      return;
    }
    this.reaperTimer = setInterval(() => {
      void this.reap().catch((e) => {
        console.error("[Cerebellum] reaper 异常:", e);
      });
    }, REAPER_INTERVAL_MS);
    this.reaperTimer.unref?.();
    this.started = true;
    console.log("[Cerebellum] 启动完成（reaper 间隔 %ds）", REAPER_INTERVAL_MS / 1000);
  }

  async stop(): Promise<void> {
    if (!this.started) {
      console.log("[Cerebellum] 未启动,跳过 stop");
      return;
    }
    if (this.reaperTimer) {
      clearTimeout(this.reaperTimer);
      this.reaperTimer = null;
    }
    this.pending.clear();
    this.started = false;
    console.log("[Cerebellum] 已停止");
  }

  // ---- 核心调度 --------------------------------------------------------

  /**
   * 调度一个主动决策：立即执行或 defer。
   *
   * 皮层（ProactionCortex）已决策 speak,小脑只管"什么时候执行"：
   *  - 抑制窗口内（用户刚开口）→ defer,别抢话
   *  - 用户 busy/sleeping → defer,等 reaper 复查状态变好
   *  - 否则 → 犹豫 0.8-2.5s 后执行,执行前再查一次抑制窗口（可被打断取消）
   */
  async schedule(
    decision: BrainDecision,
    signal: BrainSignalInput,
    fire: () => Promise<void>,
  ): Promise<void> {
    const actorId = signal.actorId;
    const now = Date.now();

    // 抑制窗口内 → defer
    const suppressUntilMs = this.suppressUntil.get(actorId);
    if (suppressUntilMs !== undefined && now < suppressUntilMs) {
      this.enqueue(actorId, decision, signal, fire);
      console.log(
        `[Cerebellum] ${actorId} 抑制窗口内,defer（剩余 ${suppressUntilMs - now}ms）: ${signal.kind}`,
      );
      return;
    }

    // 用户 busy/sleeping → defer,等 reaper 复查
    const activity = this.observeActivity(actorId);
    if (activity && DEFER_ACTIVITIES.has(activity.activity)) {
      this.enqueue(actorId, decision, signal, fire);
      console.log(`[Cerebellum] ${actorId} 用户 ${activity.activity},defer 待复查: ${signal.kind}`);
      return;
    }

    // 立即执行（带犹豫延迟,模拟真人察觉后的"要不要说"犹豫期）
    const hesitateMs = HESITATE_MIN_MS + Math.floor(Math.random() * (HESITATE_MAX_MS - HESITATE_MIN_MS));
    console.log(`[Cerebellum] ${actorId} 立即执行,犹豫 ${hesitateMs}ms: ${signal.kind}`);
    setTimeout(() => {
      // 执行前再查一次：若犹豫期间用户开口了（抑制窗口触发）,则取消
      const su = this.suppressUntil.get(actorId);
      if (su !== undefined && Date.now() < su) {
        console.log(`[Cerebellum] ${actorId} 犹豫期内被打断,取消执行: ${signal.kind}`);
        return;
      }
      void fire().catch((e) => {
        console.error(`[Cerebellum] fire 失败 (${signal.kind}):`, e);
      });
    }, hesitateMs);
  }

  /**
   * 用户开口打断：清空 defer 队列 + 设抑制窗口。
   * 让"用户开口时 Agent 不抢话"从注释变成可执行逻辑。
   */
  interrupt(actorId: string): void {
    const count = this.pending.get(actorId)?.length ?? 0;
    if (count > 0) {
      this.pending.delete(actorId);
    }
    this.suppressUntil.set(actorId, Date.now() + SUPPRESS_WINDOW_MS);
    this.interruptedCount += 1;
    this.lastInterruptAt = new Date().toISOString();
    if (count > 0) {
      console.log(
        `[Cerebellum] ${actorId} 用户开口打断,清空 ${count} 个 defer + 抑制 ${SUPPRESS_WINDOW_MS / 1000}s`,
      );
    }
  }

  /** 清空某 actor 的 defer 队列 */
  clearPending(actorId: string): void {
    this.pending.delete(actorId);
  }

  // ---- reaper：定时复查 defer 队列 -------------------------------------

  /**
   * 每 REAPER_INTERVAL_MS 触发一次：
   *  - 超时（30 分钟）未触发 → 降级 silent,记日志
   *  - 抑制窗口内 → 保留
   *  - 用户状态变好（非 busy/sleeping）→ 重新触发执行
   */
  private async reap(): Promise<void> {
    const now = Date.now();
    for (const [actorId, list] of this.pending) {
      if (list.length === 0) {
        this.pending.delete(actorId);
        continue;
      }
      const remaining: PendingDecision[] = [];
      for (const item of list) {
        // 超时 → 降级 silent
        if (now >= item.expiresAt) {
          console.log(
            `[Cerebellum] ${actorId} defer 超时,降级 silent: ${item.signal.kind}`,
          );
          continue;
        }
        // 抑制窗口内 → 保留
        const su = this.suppressUntil.get(actorId);
        if (su !== undefined && now < su) {
          remaining.push(item);
          continue;
        }
        // 复查用户状态：仍 busy/sleeping → 保留;变好 → 触发执行
        const activity = this.observeActivity(actorId);
        if (activity && DEFER_ACTIVITIES.has(activity.activity)) {
          remaining.push(item);
        } else {
          console.log(
            `[Cerebellum] ${actorId} 状态变好（${activity?.activity ?? "unknown"}）,触发 defer 执行: ${item.signal.kind}`,
          );
          void item.fire().catch((e) => {
            console.error(`[Cerebellum] defer fire 失败 (${item.signal.kind}):`, e);
          });
        }
      }
      if (remaining.length === 0) {
        this.pending.delete(actorId);
      } else {
        this.pending.set(actorId, remaining);
      }
    }
  }

  // ---- 内部辅助 --------------------------------------------------------

  /** 入队 defer 队列 */
  private enqueue(
    actorId: string,
    decision: BrainDecision,
    signal: BrainSignalInput,
    fire: () => Promise<void>,
  ): void {
    const list = this.pending.get(actorId) ?? [];
    list.push({
      actorId,
      decision,
      signal,
      fire,
      enqueuedAt: Date.now(),
      expiresAt: Date.now() + DEFER_TTL_MS,
    });
    this.pending.set(actorId, list);
  }

  /** 读取用户当前活动状态（无 awareness 时返回 null,视为可执行） */
  private observeActivity(actorId: string): UserActivityState | null {
    if (!this.awareness) return null;
    try {
      return this.awareness.observe(actorId);
    } catch {
      return null;
    }
  }

  // ---- 快照 ------------------------------------------------------------

  /** 返回小脑状态快照（供 BrainCenter.snapshot 使用） */
  snapshot(): {
    pendingCount: number;
    interruptedCount: number;
    lastInterruptAt: string | null;
  } {
    let total = 0;
    for (const list of this.pending.values()) total += list.length;
    return {
      pendingCount: total,
      interruptedCount: this.interruptedCount,
      lastInterruptAt: this.lastInterruptAt,
    };
  }
}
