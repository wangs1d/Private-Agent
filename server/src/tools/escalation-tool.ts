// 车道内升级（in-trajectory escalation）：fast 对话脑的逃生舱工具。
//
// 设计背景：fast 车道是 maxRounds=1 + 轻量工具子集的有损模式，此前路由误判
// （需要搜索/写入/多步的任务落进 fast）只能靠 fast 人设提示词劝退模型——结果
// 是"口头答应不办事"或"凭印象编答案"。本工具把升级决策交给 fast 模型本身：
// 模型发现自己手头的轻量工具办不完全这件事时，直接调用本工具，服务端短路
// 工具循环并把整轮重放到 complex 执行脑。
//
// 与词法路由（task-router / llm-task-router）的关系：前置路由是"猜"，本工具
// 是"确认后的逃生舱"——猜错的轮次在轨迹内被纠正，不再静默失败。
// 注：工具描述中避免"执行脑/规划任务"等元术语——fast 模型若在回复文本里复读
// 这些术语会污染前端气泡（见 stripInternalControlTags 的元术语检测）。
import type { ChatCompletionTool } from "openai/resources/chat/completions";

export const ESCALATION_TOOL_NAME = "agent.escalate_to_complex";

/**
 * 升级哨兵：streamCompletionWithTools 检测到 escalate 调用后原样返回该字符串，
 * agent-core 的 fast 分支据此触发 complex 重放。选值保证与任何正常回复文本冲突。
 */
export const ESCALATION_SENTINEL = "\u0000__ESCALATE_TO_COMPLEX__\u0000";

/** 判断一轮 fast 输出是否为升级信号（供 agent-core fast 分支复用）。 */
export function isEscalationSignal(text: string | undefined | null): boolean {
  return text?.includes("__ESCALATE_TO_COMPLEX__") === true;
}

export const ESCALATE_TOOL_SCHEMA: ChatCompletionTool = {
  type: "function",
  function: {
    name: ESCALATION_TOOL_NAME,
    description: [
      "【任务升级】当前轮换由后台处理（把活儿交给后续环节来办）。",
      "你手头只有轻量工具（时间/只读日程/能力查询）。凡是要搜索或查实时信息（新闻/价格/某事近况/某人近况）、要写数据（创建/修改日程提醒、发消息、下单等）、要多步操作、或任何手头工具办不完全的事：",
      "不要口头答应，不要说「我去查/稍后告诉你」，也不要凭印象回答——立即调用本工具，转交后本轮无需再输出其他内容。",
      "纯闲聊、观点交流、以及时间/日期等单点轻查询不要调用本工具。",
    ].join(" "),
    parameters: {
      type: "object",
      properties: {
        reason: {
          type: "string",
          description: "一句话说明为什么要升级（如：需要联网搜索 / 需要创建提醒 / 多步任务）",
        },
      },
      required: [],
      additionalProperties: false,
    },
  },
};
