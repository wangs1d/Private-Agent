import type { ToolLoopAfterBatchInfo } from "../external-model/types.js";
import type { AgentMemorySyncService } from "./agent-memory-sync-service.js";
import { isKvSummaryMinimal } from "../config/memory-env.js";
import { inferMemoryTopic } from "../agent/memory-topic.js";

type EvolutionNamespaceOutcome = {
  success: number;
  failure: number;
};

type EvolutionProfile = {
  totalTurns: number;
  successfulToolCalls: number;
  failedToolCalls: number;
  toolNamespaces: Record<string, number>;
  toolNamespaceOutcomes: Record<string, EvolutionNamespaceOutcome>;
  userLanguagePreference?: string;
  lastUpdatedAt: string;
};

/**
 * 记忆 KV 中能力画像的存储 key。
 * 迁移说明：旧 key 为 "hermes_profile"，为兼容历史数据读取时仍会 fallback 旧 key，
 * 写入统一使用新 key "evolution_profile"。
 */
const PROFILE_KEY = "evolution_profile";
const LEGACY_PROFILE_KEY = "hermes_profile";

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function asNonNegativeCount(v: unknown): number {
  const count = Number(v);
  return Number.isFinite(count) && count >= 0 ? count : 0;
}

function toEvolutionProfile(v: unknown): EvolutionProfile | null {
  if (!isObject(v)) return null;

  const nsRaw = isObject(v.toolNamespaces) ? v.toolNamespaces : {};
  const outcomesRaw = isObject(v.toolNamespaceOutcomes) ? v.toolNamespaceOutcomes : {};

  const toolNamespaces: Record<string, number> = {};
  const toolNamespaceOutcomes: Record<string, EvolutionNamespaceOutcome> = {};

  for (const [namespace, rawCount] of Object.entries(nsRaw)) {
    const count = asNonNegativeCount(rawCount);
    if (count > 0) toolNamespaces[namespace] = count;
  }

  for (const [namespace, rawOutcome] of Object.entries(outcomesRaw)) {
    if (!isObject(rawOutcome)) continue;
    const success = asNonNegativeCount(rawOutcome.success);
    const failure = asNonNegativeCount(rawOutcome.failure);
    if (success <= 0 && failure <= 0) continue;
    toolNamespaceOutcomes[namespace] = { success, failure };
  }

  return {
    totalTurns: asNonNegativeCount(v.totalTurns),
    successfulToolCalls: asNonNegativeCount(v.successfulToolCalls),
    failedToolCalls: asNonNegativeCount(v.failedToolCalls),
    toolNamespaces,
    toolNamespaceOutcomes,
    userLanguagePreference:
      typeof v.userLanguagePreference === "string" ? v.userLanguagePreference : undefined,
    lastUpdatedAt:
      typeof v.lastUpdatedAt === "string" && v.lastUpdatedAt
        ? v.lastUpdatedAt
        : new Date().toISOString(),
  };
}

function emptyEvolutionProfile(): EvolutionProfile {
  return {
    totalTurns: 0,
    successfulToolCalls: 0,
    failedToolCalls: 0,
    toolNamespaces: {},
    toolNamespaceOutcomes: {},
    lastUpdatedAt: new Date().toISOString(),
  };
}

function detectLanguagePreference(text: string): string | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  if (/简体|中文|汉语|普通话/.test(trimmed)) return "zh-CN";
  if (/english|英文|英语/i.test(trimmed)) return "en";
  return undefined;
}

function pickNamespace(toolName: string): string {
  const dotIndex = toolName.indexOf(".");
  if (dotIndex > 0) return toolName.slice(0, dotIndex);
  const underscoreIndex = toolName.indexOf("_");
  if (underscoreIndex > 0) return toolName.slice(0, underscoreIndex);
  return "misc";
}

function namespaceSuccessRate(outcome: EvolutionNamespaceOutcome | undefined): number {
  if (!outcome) return 0;
  const attempts = outcome.success + outcome.failure;
  return attempts > 0 ? Math.round((outcome.success / attempts) * 100) : 0;
}

function formatAbilities(profile: EvolutionProfile): string {
  const topNamespaces = Object.entries(profile.toolNamespaces)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4);
  const top = topNamespaces
    .map(([namespace, count]) => {
      const successRate = namespaceSuccessRate(profile.toolNamespaceOutcomes[namespace]);
      return successRate > 0 ? `${namespace}(${count}, ${successRate}%)` : `${namespace}(${count})`;
    })
    .join(", ");

  if (!top) {
    return "当前能力画像仍在积累中，暂时还没有稳定的工具域偏好。";
  }

  return `长期使用显示该 Agent 在这些工具域最常用且更可靠：${top}。决策时优先复用这些已验证路径。`;
}

function formatValues(profile: EvolutionProfile): string {
  const totalToolCalls = profile.successfulToolCalls + profile.failedToolCalls;
  const successRate =
    totalToolCalls > 0 ? Math.round((profile.successfulToolCalls / totalToolCalls) * 100) : 0;
  return `遵循稳健执行与可审计原则：优先复用已验证路径，当前工具成功率约 ${successRate}%（${profile.successfulToolCalls}/${totalToolCalls}）。`;
}

function formatPersona(profile: EvolutionProfile): string {
  const lang = profile.userLanguagePreference
    ? `优先使用 ${profile.userLanguagePreference}`
    : "默认跟随用户语言";
  return `你是持续演化的长期助手，已累计 ${profile.totalTurns} 轮互动；${lang}，并根据历史偏好调整表达与行动。`;
}

/**
 * 进化循环开关。
 * 兼容迁移：优先读新变量 AGENT_EVOLUTION_LOOP_ENABLED，未设置时 fallback 旧变量
 * AGENT_HERMES_EVOLUTION_ENABLED（已配置的环境无需改动即可继续生效）。
 */
export function isEvolutionLoopEnabled(): boolean {
  const raw =
    process.env.AGENT_EVOLUTION_LOOP_ENABLED?.trim().toLowerCase() ??
    process.env.AGENT_HERMES_EVOLUTION_ENABLED?.trim().toLowerCase();
  if (!raw) return true;
  if (raw === "0" || raw === "off" || raw === "false") return false;
  return true;
}

export class EvolutionLoopService {
  constructor(
    private readonly memory: AgentMemorySyncService,
    private readonly opts?: {
      onObserveForNarrative?: (actorId: string, line: string) => void | Promise<void>;
    },
  ) {}

  private emitNarrative(actorId: string, line: string): void {
    const fn = this.opts?.onObserveForNarrative;
    if (!fn) return;
    void Promise.resolve(fn(actorId, line)).catch(() => {});
  }

  onToolBatch(actorId: string, userText: string, info: ToolLoopAfterBatchInfo): void {
    if (!isEvolutionLoopEnabled()) return;

    const signal = info.toolResults.map((t) => `${t.name}:${t.ok ? "ok" : "fail"}`).join(", ");
    this.appendSummary(actorId, `toolBatch round=${info.roundIndex} ${signal || "none"}`);

    this.patchProfile(actorId, (profile) => {
      for (const toolResult of info.toolResults) {
        if (toolResult.ok) profile.successfulToolCalls += 1;
        else profile.failedToolCalls += 1;

        const namespace = pickNamespace(toolResult.name);
        profile.toolNamespaces[namespace] = (profile.toolNamespaces[namespace] ?? 0) + 1;

        const outcome = profile.toolNamespaceOutcomes[namespace] ?? { success: 0, failure: 0 };
        if (toolResult.ok) outcome.success += 1;
        else outcome.failure += 1;
        profile.toolNamespaceOutcomes[namespace] = outcome;
      }

      const preference = detectLanguagePreference(userText);
      if (preference) profile.userLanguagePreference = preference;
      return profile;
    });
  }

  onAssistantDone(actorId: string, userText: string, assistantText: string): void {
    if (!isEvolutionLoopEnabled()) return;

    this.patchProfile(actorId, (profile) => {
      profile.totalTurns += 1;
      const preference = detectLanguagePreference(userText);
      if (preference) profile.userLanguagePreference = preference;
      return profile;
    });

    const shortAssistant = assistantText.replace(/\s+/g, " ").slice(0, 120);
    this.appendSummary(
      actorId,
      `assistantDone user="${userText.slice(0, 64)}" reply="${shortAssistant}"`,
      userText,
    );
  }

  private appendSummary(actorId: string, line: string, topicSource?: string): void {
    const compact = line.replace(/\s+/g, " ").trim();
    if (!compact) return;
    const stamped = `EvolutionLoop: ${compact}`;
    if (!isKvSummaryMinimal()) {
      this.memory.appendMemorySummaryLine(actorId, stamped, inferMemoryTopic(topicSource ?? line));
    }
    this.emitNarrative(actorId, stamped);
  }

  private patchProfile(actorId: string, mutator: (profile: EvolutionProfile) => EvolutionProfile): void {
    void this.patchProfileAsync(actorId, mutator);
  }

  private async patchProfileAsync(
    actorId: string,
    mutator: (profile: EvolutionProfile) => EvolutionProfile,
  ): Promise<void> {
    for (let i = 0; i < 8; i++) {
      const { revision, entries } = this.memory.getSnapshot(actorId, [
        PROFILE_KEY,
        LEGACY_PROFILE_KEY, // 兼容历史数据：旧 key 下的画像仍可读
        "persona",
        "values",
        "abilities",
      ]);
      const profile =
        toEvolutionProfile(entries[PROFILE_KEY]) ??
        toEvolutionProfile(entries[LEGACY_PROFILE_KEY]) ??
        emptyEvolutionProfile();
      const next = mutator(profile);
      next.lastUpdatedAt = new Date().toISOString();
      const result = await this.memory.applyPatch(actorId, revision, [
        { key: PROFILE_KEY, op: "put", value: next },
        { key: "persona", op: "put", value: formatPersona(next) },
        { key: "values", op: "put", value: formatValues(next) },
        { key: "abilities", op: "put", value: formatAbilities(next) },
      ]);
      if (result.ok) return;
    }
  }
}
