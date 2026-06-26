/**
 * Jarvis Delivery Gateway — 统一发送 + 反馈埋点
 *
 * 替代直接调用 ProactiveOutboundMessageService.send：
 *  - 集中发送逻辑
 *  - 记录 delivery 结果
 *  - 调度反馈埋点（T+30s / T+5min / T+24h）
 *  - 支持 shadow 模式（不真发）
 */

import type { ProactiveOutboundMessageService } from "../proactive-outbound-message-service.js";
import type { JarvisMemoryBank } from "./memory-bank.js";
import type {
  JarvisChannel,
  JarvisDecisionResult,
  JarvisDeliveryResult,
  JarvisFeedback,
  JarvisHarnessConfig,
  JarvisTrigger,
} from "./types.js";

export type DeliveryGatewayDeps = {
  outbound: ProactiveOutboundMessageService;
  memory: JarvisMemoryBank;
  config: JarvisHarnessConfig;
  /** 获取 WS 注册的 userId（用于投递后回查） */
  isUserOnline: ((actorId: string) => boolean) | null;
  logger?: { info: (msg: string) => void; warn: (msg: string) => void };
};

type PendingFeedback = {
  feedback: JarvisFeedback;
  scheduleAt: number;
};

export class JarvisDeliveryGateway {
  private readonly pending: PendingFeedback[] = [];
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly deps: DeliveryGatewayDeps) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.runFeedbackSweep(), 30_000);
    this.deps.logger?.info("[JarvisDelivery] started");
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * 主入口：发送一条决策后的消息
   */
  async deliver(
    trigger: JarvisTrigger,
    decision: JarvisDecisionResult,
  ): Promise<JarvisDeliveryResult> {
    const decisionId = `${decision.triggerId}:${Date.now()}`;
    if (decision.decision !== "speak" || !decision.content) {
      const result: JarvisDeliveryResult = {
        triggerId: trigger.id,
        decisionId,
        actorId: trigger.actorId,
        channel: (decision.channel ?? "websocket") as JarvisChannel,
        sent: false,
        reason: decision.rejectionReason ?? "decision_not_speak",
        deliveredAt: new Date().toISOString(),
      };
      await this.deps.memory.recordDelivery(result);
      return result;
    }

    const channel = decision.channel ?? "websocket";

    // Shadow 模式不真发
    if (this.deps.config.shadowMode) {
      this.deps.logger?.info(
        `[JarvisDelivery][shadow] would send: [${channel}] ${trigger.title} → ${decision.content}`,
      );
      const result: JarvisDeliveryResult = {
        triggerId: trigger.id,
        decisionId,
        actorId: trigger.actorId,
        channel,
        sent: false,
        reason: "shadow_mode",
        deliveredAt: new Date().toISOString(),
      };
      await this.deps.memory.recordDelivery(result);
      return result;
    }

    try {
      const sent = await this.deps.outbound.send({
        actorId: trigger.actorId,
        title: trigger.title,
        text: decision.content,
        reason: `jarvis:${trigger.source}:${trigger.category}`,
        channel,
        meta: {
          triggerId: trigger.id,
          decisionId,
          source: trigger.source,
          category: trigger.category,
          urgency: trigger.urgency,
          confidence: trigger.confidence,
          value: decision.value.composite,
          disturb: decision.disturb.composite,
          rationale: decision.rationale,
        },
      });

      const result: JarvisDeliveryResult = {
        triggerId: trigger.id,
        decisionId,
        actorId: trigger.actorId,
        channel,
        sent,
        reason: sent ? "delivered" : "outbound_send_returned_false",
        deliveredAt: new Date().toISOString(),
      };
      await this.deps.memory.recordDelivery(result);

      if (sent) {
        this.scheduleFeedback(
          trigger,
          decision,
          decisionId,
          "seen",
          30_000,
        );
        this.scheduleFeedback(
          trigger,
          decision,
          decisionId,
          "responded",
          5 * 60_000,
        );
        this.scheduleFeedback(
          trigger,
          decision,
          decisionId,
          "post_mood",
          24 * 60 * 60_000,
        );
      }
      return result;
    } catch (err) {
      this.deps.logger?.warn(
        `[JarvisDelivery] send failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      const result: JarvisDeliveryResult = {
        triggerId: trigger.id,
        decisionId,
        actorId: trigger.actorId,
        channel,
        sent: false,
        reason: `exception:${err instanceof Error ? err.message : String(err)}`,
        deliveredAt: new Date().toISOString(),
      };
      await this.deps.memory.recordDelivery(result);
      return result;
    }
  }

  /**
   * 外部反馈录入（用户在客户端给出 feedback）
   */
  async recordFeedback(feedback: JarvisFeedback): Promise<void> {
    await this.deps.memory.recordFeedback(feedback);
  }

  // ────────────────────── 内部 ──────────────────────

  private scheduleFeedback(
    trigger: JarvisTrigger,
    decision: JarvisDecisionResult,
    decisionId: string,
    kind: JarvisFeedback["kind"],
    delayMs: number,
  ): void {
    this.pending.push({
      feedback: {
        kind,
        triggerId: trigger.id,
        decisionId,
        actorId: trigger.actorId,
        occurredAt: new Date(Date.now() + delayMs).toISOString(),
      },
      scheduleAt: Date.now() + delayMs,
    });
    if (this.pending.length > 500) this.pending.splice(0, this.pending.length - 500);
  }

  private async runFeedbackSweep(): Promise<void> {
    const now = Date.now();
    const due: PendingFeedback[] = [];
    const remain: PendingFeedback[] = [];
    for (const p of this.pending) {
      if (p.scheduleAt <= now) due.push(p);
      else remain.push(p);
    }
    this.pending.length = 0;
    this.pending.push(...remain);
    for (const p of due) {
      try {
        // 简化版反馈：基于"seen"时检查用户是否在线，responded 时无法知道具体响应所以只记录 metric=skipped
        if (p.feedback.kind === "seen") {
          const online = this.deps.isUserOnline?.(p.feedback.actorId) ?? true;
          if (!online) {
            // 用户离线 = 大概率没看到
            await this.recordFeedback({
              ...p.feedback,
              kind: "ignored",
              occurredAt: new Date().toISOString(),
            });
          } else {
            await this.recordFeedback(p.feedback);
          }
        } else if (p.feedback.kind === "responded") {
          // 真实环境由客户端 WS 上行事件补全（暂记录 placeholder）
          await this.recordFeedback(p.feedback);
        } else {
          await this.recordFeedback(p.feedback);
        }
      } catch (err) {
        this.deps.logger?.warn(
          `[JarvisDelivery] feedback sweep failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }
}
