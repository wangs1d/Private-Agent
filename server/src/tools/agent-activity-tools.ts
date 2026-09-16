// 工具：activity.report —— 代办足迹执行类上报（LLM 在对话中办完代办后自主调用）
//
// 定位（见 proactivity/activity-store.ts 头注释）：代办足迹台账区分两类条目——
//   告知类（盯梢信号，delivery 层自动落库，statusLabel=「已告知」）与
//   执行类（Agent 真正替用户办的事，本工具上报）。
// 典型场景：盯梢告知「会议改期」后用户在对话中说「帮我改一下/订个牛奶」，
// Agent 执行完（改日程/下单/缴费）后调本工具落一条执行类条目——与告知类条目
// 共同构成「盯到 → 办完」的可回溯弧线。
//
// 幂等：入参 dedupKey 与台账 24h 去重窗口对齐；同一件事重试重报不会刷屏。
// 安全性：只写本地台账 JSON，无外部副作用。
import type { ChatCompletionTool } from "openai/resources/chat/completions";
import { resolveActorId } from "../agent/actor-id.js";
import type { ToolRegistry } from "./tool-registry.js";
import type {
  AgentActivityStatus,
  AgentActivityStore,
} from "../proactivity/activity-store.js";

const REPORT_CATEGORIES = [
  "purchase",
  "payment",
  "schedule",
  "booking",
  "message",
  "generic",
] as const;

/** activity.report 的 LLM 工具声明（并入 getBuiltinAgentChatTools） */
export const AGENT_ACTIVITY_CHAT_TOOLS: ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "activity.report",
      description: [
        "代办足迹上报：你替用户办完或正在办一件事后调用，把结果写入右侧面板「代办足迹」台账，",
        "让用户稍后可回溯（订牛奶/缴水电费/改日程/代订餐厅/代发消息…）。",
        "时机：动作真正执行成功（或已确定进入某个状态，如商家已接单）后调用一次；",
        "不要把「我打算做」或纯告知（盯消息、提醒）报进来——纯告知由系统自动落库。",
        "用户问「你都帮我办过什么」时也不要调本工具，直接口述即可。",
      ].join(" "),
      parameters: {
        type: "object",
        properties: {
          category: {
            type: "string",
            enum: [...REPORT_CATEGORIES],
            description:
              "动作类别（决定足迹卡图标）：purchase 购物代订 / payment 缴费充值 / schedule 日程调整 / booking 预约订位 / message 代发消息 / generic 其他",
          },
          title: {
            type: "string",
            description: "一句话结果标题，站在用户视角（如「已为你订购牛奶」「已把评审会改到16:00」）",
          },
          summary: {
            type: "string",
            description: "结果补充说明（做了什么、结果如何），1-2 句",
          },
          status: {
            type: "string",
            enum: ["pending", "done", "failed", "changed"],
            description:
              "执行状态：pending 进行中（如下单待配送）/ done 已完成 / failed 未办成 / changed 已调整；缺省 done",
          },
          statusLabel: {
            type: "string",
            description: "可选自定义状态文案（如「配送中」「已改期」「排队中」），缺省按 status 推导",
          },
          detail: {
            type: "object",
            additionalProperties: { type: "string" },
            description:
              "结构化关键字段（键值对），用户点开足迹详情时展示：商品/金额/商家/新时间/单号等。值必须是字符串",
          },
          dedupKey: {
            type: "string",
            description:
              "可选幂等键（同一件事重试重报只落一条），如 `buy-milk:20260916`；不确定时留空",
          },
        },
        required: ["category", "title", "summary"],
        additionalProperties: false,
      },
    },
  },
];

const VALID_STATUSES = new Set<string>(["pending", "done", "failed", "changed"]);

/**
 * 注册代办足迹上报工具。
 * @param toolRegistry 统一工具注册中心
 * @param activityStore 代办足迹台账（装配层注入）
 */
export function registerAgentActivityTools(
  toolRegistry: ToolRegistry,
  activityStore: AgentActivityStore,
): void {
  toolRegistry.register("activity.report", async (input, context) => {
    const actorId = resolveActorId(context);
    const category = String(input.category ?? "generic").trim() || "generic";
    const title = String(input.title ?? "").trim();
    const summary = String(input.summary ?? "").trim();
    if (!title || !summary) {
      return { ok: false, error: "title 与 summary 必填" };
    }
    const statusRaw = input.status === undefined ? undefined : String(input.status);
    const status =
      statusRaw && VALID_STATUSES.has(statusRaw) ? (statusRaw as AgentActivityStatus) : undefined;
    if (statusRaw && !status) {
      return { ok: false, error: `status 非法：${statusRaw}` };
    }

    const detail: Record<string, string> = {};
    if (input.detail && typeof input.detail === "object" && !Array.isArray(input.detail)) {
      for (const [k, v] of Object.entries(input.detail as Record<string, unknown>)) {
        const value = String(v ?? "").trim();
        if (k.trim() && value) detail[k.trim().slice(0, 40)] = value.slice(0, 200);
      }
    }

    const activity = activityStore.record({
      actorId,
      kind: `action.${category}`,
      title: title.slice(0, 120),
      summary: summary.slice(0, 500),
      status,
      statusLabel: input.statusLabel === undefined ? undefined : String(input.statusLabel).slice(0, 40),
      detail,
      dedupKey: input.dedupKey === undefined ? undefined : String(input.dedupKey).slice(0, 200),
    });
    if (!activity) {
      return { ok: true, deduped: true, message: "同一 dedupKey 24 小时内已上报过，未重复落账" };
    }
    return { ok: true, activityId: activity.id, category: activity.category };
  });
}
