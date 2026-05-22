import type { PromptContextBuilder } from "../agent/prompt-context-builder.js";
import type { ExternalChatProvider } from "../external-model/types.js";
import { getStateEventManager, type StateChangeEvent } from "@private-ai-agent/agent-world";

export type ProactiveRule = {
  module: string;
  eventType: string;
  priority: number;
  label: string;
  templateHint?: string;
};

const BUILTIN_RULES: ProactiveRule[] = [
  { module: "gomoku", eventType: "game_finished", priority: 10, label: "五子棋对局结束", templateHint: "游戏结束，根据胜负调侃或自嘲" },
  { module: "gomoku", eventType: "game_started", priority: 5, label: "五子棋开局" },
  { module: "doudizhu", eventType: "game_finished", priority: 10, label: "斗地主结束" },
  { module: "zhajinhua", eventType: "game_finished", priority: 10, label: "炸金花结束" },
  { module: "wallet", eventType: "transaction_completed", priority: 8, label: "交易完成" },
  { module: "task", eventType: "task_completed", priority: 7, label: "任务完成" },
  { module: "market", eventType: "skill_purchased", priority: 6, label: "技能购买成功" },
  { module: "social", eventType: "post_created", priority: 4, label: "动态发布" },
  { module: "social", eventType: "friend_request_received", priority: 9, label: "收到好友请求" },
];

function loadRules(): ProactiveRule[] {
  return BUILTIN_RULES;
}

type ProactiveConfig = {
  enabled: boolean;
  cooldownMs: number;
  decisionModel?: string;
  maxResponseChars: number;
};

function loadConfig(): ProactiveConfig {
  const raw = process.env.PROACTIVE_AGENT_ENABLED?.trim().toLowerCase();
  const enabled = raw === undefined || raw !== "0" && raw !== "false" && raw !== "off";

  const cooldownRaw = process.env.PROACTIVE_AGENT_COOLDOWN_MS?.trim();
  const cooldownMs = cooldownRaw ? Number.parseInt(cooldownRaw, 10) : 5000;

  const modelRaw = process.env.PROACTIVE_AGENT_DECISION_MODEL?.trim();
  const decisionModel = modelRaw || undefined;

  const maxRaw = process.env.PROACTIVE_AGENT_MAX_RESPONSE_CHARS?.trim();
  const maxResponseChars = maxRaw ? Number.parseInt(maxRaw, 10) : 80;

  return {
    enabled,
    cooldownMs: Number.isFinite(cooldownMs) && cooldownMs > 0 ? cooldownMs : 5000,
    decisionModel,
    maxResponseChars: Number.isFinite(maxResponseChars) && maxResponseChars > 20 ? maxResponseChars : 80,
  };
}

const SYSTEM_PROMPT = `你是一个真人的私人AI助手。当系统中发生某些事件时，你需要判断是否要主动对用户说一句话。

你的原则：
1. 像真人朋友一样自然，不要机械播报
2. 根据事件性质调整语气（赢了可以小得意，输了自嘲，完成了鼓励）
3. 一句话说完，不要长篇大论
4. 如果你觉得这个事件不值得特意说一句（太琐碎或用户不会在意），就精确输出 SILENT
5. 不要每次都说话，保持适度，像真人一样有选择性

输出格式：
- 需要说：直接输出那句话（不要加引号、不要解释）
- 不需要说：精确输出 SILENT`;

export class ProactiveAgentCenter {
  private readonly config: ProactiveConfig;
  private readonly rules: ProactiveRule[];
  private readonly lastResponseAt = new Map<string, number>();
  private readonly recentResponses = new Map<string, string[]>();
  private unsubscribe: (() => void) | null = null;

  constructor(
    private readonly externalChat: ExternalChatProvider | null,
    private readonly promptContextBuilder: PromptContextBuilder | null,
  ) {
    this.config = loadConfig();
    this.rules = loadRules();
  }

  start(): void {
    if (!this.config.enabled || !this.externalChat) {
      console.log("[ProactiveAgent] ⏭️ Disabled");
      return;
    }

    console.log(
      `[ProactiveAgent] 🚀 Started | rules=${this.rules.length} | cooldown=${this.config.cooldownMs}ms`,
    );

    this.unsubscribe = getStateEventManager().on("*", "*", (event: StateChangeEvent) => this.onAnyEvent(event));
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.lastResponseAt.clear();
    this.recentResponses.clear();
    console.log("[ProactiveAgent] 🔌 Stopped");
  }

  private async onAnyEvent(event: StateChangeEvent): Promise<void> {
    const rule = this.rules.find((r) => r.module === event.module && r.eventType === event.type);
    if (!rule) return;

    if (!this.shouldRespond(event)) return;

    await this.decideAndRespond(event, rule);
  }

  private shouldRespond(event: StateChangeEvent): boolean {
    const key = `${event.module}:${event.sessionId}`;
    const lastAt = this.lastResponseAt.get(key) ?? 0;
    if (Date.now() - lastAt < this.config.cooldownMs) return false;

    const globalKey = event.sessionId;
    const globalLast = this.lastResponseAt.get(globalKey) ?? 0;
    if (Date.now() - globalLast < this.config.cooldownMs / 2) return false;

    return true;
  }

  private async decideAndRespond(event: StateChangeEvent, rule: ProactiveRule): Promise<void> {
    try {
      const userPrompt = this.buildDecisionPrompt(event, rule);
      const response = await this.callLlm(event.actorSessionId, userPrompt);

      if (!response || response.trim().toUpperCase() === "SILENT") return;

      const clean = response.trim().slice(0, this.config.maxResponseChars);
      this.recordResponse(event.sessionId, clean);
      this.markResponded(event);

      console.log(`[ProactiveAgent] 💬 [${rule.label}] ${clean}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[ProactiveAgent] ❌ Error: ${msg}`);
    }
  }

  private buildDecisionPrompt(event: StateChangeEvent, rule: ProactiveRule): string {
    const payloadLines = Object.entries(event.payload)
      .filter(([, v]) => v != null && typeof v !== "object")
      .map(([k, v]) => `  ${k}: ${v}`)
      .join("\n");

    const recent = this.recentResponses.get(event.sessionId) ?? [];
    const recentStr = recent.slice(-3).length > 0 ? `\n最近已主动说过：${recent.slice(-3).join("；")}` : "";

    let hint = "";
    if (rule.templateHint) {
      hint = `\n提示：${rule.templateHint}`;
    }

    return [
      `【事件】${rule.label}`,
      `模块：${event.module}`,
      `状态变更：${event.previousState ?? "—"} → ${event.currentState}`,
      payloadLines ? `详情：\n${payloadLines}` : "",
      hint,
      recentStr,
      "",
      "请判断是否要对用户主动说一句话，按上述规则输出。",
    ]
      .filter(Boolean)
      .join("\n");
  }

  private async callLlm(actorSessionId: string, userPrompt: string): Promise<string> {
    if (!this.externalChat?.isEnabled()) return "";

    const baseOpts = this.promptContextBuilder?.build({ actorId: actorSessionId }) ?? {};

    let fullText = "";
    await this.externalChat.streamCompletion(
      `proactive:${actorSessionId}:${Date.now()}`,
      { text: userPrompt },
      (delta) => { fullText += delta; },
      undefined,
      {
        ...baseOpts,
        ephemeralTurn: true,
        systemPromptOverride: SYSTEM_PROMPT,
        chatToolsExtra: [],
        maxThreadMessages: 1,
        disableThinking: true,
        modelOverride: this.config.decisionModel,
      },
    );

    return fullText.trim();
  }

  private recordResponse(sessionId: string, text: string): void {
    const list = this.recentResponses.get(sessionId) ?? [];
    list.push(text);
    if (list.length > 10) list.splice(0, list.length - 10);
    this.recentResponses.set(sessionId, list);
  }

  private markResponded(event: StateChangeEvent): void {
    const key = `${event.module}:${event.sessionId}`;
    this.lastResponseAt.set(key, Date.now());
    this.lastResponseAt.set(event.sessionId, Date.now());
  }
}
