import type { ToolLoopAfterBatchInfo } from "../external-model/types.js";
import type { AgentMemorySyncService } from "./agent-memory-sync-service.js";

type HermesProfile = {
  totalTurns: number;
  successfulToolCalls: number;
  failedToolCalls: number;
  toolNamespaces: Record<string, number>;
  userLanguagePreference?: string;
  lastUpdatedAt: string;
};

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function toHermesProfile(v: unknown): HermesProfile | null {
  if (!isObject(v)) return null;
  const nsRaw = isObject(v.toolNamespaces) ? v.toolNamespaces : {};
  const toolNamespaces: Record<string, number> = {};
  for (const [k, vv] of Object.entries(nsRaw)) {
    const n = Number(vv);
    if (Number.isFinite(n) && n >= 0) toolNamespaces[k] = n;
  }
  return {
    totalTurns: Number(v.totalTurns) || 0,
    successfulToolCalls: Number(v.successfulToolCalls) || 0,
    failedToolCalls: Number(v.failedToolCalls) || 0,
    toolNamespaces,
    userLanguagePreference:
      typeof v.userLanguagePreference === "string" ? v.userLanguagePreference : undefined,
    lastUpdatedAt:
      typeof v.lastUpdatedAt === "string" && v.lastUpdatedAt
        ? v.lastUpdatedAt
        : new Date().toISOString(),
  };
}

function detectLanguagePreference(text: string): string | undefined {
  const t = text.trim();
  if (!t) return undefined;
  if (/简体|中文|汉语|普通话/.test(t)) return "zh-CN";
  if (/english|英文|英语/i.test(t)) return "en";
  return undefined;
}

function pickNamespace(toolName: string): string {
  const idx = toolName.indexOf(".");
  if (idx <= 0) return "misc";
  return toolName.slice(0, idx);
}

function formatAbilities(profile: HermesProfile): string {
  const sorted = Object.entries(profile.toolNamespaces).sort((a, b) => b[1] - a[1]).slice(0, 4);
  const top = sorted.map(([k, v]) => `${k}(${v})`).join("、");
  if (!top) return "当前能力尚在培养期，暂无稳定工具偏好。";
  return `长期互动显示该 Agent 在以下能力域更活跃：${top}。决策时优先考虑这些工具域并保持可解释性。`;
}

function formatValues(profile: HermesProfile): string {
  const totalToolCalls = profile.successfulToolCalls + profile.failedToolCalls;
  const successRate = totalToolCalls > 0 ? Math.round((profile.successfulToolCalls / totalToolCalls) * 100) : 0;
  return `遵循稳健执行与可审计原则：优先复用已验证路径，工具成功率当前约 ${successRate}%（${profile.successfulToolCalls}/${totalToolCalls}）。`;
}

function formatPersona(profile: HermesProfile): string {
  const lang = profile.userLanguagePreference ? `优先使用 ${profile.userLanguagePreference}` : "默认跟随用户语言";
  return `你是持续进化的长期助手，已累计 ${profile.totalTurns} 轮互动；${lang}，并根据历史偏好调整表达与行动。`;
}

export function isHermesEvolutionEnabled(): boolean {
  const raw = process.env.AGENT_HERMES_EVOLUTION_ENABLED?.trim().toLowerCase();
  if (!raw) return true;
  if (raw === "0" || raw === "off" || raw === "false") return false;
  return true;
}

/**
 * Hermes 风格自动演化闭环：
 * observe(会话/工具信号) -> reflect(抽取偏好与能力统计) -> patch(memory keys)
 */
export class HermesEvolutionLoopService {
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
    if (!isHermesEvolutionEnabled()) return;
    const signal = info.toolResults.map((t) => `${t.name}:${t.ok ? "ok" : "fail"}`).join(", ");
    this.appendSummary(actorId, `toolBatch round=${info.roundIndex} ${signal || "none"}`);
    this.patchProfile(actorId, (profile) => {
      for (const t of info.toolResults) {
        if (t.ok) profile.successfulToolCalls += 1;
        else profile.failedToolCalls += 1;
        const ns = pickNamespace(t.name);
        profile.toolNamespaces[ns] = (profile.toolNamespaces[ns] ?? 0) + 1;
      }
      const pref = detectLanguagePreference(userText);
      if (pref) profile.userLanguagePreference = pref;
      return profile;
    });
  }

  onAssistantDone(actorId: string, userText: string, assistantText: string): void {
    if (!isHermesEvolutionEnabled()) return;
    this.patchProfile(actorId, (profile) => {
      profile.totalTurns += 1;
      const pref = detectLanguagePreference(userText);
      if (pref) profile.userLanguagePreference = pref;
      return profile;
    });
    const shortAssistant = assistantText.replace(/\s+/g, " ").slice(0, 120);
    this.appendSummary(actorId, `assistantDone user="${userText.slice(0, 64)}" reply="${shortAssistant}"`);
  }

  private appendSummary(actorId: string, line: string): void {
    const compact = line.replace(/\s+/g, " ").trim();
    if (!compact) return;
    const stamped = `HermesLoop: ${compact}`;
    const ok = this.memory.appendMemorySummaryLine(actorId, stamped);
    if (ok) this.emitNarrative(actorId, stamped);
  }

  private patchProfile(actorId: string, mutator: (profile: HermesProfile) => HermesProfile): void {
    for (let i = 0; i < 8; i++) {
      const { revision, entries } = this.memory.getSnapshot(actorId, [
        "hermes_profile",
        "persona",
        "values",
        "abilities",
      ]);
      const profile = toHermesProfile(entries.hermes_profile) ?? {
        totalTurns: 0,
        successfulToolCalls: 0,
        failedToolCalls: 0,
        toolNamespaces: {},
        lastUpdatedAt: new Date().toISOString(),
      };
      const next = mutator(profile);
      next.lastUpdatedAt = new Date().toISOString();
      const r = this.memory.applyPatch(actorId, revision, [
        { key: "hermes_profile", op: "put", value: next },
        { key: "persona", op: "put", value: formatPersona(next) },
        { key: "values", op: "put", value: formatValues(next) },
        { key: "abilities", op: "put", value: formatAbilities(next) },
      ]);
      if (r.ok) return;
    }
  }
}
