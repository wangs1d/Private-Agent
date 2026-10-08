/**
 * 闹钟调度服务（服务端兜底路）—— 触发主路在客户端本地（Android 精确闹钟 / iOS 本地通知），
 * 服务端负责：意图落库、跨设备同步（alarm.sync）、到点兜底触发（alarm.trigger）、
 * 客户端超时未回报时的系统级推送兜底、触发台账。
 *
 * 时序约定（docs/mobile-agent-reminder-alarm-design.md §8.3）：
 *  - tick 每 15s 扫描 nextFireAt ≤ now 的 active 闹钟 → 触发；
 *  - WS 直推成功 → 客户端应在 FALLBACK_MS 内回报 trigger-callback；
 *  - WS 失败（全离线）→ FALLBACK_OFFLINE_MS 后走 MobilePushService 系统推送；
 *  - 回报幂等由 AlarmStore.recordTrigger 保证。
 */
import { randomUUID } from "node:crypto";

import type { WsConnectionRegistry } from "../ws-connection-registry.js";
import type { MobilePushChannel } from "../../proactivity/mobile-push-service.js";
import { advanceAlarmNextFireMs } from "./alarm-rrule.js";
import { AlarmStore, type AlarmCreateInput } from "./alarm-store.js";
import type { Alarm, AlarmTriggerPayload } from "./alarm-types.js";

export type TtsSynthesizeFn = (text: string) => Promise<{ format: "mp3"; base64: string } | null>;

export type AlarmClockServiceDeps = {
  wsRegistry: WsConnectionRegistry;
  /** 离线必达推送（MobilePushService）；未装配时兜底降级为仅 WS */
  mobilePush?: MobilePushChannel | null;
  dataDir: string;
  /** 二阶段语音叫醒：TTS 合成开场白；不可用时为 null（客户端按文本兜底） */
  synthesizeSpeech?: TtsSynthesizeFn | null;
  env?: NodeJS.ProcessEnv;
  log?: { info: (msg: string) => void; warn: (msg: string) => void };
};

const TICK_MS = 15_000;
const FALLBACK_MS = 5 * 60_000; // WS 已送达但客户端未回报 → 5 分钟后推送兜底
const FALLBACK_OFFLINE_MS = 30_000; // WS 全离线 → 30 秒后推送兜底
const MAX_SNOOZE_HARD_CAP = 10; // 贪睡硬上限（防客户端死循环顺延）
/** 提醒智能路由的"活跃窗口"：窗口内有真人活动的设备 = 用户此刻所在端，提醒只发它。
 * 可用 AGENT_REMINDER_ACTIVE_WINDOW_MS 覆盖；窗口内无活跃端（人在两端都不动/全离线）
 * 时降级为全端 fan-out——宁多勿漏，位置未知时不能赌。 */
const DEFAULT_ACTIVE_WINDOW_MS = 120_000;

export class AlarmClockService {
  readonly store: AlarmStore;
  private timer: NodeJS.Timeout | null = null;
  private readonly fallbacks = new Map<string, NodeJS.Timeout>(); // `${alarmId}:${firedAtMs}` → timer
  private readonly wsRegistry: WsConnectionRegistry;
  private readonly mobilePush: MobilePushChannel | null;
  private readonly synthesizeSpeech: TtsSynthesizeFn | null;
  private readonly env: NodeJS.ProcessEnv;
  private readonly log: { info: (msg: string) => void; warn: (msg: string) => void };
  private firing = new Set<string>(); // 同 tick 去重

  constructor(deps: AlarmClockServiceDeps) {
    this.wsRegistry = deps.wsRegistry;
    this.mobilePush = deps.mobilePush ?? null;
    this.synthesizeSpeech = deps.synthesizeSpeech ?? null;
    this.env = deps.env ?? process.env;
    this.log = deps.log ?? { info: (m) => console.info(`[alarm-clock] ${m}`), warn: (m) => console.warn(`[alarm-clock] ${m}`) };
    this.store = new AlarmStore(deps.dataDir);
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick().catch(() => {}), TICK_MS);
    this.log.info(`scheduler started (tick=${TICK_MS / 1000}s)`);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const t of this.fallbacks.values()) clearTimeout(t);
    this.fallbacks.clear();
  }

  // ─── CRUD（HTTP 路由薄壳直接透传到这里） ───

  createAlarm(input: AlarmCreateInput): { alarm: Alarm; duplicate: boolean } {
    const dup = this.store.findDuplicate(input.actorId, input);
    if (dup) return { alarm: dup, duplicate: true };
    const alarm = this.store.create(input);
    this.syncToDevices(alarm, "upsert");
    // 补发一跳同步，让其他设备也排上本地调度
    if (alarm.repeat.rule) {
      const next = advanceAlarmNextFireMs(alarm.repeat, new Date(alarm.fireAt).getTime(), Date.now());
      if (next !== null) this.log.info(`repeating alarm ${alarm.id} next=${new Date(next).toISOString()}`);
    }
    return { alarm, duplicate: false };
  }

  listAlarms(actorId: string, status?: string): Alarm[] {
    return this.store.listByActor(actorId, status);
  }

  getAlarm(id: string): Alarm | undefined {
    return this.store.get(id);
  }

  updateAlarm(id: string, patch: Partial<AlarmCreateInput>): Alarm | undefined {
    const alarm = this.store.update(id, patch);
    if (alarm) this.syncToDevices(alarm, "upsert");
    return alarm;
  }

  cancelAlarm(id: string): Alarm | undefined {
    const alarm = this.store.update(id, { status: "canceled" });
    if (alarm) this.syncToDevices(alarm, "delete");
    return alarm;
  }

  snoozeAlarm(id: string, minutes: number): Alarm | undefined {
    const alarm = this.store.get(id);
    if (!alarm) return undefined;
    if ((alarm.snoozeCount ?? 0) >= Math.min(alarm.snooze.maxCount, MAX_SNOOZE_HARD_CAP)) {
      // 超过贪睡上限：不再顺延，交由触发链自然完成（响铃仍在继续，需显式关闭）
      return alarm;
    }
    const updated = this.store.snooze(alarm, minutes, Date.now());
    this.syncToDevices(updated, "upsert");
    return updated;
  }

  dismissAlarm(id: string): Alarm | undefined {
    const alarm = this.store.get(id);
    if (!alarm) return undefined;
    // dismiss = 用户确认停止本次响铃：单次 → done；重复 → 推进到下一跳
    if (alarm.repeat.rule) {
      const nowMs = Date.now();
      this.store.advanceAfterFire(alarm, nowMs);
    } else {
      this.store.update(id, { status: "done" });
    }
    const fresh = this.store.get(id)!;
    this.syncToDevices(fresh, "upsert");
    return fresh;
  }

  // ─── 触发与回执 ───

  /** 客户端回报触发结果（幂等）；via=local 表示客户端本地调度先响，服务端兜底跳自动失效 */
  reportTriggerCallback(
    alarmId: string,
    body: { firedAtMs: number; via?: string; outcome?: string; snoozeCount?: number; actualChannel?: string },
  ): { accepted: boolean; duplicate: boolean } {
    const firedAtMs = Number(body.firedAtMs);
    if (!Number.isFinite(firedAtMs)) return { accepted: false, duplicate: false };
    this.clearFallback(alarmId, firedAtMs);
    return this.store.recordTrigger({
      alarmId,
      firedAtMs,
      via: (body.via as "local" | "server" | "fallback_push") ?? "local",
      outcome: (body.outcome as "ringing" | "missed" | "acked" | "snoozed") ?? "ringing",
      snoozeCount: body.snoozeCount,
      actualChannel: body.actualChannel,
      reportedAt: new Date().toISOString(),
    });
  }

  listTriggers(alarmId: string) {
    return this.store.listTriggers(alarmId);
  }

  /** 语音模型健康探测（二阶段降级判定用）：本服务无独立模型进程，按 ttsService 能力上报 */
  voiceHealth(): { ok: boolean; model: string; available: boolean; reason?: string } {
    const available = this.synthesizeSpeech !== null && this.env.ALARM_VOICE_DISABLED !== "1";
    return {
      ok: true,
      model: this.env.ALARM_VOICE_MODEL ?? "e2e-tts",
      available,
      ...(available ? {} : { reason: "tts_unavailable" }),
    };
  }

  // ─── 内部：调度 tick 与投递 ───

  private async tick(): Promise<void> {
    await this.tickAll(Date.now());
  }

  private async tickAll(nowMs: number): Promise<void> {
    for (const alarm of this.allActive()) {
      const nextMs = alarm.nextFireAt ? new Date(alarm.nextFireAt).getTime() : NaN;
      if (!Number.isFinite(nextMs) || nextMs > nowMs) continue;
      const fireKey = `${alarm.id}:${nextMs}`;
      if (this.firing.has(fireKey)) continue;
      this.firing.add(fireKey);
      void this.fireAlarm(alarm, nextMs).finally(() => this.firing.delete(fireKey));
    }
  }

  private allActive(): Alarm[] {
    // 直接读内部数据（跨 actor 全量）；store.listByActor 是单 actor 语义
    return (this.store as unknown as { data: { alarms: Alarm[] } }).data.alarms.filter(
      (a) => a.status === "active" && !!a.nextFireAt,
    );
  }

  private async fireAlarm(alarm: Alarm, firedAtMs: number): Promise<void> {
    const payload: AlarmTriggerPayload = {
      alarmId: alarm.id,
      label: alarm.label,
      kind: alarm.kind,
      firedAtMs,
      via: "server",
      wakeMode: alarm.wakeMode,
      tts: null,
    };
    // 二阶段：voice_talk 模式且 TTS 可用 → 预合成开场白随事件下发（1.5s 预算内失败则按文本兜底）
    if (alarm.wakeMode?.level === "voice_talk" && this.synthesizeSpeech) {
      try {
        const text = alarm.wakeMode.voiceScript || `${alarm.label}，时间到了`;
        const tts = await Promise.race([
          this.synthesizeSpeech(text),
          new Promise<null>((resolve) => setTimeout(() => resolve(null), 1500)),
        ]);
        if (tts) payload.tts = tts;
      } catch {
        /* 合成失败 → tts=null，客户端文本兜底 */
      }
    }
    const sent = this.deliverTrigger(alarm, JSON.stringify({ type: "alarm.trigger", payload }));
    this.log.info(
      `fired ${alarm.kind} ${alarm.id} "${alarm.label}" route=${sent.route} delivered=${sent.ok} at=${new Date(firedAtMs).toISOString()}`,
    );
    // 推进下一跳（重复闹钟），单次置 done —— 但若客户端此后贪睡会再次改写 nextFireAt
    this.store.advanceAfterFire(alarm, firedAtMs);
    // 兜底：客户端超时未回报 → 系统级推送
    this.scheduleFallback(alarm, firedAtMs, sent.ok ? FALLBACK_MS : FALLBACK_OFFLINE_MS);
    // 即时提醒（kind=reminder）补一条 reminder.deliver 供客户端按 channelPlan 升级链展示
    if (alarm.kind === "reminder") {
      this.deliverTrigger(
        alarm,
        JSON.stringify({
          type: "reminder.deliver",
          payload: {
            reminderId: alarm.id,
            text: (alarm as Alarm & { remindText?: string }).remindText ?? alarm.label,
            channelPlan: (alarm as Alarm & { channelPlan?: string[] }).channelPlan ?? ["notification", "popup"],
            escalateAfterSec: (alarm as Alarm & { escalateAfterSec?: number }).escalateAfterSec ?? 120,
            requireAck: (alarm as Alarm & { requireAck?: boolean }).requireAck ?? true,
          },
        }),
      );
    }
  }

  /**
   * 触发投递的智能路由（2026-10-08）：判断用户当前在手机端还是电脑端，只发一端、不两端齐发。
   *
   *  - kind=alarm（闹钟）：跟人睡的地方走 → mobile 优先独占，手机全离线才退 desktop；
   *    全离线返回 ok=false 交给推送兜底。闹钟在两端齐响是事故级体验，必须单端。
   *  - kind=reminder（即时提醒）：发给「活跃窗口内最近有真人活动的设备」（用户此刻所在端）；
   *    窗口内无活跃端（位置未知）→ 降级全端 fan-out，宁多勿漏。
   *
   * alarm.sync 的跨设备同步不走这里（fan-out 是对的：每台设备都要排上本地调度）。
   */
  private deliverTrigger(alarm: Alarm, data: string): { ok: boolean; route: string } {
    if (alarm.kind === "alarm") {
      const ok = this.wsRegistry.trySendToDeviceClassOrder(alarm.actorId, data, ["mobile", "desktop"]);
      return { ok, route: ok ? "alarm_mobile_first" : "offline" };
    }
    const windowMs = Number(this.env.AGENT_REMINDER_ACTIVE_WINDOW_MS) || DEFAULT_ACTIVE_WINDOW_MS;
    if (this.wsRegistry.trySendToActiveDevice(alarm.actorId, data, windowMs)) {
      return { ok: true, route: "reminder_active_device" };
    }
    const ok = this.wsRegistry.trySend(alarm.actorId, data);
    return { ok, route: ok ? "reminder_fanout_location_unknown" : "offline" };
  }

  private scheduleFallback(alarm: Alarm, firedAtMs: number, delayMs: number): void {
    const key = `${alarm.id}:${firedAtMs}`;
    const prev = this.fallbacks.get(key);
    if (prev) clearTimeout(prev);
    const timer = setTimeout(() => {
      this.fallbacks.delete(key);
      void this.fireFallbackPush(alarm, firedAtMs).catch(() => {});
    }, delayMs);
    this.fallbacks.set(key, timer);
  }

  private clearFallback(alarmId: string, firedAtMs: number): void {
    const key = `${alarmId}:${firedAtMs}`;
    const timer = this.fallbacks.get(key);
    if (timer) {
      clearTimeout(timer);
      this.fallbacks.delete(key);
    }
  }

  private async fireFallbackPush(alarm: Alarm, firedAtMs: number): Promise<void> {
    if (!this.mobilePush) return;
    // 客户端可能已回报（竞态）：台账里已有非 ringing 记录则跳过
    const reported = this.store
      .listTriggers(alarm.id)
      .some((t) => Math.abs(t.firedAtMs - firedAtMs) < 90_000 && t.outcome !== "ringing");
    if (reported) return;
    const result = await this.mobilePush.push({
      actorId: alarm.actorId,
      title: alarm.kind === "alarm" ? `闹钟：${alarm.label}` : `提醒：${alarm.label}`,
      body: `手机端本地闹钟未响应（可能已离线/被杀进程），此为服务端兜底推送。`,
      importance: alarm.dnd.bypass ? "high" : "normal",
      kind: "alarm_fallback",
      deliveryId: `alarmfb_${randomUUID()}`,
    });
    this.log.info(`fallback push alarm=${alarm.id} ok=${result.ok} provider=${result.provider}`);
    this.store.recordTrigger({
      alarmId: alarm.id,
      firedAtMs,
      via: "fallback_push",
      outcome: "missed",
      reportedAt: new Date().toISOString(),
    });
  }

  /** 跨设备同步：把最新状态 fan-out 到该用户全部在线设备（客户端写入本地闹钟库并重排本地调度） */
  private syncToDevices(alarm: Alarm, op: "upsert" | "delete"): void {
    this.wsRegistry.trySend(
      alarm.actorId,
      JSON.stringify({ type: "alarm.sync", payload: { alarm, op } }),
    );
  }
}
