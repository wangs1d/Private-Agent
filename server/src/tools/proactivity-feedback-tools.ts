// 工具：proactivity.feedback —— 主动触达负反馈抑制（LLM 在对话中自主调用）
//
// Task 20 统一频控框架的「负反馈通道」：用户说「别再提醒我这个」「别给我推
// 刘浩存了」「天气预警太吵了」时，主对话 LLM 调本工具把抑制写入持久表
// （data/proactivity-suppression/{actorId}.json），ProactivityHub 后续发送前
// 检查抑制表，命中即放弃。用户改主意（「可以继续提醒我了」）用 action=remove
// 解除。
//
// 安全性：只写本地抑制 JSON，无外部副作用，add/remove 均可逆。
import type { ProactivitySuppressionStore } from "../proactivity/suppression-store.js";
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
