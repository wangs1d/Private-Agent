/**
 * J.A.R.V.I.S. Harness — 统一主动消息触发 / 决策 / 投递类型
 *
 * 借鉴开源方案：
 *  - LangGraph：可中断状态机 + 持久化节点
 *  - Letta (MemGPT)：episodic / semantic / reflection 三类记忆
 *  - mem0：跨会话统一记忆层
 *  - ProactiveAgent (research)：value / disturb 双轨评估
 *
 * 设计原则：
 *  1. 所有触发源都归一为 JarvisTrigger
 *  2. 所有决策都走 JarvisDecisionEngine
 *  3. 所有发送都走 DeliveryGateway
 *  4. 所有发送都进 MemoryBank，异步触发 Reflector
 */

import type { ProactiveOutboundChannel } from "../proactive-outbound-message-service.js";
import type {
  AnticipationCandidate,
  LifeSignal,
  LifeSignalSource,
} from "../life-signal-types.js";
import type { MoodInference } from "../mood-inference-service.js";
import type { StateChangeEvent } from "@private-ai-agent/agent-world";

// ────────────────────── 触发源 ──────────────────────

export type JarvisTriggerSource =
  | "event"         // 来自 StateChangeEvent（gomoku/wallet/task/market/social ...）
  | "life_signal"   // 来自 LifeSignalHubService
  | "cron"          // 定时任务（早间简报 / 自发性扫描）
  | "mood"          // 情绪推断结果
  | "self_scan";    // 主动扫描（笔记 / 日程 / 习惯 / 关系）

export type JarvisTriggerCategory =
  | "care"           // 关怀（用户情绪 / 长时间未联系）
  | "warning"        // 警告（市场异动 / 钱包 / 风险）
  | "opportunity"    // 机会（学习 / 工具 / 朋友）
  | "planning"       // 计划（提醒 / 日程 / 任务）
  | "completion"     // 完成（任务 / 游戏 / 交易）
  | "newness"        // 新增（好友 / 帖子 / 笔记）
  | "follow_up"      // 跟进（昨日未完话题）
  | "presence"       // 陪伴（问候 / 闲聊 / 周末）
  | "social"         // 社交（好友互动）
  | "finance"        // 财务
  | "general";       // 兜底

export type JarvisTriggerUrgencyBand = "low" | "medium" | "high" | "critical";

/**
 * 统一触发器：所有 trigger 源都产出这个 schema
 */
export type JarvisTrigger = {
  id: string;
  source: JarvisTriggerSource;
  actorId: string;
  category: JarvisTriggerCategory;
  title: string;
  summary: string;
  description?: string;
  tags: string[];
  urgency: number;        // 0-10
  confidence: number;     // 0-1
  importance: JarvisTriggerUrgencyBand;
  evidence: string[];
  occurredAt: string;     // ISO
  ttlMs?: number;         // 触发时效，过期不处理
  metadata?: Record<string, unknown>;
  /** 原始 payload，便于追溯 */
  rawEvent?: StateChangeEvent;
  rawSignal?: LifeSignal;
  rawAnticipation?: AnticipationCandidate;
  rawMood?: MoodInference;
};

// ────────────────────── 决策状态 ──────────────────────

export type JarvisDecision = "speak" | "do" | "wait" | "silent";

export type JarvisChannel = ProactiveOutboundChannel;

export type JarvisChannelDecision = {
  channel: JarvisChannel;
  reason: string;
  quietHours: boolean;
};

export type JarvisValueScore = {
  raw: number;
  contextual: number;
  novelty: number;
  userInterest: number;
  silenceCost: number;
  composite: number;
  rationale: string[];
};

export type JarvisDisturbScore = {
  temporal: number;
  fatigue: number;
  receptivity: number;
  context: number;
  composite: number;
  rationale: string[];
};

/**
 * 决策结果（带完整可观测性）
 */
export type JarvisDecisionResult = {
  triggerId: string;
  actorId: string;
  decision: JarvisDecision;
  channel?: JarvisChannel;
  content?: string;
  value: JarvisValueScore;
  disturb: JarvisDisturbScore;
  rejectedBy?: string;
  rejectionReason?: string;
  rationale: string[];
  decidedAt: string;
  /** LLM 决策的耗时（毫秒） */
  latencyMs?: number;
  /** 关联的自发性扫描 ID（如果触发是自发性扫描产生的） */
  selfScanKind?: string;
};

// ────────────────────── 投递结果 ──────────────────────

export type JarvisDeliveryResult = {
  triggerId: string;
  decisionId: string;
  actorId: string;
  channel: JarvisChannel;
  sent: boolean;
  reason: string;
  deliveredAt: string;
  /** 用于后续反馈埋点的关联 ID */
  outboundId?: string;
};

// ────────────────────── 反馈 ──────────────────────

export type JarvisFeedbackKind =
  | "delivered"     // 投递埋点
  | "seen"          // 客户端确认收到（曝光埋点）
  | "responded"     // 用户回复
  | "ignored"       // 用户未理睬
  | "negative"      // 用户显式 negative feedback
  | "positive"      // 用户显式 positive feedback
  | "post_mood";    // 发送后用户的整体情绪变化

export type JarvisFeedback = {
  kind: JarvisFeedbackKind;
  triggerId: string;
  decisionId: string;
  actorId: string;
  responseTimeMs?: number;
  sentimentAfter?: number;
  metadata?: Record<string, unknown>;
  occurredAt: string;
};

// ────────────────────── 记忆 ──────────────────────

export type JarvisMemoryKind = "episodic" | "reflection" | "rule";

export type JarvisMemoryEntry = {
  id: string;
  kind: JarvisMemoryKind;
  actorId: string;
  body: string;
  tags: string[];
  confidence: number;
  createdAt: string;
  source: JarvisTriggerSource | "reflection";
  /** 关联的 trigger / decision id */
  refs: string[];
};

// ────────────────────── 自发性扫描 ──────────────────────

export type JarvisSelfScanKind =
  | "stale_topic"        // 旧话题还没结论
  | "habit_gap"          // 习惯缺口
  | "knowledge_gap"      // 笔记里未解
  | "relationship_gap"   // 太久没聊
  | "upcoming_deadline"  // 日程反推
  | "idle_opportunity"   // 空闲时段
  | "weekend_ritual"     // 周末轻问候
  | "follow_up_resume";  // 续上次未完话题

export type JarvisSelfScanCandidate = {
  kind: JarvisSelfScanKind;
  actorId: string;
  title: string;
  rationale: string;
  suggestedAction: string;
  confidence: number;
  urgency: number;
  tags: string[];
  evidence: string[];
  detectedAt: string;
  /** 触发自发性扫描的 source（用于限流 / 反馈归因） */
  meta?: Record<string, unknown>;
};

// ────────────────────── Harness 配置 ──────────────────────

export type JarvisHarnessConfig = {
  enabled: boolean;
  /** 自发性扫描周期（毫秒）。默认 20 分钟 */
  selfScanIntervalMs: number;
  /** 决策引擎 LLM 模型（不填用默认） */
  decisionModel?: string;
  /** 决策单条最长字符数 */
  maxResponseChars: number;
  /** 全局冷却（毫秒）— 同 actor 两次主动消息之间最短间隔 */
  globalCooldownMs: number;
  /** 同 category 冷却（毫秒） */
  categoryCooldownMs: number;
  /** reflection 异步执行间隔（毫秒） */
  reflectionIntervalMs: number;
  /** 沉默即反馈的最大记录数（每 actor） */
  maxSilenceRecords: number;
  /** 是否启用 shadow 模式（不真发，只记录决策） */
  shadowMode: boolean;
};

export const DEFAULT_JARVIS_HARNESS_CONFIG: JarvisHarnessConfig = {
  enabled: process.env.JARVIS_HARNESS_ENABLED?.trim().toLowerCase() !== "0",
  selfScanIntervalMs: Number.parseInt(process.env.JARVIS_SELF_SCAN_INTERVAL_MS ?? "", 10) || 20 * 60_000,
  maxResponseChars: 96,
  globalCooldownMs: 5_000,
  categoryCooldownMs: 60_000,
  reflectionIntervalMs: 30 * 60_000,
  maxSilenceRecords: 200,
  shadowMode: process.env.JARVIS_HARNESS_SHADOW?.trim().toLowerCase() === "1",
};

// ────────────────────── 工厂辅助 ──────────────────────

export function toUrgencyBand(urgency: number): JarvisTriggerUrgencyBand {
  if (urgency >= 8.5) return "critical";
  if (urgency >= 6.5) return "high";
  if (urgency >= 4) return "medium";
  return "low";
}

export function inferTriggerCategoryFromLifeSignal(signal: LifeSignal): JarvisTriggerCategory {
  const tags = signal.tags ?? [];
  if (tags.includes("risk") || signal.importance === "critical") return "warning";
  if (tags.includes("completion")) return "completion";
  if (tags.includes("newness")) return "newness";
  if (tags.includes("planning")) return "planning";
  if (tags.includes("social")) return "social";
  if (tags.includes("finance")) return "finance";
  if (tags.includes("care")) return "care";
  if (tags.includes("presence")) return "presence";
  if (signal.source === "agent_inference" && signal.kind === "mood") return "care";
  if (signal.source === "market" as LifeSignalSource) return "warning";
  return "general";
}
