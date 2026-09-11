import type { ProactiveOutboundMessageService } from "../proactive-outbound-message-service.js";
import { HabitRuleStore, newHabitRuleId } from "./habit-rule-store.js";
import { HabitMiner } from "./habit-miner.js";
import type {
  HabitAction,
  HabitAuthorization,
  HabitCandidate,
  HabitLocationSample,
  HabitRule,
  HabitToolObservation,
  HabitTrigger,
} from "./habit-types.js";

/**
 * 习惯学习 → 自动执行闭环 —— 编排服务。
 *
 *   观察输入：locationLister（位置历史适配）+ recordToolEvent（HookBus
 *   tool.executed 订阅）→ HabitMiner 挖掘候选 → 规则落库
 *   执行循环：tick 匹配触发器（daily/weekly/once/location_enter/
 *   tool_pattern）→ 授权判定（auto → 直接执行，不做置信度门槛；
 *   confirm_each → 提案等确认）→ 结果反馈回灌 confidence（成功 +0.05 /
 *   失败 -0.10；auto 连续失败 2 次自动降权回 confirm_each；
 *   confirm_each 连续确认成功 3 次建议升 auto）
 *
 * 安全护栏：
 *   - 提案执行需 confirmationToken（10 分钟 TTL，一次性）
 *   - quietHours 命中时 auto 规则静默跳过（不打扰、不提案）
 *   - 金融类工具的最终闸门在 AgentTaskSafety / BookingService 两阶段确认
 *   - 产品口径：新建/挖掘规则一律先 confirm_each（提案等确认），
 *     确认成功 3 次后才建议升 auto；auto 仅限显式授权
 */

const PROPOSAL_TTL_MS = 10 * 60_000;
const MAX_TOOL_OBSERVATIONS = 3000;
/** 时间触发匹配窗（分钟）：tick 跳周期也不漏触发。 */
const TRIGGER_WINDOW_MIN = 3;

const DEFAULT_COOLDOWN_MIN: Record<HabitTrigger["kind"], number> = {
  daily: 20 * 60,
  weekly: 6 * 24 * 60,
  once: 0,
  location_enter: 6 * 60,
  tool_pattern: 7 * 24 * 60,
};

export interface HabitLoopDeps {
  outbound: ProactiveOutboundMessageService;
  /**
   * 工具执行适配（bootstrap 注入 toolRegistry.execute 的包装）。
   * mode="auto"（授权自动执行路径）/ "confirmed"（用户已确认路径）——
   * 装配层据此拒绝自动执行 spend/outbound 类工具（分类层护栏）。
   */
  toolExecutor?: ((tool: string, input: Record<string, unknown>, actorId: string, mode: "auto" | "confirmed") => Promise<{ ok: boolean; result: Record<string, unknown> }>) | null;
  /** 后台任务执行适配（bootstrap 注入 runtime/agent-task 通道） */
  agentTaskRunner?: ((actorId: string, instruction: string) => Promise<{ ok: boolean; summary: string }>) | null;
  /** 位置历史适配（bootstrap 注入 locationHistory.query 的包装） */
  locationLister?: ((actorId: string, sinceMs: number) => Promise<HabitLocationSample[]>) | null;
  storeFile?: string | null;
  observationsFile?: string | null;
  tickMs?: number;
  now?: () => Date;
}

interface PendingRun {
  token: string;
  ruleId: string;
  actorId: string;
  createdAt: number;
}

/** 待确认提案的收件箱视图（approval-inbox 消费；id 即一次性 confirmationToken）。
 *  已随「习惯不进收件箱」口径移除——confirmRun 仍保留给失败降权规则的对话内确认。 */

export class HabitLoopService {
  private readonly deps: HabitLoopDeps;
  private readonly store: HabitRuleStore;
  private readonly miner: HabitMiner;
  private readonly pendingRuns = new Map<string, PendingRun>();
  private readonly toolObservations: HabitToolObservation[] = [];
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;
  private obsPersistTimer: NodeJS.Timeout | null = null;

  constructor(deps: HabitLoopDeps) {
    this.deps = deps;
    this.store = new HabitRuleStore(deps.storeFile ?? null);
    this.miner = new HabitMiner();
    void this.loadObservations();
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.deps.tickMs ?? 60_000);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.obsPersistTimer) {
      clearTimeout(this.obsPersistTimer);
      this.obsPersistTimer = null;
    }
    void this.persistObservations();
    void this.store.flush();
  }

  // ------------------------------------------------------------------ //
  // 观察输入
  // ------------------------------------------------------------------ //

  recordToolEvent(actorId: string, tool: string, at = Date.now()): void {
    if (!actorId || !tool) return;
    this.toolObservations.push({ actorId, tool, at });
    if (this.toolObservations.length > MAX_TOOL_OBSERVATIONS) {
      this.toolObservations.splice(0, this.toolObservations.length - MAX_TOOL_OBSERVATIONS);
    }
    this.schedulePersistObservations();
    void this.checkToolPatternHit(actorId, tool, at).catch((err) => {
      console.warn("[HabitLoop] tool_pattern hit check failed:", err);
    });
  }

  // ------------------------------------------------------------------ //
  // 规则管理（工具面）
  // ------------------------------------------------------------------ //

  async createRule(draft: {
    actorId: string;
    name: string;
    trigger: HabitTrigger;
    action: HabitAction;
    source?: "manual" | "mined";
    description?: string;
    authorization?: HabitAuthorization;
    confidence?: number;
    enabled?: boolean;
    quietHours?: { start: string; end: string };
  }): Promise<HabitRule> {
    const now = this.deps.now?.() ?? new Date();
    const rule: HabitRule = {
      id: newHabitRuleId(now),
      actorId: draft.actorId,
      name: draft.name.trim() || "未命名习惯",
      description: draft.description,
      source: draft.source ?? "manual",
      trigger: draft.trigger,
      action: draft.action,
      authorization: draft.authorization ?? "confirm_each",
      confidence: clamp(draft.confidence ?? (draft.source === "mined" ? 0.45 : 0.5), 0.1, 0.95),
      enabled: draft.enabled ?? true,
      cooldownMinutes: DEFAULT_COOLDOWN_MIN[draft.trigger.kind],
      quietHours: draft.quietHours,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      stats: { runCount: 0, successCount: 0, failCount: 0, consecutiveFails: 0, confirmedCount: 0 },
    };
    return this.store.upsert(rule);
  }

  async listRules(actorId: string): Promise<HabitRule[]> {
    return this.store.listByActor(actorId);
  }

  async getRule(actorId: string, ruleId: string): Promise<HabitRule | null> {
    const rule = await this.store.get(ruleId);
    return rule && rule.actorId === actorId ? rule : null;
  }

  async updateRule(
    actorId: string,
    ruleId: string,
    patch: { enabled?: boolean; authorization?: HabitAuthorization; name?: string; cooldownMinutes?: number },
  ): Promise<HabitRule | null> {
    const rule = await this.getRule(actorId, ruleId);
    if (!rule) return null;
    const updated: HabitRule = {
      ...rule,
      ...("name" in patch && patch.name?.trim() ? { name: patch.name.trim() } : {}),
      ...("enabled" in patch ? { enabled: patch.enabled === true } : {}),
      ...("authorization" in patch && patch.authorization ? { authorization: patch.authorization } : {}),
      ...("cooldownMinutes" in patch && typeof patch.cooldownMinutes === "number" && patch.cooldownMinutes >= 0
        ? { cooldownMinutes: patch.cooldownMinutes }
        : {}),
      updatedAt: (this.deps.now?.() ?? new Date()).toISOString(),
    };
    return this.store.upsert(updated);
  }

  async deleteRule(actorId: string, ruleId: string): Promise<boolean> {
    return this.store.delete(ruleId, actorId);
  }

  // ------------------------------------------------------------------ //
  // 挖掘
  // ------------------------------------------------------------------ ]

  async mine(actorId: string, create = false): Promise<{ candidates: HabitCandidate[]; created: HabitRule[] }> {
    const now = this.deps.now?.() ?? new Date();
    const since = now.getTime() - 21 * 86_400_000;
    const locations = (await this.deps.locationLister?.(actorId, since)) ?? [];
    const candidates = [
      ...this.miner.mineFromLocation(locations, now),
      ...this.miner.mineFromTools(this.toolObservations, actorId, now),
    ];
    const created: HabitRule[] = [];
    if (create) {
      const existing = await this.store.listByActor(actorId);
      const existingKeys = new Set(existing.map((r) => `${r.name}|${JSON.stringify(r.trigger)}`));
      for (const candidate of candidates) {
        const key = `${candidate.name}|${JSON.stringify(candidate.trigger)}`;
        if (existingKeys.has(key)) continue;
        existingKeys.add(key);
        created.push(
          await this.createRule({
            actorId,
            name: candidate.name,
            description: candidate.description,
            source: "mined",
            trigger: candidate.trigger,
            action: candidate.action ?? { kind: "message", text: `习惯提醒：${candidate.name}。需要我按惯例处理什么，直接说` },
            authorization: "confirm_each",
            confidence: candidate.confidence,
          }),
        );
      }
    }
    return { candidates, created };
  }

  // ------------------------------------------------------------------ //
  // 执行入口
  // ------------------------------------------------------------------ //

  /** 手动立即执行（用户明确要求，绕过提案，但结果照常反馈）。 */
  async runNow(actorId: string, ruleId: string): Promise<{ ok: boolean; summary: string }> {
    const rule = await this.getRule(actorId, ruleId);
    if (!rule) return { ok: false, summary: `规则 ${ruleId} 不存在` };
    const result = await this.executeAction(rule, "confirmed");
    this.recordResult(rule, result.ok, "confirmed");
    return result;
  }

  /** 用户确认提案后执行（token 一次性）。 */
  async confirmRun(actorId: string, ruleId: string, token: string): Promise<{ ok: boolean; summary: string }> {
    const pending = this.pendingRuns.get(token);
    if (!pending || pending.ruleId !== ruleId || pending.actorId !== actorId) {
      return { ok: false, summary: "确认 token 无效或已使用" };
    }
    const nowMs = this.deps.now?.().getTime() ?? Date.now();
    if (nowMs - pending.createdAt > PROPOSAL_TTL_MS) {
      this.pendingRuns.delete(token);
      return { ok: false, summary: "确认已过期（10 分钟），等下次触发会再提案" };
    }
    this.pendingRuns.delete(token);
    const rule = await this.getRule(actorId, ruleId);
    if (!rule) return { ok: false, summary: `规则 ${ruleId} 不存在` };
    const result = await this.executeAction(rule, "confirmed");
    this.recordResult(rule, result.ok, "confirmed");
    return result;
  }

  // ------------------------------------------------------------------ //
  // tick 主循环
  // ------------------------------------------------------------------ //

  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const now = this.deps.now?.() ?? new Date();
      const rules = await this.store.listAll();
      const locCache = new Map<string, HabitLocationSample | null>();
      for (const rule of rules) {
        if (!rule.enabled) continue;
        if (rule.trigger.kind === "tool_pattern") continue; // 观察流驱动（recordToolEvent）
        if (!this.cooldownPassed(rule, now)) continue;
        if (rule.trigger.kind === "location_enter") {
          let sample = locCache.get(rule.actorId);
          if (sample === undefined) {
            const samples = (await this.deps.locationLister?.(rule.actorId, now.getTime() - 10 * 60_000)) ?? [];
            sample = samples.length > 0 ? samples[samples.length - 1] : null;
            locCache.set(rule.actorId, sample);
          }
          if (!sample) continue;
          if (!this.locationHit(rule, sample)) continue;
          await this.fireOrPropose(rule, now);
          continue;
        }
        if (!this.matchTrigger(rule, now)) continue;
        await this.fireOrPropose(rule, now);
      }
    } catch (err) {
      console.warn("[HabitLoop] tick failed:", err);
    } finally {
      this.ticking = false;
    }
  }

  /**
   * 触发器命中判定（时间窗匹配，非分钟精确相等）：tick 因繁忙跳过一两个
   * 周期也不漏触发；同日去重由「lastRun 本地日期」保证，冷却时间兜底。
   */
  private matchTrigger(rule: HabitRule, now: Date): boolean {
    const t = rule.trigger;
    const cur = now.getHours() * 60 + now.getMinutes();
    const todayKey = localDateKey(now);
    const lastRunTs = rule.stats.lastRunAt ? Date.parse(rule.stats.lastRunAt) : NaN;
    const lastDayKey = Number.isFinite(lastRunTs) ? localDateKey(new Date(lastRunTs)) : null;
    switch (t.kind) {
      case "daily": {
        const target = parseHHMM(t.time);
        if (target == null || cur < target || cur > target + TRIGGER_WINDOW_MIN) return false;
        return lastDayKey !== todayKey;
      }
      case "weekly": {
        if (!t.weekdays.includes(now.getDay())) return false;
        const target = parseHHMM(t.time);
        if (target == null || cur < target || cur > target + TRIGGER_WINDOW_MIN) return false;
        return lastDayKey !== todayKey;
      }
      case "once": {
        if (rule.stats.runCount > 0) return false;
        const at = Date.parse(t.atIso);
        return Number.isFinite(at) && now.getTime() >= at;
      }
      default:
        // location_enter 由 tick 位置样本驱动；tool_pattern 由观察流驱动
        return false;
    }
  }

  /** 位置样本是否命中规则的地点。 */
  private locationHit(
    rule: HabitRule,
    sample: { latitude: number; longitude: number; label?: string },
  ): boolean {
    const t = rule.trigger;
    if (t.kind !== "location_enter") return false;
    const labelHit = t.latitude == null && !!sample.label?.trim() && !!t.placeLabel && sample.label.includes(t.placeLabel);
    const coordHit =
      t.latitude != null &&
      t.longitude != null &&
      haversineMeters(sample.latitude, sample.longitude, t.latitude, t.longitude) <= (t.radiusMeters ?? 150);
    return labelHit || coordHit;
  }

  /**
   * 位置命中检查（外部位置上报流可调用）：命中 → 触发一次。
   */
  async checkLocationHit(
    actorId: string,
    sample: { latitude: number; longitude: number; label?: string; at?: number },
  ): Promise<void> {
    const rules = await this.store.listByActor(actorId);
    const now = this.deps.now?.() ?? new Date(sample.at ?? Date.now());
    for (const rule of rules) {
      if (!rule.enabled || rule.trigger.kind !== "location_enter") continue;
      if (!this.locationHit(rule, sample)) continue;
      if (!this.cooldownPassed(rule, now)) continue;
      await this.fireOrPropose(rule, now);
    }
  }

  /** 工具模式命中检查：recordToolEvent 后调用。 */
  private async checkToolPatternHit(actorId: string, tool: string, at: number): Promise<void> {
    const rules = await this.store.listByActor(actorId);
    for (const rule of rules) {
      if (!rule.enabled || rule.trigger.kind !== "tool_pattern") continue;
      const t = rule.trigger;
      if (rule.source === "mined" && !rule.action) continue;
      if (t.toolName !== tool) continue;
      const d = new Date(at);
      if (t.hour != null && d.getHours() !== t.hour) continue;
      if (t.weekday != null && d.getDay() !== t.weekday) continue;
      const windowDays = t.windowDays ?? 21;
      const minCount = t.minCount ?? 3;
      const windowStart = at - windowDays * 86_400_000;
      const lastRun = rule.stats.lastRunAt ? Date.parse(rule.stats.lastRunAt) : 0;
      const countFrom = Math.max(windowStart, Number.isFinite(lastRun) ? lastRun : windowStart);
      const count = this.toolObservations.filter((o) => o.actorId === actorId && o.tool === tool && o.at > countFrom && o.at <= at).length;
      if (count < minCount) continue;
      const now = this.deps.now?.() ?? new Date(at);
      if (!this.cooldownPassed(rule, now)) continue;
      await this.fireOrPropose(rule, now);
    }
  }

  private cooldownPassed(rule: HabitRule, now: Date): boolean {
    const last = rule.stats.lastRunAt ? Date.parse(rule.stats.lastRunAt) : 0;
    if (!Number.isFinite(last) || last <= 0) return true;
    return now.getTime() - last >= rule.cooldownMinutes * 60_000;
  }

  private inQuietHours(rule: HabitRule, now: Date): boolean {
    const q = rule.quietHours;
    if (!q) return false;
    const cur = now.getHours() * 60 + now.getMinutes();
    const [sh, sm] = q.start.split(":").map(Number);
    const [eh, em] = q.end.split(":").map(Number);
    if (![sh, sm, eh, em].every(Number.isFinite)) return false;
    const start = sh * 60 + sm;
    const end = eh * 60 + em;
    return start <= end ? cur >= start && cur <= end : cur >= start || cur <= end;
  }

  private async fireOrPropose(rule: HabitRule, now: Date): Promise<void> {
    // 产品口径：习惯是 Agent 自己的动作，授权为 auto 时直接执行、不再走
    // 用户确认（confidence 仅服务于失败降权，不做执行门槛）。
    // 兜底不变：花钱动作仍会被下游消费安全门（booking 两阶段 / spend 上限）拦住。
    if (rule.authorization === "auto") {
      if (this.inQuietHours(rule, now)) {
        // 安静时段不打扰也不提案：静默跳过，等冷却/下一个触发窗口再试。
        this.recordResult(rule, true, "proposed", { skipStats: true });
        return;
      }
      const result = await this.executeAction(rule, "auto");
      this.recordResult(rule, result.ok, "auto");
      return;
    }
    // confirm_each（失败降权或显式指定）：等用户确认（confirmRun）
    const token = newHabitRuleId(now) + `_${Math.random().toString(36).slice(2, 8)}`;
    this.pendingRuns.set(token, { token, ruleId: rule.id, actorId: rule.actorId, createdAt: now.getTime() });
    const summary = describeAction(rule.action);
    this.deps.outbound.send({
      actorId: rule.actorId,
      title: `习惯「${rule.name}」到点了`,
      text: `按你的习惯，我准备${summary}。回复「确认 ${rule.id} ${token}」我就执行；不想再被提醒可以让我关闭习惯 ${rule.id}。`,
      reason: "anticipation:planning",
      meta: { urgency: 5, tags: ["habit", "proposal"], habitRuleId: rule.id, token },
    });
    this.recordResult(rule, true, "proposed", { skipStats: true });
  }

  // ------------------------------------------------------------------ //
  // 动作执行与反馈
  // ------------------------------------------------------------------ //

  private async executeAction(rule: HabitRule, mode: "auto" | "confirmed"): Promise<{ ok: boolean; summary: string }> {
    const action = rule.action;
    try {
      if (action.kind === "tool") {
        if (!this.deps.toolExecutor) {
          return { ok: false, summary: "工具执行器未装配（HabitLoop toolExecutor）" };
        }
        const res = await this.deps.toolExecutor(action.tool, action.input ?? {}, rule.actorId, mode);
        return {
          ok: res.ok,
          summary: res.ok ? `已自动执行 ${action.tool}` : `${action.tool} 执行失败：${stringifyError(res.result)}`,
        };
      }
      if (action.kind === "agent_task") {
        if (!this.deps.agentTaskRunner) {
          return { ok: false, summary: "后台任务通道未装配（HabitLoop agentTaskRunner）" };
        }
        const res = await this.deps.agentTaskRunner(rule.actorId, action.instruction);
        return { ok: res.ok, summary: res.ok ? `后台任务已完成：${res.summary}` : `后台任务失败：${res.summary}` };
      }
      // message：直接外发（低风险）
      this.deps.outbound.send({
        actorId: rule.actorId,
        title: `习惯「${rule.name}」`,
        text: action.text,
        reason: "anticipation:planning",
        meta: { urgency: 4, tags: ["habit", "auto_message"], habitRuleId: rule.id },
      });
      return { ok: true, summary: "消息已发送" };
    } catch (err) {
      return { ok: false, summary: `执行异常：${err instanceof Error ? err.message : String(err)}` };
    }
  }

  private recordResult(rule: HabitRule, ok: boolean, mode: "auto" | "proposed" | "confirmed", opts?: { skipStats?: boolean }): void {
    const stats = { ...rule.stats };
    if (!opts?.skipStats) {
      stats.runCount += 1;
      if (mode === "confirmed") stats.confirmedCount += 1;
      if (ok) {
        stats.successCount += 1;
        stats.consecutiveFails = 0;
      } else {
        stats.failCount += 1;
        stats.consecutiveFails += 1;
      }
    }
    stats.lastRunAt = (this.deps.now?.() ?? new Date()).toISOString();
    stats.lastStatus = mode === "proposed" ? "proposed" : ok ? "success" : "failed";

    let confidence = rule.confidence;
    let authorization = rule.authorization;
    let autoSuggested = rule.autoSuggested === true;

    if (!opts?.skipStats) {
      confidence = ok ? Math.min(0.95, confidence + 0.05) : Math.max(0.2, confidence - 0.1);
      // auto 连续失败 2 次 → 降权回 confirm_each 并告知
      if (authorization === "auto" && stats.consecutiveFails >= 2) {
        authorization = "confirm_each";
        stats.consecutiveFails = 0;
        this.deps.outbound.send({
          actorId: rule.actorId,
          title: `习惯「${rule.name}」已暂停自动执行`,
          text: `自动执行连续失败，已退回「每次先确认」模式。你可以在问题解决后重新开启自动（habit.update-rule ${rule.id} authorization=auto）。`,
          reason: "anticipation:warning",
          meta: { urgency: 6, tags: ["habit", "demotion"], habitRuleId: rule.id },
        });
      }
      // confirm_each 连续确认成功 3 次 → 一次性建议升 auto
      if (authorization === "confirm_each" && stats.confirmedCount >= 3 && !autoSuggested) {
        autoSuggested = true;
        this.deps.outbound.send({
          actorId: rule.actorId,
          title: `要把习惯「${rule.name}」设为自动执行吗？`,
          text: `这个习惯你已经连续确认成功 ${stats.confirmedCount} 次。回复「习惯自动 ${rule.id}」我就把它升级为自动执行（仍受置信度与安静时段约束）。`,
          reason: "anticipation:opportunity",
          meta: { urgency: 3, tags: ["habit", "promotion"], habitRuleId: rule.id },
        });
      }
    }

    void this.store.upsert({
      ...rule,
      confidence,
      authorization,
      stats,
      updatedAt: (this.deps.now?.() ?? new Date()).toISOString(),
      ...(autoSuggested ? { autoSuggested } : {}),
    });
  }

  // ------------------------------------------------------------------ //
  // 观察持久化
  // ------------------------------------------------------------------ //

  private schedulePersistObservations(): void {
    if (this.obsPersistTimer || !this.deps.observationsFile) return;
    this.obsPersistTimer = setTimeout(() => {
      this.obsPersistTimer = null;
      void this.persistObservations();
    }, 2000);
    this.obsPersistTimer.unref?.();
  }

  private async loadObservations(): Promise<void> {
    const file = this.deps.observationsFile;
    if (!file) return;
    try {
      const { readFile } = await import("node:fs/promises");
      const raw = await readFile(file, "utf8");
      const parsed = JSON.parse(raw) as { observations?: HabitToolObservation[] };
      if (Array.isArray(parsed.observations)) {
        this.toolObservations.push(...parsed.observations.slice(-MAX_TOOL_OBSERVATIONS));
      }
    } catch {
      // 首次启动 / 文件缺失：静默
    }
  }

  private async persistObservations(): Promise<void> {
    const file = this.deps.observationsFile;
    if (!file) return;
    try {
      const { mkdir, writeFile } = await import("node:fs/promises");
      const { dirname } = await import("node:path");
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, JSON.stringify({ observations: this.toolObservations.slice(-MAX_TOOL_OBSERVATIONS) }), "utf8");
    } catch (err) {
      console.warn("[HabitLoop] 观察写盘失败", err);
    }
  }
}

function describeAction(action: HabitAction): string {
  switch (action.kind) {
    case "tool":
      return `调用工具 ${action.tool}${action.input && Object.keys(action.input).length > 0 ? `（${JSON.stringify(action.input).slice(0, 120)}）` : ""}`;
    case "agent_task":
      return `执行任务：${action.instruction.slice(0, 160)}`;
    case "message":
      return `发送消息：${action.text.slice(0, 160)}`;
  }
}

function stringifyError(result: Record<string, unknown> | undefined): string {
  const err = result?.error ?? result?.message;
  return typeof err === "string" ? err.slice(0, 160) : "未知错误";
}

function haversineMeters(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6_371_000;
  const toRad = (v: number) => (v * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

/** "HH:mm" → 当日分钟数；非法格式返回 null。 */
function parseHHMM(time: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(time.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

/** 本地时区日期键（YYYY-MM-DD）：时间触发的同日去重。 */
function localDateKey(d: Date): string {
  const local = new Date(d.getTime() - d.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 10);
}
