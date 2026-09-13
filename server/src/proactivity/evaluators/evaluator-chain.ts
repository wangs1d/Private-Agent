// 流式评估器链（EvaluatorChain）—— 五层主动性架构 L2 的落地。
//
// 订阅 SensorKernel 的信号流，按批次跑声明式评估器（纯函数 + 各自有状态小模型），
// 产出统一 AttentionEvent → 交仲裁层裁决。全部零 LLM：
//  - 规则评估器替代"LLM 找理由主动"的旧模式——主动性的原料是被持续追踪状态的 delta
//  - 事件携带模板直出的正文（voice-templates），表达层随时可发
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { ProactiveImportance } from "../pipeline-types.js";
import type { AttentionUrgency } from "../arbiter-v2.js";
import type { Signal, SignalStream } from "../sensors/types.js";

/** 评估器产出的事件：仲裁与投递的唯一中间格式 */
export type AttentionEvent = {
  id: string;
  at: number;
  /** 评估器 id（诊断与防重） */
  kind: string;
  urgency: AttentionUrgency;
  /** 管道提案 kind（映射频控冷却表，如 greeting / care / life_reminder） */
  proposalKind: string;
  tier: "must" | "social";
  importance: ProactiveImportance;
  title: string;
  /** 模板直出的用户可见文本（零 LLM） */
  body: string;
  dedupKey: string;
  salience: "high" | "medium" | "low";
  /** ask_first 提案的确认按钮文案（如承诺代催） */
  confirmLabel?: string;
  /** 提案保质期 ms（如临日会议提醒在会议开始后即无意义） */
  expiresAt?: number;
  actorId?: string;
};

/** 评估器可消费的外部数据源（全部可选注入，缺了自动跳段） */
export type EvaluatorServices = Record<string, unknown>;

export type EvaluatorContext = {
  now: Date;
  nowMs: number;
  /** 自上次 flush 以来该评估器订阅流的新信号 */
  recent: (stream: SignalStream) => Signal[];
  /** 该流最近一条信号（历史，不限本次窗口） */
  latest: (stream: SignalStream) => Signal | undefined;
  /** 评估器私有状态（跨批次保留） */
  state: Map<string, unknown>;
  /** 信号归属用户（多 actor 维度；缺省 undefined → 事件用链默认 actor） */
  actorIdOf: (signal: Signal | undefined) => string | undefined;
  /** 外部数据源（digest/日程/承诺等拼接用） */
  services: EvaluatorServices;
};

export type Evaluator = {
  id: string;
  /** 订阅的信号流；空数组 = 时间驱动（按 tickEveryMs 周期触发） */
  streams: SignalStream[];
  tickEveryMs?: number;
  eval(ctx: EvaluatorContext): AttentionEvent[] | Promise<AttentionEvent[]>;
};

export type EvaluatorChainOptions = {
  /** flush 批间隔（默认 20s） */
  flushIntervalMs?: number;
  /** 默认 actor（单用户场景；多用户时评估器在事件里自行指定） */
  defaultActorId?: () => string | null;
  /** 评估器可消费的外部数据源（日程/承诺/天气/目标……bootstrap 注入） */
  services?: EvaluatorServices;
  /**
   * 状态持久化目录：提供时，评估器私有 state 与事件去重指纹在每次 flush 后
   * 落盘 evaluator-state.json、构造时恢复——重启不重发、马拉松计时不清零。
   */
  dataPath?: string;
  nowFn?: () => number;
};

const STREAM_BUFFER_MAX = 200;
const EVENT_DEDUP_MAX = 400;
const STATE_SAVE_MIN_INTERVAL_MS = 60_000; // 落盘节流：状态变化至多每分钟写盘一次

/** 事件审计单条记录（events.ndjson；每一次主动事件的裁决全链留痕） */
export type EventAuditRecord = {
  at: number;
  eventId: string;
  kind: string;
  urgency: string;
  actorId: string;
  /** 仲裁动作（deliver_now / wait_for_pause / log） */
  action: string;
  cost?: number;
  /** 管道 verdict（deliver_now 时有值） */
  verdict?: string;
  title: string;
};

const EVENT_LOG_MAX_BYTES = 5 * 1024 * 1024;

/** 追加事件审计（轮转同信号日志；落盘失败静默） */
export function appendEventAudit(logPath: string, rec: EventAuditRecord): void {
  try {
    mkdirSync(dirname(logPath), { recursive: true });
    if (existsSync(logPath) && statSync(logPath).size > EVENT_LOG_MAX_BYTES) {
      try {
        renameSync(logPath, `${logPath}.1`);
      } catch {
        /* 轮转失败继续追加 */
      }
    }
    appendFileSync(logPath, `${JSON.stringify(rec)}
`);
  } catch {
    /* 审计失败不影响主链路 */
  }
}

/** 序列化评估器状态：Map/Set 展开为标记对象，其余 JSON 原生 */
function serializeValue(v: unknown): unknown {
  if (v instanceof Map) return { __t: "map", e: [...v].map(([k, val]) => [k, serializeValue(val)]) };
  if (v instanceof Set) return { __t: "set", e: [...v].map((x) => serializeValue(x)) };
  return v;
}

function deserializeValue(v: unknown): unknown {
  if (v && typeof v === "object" && !Array.isArray(v)) {
    const rec = v as { __t?: string; e?: unknown };
    if (rec.__t === "map" && Array.isArray(rec.e)) {
      return new Map(rec.e.map(([k, val]) => [k, deserializeValue(val)]));
    }
    if (rec.__t === "set" && Array.isArray(rec.e)) {
      return new Set(rec.e.map((x) => deserializeValue(x)));
    }
  }
  return v;
}

export class EvaluatorChain {
  private readonly evaluators: Evaluator[] = [];
  private readonly buffers = new Map<SignalStream, Signal[]>();
  private readonly latestByStream = new Map<SignalStream, Signal>();
  private readonly evalWatermark = new Map<string, number>();
  private readonly state = new Map<string, Map<string, unknown>>();
  private readonly eventFingerprints = new Map<string, number>(); // dedupKey → at（LRU）
  private readonly listeners = new Set<(event: AttentionEvent) => void>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly flushIntervalMs: number;
  private readonly nowFn: () => number;
  private readonly statePath: string | null;
  private lastStateSaveAt = 0;
  private stateDirty = false;

  constructor(private readonly opts: EvaluatorChainOptions) {
    this.flushIntervalMs = opts.flushIntervalMs ?? 20_000;
    this.nowFn = opts.nowFn ?? Date.now;
    this.statePath = opts.dataPath ? join(opts.dataPath, "evaluator-state.json") : null;
    this.restoreState();
  }

  /** 重启恢复：评估器 state + 事件去重指纹（消除重启后重复投递/计时清零） */
  private restoreState(): void {
    if (!this.statePath) return;
    try {
      if (!existsSync(this.statePath)) return;
      const raw = JSON.parse(readFileSync(this.statePath, "utf8")) as {
        evaluators?: Record<string, Record<string, unknown>>;
        eventFingerprints?: Array<[string, number]>;
      };
      for (const [id, kv] of Object.entries(raw.evaluators ?? {})) {
        const map = this.state.get(id) ?? new Map<string, unknown>();
        for (const [k, v] of Object.entries(kv)) map.set(k, deserializeValue(v));
        this.state.set(id, map);
      }
      for (const [k, at] of raw.eventFingerprints ?? []) this.eventFingerprints.set(k, at);
      console.log(
        `[EvaluatorChain] 状态已恢复 evaluators=${Object.keys(raw.evaluators ?? {}).length} fingerprints=${raw.eventFingerprints?.length ?? 0}`,
      );
    } catch {
      /* 损坏文件按空状态处理 */
    }
  }

  /** 状态落盘（节流：脏标记 + 最小间隔） */
  private persistState(force = false): void {
    if (!this.statePath || !this.stateDirty) return;
    const now = this.nowFn();
    if (!force && now - this.lastStateSaveAt < STATE_SAVE_MIN_INTERVAL_MS) return;
    try {
      mkdirSync(dirname(this.statePath), { recursive: true });
      const evaluators: Record<string, Record<string, unknown>> = {};
      for (const [id, map] of this.state) {
        if (map.size === 0) continue;
        const kv: Record<string, unknown> = {};
        for (const [k, v] of map) kv[k] = serializeValue(v);
        evaluators[id] = kv;
      }
      writeFileSync(this.statePath, JSON.stringify({ evaluators, eventFingerprints: [...this.eventFingerprints] }));
      this.stateDirty = false;
      this.lastStateSaveAt = now;
    } catch {
      /* 落盘失败不影响评估主链路 */
    }
  }

  register(evaluator: Evaluator): void {
    this.evaluators.push(evaluator);
    this.evalWatermark.set(evaluator.id, 0);
    this.state.set(evaluator.id, new Map());
  }

  /** 订阅事件（bootstrap 接仲裁层 + 观察流） */
  onEvent(listener: (event: AttentionEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** 接 SensorKernel 信号（bootstrap 一行桥接） */
  handleSignal = (signal: Signal): void => {
    const buf = this.buffers.get(signal.stream) ?? [];
    buf.push(signal);
    if (buf.length > STREAM_BUFFER_MAX) buf.shift();
    this.buffers.set(signal.stream, buf);
    this.latestByStream.set(signal.stream, signal);
  };

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.flush(), this.flushIntervalMs);
    if (typeof this.timer.unref === "function") this.timer.unref();
    console.log(
      `[EvaluatorChain] 已启动 evaluators=${this.evaluators.length}（批间隔 ${Math.round(this.flushIntervalMs / 1000)}s，零 LLM）`,
    );
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.persistState(true);
  }

  /** 评估器状态概览（selftest 探针：id/订阅流/状态键数） */
  probes(): Array<{ id: string; streams: string[]; stateKeys: number; tickEveryMs?: number }> {
    return this.evaluators.map((e) => ({
      id: e.id,
      streams: [...e.streams],
      stateKeys: this.state.get(e.id)?.size ?? 0,
      ...(e.tickEveryMs !== undefined ? { tickEveryMs: e.tickEveryMs } : {}),
    }));
  }

  /** 批处理：各评估器消费新信号 / 到期时间驱动，产出事件分发 */
  async flush(): Promise<void> {
    const nowMs = this.nowFn();
    const now = new Date(nowMs);
    for (const evaluator of this.evaluators) {
      const wm = this.evalWatermark.get(evaluator.id) ?? 0;
      this.evalWatermark.set(evaluator.id, nowMs);
      const recent = (stream: SignalStream): Signal[] =>
        evaluator.streams.includes(stream) ? (this.buffers.get(stream) ?? []).filter((s) => s.at > wm) : [];
      // 触发条件：订阅流有新信号，或时间驱动到期（tickEveryMs）
      const tickDue = evaluator.tickEveryMs !== undefined && nowMs - wm >= evaluator.tickEveryMs;
      const hasFresh = evaluator.streams.some((st) => recent(st).length > 0);
      if (!tickDue && !hasFresh) continue;
      try {
        const events = await evaluator.eval({
          now,
          nowMs,
          recent,
          latest: (stream) => this.latestByStream.get(stream),
          state: this.state.get(evaluator.id) ?? new Map(),
          actorIdOf: (sig) => sig?.actorId,
          services: this.opts.services ?? {},
        });
        for (const event of events ?? []) this.dispatch(event);
      } catch (err) {
        console.log(`[EvaluatorChain] 评估器 ${evaluator.id} 失败（忽略）: ${err}`);
      }
      // 清理已被全部评估器消费的旧缓冲（保留最近 50 条供 latest）
      for (const [stream, buf] of this.buffers) {
        if (buf.length > STREAM_BUFFER_MAX / 2) this.buffers.set(stream, buf.slice(-50));
      }
    }
    this.persistState(); // 评估器产生了状态/去重变化 → 节流落盘
  }

  private dispatch(event: AttentionEvent): void {
    // 事件级去重（同 dedupKey 一天内只发一次）
    const fp = event.dedupKey || `${event.kind}:${event.at}`;
    const dayKey = `${fp}:${new Date(event.at).toISOString().slice(0, 10)}`;
    if (this.eventFingerprints.has(dayKey)) return;
    this.eventFingerprints.set(dayKey, event.at);
    this.stateDirty = true;
    while (this.eventFingerprints.size > EVENT_DEDUP_MAX) {
      const oldest = this.eventFingerprints.keys().next().value;
      if (oldest === undefined) break;
      this.eventFingerprints.delete(oldest);
    }
    const filled: AttentionEvent = {
      ...event,
      actorId: event.actorId ?? this.opts.defaultActorId?.() ?? "local_user",
      id: event.id || `ev_${event.kind}_${event.at.toString(36)}`,
    };
    for (const listener of this.listeners) {
      try {
        listener(filled);
      } catch {
        /* 单订阅者失败不影响其他 */
      }
    }
  }
}
