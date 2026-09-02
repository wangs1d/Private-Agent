// 车道内升级（in-trajectory escalation）：fast 对话脑的逃生舱工具。
//
// 设计背景：fast 车道曾是 maxRounds=1 + 轻量工具子集的有损模式，路由误判
// （需要搜索/写入/多步的任务落进 fast）只能靠 fast 人设提示词劝退模型——结果
// 是"口头答应不办事"或"凭印象编答案"。本工具把升级决策交给 fast 模型本身：
// 模型发现手头工具办不完全这件事时，直接调用本工具，服务端短路工具循环并把
// 整轮重放到 complex 执行脑。
//
// 2026-08-31 调整：fast 已直接携带 search_web/fetch_web 等联网工具（搜索链路
// 服务端固定为 AnySearch 优先、必应/百度等多引擎兜底，见 search-api-provider.ts
// 与 domestic-web-providers.ts 的 searchWebMultiEngine）。查实时信息不再走升级，
// 模型先自己调 search_web 作答；本工具退居"写数据/多步操作/搜索办不完全"的
// 逃生舱。工具描述必须与该分工一致，避免两套 schema 描述打架导致模型两头都不调。
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

/** fast 轮已尝试的工具调用记录（升级继承负载，2026-09-02）。 */
export type EscalationToolAttempt = {
  tool: string;
  ok: boolean;
  /** 关键入参摘要（query/url 等，截断） */
  input?: string;
  /** 结果/错误摘要（截断） */
  detail?: string;
};

/**
 * 构造升级哨兵。attempts 非空时把 fast 轮已尝试的工具调用序列化进哨兵尾部，
 * agent-core 重放 complex 时解析并注入【上游尝试记录】块——complex 首波带着
 * 部分成果续办（换关键词/换工具），而不是从头盲搜。
 * 负载用行分隔符与哨兵本体隔开，isEscalationSignal 的 includes 判定不受影响。
 */
export function buildEscalationSentinel(attempts?: EscalationToolAttempt[]): string {
  if (!attempts || attempts.length === 0) return ESCALATION_SENTINEL;
  try {
    return `${ESCALATION_SENTINEL}${JSON.stringify({ attempts })}`;
  } catch {
    return ESCALATION_SENTINEL;
  }
}

/** 从一轮输出中解析升级信号及其携带的工具尝试记录（无升级信号 → null）。 */
export function parseEscalationPayload(
  text: string | undefined | null,
): { escalate: true; attempts: EscalationToolAttempt[] } | null {
  if (!isEscalationSignal(text)) return null;
  const t = text ?? "";
  const marker = t.indexOf("__ESCALATE_TO_COMPLEX__");
  // 哨兵本体以 \u0000 结尾，负载紧跟其后：剥离尾部 NUL/空白后再 JSON.parse
  const tail = t
    .slice(marker + "__ESCALATE_TO_COMPLEX__".length)
    .replace(/^[\u0000\s]+/, "")
    .trim();
  if (!tail) return { escalate: true, attempts: [] };
  try {
    const parsed = JSON.parse(tail) as { attempts?: EscalationToolAttempt[] };
    return { escalate: true, attempts: Array.isArray(parsed.attempts) ? parsed.attempts : [] };
  } catch {
    return { escalate: true, attempts: [] };
  }
}

/** 把工具尝试记录格式化为可注入 prompt 的紧凑文本块（升级继承，agent-core 消费）。 */
export function formatEscalationAttempts(attempts: EscalationToolAttempt[]): string {
  return attempts
    .map((a, i) => {
      const input = a.input ? `(${a.input})` : "";
      const detail = a.detail ? `：${a.detail}` : "";
      return `${i + 1}. ${a.tool}${input} → ${a.ok ? "执行成功但未满足诉求" : "执行失败"}${detail}`;
    })
    .join("\n");
}

/** 判断一轮 fast 输出是否为升级信号（供 agent-core fast 分支复用）。 */
export function isEscalationSignal(text: string | undefined | null): boolean {
  return text?.includes("__ESCALATE_TO_COMPLEX__") === true;
}

export const ESCALATE_TOOL_SCHEMA: ChatCompletionTool = {
  type: "function",
  function: {
    name: ESCALATION_TOOL_NAME,
    description: [
      "【任务升级】把当前这件事转交后台处理（调用后本轮无需再输出其他内容）。",
      "你手头已有联网搜索工具（search_web/fetch_web，链路优先 AnySearch 检索源、多引擎自动兜底）：要查实时信息（新闻/某人近况/价格/热搜/比分等）必须先自己调 search_web 搜真实结果再回答，这类需求禁止用本工具升级、也不要凭印象说「没掌握/没更新到」。",
      "只有以下情况才调用本工具：要写数据（创建/修改日程提醒、发消息、下单等有副作用的操作）、要多步操作、或搜索办不完全（需要多来源核实/深度研究/继续抓取网页深读）。",
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
