// 工具：proactivity.feedback —— 主动触达负反馈抑制（LLM 在对话中自主调用）
//
// Task 20 统一频控框架的「负反馈通道」：用户说「别再提醒我这个」「别给我推
// 刘浩存了」「天气预警太吵了」时，主对话 LLM 调本工具把抑制写入持久表
// （data/proactivity-suppression/{actorId}.json），ProactivityHub 后续发送前
// 检查抑制表，命中即放弃。用户改主意（「可以继续提醒我了」）用 action=remove
// 解除。
//
// 工具：proactivity.confirmAction —— act 三分支 ask_first 的确认闭环（方案 C）。
// agent 发出「需要确认：…」后，用户在对话中回复「可以/不行」，LLM 调本工具
// approve/reject 推进挂起的行动计划。
//
// 工具：proactivity.whySilent —— 沉默决策反问（方案 B）。用户问「你上周为什么
// 没提醒我 XX」时检索沉默日志，给出当时的效用评估依据。
//
// 安全性：只写本地抑制 JSON，无外部副作用，add/remove 均可逆。
import type { ProactivitySuppressionStore } from "../proactivity/suppression-store.js";
import type { PendingActionConfirmation } from "../proactivity/proactivity-hub.js";
import type { SilenceLogEntry } from "../proactivity/silence-log.js";
import { resolveActorId } from "../agent/actor-id.js";
import type { ToolRegistry } from "./tool-registry.js";
import type { ChatCompletionTool } from "openai/resources/chat/completions";

/**
 * proactivity.feedback 的 LLM 工具声明（并入 getBuiltinAgentChatTools）。
 * 让模型在对话中看到完整的描述与参数；执行体在 registerProactivityFeedbackTools。
 */
export const PROACTIVITY_FEEDBACK_CHAT_TOOLS: ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "proactivity.feedback",
      description: [
        "主动触达负反馈管理（用户对提醒/推送说『别再发了』时使用）。",
        "当用户明确表达不想再收到某类主动提醒或推送时（如「别再提醒我这个」「别给我推XX的动态了」「天气预警别发了」「太烦了别打扰我」），",
        "调本工具 action=suppress 写入持久抑制：kind 填触达类别（interest_alert 兴趣推送/weather_alert 天气预警/life_reminder 生活提醒/monthly_report 月报/greeting 问候等），",
        "keywords 填要抑制的具体对象（如「刘浩存」；留空=抑制整个 kind）。",
        "用户改主意想恢复提醒时用 action=remove（target 填之前抑制的 kind 或对象名）；action=list 查看当前抑制列表。",
      ].join(" "),
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["suppress", "remove", "list"],
            description: "操作类型：suppress 新增抑制、remove 解除抑制、list 查看当前抑制列表",
          },
          kind: {
            type: "string",
            description:
              "要抑制的触达类别：interest_alert（兴趣热议推送）/ weather_alert（天气预警）/ life_reminder（生活提醒）/ monthly_report（月度报告）/ greeting（问候）等；action=suppress 必填",
          },
          keywords: {
            type: "array",
            items: { type: "string" },
            description:
              "抑制的具体对象关键词（如 [\"刘浩存\"]）；留空则抑制整个 kind。action=remove 时也可传对象名作为 target",
          },
          note: {
            type: "string",
            description: "用户原话摘要（如「用户说别再推刘浩存了」），审计用",
          },
          target: {
            type: "string",
            description: "action=remove 时要解除的抑制对象（之前抑制的 kind 名或关键词）",
          },
        },
        required: ["action"],
        additionalProperties: false,
      },
    },
  },
];

/**
 * 注册主动触达负反馈工具。
 * @param toolRegistry 统一工具注册中心
 * @param store ProactivitySuppressionStore 实例（装配层注入）
 */
export function registerProactivityFeedbackTools(
  toolRegistry: ToolRegistry,
  store: ProactivitySuppressionStore,
): void {
  toolRegistry.register(
    "proactivity.feedback",
    async (input, context) => {
      const action = String(input?.action ?? "").trim().toLowerCase();
      const actorId = resolveActorId(context);
      const kind = input?.kind;
      const keywords = input?.keywords;
      const note = input?.note;
      const target = input?.target;

      try {
        switch (action) {
          case "suppress": {
            if (!kind) {
              return { ok: false, error: "action=suppress 需要提供 kind（要抑制的触达类别）" };
            }
            const list = await store.add(actorId, String(kind), keywords, note);
            const kw = Array.isArray(keywords) && keywords.length > 0
              ? `（关键词：${keywords.map(String).join("、")}）`
              : "（整个类别）";
            return {
              ok: true,
              message: `已记录：不再主动推送「${String(kind)}」类内容${kw}。`,
              count: list.length,
              suppressions: list.map(summarize),
            };
          }
          case "remove": {
            const t = target ?? (Array.isArray(keywords) ? keywords[0] : undefined);
            if (!t) {
              return { ok: false, error: "action=remove 需要提供 target（之前抑制的 kind 或对象名）" };
            }
            const list = await store.remove(actorId, t);
            return {
              ok: true,
              message: `已解除对「${String(t)}」的抑制，相关提醒恢复正常。`,
              count: list.length,
              suppressions: list.map(summarize),
            };
          }
          case "list": {
            const list = store.list(actorId);
            return {
              ok: true,
              message: list.length
                ? `当前共 ${list.length} 条抑制记录。`
                : "当前没有任何抑制记录，所有主动提醒类别均正常。",
              count: list.length,
              suppressions: list.map(summarize),
            };
          }
          default:
            return {
              ok: false,
              error:
                `未知 action「${action || "(空)"}」。` +
                `可选：suppress（新增抑制）/ remove（解除抑制）/ list（查看）。`,
            };
        }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
    {
      category: "life",
      sideEffect: "none",
      riskLevel: "low",
    },
  );

  function summarize(e: { kind: string; keywords: string[]; note?: string; createdAt: string }) {
    return {
      kind: e.kind,
      keywords: e.keywords,
      note: e.note,
      createdAt: e.createdAt,
    };
  }
}

// ============================================================
// act 三分支确认闭环（方案 C）+ 沉默反问（方案 B）
// ============================================================

/** hub 侧最小接口（装配层注入 ProactivityHub 实例，避免工具层依赖装配细节） */
export interface ProactivityHubToolFacade {
  listPendingConfirmations(actorId: string): PendingActionConfirmation[];
  resolveConfirmation(
    actorId: string,
    approved: boolean,
    confirmId?: string,
  ): Promise<{ ok: boolean; executed: boolean; confirmId?: string; error?: string }>;
  searchSilences(opts: {
    actorId?: string;
    keyword?: string;
    sinceMs?: number;
    kind?: string;
    limit?: number;
  }): SilenceLogEntry[];
}

/** proactivity.confirmAction / proactivity.whySilent 的 LLM 工具声明 */
export const PROACTIVITY_CONFIRM_CHAT_TOOLS: ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "proactivity.confirmAction",
      description: [
        "推进之前发出「需要确认：…」的挂起行动计划（ask_first 确认闭环）。",
        "当你此前主动询问用户是否执行某行动（如发消息、下单、代催促），用户在对话中给出肯定/否定答复时调用：",
        "approved=true（用户说「可以/行/做吧」）或 approved=false（用户说「不用了/别做」）；confirmId 省略时自动取最近一条待确认。",
        "action=list 可查看当前所有待确认计划。",
      ].join(" "),
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["resolve", "list"],
            description: "resolve=推进确认（需 approved），list=查看待确认列表",
          },
          approved: {
            type: "boolean",
            description: "action=resolve 时必填：用户是否同意执行",
          },
          confirmId: {
            type: "string",
            description: "要推进的确认 ID（省略=最近一条待确认）",
          },
        },
        required: ["action"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "proactivity.whySilent",
      description: [
        "检索主动性系统的沉默决策日志：用户问「你为什么没提醒我 XX」「上次为什么不直接做」时调用。",
        "返回效用评估后主动选择不动作的记录（净效用/风险分/命中规则），据此向用户解释当时的判断依据。",
        "keyword 填用户提到的对象（如「体检」「刘浩存」），days 填回溯天数（默认 7）。",
      ].join(" "),
      parameters: {
        type: "object",
        properties: {
          keyword: { type: "string", description: "检索关键词（匹配类别/标题/原因）" },
          days: { type: "number", description: "回溯天数（默认 7，最大 90）" },
          kind: { type: "string", description: "可选：限定触达类别" },
        },
        additionalProperties: false,
      },
    },
  },
];

/**
 * 注册 act 确认闭环与沉默反问工具。
 * @param toolRegistry 统一工具注册中心
 * @param hub ProactivityHub 的工具面（装配层注入）
 */
export function registerProactivityConfirmTools(
  toolRegistry: ToolRegistry,
  hub: ProactivityHubToolFacade,
): void {
  toolRegistry.register(
    "proactivity.confirmAction",
    async (input, context) => {
      const action = String(input?.action ?? "").trim().toLowerCase();
      const actorId = resolveActorId(context);
      try {
        if (action === "list") {
          const list = hub.listPendingConfirmations(actorId);
          return {
            ok: true,
            message: list.length
              ? `当前有 ${list.length} 条待确认行动计划。`
              : "当前没有待确认的行动计划。",
            pending: list.map((c) => ({
              confirmId: c.confirmId,
              kind: c.kind,
              rationale: c.rationale,
              steps: c.steps.map((s) => s.tool),
              expiresAt: new Date(c.expiresAt).toISOString(),
            })),
          };
        }
        if (action === "resolve") {
          const approved = input?.approved === true;
          if (typeof input?.approved !== "boolean") {
            return { ok: false, error: "action=resolve 需要布尔 approved（用户是否同意）" };
          }
          const confirmId = input?.confirmId ? String(input.confirmId) : undefined;
          const result = await hub.resolveConfirmation(actorId, approved, confirmId);
          if (!result.ok) return { ok: false, error: result.error ?? "没有待确认的行动计划" };
          return {
            ok: true,
            message: approved
              ? `已执行确认 ${result.confirmId} 的行动计划。`
              : `已取消确认 ${result.confirmId} 的行动计划（不执行）。`,
            executed: result.executed,
            confirmId: result.confirmId,
          };
        }
        return { ok: false, error: `未知 action「${action}」。可选：resolve / list。` };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
    { category: "life", sideEffect: "none", riskLevel: "low" },
  );

  toolRegistry.register(
    "proactivity.whySilent",
    async (input, context) => {
      const actorId = resolveActorId(context);
      const days = Math.max(1, Math.min(90, Number(input?.days) > 0 ? Number(input.days) : 7));
      const keyword = input?.keyword ? String(input.keyword) : undefined;
      const kind = input?.kind ? String(input.kind) : undefined;
      try {
        const entries = hub.searchSilences({
          actorId,
          keyword,
          kind,
          sinceMs: Date.now() - days * 24 * 60 * 60 * 1000,
          limit: 10,
        });
        return {
          ok: true,
          message: entries.length
            ? `最近 ${days} 天命中 ${entries.length} 条沉默决策（keyword=${keyword ?? "-"}）。`
            : `最近 ${days} 天没有命中「${keyword ?? kind ?? "-"}」的沉默决策记录。`,
          silences: entries.map((e) => ({
            at: new Date(e.at).toISOString(),
            kind: e.kind,
            title: e.title,
            scope: e.scope,
            netUtility: e.netUtility,
            riskScore: e.riskScore,
            valueScore: e.valueScore,
            reason: e.reason,
          })),
        };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
    { category: "life", sideEffect: "none", riskLevel: "low" },
  );
}
