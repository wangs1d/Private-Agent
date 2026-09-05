// 统一主动性管道（ProactivePipeline）—— docs/proactivity-architecture.md 的 L1→L5 落地。
// 唯一入口 submitProposal：去重 → 仲裁（纯规则零 LLM）→ 投递（在线 WS / 离线 MessageHub）
// → 结果反馈（outcome 回灌自适应冷却）。周期 flush 推进延迟提案并落盘。
// 与 ProactivityHub 分工：本管道承接确定性提案源（日程/提醒/预警等 must 层）；
// hub 快路径（对话/问候/兴趣等 social 层）后续迁移为提案源，投递层已统一到 DeliveryService。
import { arbitrate, DELIVERY_RETRY_MS, IN_CONVERSATION_WINDOW_MS, type ArbiterContext } from "./arbiter.js";
import type { ProactiveDeliveryService } from "./delivery-service.js";
import { readJson, writeJson } from "./persist-file.js";
import type { ArbitrationDecision, ProactiveOutcome, ProactiveProposal } from "./pipeline-types.js";
import { OutcomeStore } from "./outcome-store.js";
import type { PresenceService } from "./presence-service.js";
import { ProposalStore } from "./proposal-store.js";
import { SilenceLog } from "./silence-log.js";
import { CONFIRMATION_TTL_MS, type PendingConfirmation, PendingConfirmationStore } from "./pending-confirmation-store.js";

export type ProactivePipelineDeps = {
  /** 数据目录（默认 data/proactivity）：proposals.json / frequency.json / known-actors.json */
  dataPath: string;
  governor: import("./frequency-governor.js").FrequencyGovernor;
  suppression: {
    isSuppressed(actorId: string, kind: string, text?: string): { suppressed: boolean; reason: string };
  };
  presence: PresenceService;
  delivery: ProactiveDeliveryService;
  outcomes: OutcomeStore;
  /** 无 directText 提案的 speak 兜底（现有 ProactionCortex 闭环——全管道唯一 LLM 调用点） */
  speak?: (p: ProactiveProposal) => void;
  flushIntervalMs?: number;
  /** known actor 持久化（重启恢复主动性资格，hub 状态的存取薄包装） */
  exportActors?: () => Array<{ actorId: string; lastInteractionAt: number }>;
  restoreActors?: (entries: Array<{ actorId: string; lastInteractionAt: number }>) => void;
  /** 可注入时钟（测试确定性；默认 Date.now） */
  nowFn?: () => number;
  /**
   * 移动端推送通道（离线必达升级）：两端都不在线时，必达层/critical 提案
   * 改走手机系统推送（App 被杀也能收到）。未注入 = 通道禁用，离线一律挂起待重连。
   */
  mobilePush?: import("./mobile-push-service.js").MobilePushChannel;
  /**
   * 沉默日志（方案 B）：verdict=silenced 的效用评估留痕，支持
   * 「你上周为什么没提醒我 XX」反问检索。未注入时管道内建一份
   * （与 hub 共享同一实例由装配层注入，这里只兜底）。
   */
  silenceLog?: SilenceLog;
  /**
   * 挂起确认存储（与 hub 共享同一实例）：ask_first 且带 confirmAction 的提案
   * 投递确认文案后在此登记，批准经 hub resolver 回流到 onProposalApproved。
   */
  confirmations?: PendingConfirmationStore;
  /** 提案级确认的批准动作（装配层定义：如承诺代催的落地行为 + 助手动态留痕） */
  onProposalApproved?: (p: ProactiveProposal) => void;
};

/** 正反馈 outcome 集合（自适应冷却的方向判定） */
const POSITIVE = new Set<ProactiveOutcome>(["accepted", "replied", "snoozed"]);

/** 离线推送重试退避（推送失败后 5min 再试，防 provider 连打；成功即出队不会重复推） */
const OFFLINE_PUSH_RETRY_MS = 5 * 60_000;

export class ProactivePipeline {
  private readonly store: ProposalStore;
  private readonly silenceLog: SilenceLog;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly flushIntervalMs: number;
  private pushSeq = 0;

  constructor(private readonly deps: ProactivePipelineDeps) {
    this.store = new ProposalStore(`${deps.dataPath}/proposals.json`);
    this.silenceLog = deps.silenceLog ?? new SilenceLog(`${deps.dataPath}/silence-log.json`);
    this.flushIntervalMs = deps.flushIntervalMs ?? 30_000;
    // 重启恢复：频控状态（预算/冷却）+ 已知 actor —— 否则重启后 agent 永不主动
    const govSnapshot = readJson<import("./frequency-governor.js").GovernorSnapshot | null>(
      `${deps.dataPath}/frequency.json`,
      null,
    );
    if (govSnapshot) this.deps.governor.restore(govSnapshot);
    const actors = readJson<Array<{ actorId: string; lastInteractionAt: number }>>(
      `${deps.dataPath}/known-actors.json`,
      [],
    );
    if (actors.length) this.deps.restoreActors?.(actors);
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      try {
        this.flushDue();
        this.persist();
      } catch (err) {
        console.log(`[ProactivePipeline] flush 失败（忽略）: ${err}`);
      }
    }, this.flushIntervalMs);
    if (typeof this.timer.unref === "function") this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.flushDue();
    this.persist();
  }

  /** 统一入口：任何触发源只调这一个方法（fire-and-forget，绝不阻塞调用方） */
  submitProposal(p: ProactiveProposal): ArbitrationDecision {
    const now = this.deps.nowFn?.() ?? Date.now();
    if (this.store.wasDeliveredRecently(p.dedupKey, now) || !this.store.enqueue(p)) {
      const merged: ArbitrationDecision = {
        proposal: p,
        verdict: "merged",
        reasonChain: [`dedup:${p.dedupKey}`],
      };
      this.store.logDecision(merged);
      return merged;
    }
    return this.decide(p);
  }

  /** 推进到期延迟提案（deferred/offline 挂起的在在场变化后重仲裁；at 可注入推进时钟） */
  flushDue(now = Date.now()): void {
    for (const p of this.store.listPending()) {
      if ((p.deliverAfter ?? 0) <= now) this.decide(p, now);
    }
  }

  /** 客户端回传触达结果 → 落库 + 自适应冷却（负反馈即时惩罚；接受率>0.6 回升） */
  recordOutcome(deliveryId: string, outcome: ProactiveOutcome): boolean {
    const prev = this.deps.outcomes.findByDeliveryId(deliveryId);
    if (!prev) return false;
    this.deps.outcomes.record({ ...prev, outcome, at: Date.now() });
    if (!POSITIVE.has(outcome) && outcome !== "delivered") {
      this.deps.governor.noteOutcome(prev.kind, false);
    }
    const rate = this.deps.outcomes.acceptanceRate(prev.kind);
    if (rate !== null && rate > 0.6) this.deps.governor.noteOutcome(prev.kind, true);
    return true;
  }

  /** 诊断快照（GET /api/proactivity/diagnostics）："为什么发/没发"全程可解释 */
  diagnostics() {
    return {
      pending: this.store.listPending(),
      recentDecisions: this.store.recentDecisions(30),
      recentOutcomes: this.deps.outcomes.recent(20),
      budget: this.deps.governor.usageSnapshot(),
      presence: {
        onlineCount: this.deps.presence.listOnline().length,
        online: this.deps.presence.listOnline(),
      },
      offlinePush: { enabled: !!this.deps.mobilePush },
      // 沉默决策留痕（方案 B）：最近效用评估后主动选择不动作的提案
      recentSilences: this.silenceLog.recent(10),
    };
  }

  /** 沉默决策检索（支持「你上周为什么没提醒我 XX」反问） */
  searchSilences(opts: Parameters<SilenceLog["search"]>[0]) {
    return this.silenceLog.search(opts);
  }

  /**
   * 离线推送升级：两端都不在线（或 WS 投递竞态失败）时，必达层/critical 提案改走手机
   * 系统推送——App 被杀也能收到系统通知。fire-and-forget；先退避 5min 防失败连打，
   * 推送成功即出队并记 mobile_push outcome（不会在重连后重复投递）。
   */
  private attemptOfflinePush(p: ProactiveProposal): void {
    const push = this.deps.mobilePush;
    if (!push || (p.tier !== "must" && p.importance !== "critical") || !push.hasChannel(p.actorId)) return;
    const clock = () => this.deps.nowFn?.() ?? Date.now();
    this.store.reschedule(p.dedupKey, clock() + OFFLINE_PUSH_RETRY_MS);
    const deliveryId = `dp_${clock().toString(36)}_${(this.pushSeq++).toString(36)}`;
    void push
      .push({ actorId: p.actorId, title: p.title, body: p.directText ?? p.summary, importance: p.importance, kind: p.kind, deliveryId })
      .then((result) => {
        if (!result.ok) {
          console.log(`[ProactivePipeline] 离线推送失败（保留待发区重试）kind=${p.kind} provider=${result.provider} reason=${result.reason}`);
          return;
        }
        if (!this.store.take(p.dedupKey)) return; // 已被 WS 重连直投抢先
        this.store.markDelivered(p.dedupKey, clock());
        this.deps.outcomes.record({
          deliveryId,
          actorId: p.actorId,
          kind: p.kind,
          channel: "mobile_push",
          outcome: "delivered",
          at: Date.now(),
        });
        console.log(`[ProactivePipeline] 离线推送已送达 kind=${p.kind} provider=${result.provider} actor=${p.actorId}`);
      })
      .catch((err) => {
        console.log(`[ProactivePipeline] 离线推送异常（忽略）kind=${p.kind}: ${err}`);
      });
  }

  /**
   * 提案级 ask_first 登记：ask_first 分支 + 提案声明 confirmAction（如承诺代催
   * 「发送前会先经你确认」）时，确认文案投递后在共享存储登记待确认——
   * 用户回复「可以」经 hub resolver 回流 resolveProposalConfirmation。
   * 普通通知类 ask_first 提案不登记（投递即完成，无后续动作可批准）。
   */
  private registerProposalConfirmationIfNeeded(p: ProactiveProposal, decision: ArbitrationDecision): void {
    if (!this.deps.confirmations) return;
    if (decision.utility?.branch !== "ask_first" || !p.confirmAction) return;
    this.deps.confirmations.register({
      actorId: p.actorId,
      kind: p.kind,
      steps: [],
      rationale: p.title,
      createdAt: this.deps.nowFn?.() ?? Date.now(),
      expiresAt: (this.deps.nowFn?.() ?? Date.now()) + CONFIRMATION_TTL_MS,
      origin: "pipeline",
      proposal: p,
    });
    console.log(`[ProactivePipeline] 提案级待确认已登记 kind=${p.kind} label=${p.confirmAction.label}`);
  }

  /**
   * 提案级确认推进（hub resolver 委托入口；条目已由 hub 从共享存储取出）：
   * 批准 → onProposalApproved 落地动作 + speak 回执；拒绝静默关闭。
   */
  resolveProposalConfirmation(entry: PendingConfirmation, approved: boolean): { executed: boolean } {
    if (!approved) return { executed: false };
    const proposal =
      entry.proposal ??
      ({
        proposalId: `confirm_${entry.confirmId}`,
        actorId: entry.actorId,
        kind: entry.kind,
        tier: "must",
        importance: "medium",
        dedupKey: `confirm:${entry.confirmId}`,
        title: entry.rationale,
        summary: entry.rationale,
        evidence: [],
        createdAt: entry.createdAt,
        source: "commitment-board",
      } as ProactiveProposal);
    try {
      this.deps.onProposalApproved?.(proposal);
    } catch (err) {
      console.log(`[ProactivePipeline] 提案批准回调失败（忽略）kind=${proposal.kind}: ${err}`);
    }
    // 回执：经 speak 兜底车道告知用户「已按确认推进」
    this.deps.speak?.({
      ...proposal,
      title: `已确认：${entry.rationale.slice(0, 40)}`,
      summary: "好的，已按你的确认推进。",
      directText: undefined,
      dedupKey: `confirm_ack:${entry.confirmId}`,
    });
    return { executed: true };
  }

  /** 仲裁并执行（提案已在待发区内；delivered 出队投递，deferred 更新时刻，其余出队） */
  private decide(p: ProactiveProposal, at?: number): ArbitrationDecision {
    const decision = arbitrate(p, this.buildContext(p, at));
    this.store.logDecision(decision);
    switch (decision.verdict) {
      case "delivered": {
        if (this.dispatch(p)) {
          this.store.take(p.dedupKey);
          this.store.markDelivered(p.dedupKey, this.deps.nowFn?.() ?? Date.now());
          this.registerProposalConfirmationIfNeeded(p, decision);
        } else {
          // 竞态：仲裁时设备在线、发送时已全部掉线 → 保留待发区稍后重试（重连即达）
          this.store.reschedule(p.dedupKey, (this.deps.nowFn?.() ?? Date.now()) + DELIVERY_RETRY_MS);
          this.attemptOfflinePush(p);
        }
        break;
      }
      case "deferred":
        if (decision.deliverAfter !== undefined) this.store.reschedule(p.dedupKey, decision.deliverAfter);
        if (decision.reasonChain.includes("offline_wait_reconnect")) this.attemptOfflinePush(p);
        break;
      case "silenced":
        // 效用评估后主动选择不动作（区别于 suppressed 的负反馈抑制）：出队 + 沉默日志留痕
        this.store.take(p.dedupKey);
        this.silenceLog.record({
          at: this.deps.nowFn?.() ?? Date.now(),
          actorId: p.actorId,
          kind: p.kind,
          title: p.title,
          dedupKey: p.dedupKey,
          source: p.source,
          scope: "proposal",
          netUtility: decision.utility?.netUtility ?? 0,
          riskScore: decision.utility?.riskScore ?? 0,
          valueScore: decision.utility?.valueScore ?? 0,
          reason: decision.utility?.reason ?? decision.reasonChain.join(";"),
        });
        break;
      default:
        this.store.take(p.dedupKey); // expired / suppressed / throttled：出队（原因已留痕）
        break;
    }
    return decision;
  }

  /**
   * 执行投递：directText 直推全部在线设备（电脑端 + 手机端 fan-out）；无 directText 走
   * speak 闭环（唯一 LLM 点，一次调用）。投递失败（两端都不在线）返回 false，由 decide
   * 改判重试——预算计数与 outcome 都只在真正送达后记录。
   */
  private dispatch(p: ProactiveProposal): boolean {
    if (p.directText) {
      const result = this.deps.delivery.deliver(p, p.directText, p.title);
      if (!result.ok) return false;
      this.deps.outcomes.record({
        deliveryId: result.deliveryId,
        actorId: p.actorId,
        kind: p.kind,
        channel: "in_app",
        outcome: "delivered",
        at: Date.now(),
      });
      if (p.tier === "social") this.deps.governor.record(p.actorId, p.kind);
      return true;
    }
    this.deps.speak?.(p);
    if (p.tier === "social") this.deps.governor.record(p.actorId, p.kind);
    return true;
  }

  private buildContext(p: ProactiveProposal, at?: number): ArbiterContext {
    const now = at ?? this.deps.nowFn?.() ?? Date.now();
    const presence = this.deps.presence.getPresence(p.actorId, now);
    const last = this.deps.presence.lastActivityAt(p.actorId);
    return {
      now,
      presence,
      inConversation: presence === "active" && last !== null && now - last <= IN_CONVERSATION_WINDOW_MS,
      isSuppressed: (actorId, kind, text) => this.deps.suppression.isSuppressed(actorId, kind, text),
      socialCanTrigger: (actorId, kind, importance) => this.deps.governor.canTrigger(actorId, kind, importance),
    };
  }

  private persist(): void {
    this.store.flush();
    this.deps.outcomes.flush();
    writeJson(`${this.deps.dataPath}/frequency.json`, this.deps.governor.snapshot());
    const actors = this.deps.exportActors?.();
    if (actors?.length) writeJson(`${this.deps.dataPath}/known-actors.json`, actors);
  }
}

export { IN_CONVERSATION_WINDOW_MS };
