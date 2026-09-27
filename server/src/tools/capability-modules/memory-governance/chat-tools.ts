import type { ChatCompletionTool } from "openai/resources/chat/completions";

/**
 * 记忆治理能力 —— ChatCompletionTool schema。
 *
 * memory.forget：用户侧「定向遗忘」统一入口（对标 Muse forget 指令）。
 * 幂等、按关键词联动清除兴趣池/降价监控/承诺/计划/长期记忆五处可见台账。
 * activity.timeline：行为审计只读视图（对标 Muse 全量审计轨迹）。
 */
export const MEMORY_GOVERNANCE_CHAT_TOOLS: ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "memory.forget",
      description:
        "定向遗忘：用户明确要求忘掉/删除/不再关注某个具体人或事时调用" +
        "（如「把前公司的事忘了」「别再帮我盯着 XX 的价格了」「删除关于 XX 的记忆」）。" +
        "联动清除：兴趣关注、降价监控、相关承诺、相关计划、长期记忆条目（按关键词匹配，逐项报告清了什么）。" +
        "约束：仅在用户点名具体对象时调用，且调用前向用户复述要清的范围；" +
        "用户只是随口说「我忘了」/「忘了」不是遗忘指令，不要调用。",
      parameters: {
        type: "object",
        properties: {
          target: {
            type: "string",
            description: "要遗忘的对象关键词（人名/商品名/事项，2 字以上，如「前公司」「戴森吹风机」）",
          },
          scope: {
            type: "string",
            enum: ["auto", "interest", "watch", "commitment", "plan", "memory"],
            description:
              "清理范围：auto=全部台账联动（默认）；" +
              "interest=仅兴趣关注；watch=仅降价监控；commitment=仅承诺；plan=仅计划/盯梢目标；memory=仅长期记忆",
          },
          reason: { type: "string", description: "可选：用户给的原因（记录用）" },
        },
        required: ["target"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "activity.timeline",
      description:
        "行为审计时间线：你替用户办过的事、正在办/在盯的事、等用户确认的事，按时间倒序。" +
        "用户问「你最近都帮我干了什么」「你在忙什么」「有什么在等我确认」「你都做了哪些事」时调用，" +
        "以返回的真实台账回答，不要凭印象编造。",
      parameters: {
        type: "object",
        properties: {
          limit: { type: "number", description: "可选返回条数上限（默认 30，最大 60）" },
        },
        additionalProperties: false,
      },
    },
  },
];
