// ProactivityHub —— InitiativeEngine（LLM 主动性决策引擎）
//
// Jarvis 式通用主动性的核心：不是"规则命中就触发"，而是把观察流交给 LLM，
// 让它像真人助理一样自主判断——
//   1. 现在值得主动做什么吗？（大多数时候答案是"不"，克制是主动性的前提）
//   2. 以什么形式？speak（发消息）/ act（静默做事）/ advise（下轮带建议）/ none
//   3. 具体做什么？speak/advise 给话术提示；act 给工具调用行动计划
//
// 触发时机：周期 tick（有新观察才调）+ 高显著事件即时评估。
// 规则触发器（celebration/overwork 等）保留为确定性快路径（零 LLM），
// 本引擎处理其余所有"规则写不完"的场景。
//
// LLM 调用通过注入的 llmComplete 包装（externalChat.streamCompletion 的薄包装），
// 便于测试 mock；解析失败/LLM 不可用时返回 null（静默降级为 none）。
import type { InitiativeDecision, Observation } from "./proactivity-types.js";

/** LLM 完成函数（(prompt) => 全文），由装配层包装 externalChat.streamCompletion */
export type LlmCompleteFn = (prompt: string, sessionId: string) => Promise<string>;

export type InitiativeEvaluateInput = {
  actorId: string;
  /** 自上次评估以来的新观察（决策主体） */
  observations: Observation[];
  /** 近期背景观察（可选，帮助 LLM 理解连续状态） */
  recentContext?: Observation[];
  /** 用户画像摘要（偏好/习惯/话题，自然语言） */
  profileText?: string;
  /** 最近一次对话交互时刻；null=从未交互 */
  lastInteractionAt?: number | null;
  /** 最近已发起的主动行为描述（避免重复同类主动） */
  recentInitiatives?: string[];
  /** 频控余量说明（如"今日还可主动 3 次；greeting/interest_share 已达当日上限"） */
  budgetNote?: string;
  /** 可用工具清单（name + 描述），act 行动计划从中选 */
  availableTools?: Array<{ name: string; description: string }>;
  now?: Date;
};

export class InitiativeEngine {
  constructor(private readonly llmComplete: LlmCompleteFn | null) {}

  isEnabled(): boolean {
    return this.llmComplete !== null;
  }

  /**
   * 评估一次主动性决策。任何失败（LLM 异常/JSON 解析失败/输出非法）
   * 都返回 null（= none，静默不主动），绝不抛错。
   */
  async evaluate(input: InitiativeEvaluateInput): Promise<InitiativeDecision | null> {
    if (!this.llmComplete) return null;
    const prompt = this.buildPrompt(input);
    let raw: string;
    try {
      raw = await this.llmComplete(prompt, input.actorId);
      // Token 审计：主动意图决策是低频旁路，量级不大但可查
      const { recordLlmUsageByChars } = await import("../services/llm-token-audit.js");
      recordLlmUsageByChars({
        stage: "proactive_intent",
        inputChars: prompt.length,
        outputChars: raw.length,
      });
    } catch (err) {
      console.log(`[InitiativeEngine] LLM 调用失败（静默跳过）: ${err}`);
      return null;
    }
    return this.normalize(this.parseJson(raw), input);
  }

  // ---- prompt 构造 ----

  /** prompt 内工具描述截断长度（长描述只留首句要点） */
  private static readonly TOOL_DESC_MAX = 80;
  /** prompt 内背景观察条数上限（够理解连续性即可） */
  private static readonly RECENT_CONTEXT_MAX = 6;

  private buildPrompt(input: InitiativeEvaluateInput): string {
    const now = input.now ?? new Date();
    const lines: string[] = [];
    lines.push(
      "你是 Agent 的主动性引擎（像 Jarvis）。观察用户状态流，判断现在是否值得主动做什么。" +
        "大多数时候答案是 none——为做而做的主动是打扰，不是能力。",
    );
    lines.push(
      "模式：speak=主动发消息（仅真正值得打断时）；act=静默后台做事（排日程/放音乐/整理，" +
        "做完轻提一句，优先于 speak）；advise=存建议等用户下次说话带出（最低打扰）；none=不动。",
    );
    lines.push("原则：克制优先，宁可错过不可打扰；勿重复最近已做过的主动；信息不足→none。");
    lines.push(`当前时间：${now.toLocaleString("zh-CN")}（周${["日","一","二","三","四","五","六"][now.getDay()]}）`);
    if (input.lastInteractionAt != null) {
      const gapMin = Math.round((now.getTime() - input.lastInteractionAt) / 60000);
      lines.push(
        `最近交互：${gapMin < 60 ? `${gapMin} 分钟前` : `${Math.round(gapMin / 60)} 小时前`}` +
          (gapMin > 2880 ? "（久未联系）" : ""),
      );
    } else {
      lines.push("最近交互：从未（绝对不要主动）");
    }
    if (input.budgetNote) lines.push(`主动额度：${input.budgetNote}`);
    if (input.profileText) lines.push(`用户画像：${input.profileText}`);
    if (input.recentInitiatives && input.recentInitiatives.length > 0) {
      lines.push(`最近已主动（勿重复）：${input.recentInitiatives.slice(-4).join("；")}`);
    }
    const ctx = input.recentContext?.slice(-InitiativeEngine.RECENT_CONTEXT_MAX) ?? [];
    if (ctx.length > 0) {
      lines.push(`背景观察：${ctx.map((o) => `[${o.type}]${o.content}`).join("；")}`);
    }
    lines.push(`本次新观察（决策依据）：`);
    for (const o of input.observations) {
      lines.push(`- [${o.type}/${o.salience}] ${o.content}`);
    }
    if (input.availableTools && input.availableTools.length > 0) {
      lines.push(`可用工具（act 从中选，name 必须完全一致）：`);
      for (const t of input.availableTools.slice(0, 18)) {
        lines.push(`- ${t.name}：${this.compactDesc(t.description)}`);
      }
    }
    lines.push(
      '只返回 JSON：{"mode":"speak|act|advise|none","kind":"英文蛇形标签",' +
        '"importance":"high|medium|low","rationale":"一句话理由",' +
        '"messageHint":"speak/advise 的话术要点","actions":[{"tool":"名","args":{}}]（仅 act，其余 []）}',
    );
    return lines.join("\n");
  }

  /** 工具描述压缩：压空白 + 截断到首句要点 */
  private compactDesc(desc: string): string {
    const flat = desc.replace(/\s+/g, " ").trim();
    if (flat.length <= InitiativeEngine.TOOL_DESC_MAX) return flat;
    const cut = flat.slice(0, InitiativeEngine.TOOL_DESC_MAX);
    const stop = Math.max(cut.lastIndexOf("。"), cut.lastIndexOf("；"), cut.lastIndexOf(","));
    return (stop > 20 ? cut.slice(0, stop) : cut) + "…";
  }

  // ---- JSON 解析与归一化 ----

  private parseJson(text: string): Record<string, unknown> | null {
    const trimmed = text.trim();
    try {
      return JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      const start = trimmed.indexOf("{");
      const end = trimmed.lastIndexOf("}");
      if (start < 0 || end <= start) return null;
      try {
        return JSON.parse(trimmed.slice(start, end + 1)) as Record<string, unknown>;
      } catch {
        return null;
      }
    }
  }

  private normalize(raw: Record<string, unknown> | null, input: InitiativeEvaluateInput): InitiativeDecision | null {
    if (!raw) return null;
    const mode = this.toMode(raw.mode);
    if (mode === null) return null;
    const kind = typeof raw.kind === "string" && raw.kind.trim() ? raw.kind.trim().slice(0, 40) : "general";
    const importance = this.toImportance(raw.importance);
    const rationale =
      typeof raw.rationale === "string" && raw.rationale.trim() ? raw.rationale.trim().slice(0, 200) : "";
    const messageHint =
      typeof raw.messageHint === "string" && raw.messageHint.trim() ? raw.messageHint.trim().slice(0, 300) : "";
    const actions = this.toActions(raw.actions);
    // 从未交互的用户绝不允许主动（防御 LLM 越权）
    if (input.lastInteractionAt == null) return null;
    if (mode === "act" && actions.length === 0) {
      // act 没有行动计划 → 降级 advise（还有话可说）或 none
      return messageHint
        ? { mode: "advise", kind, importance, rationale, messageHint, actions: [] }
        : { mode: "none", kind, importance, rationale, messageHint, actions: [] };
    }
    return { mode, kind, importance, rationale, messageHint, actions };
  }

  private toMode(value: unknown): InitiativeDecision["mode"] | null {
    if (value === "speak" || value === "act" || value === "advise" || value === "none") return value;
    return null;
  }

  private toImportance(value: unknown): InitiativeDecision["importance"] {
    return value === "high" || value === "low" ? value : "medium";
  }

  private toActions(value: unknown): InitiativeDecision["actions"] {
    if (!Array.isArray(value)) return [];
    const out: InitiativeDecision["actions"] = [];
    for (const item of value.slice(0, 5)) {
      if (!item || typeof item !== "object") continue;
      const rec = item as Record<string, unknown>;
      const tool = typeof rec.tool === "string" ? rec.tool.trim() : "";
      if (!tool) continue;
      const args =
        rec.args && typeof rec.args === "object" && !Array.isArray(rec.args)
          ? (rec.args as Record<string, unknown>)
          : {};
      out.push({ tool, args });
    }
    return out;
  }
}
