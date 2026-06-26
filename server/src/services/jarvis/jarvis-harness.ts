/**
 * Jarvis Harness — 总装
 *
 * 把 5 类 trigger 源 + 单点决策 + 统一发送 + 反馈 + 反思 串成一个 Harness。
 *
 * 借鉴 OpenHands "Worker / Trigger / Function" 三原语思想：
 *  - Trigger：5 类触发源（event / life_signal / cron / mood / self_scan）
 *  - Worker：JarvisDecisionEngine（单点决策）
 *  - Function：DeliveryGateway（统一发送）+ MemoryBank（记录）+ Reflector（学习）
 *
 * 启动入口：
 *  1. 构造时传入所有依赖
 *  2. start() 开启：
 *     - 订阅 StateChangeEvent
 *     - 订阅 LifeSignalHubService
 *     - 订阅 MoodInferenceService 的情绪结果（通过 LifeSignal kind=mood）
 *     - 启动自发性扫描定时器
 *     - 启动 reflector 定时器
 *     - 启动 delivery 反馈埋点定时器
 *  3. stop() 全部关闭
 *
 * 与现有服务的关系：
 *  - 不删除 ProactiveAgentCenter / ProactiveLifeRuntimeService
 *  - 默认新 Harness 接管决策（行为更精准）
 *  - 通过环境变量 JARVIS_HARNESS_ENABLED=0 关闭
 *  - 通过 JARVIS_HARNESS_SHADOW=1 走 shadow 模式（只记录决策不真发）
 */

import { join } from "node:path";

import type { ExternalChatProvider } from "../../external-model/types.js";
import type { PromptContextBuilder } from "../../agent/prompt-context-builder.js";
import type { LifeSignalHubService } from "../life-signal-hub-service.js";
import type { ProactiveOutboundMessageService } from "../proactive-outbound-message-service.js";
import type { NotesService } from "../notes-service.js";
import type { ScheduleTaskService } from "../schedule-task-service.js";
import type { MoodInferenceService } from "../mood-inference-service.js";
import type { UserPersonalizationService } from "../user-personalization/user-personalization-service.js";
import { JarvisMemoryBank } from "./memory-bank.js";
import { JarvisReflector } from "./reflector.js";
import { JarvisSelfScanTrigger } from "./self-scan-trigger.js";
import { JarvisDecisionEngine } from "./decision-engine.js";
import { JarvisDeliveryGateway } from "./delivery-gateway.js";
import {
  eventTriggerAdapter,
  lifeSignalTriggerAdapter,
  moodTriggerAdapter,
} from "./trigger-adapters.js";
import {
  DEFAULT_JARVIS_HARNESS_CONFIG,
  type JarvisDecisionResult,
  type JarvisFeedback,
  type JarvisHarnessConfig,
  type JarvisSelfScanCandidate,
  type JarvisTrigger,
} from "./types.js";

export type JarvisHarnessDeps = {
  externalChat: ExternalChatProvider | null;
  promptContextBuilder: PromptContextBuilder | null;
  lifeSignalHub: LifeSignalHubService;
  outbound: ProactiveOutboundMessageService;
  notes: NotesService | null;
  schedule: ScheduleTaskService | null;
  moodInference: MoodInferenceService | null;
  personalization: UserPersonalizationService | null;
  isUserOnline: ((actorId: string) => boolean) | null;
  config?: Partial<JarvisHarnessConfig>;
  dataDir?: string;
  logger?: {
    info: (msg: string) => void;
    warn: (msg: string) => void;
    error: (msg: string) => void;
  };
};

export class JarvisHarness {
  readonly config: JarvisHarnessConfig;
  readonly memory: JarvisMemoryBank;
  readonly decision: JarvisDecisionEngine;
  readonly delivery: JarvisDeliveryGateway;
  readonly selfScan: JarvisSelfScanTrigger;
  readonly reflector: JarvisReflector;

  private readonly deps: JarvisHarnessDeps;
  private readonly logger: NonNullable<JarvisHarnessDeps["logger"]>;
  private unsubscribers: Array<() => void> = [];
  private selfScanTimer: NodeJS.Timeout | null = null;
  private started = false;

  // 最近 trigger 缓存（用于决策时 recall）
  private readonly recentTriggers = new Map<string, JarvisTrigger[]>();
  private readonly triggerSeen = new Set<string>();
  // 同 category 冷却
  private readonly categoryLastAt = new Map<string, number>();
  // 全局冷却
  private readonly actorLastAt = new Map<string, number>();

  constructor(deps: JarvisHarnessDeps) {
    this.deps = deps;
    this.logger = deps.logger ?? console;
    this.config = { ...DEFAULT_JARVIS_HARNESS_CONFIG, ...(deps.config ?? {}) };

    const dataDir = deps.dataDir ?? join(process.cwd(), "data");
    this.memory = new JarvisMemoryBank({
      persistFilePath: join(dataDir, "jarvis-memory.jsonl"),
      logger: this.logger,
    });

    this.decision = new JarvisDecisionEngine({
      externalChat: deps.externalChat,
      promptContextBuilder: deps.promptContextBuilder,
      outbound: deps.outbound,
      memory: this.memory,
      personalization: deps.personalization,
      isUserOnline: deps.isUserOnline,
      config: this.config,
      logger: this.logger,
    });

    this.delivery = new JarvisDeliveryGateway({
      outbound: deps.outbound,
      memory: this.memory,
      config: this.config,
      isUserOnline: deps.isUserOnline,
      logger: this.logger,
    });

    this.selfScan = new JarvisSelfScanTrigger({
      notes: deps.notes,
      schedule: deps.schedule,
      lifeSignalHub: deps.lifeSignalHub,
      memory: this.memory,
      resolveActorIds: () => this.resolveKnownActorIds(),
      logger: this.logger,
    });

    this.reflector = new JarvisReflector({
      memory: this.memory,
      logger: this.logger,
    });
  }

  async start(): Promise<void> {
    if (this.started) return;
    if (!this.config.enabled) {
      this.logger.info("[JarvisHarness] disabled via config");
      return;
    }
    this.started = true;
    await this.memory.load();
    this.delivery.start();
    this.reflector.start(this.config.reflectionIntervalMs);
    this.startSelfScan();
    this.subscribeToTriggers();
    this.logger.info(
      `[JarvisHarness] started | shadow=${this.config.shadowMode} | ` +
        `selfScanInterval=${this.config.selfScanIntervalMs}ms | ` +
        `cooldown=${this.config.globalCooldownMs}ms`,
    );
  }

  stop(): void {
    for (const u of this.unsubscribers) u();
    this.unsubscribers = [];
    if (this.selfScanTimer) clearInterval(this.selfScanTimer);
    this.selfScanTimer = null;
    this.delivery.stop();
    this.reflector.stop();
    this.started = false;
    this.logger.info("[JarvisHarness] stopped");
  }

  // ────────────────────── 订阅 5 类 trigger ──────────────────────

  private subscribeToTriggers(): void {
    // 1) LifeSignal
    const unsubLife = this.deps.lifeSignalHub.subscribe((signal) => {
      // 跳过已经在旧 LifeSignalHub 里被消费过的 mood 类（防重复触发）
      if (signal.kind === "mood" && (signal.metadata as { handledByJarvis?: boolean } | undefined)?.handledByJarvis) {
        return;
      }
      const trigger = lifeSignalTriggerAdapter(signal);
      // mood 类单独走 moodTriggerAdapter 以保留 inference 原文
      if (signal.kind === "mood") {
        const inference = this.extractMoodInference(signal);
        if (inference) {
          void this.handleTrigger(moodTriggerAdapter(inference));
          return;
        }
      }
      void this.handleTrigger(trigger);
    });
    this.unsubscribers.push(unsubLife);
  }

  // ────────────────────── 主动消息主流程 ──────────────────────

  private async handleTrigger(trigger: JarvisTrigger): Promise<void> {
    if (this.triggerSeen.has(trigger.id)) return;
    this.triggerSeen.add(trigger.id);
    if (this.triggerSeen.size > 2000) {
      // 简单 LRU 清理
      const arr = [...this.triggerSeen];
      this.triggerSeen.clear();
      for (const id of arr.slice(-1000)) this.triggerSeen.add(id);
    }
    if (!this.started) return;

    // 1) 冷却检查
    if (!this.passesCooldown(trigger)) {
      await this.memory.recordTrigger(trigger);
      return;
    }

    // 2) 写入 episodic memory
    await this.memory.recordTrigger(trigger);

    // 3) 累积到 recentTriggers
    const recent = this.recentTriggers.get(trigger.actorId) ?? [];
    recent.push(trigger);
    if (recent.length > 50) recent.splice(0, recent.length - 50);
    this.recentTriggers.set(trigger.actorId, recent);

    // 4) 决策
    const recentOutboundTexts = this.deps.outbound
      .getRecent(trigger.actorId, 3)
      .map((m) => m.text);
    const decision = await this.decision.decide({
      trigger,
      recentTriggers: recent.slice(0, 20),
      recentOutboundTexts,
    });

    // 5) 写入 decision memory
    await this.memory.recordDecision(trigger, decision);

    // 6) 投递
    if (decision.decision === "speak") {
      this.actorLastAt.set(trigger.actorId, Date.now());
      this.categoryLastAt.set(
        `${trigger.actorId}:${trigger.category}`,
        Date.now(),
      );
    }
    const delivery = await this.delivery.deliver(trigger, decision);

    // 7) 日志
    this.logger.info(
      `[JarvisHarness] [${trigger.source}/${trigger.category}] ` +
        `decision=${decision.decision} value=${decision.value.composite.toFixed(2)} ` +
        `disturb=${decision.disturb.composite.toFixed(2)} ` +
        `${decision.decision === "speak" ? `→ "${decision.content}"` : ""} ` +
        `| sent=${delivery.sent} channel=${decision.channel ?? "-"}`,
    );
  }

  // ────────────────────── 自发性扫描定时 ──────────────────────

  private startSelfScan(): void {
    if (this.selfScanTimer) return;
    this.selfScanTimer = setInterval(() => {
      void this.runSelfScan().catch((err) =>
        this.logger.warn(
          `[JarvisHarness] self-scan failed: ${err instanceof Error ? err.message : String(err)}`,
        ),
      );
    }, this.config.selfScanIntervalMs);
  }

  private async runSelfScan(): Promise<void> {
    if (!this.started) return;
    const candidates = await this.selfScan.scan();
    if (candidates.length === 0) return;
    let promoted = 0;
    for (const candidate of candidates) {
      const trigger = this.selfScan.toTrigger(candidate);
      if (!trigger) continue;
      promoted += 1;
      void this.handleTrigger(trigger);
    }
    if (promoted > 0) {
      this.logger.info(`[JarvisHarness] self-scan promoted ${promoted} candidate(s)`);
    }
  }

  // ────────────────────── 反馈入口（外部调用） ──────────────────────

  async recordFeedback(feedback: JarvisFeedback): Promise<void> {
    await this.delivery.recordFeedback(feedback);
  }

  /**
   * 暴露最近决策（供调试接口 / 前端展示）
   */
  recentTriggersFor(actorId: string, limit = 20): JarvisTrigger[] {
    return [...(this.recentTriggers.get(actorId) ?? [])].slice(-limit);
  }

  recentDecisionsFor(actorId: string, limit = 20): JarvisDecisionResult[] {
    const episodic = this.memory.episodicFor(actorId, 200);
    // 简易：从 episodic 文本里 DECISION[...] 还原
    return episodic
      .filter((e) => e.body.startsWith("DECISION["))
      .slice(-limit)
      .map((e) => {
        const m = e.body.match(/DECISION\[(\w+)\]/);
        const decision = (m?.[1] as JarvisDecisionResult["decision"]) ?? "silent";
        return {
          triggerId: e.refs[0] ?? e.id,
          actorId: e.actorId,
          decision,
          value: { composite: 0, raw: 0, contextual: 0, novelty: 0, userInterest: 0, silenceCost: 0, rationale: [] },
          disturb: { composite: 0, temporal: 0, fatigue: 0, receptivity: 0, context: 0, rationale: [] },
          rationale: e.tags,
          decidedAt: e.createdAt,
        } as JarvisDecisionResult;
      });
  }

  // ────────────────────── 辅助 ──────────────────────

  private passesCooldown(trigger: JarvisTrigger): boolean {
    const now = Date.now();
    const lastActor = this.actorLastAt.get(trigger.actorId) ?? 0;
    if (now - lastActor < this.config.globalCooldownMs) return false;
    const lastCat = this.categoryLastAt.get(`${trigger.actorId}:${trigger.category}`) ?? 0;
    if (now - lastCat < this.config.categoryCooldownMs) return false;
    // warning 类无冷却
    if (trigger.category === "warning" || trigger.urgency >= 8.5) return true;
    return true;
  }

  private extractMoodInference(signal: import("../life-signal-types.js").LifeSignal) {
    const meta = signal.metadata as Record<string, unknown> | undefined;
    const fromMeta = meta?.inference as import("../mood-inference-service.js").MoodInference | undefined;
    if (
      fromMeta &&
      typeof fromMeta === "object" &&
      typeof fromMeta.sessionId === "string"
    ) {
      return fromMeta;
    }
    const metrics = signal.metrics;
    if (
      metrics &&
      typeof metrics.sentimentScore === "number" &&
      typeof metrics.confidence === "number"
    ) {
      return {
        sessionId: signal.actorId,
        sentimentScore: metrics.sentimentScore,
        confidence: metrics.confidence,
        emotionTags: Array.isArray(signal.tags) ? signal.tags : [],
        source: "conversation" as const,
        rawSignals: {},
        timestamp: signal.occurredAt,
      };
    }
    return null;
  }

  private resolveKnownActorIds(): string[] {
    const ids = new Set<string>();
    // 从 lifeSignalHub 历史收集
    for (const actorId of this.recentTriggers.keys()) ids.add(actorId);
    return [...ids];
  }
}
