import { randomBytes, randomInt, randomUUID } from "crypto";
import { mkdir, readdir, readFile, rename, unlink, writeFile } from "fs/promises";
import { dirname, join } from "path";
import { ServerEventType } from "../protocol.js";
import type { TtsService } from "./tts-service.js";
import type { ClientPushPort } from "../ports/client-push-port.js";
/** 前摇阶段配置 */
export interface RingPhaseConfig {
  /** 振铃持续时间（毫秒），默认 8000ms（8秒振铃） */
  ringDurationMs?: number;
  /** 是否启用前摇阶段；设为 false 则退化为旧逻辑直接推 incoming（向后兼容） */
  enableRingingPhase?: boolean;
}

export type VirtualPhoneRingStyle = "reminder" | "peer";
export type VirtualPhoneInitiator = "user" | "agent";

type PersistedVirtualPhones = {
  byActor: Record<string, string>;
};

export type CallUserParams = {
  fromActorId: string;
  toUserId: string;
  transcript: string;
  ringStyle: VirtualPhoneRingStyle;
  /** 前摇阶段配置（可选，不传则启用默认前摇） */
  ringPhase?: RingPhaseConfig;
};

export type UserCallAgentParams = {
  fromUserId: string;
  toActorId: string;
  userMessage?: string;
  /** 前摇阶段配置（可选） */
  ringPhase?: RingPhaseConfig;
};

/** 用户→Agent 通话接通后的 Agent 回应生成器（bootstrap 接线到 AgentCore） */
export type UserCallAgentHandler = (params: {
  callId: string;
  fromUserId: string;
  toActorId: string;
  userMessage: string;
}) => Promise<{ replyText: string } | null>;

/** 通话中用户回复处理器（bootstrap 接线到 AgentCore 主对话管线） */
export type UserCallReplyHandler = (params: {
  callId: string;
  fromActorId: string;
  toUserId: string;
  text: string;
}) => Promise<void>;

type ActiveCallSession = {
  callId: string;
  /** 通话中的 Agent 一侧（user_to_agent=被叫 Agent；agent_to_user=主叫 Agent） */
  fromActorId: string;
  /** 通话中的用户一侧 */
  toUserId: string;
  direction: "user_to_agent" | "agent_to_user";
  createdAt: number;
  /** 呼出时的语音稿/留言（通话记录落盘用） */
  initialTranscript?: string;
};

type ReplyWaiter = {
  resolve: (value: { text: string } | null) => void;
  timer?: ReturnType<typeof setTimeout>;
};

/** 通话会话保活时长：超时后 call_reply 不再路由进 Agent，防映射表无界增长 */
const CALL_SESSION_TTL_MS = 10 * 60_000;
/** 用户→Agent 通话 Agent 生成回应的超时；超时按兜底话术接通 */
const USER_CALL_AGENT_TIMEOUT_MS = (() => {
  const n = Number(process.env.VIRTUAL_PHONE_USER_CALL_AGENT_TIMEOUT_MS ?? 25_000);
  return Number.isFinite(n) && n > 0 ? n : 25_000;
})();
/** 通话记录保留天数（TTL 清理），默认 30 天 */
const CALL_HISTORY_TTL_DAYS = (() => {
  const n = Number(process.env.VIRTUAL_PHONE_HISTORY_TTL_DAYS ?? 30);
  return Number.isFinite(n) && n > 0 ? n : 30;
})();

/**
 * 按持久化路径串行化的全局写队列（同进程所有 VirtualPhoneService 实例共享）。
 * 同一文件多实例并发落盘时：Windows 上并发 rename 同一目标会 EPERM，
 * 串行化后写入永远原子且有序。
 */
const persistQueues = new Map<string, Promise<void>>();

export class VirtualPhoneService {
  private readonly byActor = new Map<string, string>();
  private readonly byPhone = new Map<string, string>();
  /** 通话回复总线：提醒电话等场景等待用户在通话中输入（phone.call_reply 喂入） */
  private readonly replyWaiters = new Map<string, ReplyWaiter[]>();
  /** 活跃通话会话：callId → 双方身份，用于通话中回复路由与挂断清理 */
  private readonly callSessions = new Map<string, ActiveCallSession>();
  private userCallAgentHandler: UserCallAgentHandler | null = null;
  private userReplyHandler: UserCallReplyHandler | null = null;

  constructor(
    private readonly tts: TtsService,
    private readonly wsRegistry: ClientPushPort,
  ) {}

  /** 注入用户→Agent 通话的接通回应生成器（应在启动时由 bootstrap 调用一次） */
  setUserCallAgentHandler(handler: UserCallAgentHandler): void {
    this.userCallAgentHandler = handler;
  }

  /** 注入通话中用户回复的处理器（应在启动时由 bootstrap 调用一次） */
  setUserReplyHandler(handler: UserCallReplyHandler): void {
    this.userReplyHandler = handler;
  }

  // ============================================================
  // 通话回复总线：通话中的用户输入（phone.call_reply）与等待方（提醒电话
  // 交互循环 / Agent 主对话管线）在此汇合。
  // ============================================================

  /**
   * 等待用户在指定通话中的下一条输入。
   * 超时或被取消（挂断/强制结束）返回 null；收到输入返回 { text }。
   */
  waitForCallReply(callId: string, timeoutMs: number): Promise<{ text: string } | null> {
    const id = callId.trim();
    if (!id || !(timeoutMs > 0)) return Promise.resolve(null);
    return new Promise((resolve) => {
      const waiter: ReplyWaiter = { resolve };
      const list = this.replyWaiters.get(id) ?? [];
      const timer = setTimeout(() => {
        const arr = this.replyWaiters.get(id);
        if (arr) {
          const idx = arr.indexOf(waiter);
          if (idx >= 0) arr.splice(idx, 1);
          if (arr.length === 0) this.replyWaiters.delete(id);
        }
        resolve(null);
      }, timeoutMs);
      if (typeof timer.unref === "function") timer.unref();
      waiter.timer = timer;
      list.push(waiter);
      this.replyWaiters.set(id, list);
    });
  }

  /** 取消某通电话的全部等待方（以 null 收尾），用于挂断/强制结束时不留悬空 Promise */
  cancelCallReplyWaiters(callId: string): void {
    const id = callId.trim();
    const waiters = this.replyWaiters.get(id);
    if (!waiters) return;
    this.replyWaiters.delete(id);
    for (const waiter of waiters) {
      if (waiter.timer) clearTimeout(waiter.timer);
      waiter.resolve(null);
    }
  }

  /**
   * 投递用户在通话中的回复。
   * 优先唤醒等待方（提醒电话交互循环）；否则若该通话有活跃会话且已注入
   * userReplyHandler，则路由进 Agent 主对话管线（回复经 TTS 推回用户）。
   */
  deliverCallReply(
    callId: string,
    text: string,
    fromUserId?: string,
  ): { ok: boolean; handled?: "reminder_dialogue" | "chat"; error?: string } {
    const id = callId.trim();
    const body = text.trim();
    if (!id) return { ok: false, error: "缺少 callId" };
    if (!body) return { ok: false, error: "缺少回复内容" };

    const waiters = this.replyWaiters.get(id);
    if (waiters && waiters.length > 0) {
      const waiter = waiters.shift()!;
      if (waiter.timer) clearTimeout(waiter.timer);
      if (waiters.length === 0) this.replyWaiters.delete(id);
      waiter.resolve({ text: body });
      return { ok: true, handled: "reminder_dialogue" };
    }

    const session = this.callSessions.get(id);
    if (session) {
      if (fromUserId && session.toUserId && fromUserId !== session.toUserId) {
        return { ok: false, error: "该通话不属于当前会话" };
      }
      const handler = this.userReplyHandler;
      if (handler) {
        void handler({ callId: id, fromActorId: session.fromActorId, toUserId: session.toUserId, text: body })
          .catch((err) => console.error("[virtual-phone] 通话回复处理失败:", err));
        return { ok: true, handled: "chat" };
      }
      return { ok: false, error: "通话回复处理未启用" };
    }

    return { ok: false, error: "通话不存在或已结束" };
  }

  // ============================================================
  // 通话会话与通话内语音推送
  // ============================================================

  private registerCallSession(session: ActiveCallSession): void {
    // 清理过期会话，防长期运行下映射表无界增长
    const now = Date.now();
    for (const [id, s] of this.callSessions) {
      if (now - s.createdAt > CALL_SESSION_TTL_MS) {
        this.callSessions.delete(id);
        this.recordCallHistory(s, "expired");
      }
    }
    this.callSessions.set(session.callId, session);
    this.scheduleSessionsPersist();
  }

  /**
   * 用户挂断/服务端结束通话：清理会话与等待方，落通话记录，并向用户端推 ended 状态。
   */
  endCall(callId: string, reason = "hangup"): { ok: boolean; error?: string } {
    const id = callId.trim();
    if (!id) return { ok: false, error: "缺少 callId" };
    const session = this.callSessions.get(id);
    const closed = this.closeCall(id, reason);
    if (!closed && !this.replyWaiters.has(id)) {
      return { ok: false, error: "通话不存在或已结束" };
    }
    if (session) {
      this.wsRegistry.trySend(
        session.toUserId,
        JSON.stringify({
          type: ServerEventType.VirtualPhoneCallStatus,
          payload: {
            callId: id,
            direction: session.direction,
            status: "ended",
            reason,
          },
        }),
      );
    }
    return { ok: true };
  }

  /**
   * 仅收尾不推送：清理会话/等待方、落通话记录、持久化会话文件。
   * 供自带 ended 推送的调用方（如提醒电话交互循环）使用，避免双 ended 事件。
   */
  closeCall(callId: string, reason = "hangup"): boolean {
    const id = callId.trim();
    if (!id) return false;
    const session = this.callSessions.get(id);
    if (!session) return false;
    this.callSessions.delete(id);
    this.cancelCallReplyWaiters(id);
    this.scheduleSessionsPersist();
    this.recordCallHistory(session, reason);
    return true;
  }

  // ============================================================
  // 并发忙线 / 重启韧性 / 通话记录
  // ============================================================

  /** 该用户是否已有活跃通话会话（同一用户同一时刻只允许一通） */
  private findActiveSessionByUser(toUserId: string): ActiveCallSession | undefined {
    const user = toUserId.trim();
    if (!user) return undefined;
    for (const s of this.callSessions.values()) {
      if (s.toUserId === user) return s;
    }
    return undefined;
  }

  /**
   * 忙线拒绝：向用户推 busy 状态（客户端不覆盖现有通话），并给调用方可重试的失败。
   */
  private rejectBusy(callId: string, toUserId: string, direction: ActiveCallSession["direction"]): void {
    this.wsRegistry.trySend(
      toUserId,
      JSON.stringify({
        type: ServerEventType.VirtualPhoneCallStatus,
        payload: {
          callId,
          direction,
          status: "busy",
          message: "当前已在通话中，新呼叫被拒绝",
        },
      }),
    );
  }

  /**
   * 落通话记录（data/virtual-phone-history/{ts}-{callId}.json）。
   * 只记服务端已知信息：双方、方向、起止与结束原因、呼出语音稿；失败吞掉不影响链路。
   */
  private recordCallHistory(session: ActiveCallSession, endReason: string): void {
    const record = {
      callId: session.callId,
      direction: session.direction,
      fromActorId: session.fromActorId,
      toUserId: session.toUserId,
      startedAt: new Date(session.createdAt).toISOString(),
      endedAt: new Date().toISOString(),
      endReason,
      initialTranscript: session.initialTranscript ?? "",
    };
    const dir = this.historyDir;
    const file = join(dir, `${Date.now()}-${session.callId}.json`);
    void mkdir(dir, { recursive: true })
      .then(() => writeFile(file, JSON.stringify(record, null, 2), "utf8"))
      .catch((err) => console.warn("[VirtualPhoneService] 通话记录落盘失败:", err));
  }

  private get historyDir(): string {
    return process.env.VIRTUAL_PHONE_HISTORY_DIR ?? join(process.cwd(), "data", "virtual-phone-history");
  }

  private get sessionsPath(): string {
    return process.env.VIRTUAL_PHONE_CALLS_FILE ?? join(process.cwd(), "data", "virtual-phone-calls.json");
  }

  /** 活跃通话会话落盘（原子写 + 全局写队列，同 virtual-phones.json 策略） */
  private scheduleSessionsPersist(): void {
    const path = this.sessionsPath;
    const prev = persistQueues.get(path) ?? Promise.resolve();
    const next = prev
      .then(async () => {
        const dir = dirname(path);
        await mkdir(dir, { recursive: true });
        const sessions: ActiveCallSession[] = [...this.callSessions.values()];
        const tmp = `${path}.${randomBytes(4).toString("hex")}.tmp`;
        await writeFile(tmp, JSON.stringify({ sessions }, null, 2), "utf8");
        await rename(tmp, path);
      })
      .catch((err: unknown) => {
        console.warn("[VirtualPhoneService] 通话会话落盘失败:", err);
      });
    persistQueues.set(path, next);
  }

  /**
   * 启动恢复：上次进程遗留的活跃会话已随重启失效——对每通补推
   * ended(server_restart) 让客户端干净收尾，然后清空落盘文件。
   * 顺带做通话记录 TTL 清理。
   */
  private async recoverStaleSessions(): Promise<void> {
    try {
      const raw = await readFile(this.sessionsPath, "utf8");
      const data = JSON.parse(raw) as { sessions?: ActiveCallSession[] };
      for (const s of data.sessions ?? []) {
        if (!s?.callId || !s?.toUserId) continue;
        this.wsRegistry.trySend(
          s.toUserId,
          JSON.stringify({
            type: ServerEventType.VirtualPhoneCallStatus,
            payload: {
              callId: s.callId,
              direction: s.direction,
              status: "ended",
              reason: "server_restart",
            },
          }),
        );
      }
      await unlink(this.sessionsPath).catch(() => undefined);
    } catch {
      // 无遗留会话文件（首次启动/已清理）属正常
    }
    try {
      const dir = this.historyDir;
      const files = await readdir(dir).catch(() => [] as string[]);
      const cutoff = Date.now() - CALL_HISTORY_TTL_DAYS * 24 * 60 * 60_000;
      for (const f of files) {
        if (!f.endsWith(".json")) continue;
        const ts = Number(f.split("-")[0]);
        if (Number.isFinite(ts) && ts < cutoff) {
          await unlink(join(dir, f)).catch(() => undefined);
        }
      }
    } catch (err) {
      console.warn("[VirtualPhoneService] 通话记录 TTL 清理失败:", err);
    }
  }

  /**
   * 通话中向用户推送 Agent 语音回应（TTS + transcript）。
   * 用于提醒电话交互循环与通话中多轮回复；接通首帧请随 call_connecting 下发。
   */
  async pushVoiceReply(
    callId: string,
    toUserId: string,
    transcript: string,
  ): Promise<{ ok: boolean; pushed?: boolean; error?: string }> {
    const id = callId.trim();
    const toUser = toUserId.trim();
    const text = transcript.trim();
    if (!id || !toUser || !text) {
      return { ok: false, error: "缺少 callId / toUserId / transcript" };
    }
    const ttsResult = await this.tts.synthesizeMp3Base64(text).catch(() =>
      ({ ok: false as const, reason: "tts_synth_failed" }),
    );
    const pushed = this.wsRegistry.trySend(
      toUser,
      JSON.stringify({
        type: ServerEventType.VirtualPhoneVoiceReply,
        payload: {
          callId: id,
          direction: "agent_to_user" as const,
          transcript: text,
          tts: ttsResult.ok
            ? { format: ttsResult.format, base64: ttsResult.base64 }
            : { format: null, skippedReason: ttsResult.reason },
        },
      }),
    );
    return { ok: true, pushed };
  }

  private get persistPath(): string {
    return process.env.VIRTUAL_PHONES_FILE ?? join(process.cwd(), "data", "virtual-phones.json");
  }

  async load(): Promise<void> {
    try {
      const raw = await readFile(this.persistPath, "utf8");
      const data = JSON.parse(raw) as PersistedVirtualPhones;
      this.byActor.clear();
      this.byPhone.clear();
      for (const [actor, phone] of Object.entries(data.byActor ?? {})) {
        const a = actor?.trim() ?? "";
        const p = normalizeVirtualPhone(phone);
        if (!a || !p) continue;
        const owner = this.byPhone.get(p);
        if (owner && owner !== a) {
          continue;
        }
        this.byActor.set(a, p);
        this.byPhone.set(p, a);
      }
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      // 号码文件不存在（首次启动）不算错，继续走重启恢复
      if (err.code !== "ENOENT") throw e;
    }
    // 号码装好后做重启恢复与会话记录 TTL 清理（best-effort，失败不断链）
    await this.recoverStaleSessions();
  }

  private schedulePersist(): void {
    const path = this.persistPath;
    // 按路径的全局写队列：同进程多实例（测试/多会话）写同一文件时串行化，
    // 避免并发 rename 在 Windows 上 EPERM；失败吞掉（warn），链不断
    const prev = persistQueues.get(path) ?? Promise.resolve();
    const next = prev
      .then(() => this.persistNow())
      .catch((err: unknown) => {
        console.warn("[VirtualPhoneService] persist failed:", err);
      });
    persistQueues.set(path, next);
  }

  private async persistNow(): Promise<void> {
    const dir = dirname(this.persistPath);
    await mkdir(dir, { recursive: true });
    const byActor: Record<string, string> = {};
    for (const [k, v] of this.byActor) byActor[k] = v;
    // 原子写（tmp + rename）：多个实例/进程写同一路径时读方永远看到完整 JSON，
    // 不会出现并发 writeFile 交错出的截断/拼接损坏（同 booking-order-store 策略）
    const tmp = `${this.persistPath}.${randomBytes(4).toString("hex")}.tmp`;
    await writeFile(tmp, JSON.stringify({ byActor }, null, 2), "utf8");
    await rename(tmp, this.persistPath);
  }

  getPhoneForActor(actorId: string): string | undefined {
    return this.byActor.get(actorId);
  }

  /**
   * 申领或返回该 Actor（Agent 实例）的 6 位虚拟号码。
   * 号码登记在 Agent 名下，即用户的站内电话号，申领后方可呼出虚拟电话；App 内通话不必另输 6 位号。
   * 仅应在用户明确要求办理时调用（如 `phone.ensure_my_number`），不得在其它路径隐式调用。
   */
  ensureNumber(actorId: string): string {
    const id = actorId.trim();
    if (!id) throw new Error("actorId 不能为空");
    const existing = this.byActor.get(id);
    if (existing) return existing;

    const maxAttempts = 16_384;
    const poolSize = 1_000_000;
    const taken = this.byPhone.size;
    if (taken >= poolSize) {
      throw new Error("6 位虚拟号已用尽");
    }
    for (let i = 0; i < maxAttempts; i++) {
      const candidate = randomSixDigits();
      if (this.byPhone.has(candidate)) continue;
      this.byActor.set(id, candidate);
      this.byPhone.set(candidate, id);
      this.schedulePersist();
      return candidate;
    }
    throw new Error("虚拟号池忙碌，请稍后重试");
  }

  /**
   * 释放该 Actor 的站内号码（账号注销/用户主动解绑）。
   * 号码回池可被再次随机分给他人；未申领时返回 ok:false。
   */
  releaseNumber(actorId: string): { ok: boolean; released?: string; error?: string } {
    const id = actorId.trim();
    if (!id) return { ok: false, error: "actorId 不能为空" };
    const phone = this.byActor.get(id);
    if (!phone) return { ok: false, error: "该 Actor 尚未申领号码" };
    this.byActor.delete(id);
    this.byPhone.delete(phone);
    this.schedulePersist();
    return { ok: true, released: phone };
  }

  /**
   * Agent 直接呼叫用户（无需用户有虚拟号码）。
   * 通过 WebSocket 向用户的客户端推送来电事件，附带 TTS 语音。
   * 用户可在接听后回复文字或语音，实现双向交互式通话。
   */
  async callUser(params: CallUserParams): Promise<{
    ok: boolean;
    callId?: string;
    pushed?: boolean;
    busy?: boolean;
    toUserId?: string;
    fromPhone?: string;
    error?: string;
  }> {
    const fromActorId = params.fromActorId.trim();
    const toUserId = params.toUserId.trim();
    if (!fromActorId) {
      return { ok: false, error: "主叫方 Actor ID 无效" };
    }
    if (!toUserId) {
      return { ok: false, error: "被叫用户 ID 无效" };
    }
    // 忙线护栏：同一用户同一时刻只允许一通，后来的呼叫推 busy 且不入会话
    const activeCall = this.findActiveSessionByUser(toUserId);
    if (activeCall) {
      const busyCallId = randomUUID();
      this.rejectBusy(busyCallId, toUserId, "agent_to_user");
      return { ok: false, busy: true, error: "用户当前已在通话中，请稍后再试", callId: busyCallId };
    }
    const fromPhone = this.byActor.get(fromActorId);
    const ttsResult = await this.tts.synthesizeMp3Base64(params.transcript);
    const callId = randomUUID();

    const payload: Record<string, unknown> = {
      callId,
      fromActorId,
      fromPhone: fromPhone ?? null,
      toUserId,
      transcript: params.transcript.trim(),
      ringStyle: params.ringStyle,
      initiatedBy: "agent" as const,
      direction: "agent_to_user" as const,
      tts: ttsResult.ok
        ? { format: ttsResult.format, base64: ttsResult.base64 }
        : { format: null, skippedReason: ttsResult.reason },
      replyEnabled: true,
    };

    const pushed = this.wsRegistry.trySend(
      toUserId,
      JSON.stringify({
        type: ServerEventType.VirtualPhoneIncoming,
        payload,
      }),
    );

    if (pushed) {
      this.registerCallSession({
        callId,
        fromActorId,
        toUserId,
        direction: "agent_to_user",
        createdAt: Date.now(),
        initialTranscript: params.transcript.trim(),
      });
    }

    return {
      ok: true,
      callId,
      pushed,
      toUserId,
      fromPhone: fromPhone ?? undefined,
    };
  }

  /**
   * Agent 呼叫用户（带前摇振铃阶段）。
   *
   * 分两个阶段推送：
   *   1. ringing_start —— 客户端进入「振铃中」UI，播放振铃音、渐入动画、倒计时
   *   2. call_connecting（延迟后）—— 前摇结束，正式接通，含 TTS 音频 + transcript
   *
   * 若 ringPhase.enableRingingPhase === false 则退化为旧逻辑直接推 incoming。
   */
  async callUserWithRinging(params: CallUserParams): Promise<{
    ok: boolean;
    callId?: string;
    pushed?: boolean;
    busy?: boolean;
    toUserId?: string;
    fromPhone?: string;
    error?: string;
  }> {
    const fromActorId = params.fromActorId.trim();
    const toUserId = params.toUserId.trim();
    if (!fromActorId) {
      return { ok: false, error: "主叫方 Actor ID 无效" };
    }
    if (!toUserId) {
      return { ok: false, error: "被叫用户 ID 无效" };
    }
    // 忙线护栏：同一用户同一时刻只允许一通
    const activeCall = this.findActiveSessionByUser(toUserId);
    if (activeCall) {
      const busyCallId = randomUUID();
      this.rejectBusy(busyCallId, toUserId, "agent_to_user");
      return { ok: false, busy: true, error: "用户当前已在通话中，请稍后再试", callId: busyCallId };
    }

    const ringCfg = params.ringPhase ?? {};
    const enableRinging = ringCfg.enableRingingPhase !== false;
    const ringDurationMs = ringCfg.ringDurationMs ?? 8_000;

    const fromPhone = this.byActor.get(fromActorId);
    const callId = randomUUID();

    // ---- 阶段 1：推送振铃开始事件 ----
    if (enableRinging) {
      const ringingPayload: Record<string, unknown> = {
        callId,
        fromActorId,
        fromPhone: fromPhone ?? null,
        toUserId,
        direction: "agent_to_user" as const,
        status: "ringing",
        ringStyle: params.ringStyle,
        initiatedBy: "agent" as const,
        /** 振铃持续毫秒数，客户端用于倒计时 */
        ringDurationMs,
        /** 预计自动接通时间戳（ISO） */
        estimatedConnectAt: new Date(Date.now() + ringDurationMs).toISOString(),
      };

      this.wsRegistry.trySend(
        toUserId,
        JSON.stringify({
          type: ServerEventType.VirtualPhoneRingingStart,
          payload: ringingPayload,
        }),
      );
    }

    // ---- 预生成 TTS（与振铃并行，减少接通等待） ----
    const ttsResult = await this.tts.synthesizeMp3Base64(params.transcript);

    // ---- 等待振铃阶段结束 ----
    if (enableRinging) {
      await new Promise<void>((resolve) => setTimeout(resolve, ringDurationMs));
    }

    // ---- 阶段 2：推送接通事件（含 TTS + 正文） ----
    const connectPayload: Record<string, unknown> = {
      callId,
      fromActorId,
      fromPhone: fromPhone ?? null,
      toUserId,
      transcript: params.transcript.trim(),
      ringStyle: params.ringStyle,
      initiatedBy: "agent" as const,
      direction: "agent_to_user" as const,
      status: "connected",
      tts: ttsResult.ok
        ? { format: ttsResult.format, base64: ttsResult.base64 }
        : { format: null, skippedReason: ttsResult.reason },
      replyEnabled: true,
    };

    const pushed = this.wsRegistry.trySend(
      toUserId,
      JSON.stringify({
        type: enableRinging
          ? ServerEventType.VirtualPhoneCallConnecting
          : ServerEventType.VirtualPhoneIncoming,
        payload: connectPayload,
      }),
    );

    if (pushed) {
      this.registerCallSession({
        callId,
        fromActorId,
        toUserId,
        direction: "agent_to_user",
        createdAt: Date.now(),
        initialTranscript: params.transcript.trim(),
      });
    }

    return {
      ok: true,
      callId,
      pushed,
      toUserId,
      fromPhone: fromPhone ?? undefined,
    };
  }

  /**
   * 用户主动拨打 Agent（通过 WebSocket 或 HTTP 触发）。
   * 支持前摇阶段：先推振铃状态 → 延迟后推接通状态。
   * 向用户端推送「通话中」状态序列（ringing -> connecting -> connected）。
   * 返回 callId 供后续消息关联。
   */
  async handleUserCallAgent(params: UserCallAgentParams): Promise<{
    ok: boolean;
    callId?: string;
    busy?: boolean;
    error?: string;
  }> {
    const fromUserId = params.fromUserId.trim();
    const toActorId = params.toActorId.trim();
    if (!fromUserId) {
      return { ok: false, error: "用户 ID 无效" };
    }
    if (!toActorId) {
      return { ok: false, error: "目标 Agent ID 无效" };
    }
    // 号码注册制门禁：只有申领了站内号码的用户才能发起虚拟通话
    if (!this.byActor.get(fromUserId)) {
      return {
        ok: false,
        error:
          "尚未申领站内号码，无法发起通话。请先申领：对我说「帮我申请虚拟号码」即可领取 6 位号码。",
      };
    }
    // 忙线护栏：用户已在通话中时拒绝再次发起，避免新会话顶掉进行中的通话
    if (this.findActiveSessionByUser(fromUserId)) {
      return { ok: false, busy: true, error: "当前已在通话中，请先挂断再发起新呼叫" };
    }

    const ringCfg = params.ringPhase ?? {};
    const enableRinging = ringCfg.enableRingingPhase !== false;
    const ringDurationMs = ringCfg.ringDurationMs ?? 5_000; // 用户主动呼叫默认5秒振铃

    const toPhone = this.byActor.get(toActorId);
    const callId = randomUUID();

    // ---- 阶段 1：振铃中 ----
    const ringingPayload: Record<string, unknown> = {
      callId,
      toActorId,
      toPhone: toPhone ?? null,
      userMessage: (params.userMessage ?? "").trim(),
      direction: "user_to_agent" as const,
      status: "ringing",
      /** 振铃持续时间 */
      ringDurationMs: enableRinging ? ringDurationMs : undefined,
      message: "正在呼叫 Agent，请稍候…",
    };

    this.wsRegistry.trySend(
      fromUserId,
      JSON.stringify({
        type: ServerEventType.VirtualPhoneCallStatus,
        payload: ringingPayload,
      }),
    );

    // ---- 阶段 2：等待振铃后进入接通/连接中 ----
    if (enableRinging) {
      await new Promise<void>((resolve) => setTimeout(resolve, ringDurationMs));
    }

    // 推送「连接中」状态
    this.wsRegistry.trySend(
      fromUserId,
      JSON.stringify({
        type: ServerEventType.VirtualPhoneCallStatus,
        payload: {
          callId,
          toActorId,
          toPhone: toPhone ?? null,
          direction: "user_to_agent" as const,
          status: "connecting",
          message: "Agent 正在接听…",
        },
      }),
    );

    // 登记通话会话：接通后用户可在通话中继续回复（phone.call_reply 路由进 Agent）
    this.registerCallSession({
      callId,
      fromActorId: toActorId,
      toUserId: fromUserId,
      direction: "user_to_agent",
      createdAt: Date.now(),
      initialTranscript: (params.userMessage ?? "").trim(),
    });

    // Agent 回应生成走异步续体：不阻塞本次 WS 事件处理（避免 Agent 回合
    // 期间同 socket 的后续消息——如 call_reply——被串行阻塞）。
    void this.completeUserCallAgent({
      callId,
      fromUserId,
      toActorId,
      toPhone: toPhone ?? null,
      userMessage: (params.userMessage ?? "").trim(),
    }).catch((err) => console.error("[virtual-phone] user call completion failed:", err));

    return { ok: true, callId };
  }

  /**
   * 用户→Agent 通话的接通续体：等待 Agent 生成回应（带超时兜底），
   * 推送 connected（含回应 transcript + TTS）。后续多轮经 userReplyHandler 走 voice_reply。
   */
  private async completeUserCallAgent(args: {
    callId: string;
    fromUserId: string;
    toActorId: string;
    toPhone: string | null;
    userMessage: string;
  }): Promise<void> {
    let replyText = "";
    const handler = this.userCallAgentHandler;
    if (handler) {
      try {
        const result = await Promise.race([
          handler(args),
          new Promise<null>((resolve) => {
            const t = setTimeout(() => resolve(null), USER_CALL_AGENT_TIMEOUT_MS);
            if (typeof t.unref === "function") t.unref();
          }),
        ]);
        replyText = result?.replyText?.trim() ?? "";
      } catch (err) {
        console.error("[virtual-phone] user call agent handler failed:", err);
      }
    }
    if (!replyText) {
      replyText = "您好，我已接通。刚才没能整理出回复，请稍后在对话里告诉我您想说的话。";
    }

    const ttsResult = await this.tts.synthesizeMp3Base64(replyText).catch(() =>
      ({ ok: false as const, reason: "tts_synth_failed" }),
    );

    this.wsRegistry.trySend(
      args.fromUserId,
      JSON.stringify({
        type: ServerEventType.VirtualPhoneCallStatus,
        payload: {
          callId: args.callId,
          toActorId: args.toActorId,
          toPhone: args.toPhone,
          direction: "user_to_agent" as const,
          status: "connected",
          transcript: replyText,
          tts: ttsResult.ok
            ? { format: ttsResult.format, base64: ttsResult.base64 }
            : { format: null, skippedReason: ttsResult.reason },
          message: "Agent 已接听",
        },
      }),
    );
  }
}

export function normalizeVirtualPhone(raw: string): string | null {
  const digits = String(raw ?? "").replace(/\D/g, "");
  if (digits.length !== 6) return null;
  return digits;
}

/** 密码学安全随机，均匀分布于 000000–999999；与 byPhone 配合保证进程内唯一。 */
function randomSixDigits(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, "0");
}
