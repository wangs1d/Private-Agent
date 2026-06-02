import type OpenAI from "openai";
import type {
  ChatCompletionMessageParam,
  ChatCompletionMessageToolCall,
  ChatCompletionTool,
} from "openai/resources/chat/completions";

import { AGENT_WORLD_CHAT_TOOLS } from "@private-ai-agent/agent-world";
import { AIP_CHAT_TOOLS } from "../aip/aip-chat-completion-tools.js";
import { getDesktopVisualChatTools } from "../tools/desktop-visual-chat-tools.js";
import { EMBODIMENT_CHAT_TOOLS } from "../tools/embodiment-tools.js";
import { SMART_HOME_CHAT_TOOLS } from "../tools/smart-home-tools.js";
import { SELF_PROGRAMMING_CHAT_TOOLS } from "../tools/self-programming-chat-tools.js";
import { openAiUserContentFromTurn } from "./build-user-message-content.js";
import { getAgentRuntimeConfig } from "../agent/agent-runtime-config.js";
import {
  MASTER_INVOKE_SUB_AGENT_REGISTRY,
  MASTER_POLL_SUB_AGENT_TASKS_REGISTRY,
} from "../agent/master-subagent-delegate-tools.js";
import { compactToolOutputForLlm } from "../tokenjuice/compactor.js";
import {
  executeToolSearchBridge,
  isToolSearchBridgeName,
  prepareToolsWithToolSearch,
} from "../tools/tool-search/index.js";
import {
  isAssistantWithToolCalls,
  isToolCallIdNotFoundError,
  sanitizeChatMessagesForApi,
} from "./chat-thread-sanitize.js";
import type {
  ChatToolExecutionContext,
  StreamDeltaHandler,
  ToolLoopAfterBatchInfo,
  VisionFrame,
} from "./types.js";

const TOOL_RESULT_VISION_INJECT_KEY = "_injectVisionUserMessage";

type ToolAcc = { id: string; name: string; arguments: string };

const DEFAULT_MAX_ROUNDS = 12;

function resolveToolExecutionTimeoutMs(registryToolName: string): number {
  const fallback = Number.parseInt(process.env.TOOL_EXECUTION_TIMEOUT_MS ?? "30000", 10);
  const defaultMs = Number.isFinite(fallback) && fallback > 0 ? fallback : 30_000;
  if (registryToolName === MASTER_INVOKE_SUB_AGENT_REGISTRY) {
    const rt = getAgentRuntimeConfig().masterDelegation;
    return (
      Math.max(
        rt.subtaskTimeoutMs,
        rt.techSubtaskTimeoutMs,
        rt.infoSubtaskTimeoutMs,
      ) + 5_000
    );
  }
  if (registryToolName === MASTER_POLL_SUB_AGENT_TASKS_REGISTRY) {
    return Math.max(defaultMs, 10_000);
  }
  return defaultMs;
}

/**
 * 动态工具轮次配置：基于任务复杂度自动调整最大工具调用轮次
 * 预期效果：简单任务总耗时 -30%，复杂任务保持完整能力
 */
interface TaskComplexityConfig {
  maxRounds: number;
  description: string;
}

function analyzeTaskComplexity(userText: string, messageCount: number): TaskComplexityConfig {
  const textLength = userText.length;
  const hasMultipleQuestions = (userText.match(/[？?。]/g) || []).length > 2;
  const hasComplexKeywords = ['分析', 'analyze', '比较', 'compare', '总结', 'summarize', '优化', 'optimize', '设计', 'design', '实现', 'implement']
    .some(kw => userText.toLowerCase().includes(kw));
  const isLongContext = messageCount > 8;
  
  let complexityScore = 0;
  
  // 文本长度评分 (0-3)
  if (textLength > 500) complexityScore += 3;
  else if (textLength > 200) complexityScore += 2;
  else if (textLength > 50) complexityScore += 1;
  
  // 问题数量评分 (0-2)
  if (hasMultipleQuestions) complexityScore += 2;
  
  // 关键词评分 (0-2)
  if (hasComplexKeywords) complexityScore += 2;
  
  // 上下文长度评分 (0-2)
  if (isLongContext) complexityScore += 2;
  else if (messageCount > 4) complexityScore += 1;
  
  // 根据分数返回配置
  if (complexityScore <= 2) {
    return { 
      maxRounds: Math.max(2, parseInt(process.env.TOOL_LOOP_MIN_ROOUNDS ?? '3')), 
      description: '简单任务' 
    };
  } else if (complexityScore <= 5) {
    return { 
      maxRounds: parseInt(process.env.TOOL_LOOP_MEDIUM_ROOUNDS ?? '6'), 
      description: '中等任务' 
    };
  } else if (complexityScore <= 7) {
    return { 
      maxRounds: parseInt(process.env.TOOL_LOOP_COMPLEX_ROOUNDS ?? '9'), 
      description: '复杂任务' 
    };
  } else {
    return { 
      maxRounds: DEFAULT_MAX_ROUNDS, 
      description: '高度复杂任务' 
    };
  }
}

export function getOptimalMaxRounds(userText: string, messageCount: number): number {
  const config = analyzeTaskComplexity(userText, messageCount);
  return config.maxRounds;
}

/**
 * 清理消息数组中的孤立 tool 消息（tool_call_id 不匹配任何 assistant 消息的 tool_calls）。
 * 同时清理有 tool_calls 但缺少对应 tool 结果的孤立 assistant 消息。
 * 防止 Kimi/Moonshot 等 API 返回 "tool_call_id is not found" 错误。
 */
/** Moonshot `extra_body.thinking.type === "disabled"` 时须从历史消息中剥离 reasoning_content。 */
export function isThinkingDisabled(extraBody?: Record<string, unknown>): boolean {
  const thinking = extraBody?.thinking as { type?: string } | undefined;
  return thinking?.type === "disabled";
}

function repairMessagesAfterToolCallIdError(
  messages: ChatCompletionMessageParam[],
  stripReasoning: boolean,
): ChatCompletionMessageParam[] {
  const before = messages.length;
  const repaired = sanitizeChatMessagesForApi(messages, {
    stripReasoning,
    logPrefix: "[openai-tool-loop-repair]",
  });
  messages.length = 0;
  messages.push(...repaired);
  if (repaired.length !== before) {
    console.warn(
      `[openai-tool-loop] Repaired message history after tool_call_id error: ` +
      `${before} → ${repaired.length} messages`,
    );
  }
  return repaired;
}

/** Moonshot Kimi 等端点仅允许字母数字下划线连字符，将 registry 名 `a.b` 映射为 `a_b`。 */
function registryNameToApiToolName(name: string): string {
  return name.replace(/\./g, "_");
}

function prepareToolsForChatApi(tools: ChatCompletionTool[]): {
  apiTools: ChatCompletionTool[];
  resolveRegistryToolName: (apiName: string) => string;
} {
  const apiToRegistry = new Map<string, string>();
  const apiTools = tools.map((tool) => {
    if (tool.type !== "function" || !tool.function?.name) return tool;
    const registryName = tool.function.name;
    const apiName = registryNameToApiToolName(registryName);
    apiToRegistry.set(apiName, registryName);
    return {
      ...tool,
      function: {
        ...tool.function,
        name: apiName,
      },
    };
  });
  return {
    apiTools,
    resolveRegistryToolName: (apiName) => apiToRegistry.get(apiName) ?? apiName,
  };
}

const INFO_WEB_CHAT_TOOLS: ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "search_web",
      description:
        "联网搜索公开网页信息（按发布时间从新到旧，默认剔除超过约 120 天的旧条目）。query 请简短（2-6 个核心词），时效话题请加当前年月或「最新」，如「科技新闻 2026年5月 最新」「兴义 梦乐城 电影 热映」。",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string" },
          limit: { type: "integer", description: "返回数量，1-20，默认 8" },
        },
        required: ["query"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "fetch_web",
      description: "读取指定网页正文并返回标题、摘要与纯文本内容。",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string" },
        },
        required: ["url"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "info.inspect_webpage",
      description: "巡检网页：返回标题、摘要、内容预览、主要链接和同域链接，便于继续导航。",
      parameters: {
        type: "object",
        properties: { url: { type: "string" } },
        required: ["url"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "info.navigate_site",
      description: "从起始 URL 自动多层跟进链接，直到命中目标关键词页面（如注册入口）。",
      parameters: {
        type: "object",
        properties: {
          startUrl: { type: "string" },
          goalKeywords: { type: "array", items: { type: "string" } },
          maxDepth: { type: "integer", description: "默认 2，最大 5" },
          maxPages: { type: "integer", description: "默认 20，最大 80" },
          sameHostOnly: { type: "boolean", description: "默认 true" },
        },
        required: ["startUrl"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "weather.get_local",
      description:
        "获取当地天气与穿衣建议（Open-Meteo）。优先提供 latitude、longitude（来自浏览器定位）；或仅提供 city 由服务做地理编码。可选 timezone（IANA，默认 Asia/Shanghai）。",
      parameters: {
        type: "object",
        properties: {
          latitude: { type: "number" },
          longitude: { type: "number" },
          city: { type: "string", description: "城市名（与坐标二选一）" },
          timezone: { type: "string" },
          locationLabel: { type: "string", description: "展示用地点名" },
        },
        additionalProperties: false,
      },
    },
  },
];

const LIFE_ASSISTANT_CHAT_TOOLS: ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "budget.calculate",
      description: "根据收入与各项支出计算剩余预算并给出建议。",
      parameters: {
        type: "object",
        properties: {
          income: { type: "number", description: "月收入" },
          rent: { type: "number", description: "房租" },
          food: { type: "number", description: "餐饮" },
          transport: { type: "number", description: "交通" },
        },
        required: ["income"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "shopping.suggest",
      description: "根据商品与预算给出购物建议（比价决策辅助，不执行购买）。",
      parameters: {
        type: "object",
        properties: {
          item: { type: "string", description: "商品名称或品类" },
          budget: { type: "number", description: "预算上限（元）" },
        },
        required: ["item"],
        additionalProperties: false,
      },
    },
  },
];

/** 宿主 Agent 真实资金钱包（与 Agent World 世界点数无关）。 */
const WALLET_CHAT_TOOLS: ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "wallet.get_balance",
      description: "查询当前用户绑定的真实资金钱包余额（CNY，只读）。",
      parameters: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "wallet.get_transactions",
      description: "查询用户钱包交易记录，支持分页与类型过滤。",
      parameters: {
        type: "object",
        properties: {
          limit: { type: "integer", description: "返回条数，默认 20" },
          offset: { type: "integer", description: "偏移，默认 0" },
          type: {
            type: "string",
            enum: ["all", "income", "expense", "transfer"],
            description: "交易类型过滤，默认 all",
          },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "wallet.transfer",
      description: "在用户明确同意后，代其向其他 Agent 转账（recipientId 为对方 session/user id）。",
      parameters: {
        type: "object",
        properties: {
          recipientId: { type: "string", description: "收款方 Agent id" },
          amount: { type: "number", description: "转账金额（CNY，须 > 0）" },
          remark: { type: "string", description: "可选备注" },
        },
        required: ["recipientId", "amount"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "wallet.recharge",
      description: "在用户明确要求后，代其向钱包充值（演示/测试用）。",
      parameters: {
        type: "object",
        properties: {
          amount: { type: "number", description: "充值金额（CNY，须 > 0）" },
        },
        required: ["amount"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "wallet.purchase",
      description:
        "代用户消费/购物（须用户授权）。覆盖外卖、打车、酒店、电影票、网购、缴费、红包等50+类别。category 示例：food_delivery/taxi/hotel/movie/shopping/phone_bill/red_packet 等。",
      parameters: {
        type: "object",
        properties: {
          category: {
            type: "string",
            description:
              "消费类别，如 food_delivery, taxi, hotel, movie, shopping, train, flight, phone_bill, red_packet, other 等",
          },
          amount: { type: "number", description: "消费金额（CNY，须 > 0）" },
          description: { type: "string", description: "消费描述（订单摘要）" },
          merchant: { type: "string", description: "商户/平台名称，如美团、滴滴、京东" },
          orderDetails: {
            type: "object",
            description: "可选订单细节（商品名、数量等）",
          },
        },
        required: ["category", "amount", "description"],
        additionalProperties: false,
      },
    },
  },
];

/** Agent Link：好友列表、好友请求（与 App 侧栏「Agent Link」/ MailboxPage 对齐）。 */
const AGENT_LINK_CHAT_TOOLS: ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "agent.link.list_friends",
      description: "列出当前用户的好友（Agent Link）。",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "agent.link.list_friend_requests",
      description: "列出好友请求。scope: all（默认）| incoming | outgoing。",
      parameters: {
        type: "object",
        properties: {
          scope: { type: "string", enum: ["all", "incoming", "outgoing"] },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "agent.link.send_friend_request",
      description: "向另一用户发送好友请求（须用户明确要求）。",
      parameters: {
        type: "object",
        properties: {
          toActorId: { type: "string", description: "对方 userId/sessionId" },
          message: { type: "string", description: "可选附言" },
        },
        required: ["toActorId"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "agent.link.respond_friend_request",
      description: "接受或拒绝收到的好友请求。",
      parameters: {
        type: "object",
        properties: {
          requestId: { type: "string" },
          accept: { type: "boolean" },
        },
        required: ["requestId", "accept"],
        additionalProperties: false,
      },
    },
  },
];

const AGENT_RELAY_CHAT_TOOLS: ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "agent.send_to_peer",
      description: "向好友或其它已配对 Agent 发送中继消息（可与 agent.link 好友配合）。",
      parameters: {
        type: "object",
        properties: {
          targetSessionId: { type: "string", description: "对方 sessionId" },
          body: { type: "string", description: "消息正文" },
          subject: { type: "string", description: "可选主题" },
          traceId: { type: "string", description: "可选追踪 id" },
        },
        required: ["targetSessionId", "body"],
        additionalProperties: false,
      },
    },
  },
];

/** 对话中自动创建/查询日程与提醒的内置工具组（写入定时任务，非独立日历应用）。 */
const CALENDAR_CHAT_TOOLS: ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "reminder.plan",
      description:
        "【生活助手】根据用户原句创建定时提醒并写入服务端日程。若用户只说时刻与事项、未说明「单次/每天/每周/连续」，返回 needsRecurrenceConfirm=true，须先追问用户，确认后再调用。系统会智能分析任务内容（如「开会」→建议单次、「吃药」→建议每天、「接下来3天」→建议连续），并在结果中返回 suggestedQuestion、suggestedType、confidence、reason 和 examples 供你参考。请根据这些建议向用户提问，提供清晰的选项让用户选择。例：「明天 9:00 提醒我开会」可直接创建；「早上七点叫我起床」「提醒我每天喝水」须先根据建议询问用户重复方式。成功返回 taskId、nextRunAt、recurrence。",
      parameters: {
        type: "object",
        properties: {
          text: { type: "string", description: "用户原句，须含时间与提醒事项" },
          subject: { type: "string", description: "可选，与 date 组合解析（无 text 时）" },
          date: { type: "string", description: "可选，如「明天 09:00」（无 text 时）" },
          runAt: { type: "string", description: "可选 ISO-8601，与 subject 结构化创建" },
          recurrence: {
            type: "string",
            enum: ["none", "daily", "weekly", "yearly"],
            description: "默认 none；仅用户明确要每天/每周/每年重复时才填 daily/weekly/yearly",
          },
          reminderMessage: { type: "string", description: "到点时展示的提醒文案" },
          timezone: { type: "string", description: "IANA 时区，默认 Asia/Shanghai" },
        },
        required: ["text"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "calendar.create_from_text",
      description:
        "【内置 Calendar】在对话中根据用户原句自动创建日程/提醒。提醒类若未说明单次或每天/每周/连续，返回 needsRecurrenceConfirm=true，须先向用户确认后再创建。系统会智能分析任务类型并提供建议（含 suggestedQuestion、examples 等），请据此向用户提问。例「明天 9:00 提醒我开会」「每天 7 点天气提醒」「接下来3天提醒我复习」。成功返回 taskId；解析失败则 matched=false。",
      parameters: {
        type: "object",
        properties: {
          text: { type: "string", description: "用户原句，含时间与事项" },
          timezone: { type: "string", description: "IANA 时区，默认 Asia/Shanghai" },
        },
        required: ["text"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "calendar.create_task",
      description:
        "【内置 Calendar】在对话中按结构化字段自动创建定时任务：提醒（reminder）、HTTP 动作（action）、天气简报（weather_brief）、Agent 自动化任务（agent_task）。runAt 须为 ISO-8601 且为未来时间。用户已说清楚时间/类型时优先用本工具；含糊时可用 calendar.create_from_text。",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string" },
          description: { type: "string" },
          kind: {
            type: "string",
            enum: ["reminder", "action", "weather_brief", "agent_task"],
            description: "weather_brief 需用户已在天气页保存定位；agent_task 会在到点后让 Agent 执行 prompt",
          },
          runAt: { type: "string", description: "ISO-8601" },
          recurrence: {
            type: "string",
            enum: ["none", "daily", "weekly", "yearly"],
            description: "默认 none；勿在用户未要求时填 daily",
          },
          timezone: { type: "string" },
          reminderMessage: { type: "string", description: "仅 kind=reminder" },
          action: {
            type: "object",
            description: "仅 kind=action",
            properties: {
              url: { type: "string" },
              method: { type: "string", enum: ["GET", "POST", "PUT", "PATCH", "DELETE"] },
            },
          },
          actionUrl: { type: "string", description: "与 action.url 二选一" },
          agentTask: {
            type: "object",
            description: "仅 kind=agent_task",
            properties: {
              prompt: { type: "string", description: "到点后交给 Agent 执行的自然语言任务" },
              accessMode: { type: "string", enum: ["sandbox", "full"], description: "默认 sandbox" },
            },
          },
          prompt: { type: "string", description: "agent_task 的快捷 prompt 字段" },
        },
        required: ["title", "description", "kind", "runAt"],
        additionalProperties: true,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "calendar.list_tasks",
      description:
        "【内置 Calendar】查询当前用户已创建的定时日程/提醒（含下次执行时间）。仅当用户**明确**要查看/确认日程或定时任务时调用；禁止用于「你确定？」「真的吗？」等短句追问（应结合对话线程上一轮回复作答）。",
      parameters: {
        type: "object",
        properties: {
          from: { type: "string", description: "范围起点 ISO，可选" },
          to: { type: "string", description: "范围终点 ISO，可选" },
        },
        additionalProperties: false,
      },
    },
  },
];

const PHONE_CHAT_TOOLS: ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "phone.ensure_my_number",
      description:
        "仅当用户明确要求办理/申领虚拟电话时调用：分配或查询其 6 位虚拟号码。禁止在用户未要求时主动调用；不要用此工具「帮用户提前占号」。跨 Agent 拨打需配对时与中继规则一致。",
      parameters: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "phone.virtual_call",
      description:
        "拨打 6 位虚拟号码：主叫须已申领号码（用户需先明确要求办理过虚拟号）。向目标推送「虚拟来电」并朗读 spokenMessage。ringStyle：reminder=提醒调；peer=联络他人（默认）。打给好友或本人自提醒均可。",
      parameters: {
        type: "object",
        properties: {
          toPhone: { type: "string", description: "6 位数字虚拟号码" },
          spokenMessage: { type: "string", description: "对方将听到的播报正文（尽量简短清晰）" },
          ringStyle: {
            type: "string",
            enum: ["peer", "reminder"],
            description: "peer=联络其他 Agent；reminder=提醒风格",
          },
        },
        required: ["toPhone", "spokenMessage"],
        additionalProperties: false,
      },
    },
  },
];

/** 沙箱模式下从模型 tools 列表移除、完全访问时须下发的视觉高权限工具。 */
export const VISION_SANDBOX_RESTRICTED_CHAT_TOOLS: ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "vision.http_pull",
      description:
        "【服务端视觉】通过 HTTP(S) 抓取远程快照图像（如摄像头 MJPEG/快照接口）。抓取成功后图像会注入当前对话下一轮模型上下文用于识别场景。**请勿用于探测内网**（服务端默认阻断 localhost 与私网 IP；可对可信域名配置 AGENT_VISION_HTTP_PULL_ALLOW_HOSTS）。",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "http(s) 图像快照完整 URL" },
          sourceId: { type: "string", description: "可选稳定源标记（telemetry）" },
        },
        required: ["url"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "vision.periodic_start",
      description:
        "【服务端定时视觉】按固定间隔从给定 HTTP(S) 快照 URL 拉帧并向模型推送一轮「配图」巡检推理。**客户端 WebSocket 需在线**才能收到助手的 chunk/done。与单次 vision.http_pull 不同：此为服务端调度无需用户每次手动发送图像。",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "快照 URL（同上约束）" },
          intervalSeconds: {
            type: "integer",
            description: "间隔秒数（下限约 30s，可由环境变量收紧）",
          },
          prompt: {
            type: "string",
            description: "每轮发给模型的巡检文案（可选）",
          },
        },
        required: ["url", "intervalSeconds"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "vision.periodic_stop",
      description: "停止指定的定时视觉任务（需提供 vision.periodic_start 返回的 jobId）。",
      parameters: {
        type: "object",
        properties: { jobId: { type: "string" } },
        required: ["jobId"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "vision.periodic_stop_all",
      description: "停止当前会话用户的全部定时视觉任务。",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "vision.periodic_list",
      description: "列出当前会话用户的定时视觉任务（jobId、url、间隔与巡检文案）。",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
];

const VISION_CHAT_TOOLS: ChatCompletionTool[] = VISION_SANDBOX_RESTRICTED_CHAT_TOOLS;

/** 时钟工具：获取当前时间和日期信息（通过IP地址查询用户时区）。 */
const CLOCK_CHAT_TOOLS: ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "clock.get_current_time",
      description:
        "获取当前时间（注册名 clock.get_current_time）。通过 IP 查询时区与城市，返回本地时间（精确到秒）、星期。用户问现在几点、当前时间时必须调用。",
      parameters: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "clock.get_user_location",
      description:
        "通过 IP 识别用户当前所在城市、省份/州、国家和时区。用户问「我在哪个城市」「我在哪」「当前位置」时必须调用。",
      parameters: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "clock.get_date",
      description: "获取当前日期和星期。通过IP地址查询自动识别用户所在城市，返回当地日期信息。当用户询问今天几号、今天星期几时使用此工具。",
      parameters: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "clock.format_timestamp",
      description: "将 Unix 时间戳格式化为可读的本地时间（通过IP地址识别用户时区）。",
      parameters: {
        type: "object",
        properties: {
          timestamp: { type: "number", description: "Unix 时间戳（秒）" },
        },
        required: ["timestamp"],
        additionalProperties: false,
      },
    },
  },
];

/** Agent 能力详细查询工具（Layer 3）：system prompt 已包含行为规则和路由表（Layer 2），本工具用于获取某领域的完整能力描述和运行时状态。 */
const AGENT_CAPABILITY_QUERY_CHAT_TOOLS: ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "agent.query_capabilities",
      description:
        "查询指定领域的完整能力描述和运行时状态。system prompt 中已有基础规则和路由表，本工具用于：①用户问「你能做什么」需展示完整清单时 ②需要某领域的详细工具说明/参数提示时 ③查看Agent World完整状态(社交推文站/技能商店/world.*工具族)时 ④确认虚拟电话号码等动态信息时。结果会保留在对话上下文供后续参考。",
      parameters: {
        type: "object",
        properties: {
          domain: {
            type: "string",
            enum: ["wallet", "agent_link", "calendar", "weather", "sub_agent", "aip", "vision", "desktop", "web", "life_assistant", "phone", "entertainment", "social_feed", "self_programming", "agent_account", "world", "embodiment", "all"],
            description:
              "能力领域过滤。不传或传 'all' 返回全部；传具体域名仅返回该领域。建议优先指定领域以减少 token 消耗：wallet=钱包, agent_link=好友, calendar=日程, weather=天气, sub_agent=子Agent委派, aip=AIP协议, vision=视觉, desktop=桌面自动化, web=网页浏览, life_assistant=生活助手, phone=虚拟电话, entertainment=侧栏游戏(五子棋/斗地主/炸金花), self_programming=自我编程, agent_account=账号注册, embodiment=具身身体, world=Agent World。",
          },
        },
        additionalProperties: false,
      },
    },
  },
];

/** world.* / AIP / 内置联网工具等（不含按会话合并的 Skill function 列表）。结果带模块级缓存。 */
let _builtinToolsCache: ChatCompletionTool[] | null = null;
export function getBuiltinAgentChatTools(): ChatCompletionTool[] {
  if (_builtinToolsCache) return _builtinToolsCache;
  _builtinToolsCache = [
    ...AGENT_WORLD_CHAT_TOOLS,
    ...AIP_CHAT_TOOLS,
    ...INFO_WEB_CHAT_TOOLS,
    ...LIFE_ASSISTANT_CHAT_TOOLS,
    ...WALLET_CHAT_TOOLS,
    ...AGENT_LINK_CHAT_TOOLS,
    ...AGENT_RELAY_CHAT_TOOLS,
    ...CALENDAR_CHAT_TOOLS,
    ...PHONE_CHAT_TOOLS,
    ...VISION_CHAT_TOOLS,
    ...CLOCK_CHAT_TOOLS,
    ...AGENT_CAPABILITY_QUERY_CHAT_TOOLS,
    ...EMBODIMENT_CHAT_TOOLS,
    ...SMART_HOME_CHAT_TOOLS,
    ...getDesktopVisualChatTools(),
    ...SELF_PROGRAMMING_CHAT_TOOLS,
  ];
  return _builtinToolsCache;
}

/**
 * 智能工具选择系统：基于用户输入上下文动态筛选相关工具，减少 Token 消耗和模型推理时间
 * 预期效果：减少 60-80% 的工具 Token，首字延迟降低 30-50%
 */

type ToolCategory = 'web' | 'calendar' | 'wallet' | 'social' | 'phone' | 'vision' | 'clock' | 'life' | 'capability' | 'desktop' | 'programming' | 'world' | 'game' | 'aip' | 'embodiment' | 'smart_home';

interface ToolCategoryMapping {
  category: ToolCategory;
  keywords: string[];
  toolNames: string[];
}

const TOOL_CATEGORY_MAPPINGS: ToolCategoryMapping[] = [
  {
    category: 'web',
    keywords: ['搜索', 'search', '网页', 'web', '网址', 'url', '链接', 'link', '查询', 'query', '新闻', 'news', '天气', 'weather', 'fetch', '浏览', 'browse', '导航', 'navigate'],
    toolNames: ['search_web', 'fetch_web', 'info.inspect_webpage', 'info.navigate_site', 'weather.get_local']
  },
  {
    category: 'calendar',
    keywords: ['提醒', 'reminder', '日程', 'schedule', '日历', 'calendar', '任务', 'task', '定时', 'timer', '闹钟', 'alarm', '计划', 'plan', '会议', 'meeting', '预约', 'appointment'],
    toolNames: ['reminder.plan', 'calendar.create_from_text', 'calendar.create_task', 'calendar.list_tasks']
  },
  {
    category: 'wallet',
    keywords: ['钱包', 'wallet', '余额', 'balance', '支付', 'pay', '转账', 'transfer', '充值', 'recharge', '消费', 'purchase', '交易', 'transaction', '账单', 'bill', '钱', 'money', '金额', 'amount'],
    toolNames: ['wallet.get_balance', 'wallet.get_transactions', 'wallet.transfer', 'wallet.recharge', 'wallet.purchase']
  },
  {
    category: 'social',
    keywords: ['好友', 'friend', '联系人', 'contact', '消息', 'message', '发送', 'send', '接收', 'receive', '请求', 'request', 'agent', 'peer', '中继', 'relay', '配对', 'pair'],
    toolNames: ['agent.link.list_friends', 'agent.link.list_friend_requests', 'agent.link.send_friend_request', 'agent.link.respond_friend_request', 'agent.send_to_peer']
  },
  {
    category: 'phone',
    keywords: ['电话', 'phone', '拨打', 'call', '虚拟号', 'virtual', '号码', 'number', '通话', 'ring', '来电', 'call'],
    toolNames: ['phone.ensure_my_number', 'phone.virtual_call']
  },
  {
    category: 'vision',
    keywords: ['图像', 'image', '图片', 'picture', '视觉', 'vision', '摄像头', 'camera', '截图', 'screenshot', '画面', 'frame', '拍照', 'photo', '识别', 'recognize', '看', 'see', '观察', 'observe'],
    toolNames: ['vision.http_pull', 'vision.periodic_start', 'vision.periodic_stop', 'vision.periodic_stop_all', 'vision.periodic_list']
  },
  {
    category: 'clock',
    keywords: ['时间', 'time', '日期', 'date', '时钟', 'clock', '现在', 'now', '当前', 'current', '几点', 'what time', '今天', 'today', '星期', 'week', '时区', 'timezone', 'timestamp', '时间戳'],
    toolNames: ['clock.get_current_time', 'clock.get_user_location', 'clock.get_date', 'clock.format_timestamp']
  },
  {
    category: 'life',
    keywords: ['预算', 'budget', '计算', 'calculate', '购物', 'shopping', '建议', 'suggest', '比价', 'compare', '推荐', 'recommend', '生活', 'life', '助手', 'assistant'],
    toolNames: ['budget.calculate', 'shopping.suggest']
  },
  {
    category: 'capability',
    keywords: ['能力', 'capability', '功能', 'function', '能做什么', 'can you do', '帮助', 'help', '技能', 'skill', '工具', 'tool', '介绍', 'introduce', '说明', 'explain'],
    toolNames: ['agent.query_capabilities']
  },
  {
    category: 'embodiment',
    keywords: ['身体', '移动', '动一动', '走动', '逛逛', '漫游', '球形', '机器人', '挪', '飞', '兴奋', '表情', 'roam', 'move', 'body', 'embodiment'],
    toolNames: ['embodiment.observe', 'embodiment.window_place', 'embodiment.roam', 'embodiment.move', 'embodiment.stop', 'embodiment.set_state', 'embodiment.excite', 'embodiment.window_roam']
  },
  {
    category: 'desktop',
    keywords: ['桌面', 'desktop', '电脑', 'computer', '屏幕', 'screen', '自动化', 'automation', '控制', 'control', '操作', 'operate', '点击', 'click', '键盘', 'keyboard', '鼠标', 'mouse'],
    toolNames: [] // desktop tools are dynamic
  },
  {
    category: 'programming',
    keywords: ['编程', 'program', '代码', 'code', '开发', 'develop', '自我', 'self', '优化', 'optimize', '改进', 'improve', '修复', 'fix', 'bug', 'debug'],
    toolNames: [] // self-programming tools are dynamic
  },
  {
    category: 'world',
    keywords: ['世界', 'world', '社交', 'social', '市场', 'market', '点数', 'points', '积分', 'score'],
    toolNames: [] // agent world tools are dynamic
  },
  {
    category: 'game',
    keywords: ['游戏', 'game', '对局', 'match', '竞技', 'compete', '五子棋', 'gomoku', '斗地主', 'doudizhu', '炸金花', 'zhajinhua', '21点', 'blackjack', '下棋', '打牌'],
    toolNames: [] // game tools (world.gomoku/doudizhu/zhajinhua) are dynamic
  },
  {
    category: 'aip',
    keywords: ['提案', 'proposal', '联盟', 'alliance', '冲突', 'conflict', '协议', 'protocol', 'aip', '投票', 'vote', '交易', 'trade'],
    toolNames: [] // aip tools are dynamic
  },
  {
    category: 'smart_home',
    keywords: ['灯', '灯光', '开关', '空调', '温度', '窗帘', '传感器', '设备', '家电', '家居', '智能', 'home', 'light', 'climate', 'switch', 'cover', 'sensor', '加热', '取暖', '制冷', 'cool', 'heat', 'fan', '风扇', '湿度', 'humidity', 'brightness', '亮度', '场景', 'scene', '回家', '离家', '晚安'],
    toolNames: ['smart_home.list_devices', 'smart_home.control_device', 'smart_home.scene']
  },
];

const ALWAYS_INCLUDED_TOOLS = [
  'clock.get_current_time',
  'agent.query_capabilities',
  'embodiment.roam',
  'embodiment.move',
  'embodiment.set_state',
];

function extractKeywords(text: string): string[] {
  const cleaned = text.toLowerCase()
    .replace(/[^\u4e00-\u9fa5a-zA-Z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  
  const words = cleaned.split(' ').filter(w => w.length > 0);
  
  const chineseSegments: string[] = [];
  let currentChinese = '';
  
  for (const char of text) {
    if (/[\u4e00-\u9fa5]/.test(char)) {
      currentChinese += char;
      if (currentChinese.length >= 2) {
        chineseSegments.push(currentChinese);
        currentChinese = currentChinese.slice(1);
      }
    } else {
      currentChinese = '';
    }
  }
  
  return [...new Set([...words, ...chineseSegments])];
}

function detectRelevantCategories(userText: string): Set<ToolCategory> {
  const keywords = extractKeywords(userText);
  const relevantCategories = new Set<ToolCategory>();
  
  for (const mapping of TOOL_CATEGORY_MAPPINGS) {
    const matchCount = mapping.keywords.filter(kw => 
      keywords.some(userKw => 
        userKw.includes(kw) || kw.includes(userKw)
      )
    ).length;
    
    if (matchCount > 0) {
      relevantCategories.add(mapping.category);
    }
  }
  
  return relevantCategories;
}

export function selectRelevantTools(
  userText: string, 
  allTools: ChatCompletionTool[],
  options?: { 
    minTools?: number; 
    maxTools?: number;
    includeAlwaysIncluded?: boolean;
  }
): ChatCompletionTool[] {
  const minTools = options?.minTools ?? 5;
  const maxTools = options?.maxTools ?? 20;
  const includeAlwaysIncluded = options?.includeAlwaysIncluded ?? true;
  
  const relevantCategories = detectRelevantCategories(userText);
  
  const selectedToolNames = new Set<string>();
  
  if (includeAlwaysIncluded) {
    ALWAYS_INCLUDED_TOOLS.forEach(name => selectedToolNames.add(name));
  }
  
  for (const mapping of TOOL_CATEGORY_MAPPINGS) {
    if (relevantCategories.has(mapping.category)) {
      mapping.toolNames.forEach(name => selectedToolNames.add(name));
    }
  }
  
  const filteredTools = allTools.filter((tool) => {
    if (tool.type !== "function" || !("function" in tool) || !tool.function?.name) return false;
    return selectedToolNames.has(tool.function.name);
  });
  
  if (filteredTools.length < minTools) {
    const remainingTools = allTools.filter((tool) => {
      if (tool.type !== "function" || !("function" in tool) || !tool.function?.name) return false;
      return !selectedToolNames.has(tool.function.name);
    });
    const needed = minTools - filteredTools.length;
    filteredTools.push(...remainingTools.slice(0, needed));
  }
  
  if (filteredTools.length > maxTools) {
    return filteredTools.slice(0, maxTools);
  }
  
  return filteredTools;
}

export function getSmartToolsForContext(userText: string, extraTools?: ChatCompletionTool[]): ChatCompletionTool[] {
  const allBuiltinTools = getBuiltinAgentChatTools();
  const allTools = extraTools ? [...allBuiltinTools, ...extraTools] : allBuiltinTools;
  
  return selectRelevantTools(userText, allTools);
}

function extractUserTextFromMessages(messages: ChatCompletionMessageParam[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === 'user') {
      if (typeof msg.content === 'string' && msg.content.trim()) {
        return msg.content.trim();
      }
      if (Array.isArray(msg.content)) {
        const textPart = msg.content.find(part => 
          part.type === 'text' && (part as { text?: string })?.text?.trim()
        );
        if (textPart && typeof textPart === 'object' && 'text' in textPart) {
          return (textPart as { text: string }).text.trim();
        }
      }
    }
  }
  return null;
}

/**
 * OpenAI 兼容 Chat Completions：流式输出 + tool_calls 多轮执行（Kimi / OpenAI 共用）。
 */
export async function streamCompletionWithTools(
  client: OpenAI,
  model: string,
  messages: ChatCompletionMessageParam[],
  onDelta: StreamDeltaHandler,
  ctx: ChatToolExecutionContext,
  options?: {
    maxRounds?: number;
    tools?: ChatCompletionTool[];
    onAfterToolBatch?: (info: ToolLoopAfterBatchInfo) => void;
    /** Moonshot Kimi：如 `{ thinking: { type: "disabled" } }` */
    extraBody?: Record<string, unknown>;
  },
): Promise<string> {
  // 动态调整工具循环轮次（基于任务复杂度）
  let maxRounds = options?.maxRounds;
  
  if (!maxRounds) {
    const userText = extractUserTextFromMessages(messages) || '';
    maxRounds = getOptimalMaxRounds(userText, messages.length);
  }
  
  const mergedRegistryTools = options?.tools ?? getBuiltinAgentChatTools();
  const toolSearchPrepared = prepareToolsWithToolSearch(mergedRegistryTools);
  const registryTools = toolSearchPrepared.visibleTools;
  const deferredToolCatalog = toolSearchPrepared.deferredCatalog;

  if (toolSearchPrepared.toolSearchActive) {
    console.info(
      `[tool-search] active: core=${toolSearchPrepared.coreToolCount} ` +
        `deferred=${toolSearchPrepared.deferredToolCount} ` +
        `visible=${registryTools.length} (BM25 index cached per turn)`,
    );
  }

  const { apiTools, resolveRegistryToolName } = prepareToolsForChatApi(registryTools);
  let lastAssistantText = "";
  const thinkingDisabled = isThinkingDisabled(options?.extraBody);

  for (let round = 0; round < maxRounds; round++) {
    let retriedToolCallIdError = false;
    let stream: Awaited<ReturnType<OpenAI["chat"]["completions"]["create"]>>;

    while (true) {
      const sanitizedMessages = sanitizeChatMessagesForApi(messages, {
        stripReasoning: thinkingDisabled,
        logPrefix: "[openai-tool-loop]",
      });
      try {
        stream = await client.chat.completions.create({
          model,
          messages: sanitizedMessages,
          tools: apiTools,
          tool_choice: "auto",
          stream: true,
          ...(options?.extraBody ? { extra_body: options.extraBody } : {}),
        });
        break;
      } catch (e) {
        if (!retriedToolCallIdError && isToolCallIdNotFoundError(e)) {
          retriedToolCallIdError = true;
          repairMessagesAfterToolCallIdError(messages, thinkingDisabled);
          console.warn("[openai-tool-loop] Retrying completion after tool_call_id repair");
          continue;
        }
        throw e;
      }
    }

    let fullText = "";
    let fullReasoning = "";
    const toolAcc = new Map<number, ToolAcc>();
    let finishReason: string | null | undefined;

    try {
      for await (const part of stream) {
        const choice = part.choices[0];
        if (!choice) continue;
        finishReason = choice.finish_reason ?? finishReason;
        const d = choice.delta;
        const reasoningChunk =
          (d as { reasoning_content?: string | null } | undefined)?.reasoning_content ?? "";
        if (reasoningChunk) {
          fullReasoning += reasoningChunk;
        }
        if (d?.content) {
          fullText += d.content;
          const statusLine = fullText.trim();
          if (ctx.onAgentStatusLine) {
            if (statusLine) ctx.onAgentStatusLine(statusLine);
          } else {
            onDelta(d.content);
          }
        }
        if (d?.tool_calls) {
          for (const tc of d.tool_calls) {
            const idx = tc.index ?? 0;
            let acc = toolAcc.get(idx);
            if (!acc) {
              acc = { id: "", name: "", arguments: "" };
              toolAcc.set(idx, acc);
            }
            if (tc.id != null) acc.id = tc.id;
            if (tc.function?.name) acc.name = tc.function.name;
            if (tc.function?.arguments) acc.arguments += tc.function.arguments;
          }
        }
      }
    } catch (e) {
      throw e;
    }

    lastAssistantText = fullText;

    if (finishReason !== "tool_calls" || toolAcc.size === 0) {
      if (ctx.onAgentStatusLine && fullText.trim()) {
        onDelta(fullText);
      }
      messages.push({
        role: "assistant",
        content: fullText || null,
      });
      return fullText;
    }

    const toolCalls: ChatCompletionMessageToolCall[] = [...toolAcc.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([idx, v]) => {
        if (!v.id) {
          console.warn(
            `[openai-tool-loop] tool_calls[${idx}].id is empty from stream; ` +
            `fallback to random id. model=${model} name=${v.name}`,
          );
        }
        const callId = v.id || `call_${Date.now()}_${Math.random().toString(36).slice(2, 8)}_${idx}`;
        return {
          id: callId,
          type: "function" as const,
          function: {
            name: v.name,
            arguments: v.arguments || "{}",
          },
        };
      });

    const assistantWithTools: ChatCompletionMessageParam = {
      role: "assistant",
      content: fullText || null,
      tool_calls: toolCalls,
    };
    // Kimi k2.5 开启 thinking 时，带 tool_calls 的 assistant 须含 reasoning_content；关闭 thinking 时不得携带该字段
    if (!thinkingDisabled) {
      (assistantWithTools as { reasoning_content?: string }).reasoning_content =
        fullReasoning.trim() || " ";
    }
    messages.push(assistantWithTools);

    const toolResults: ToolLoopAfterBatchInfo["toolResults"] = [];

    type ToolCallWorkItem = {
      tc: (typeof toolCalls)[number];
      registryToolName: string;
      parsedArgs: Record<string, unknown>;
    };
    const workItems: ToolCallWorkItem[] = [];
    for (const tc of toolCalls) {
      if (tc.type !== "function") continue;
      const fn = tc.function;
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(fn.arguments || "{}") as Record<string, unknown>;
      } catch {
        args = {};
      }
      let registryToolName = resolveRegistryToolName(fn.name);
      let notifyToolName = registryToolName;
      if (isToolSearchBridgeName(registryToolName) && registryToolName === "tool_call") {
        const bridge = executeToolSearchBridge(registryToolName, args, deferredToolCatalog);
        if (bridge.kind === "call" && bridge.ok) {
          notifyToolName = bridge.registryToolName;
        }
      }
      ctx.onToolExecuteStart?.({
        toolName: notifyToolName,
        input: args,
        assistantPreamble: fullText.trim() || undefined,
      });
      workItems.push({ tc, registryToolName, parsedArgs: args });
    }

    const settledResults = await Promise.allSettled(
      workItems.map(async (item) => {
        let targetToolName = item.registryToolName;
        let targetArgs = item.parsedArgs;

        if (isToolSearchBridgeName(item.registryToolName)) {
          const bridge = executeToolSearchBridge(
            item.registryToolName,
            item.parsedArgs,
            deferredToolCatalog,
          );
          if (bridge.kind === "search" || bridge.kind === "describe" || bridge.kind === "discover") {
            const compacted = await compactToolOutputForLlm({
              toolName: item.registryToolName,
              ok: bridge.ok,
              result: bridge.result,
            });
            return {
              exec: { ok: bridge.ok, result: bridge.result },
              compacted,
              injectFrames: undefined,
              resultForWire: bridge.result,
              wireToolName: item.registryToolName,
            } as const;
          }
          if (bridge.kind === "call") {
            if (!bridge.ok) {
              const compacted = await compactToolOutputForLlm({
                toolName: item.registryToolName,
                ok: false,
                result: bridge.result,
              });
              return {
                exec: { ok: false, result: bridge.result },
                compacted,
                injectFrames: undefined,
                resultForWire: bridge.result,
                wireToolName: item.registryToolName,
              } as const;
            }
            targetToolName = bridge.registryToolName;
            targetArgs = bridge.parsedArgs;
          }
        }

        const TOOL_TIMEOUT_MS = resolveToolExecutionTimeoutMs(targetToolName);

        let exec: Awaited<ReturnType<ChatToolExecutionContext['executeTool']>>;
        try {
          exec = await Promise.race([
            ctx.executeTool(targetToolName, targetArgs),
            new Promise<never>((_, reject) =>
              setTimeout(() => reject(new Error(`工具 "${targetToolName}" 执行超时 (${TOOL_TIMEOUT_MS}ms)`)), TOOL_TIMEOUT_MS)
            )
          ]);
        } catch (timeoutError) {
          console.error(`[工具超时] ${targetToolName}:`, timeoutError instanceof Error ? timeoutError.message : timeoutError);
          exec = {
            ok: false,
            result: {
              error: `工具执行超时，请稍后重试。(${TOOL_TIMEOUT_MS}ms)`,
              timeout: true,
              toolName: targetToolName
            }
          };
        }
        
        let injectFrames: VisionFrame[] | undefined;
        let resultForWire: Record<string, unknown>;
        if (
          exec.ok &&
          exec.result &&
          Array.isArray((exec.result as Record<string, unknown>)[TOOL_RESULT_VISION_INJECT_KEY])
        ) {
          injectFrames = (exec.result as Record<string, unknown>)[TOOL_RESULT_VISION_INJECT_KEY] as VisionFrame[];
          resultForWire = { ...(exec.result as Record<string, unknown>) };
          delete resultForWire[TOOL_RESULT_VISION_INJECT_KEY];
        } else {
          resultForWire = exec.result;
        }
        const compacted = await compactToolOutputForLlm({
          toolName: targetToolName,
          ok: exec.ok,
          result: exec.ok ? resultForWire : { error: exec.result.error ?? exec.result },
        });
        return {
          exec,
          compacted,
          injectFrames,
          resultForWire,
          wireToolName: targetToolName,
        } as const;
      }),
    );

    for (let i = 0; i < workItems.length; i++) {
      const item = workItems[i];
      const settled = settledResults[i];
      const exec = settled.status === "fulfilled" ? settled.value.exec : { ok: false, result: { error: settled.reason instanceof Error ? settled.reason.message : String(settled.reason) } };
      const compacted = settled.status === "fulfilled" ? settled.value.compacted : { content: JSON.stringify(exec.result), rawBytes: 0, compactBytes: 0, compacted: false };
      const injectFrames = settled.status === "fulfilled" ? settled.value.injectFrames : undefined;
      const wireToolName =
        settled.status === "fulfilled" ? settled.value.wireToolName : item.registryToolName;

      toolResults.push({ name: wireToolName, ok: exec.ok });
      ctx.onToolExecuted?.({
        toolName: wireToolName,
        input: item.parsedArgs,
        ok: exec.ok,
        result: settled.status === "fulfilled" ? settled.value.resultForWire : exec.result,
      });
      const toolContent = compacted.content;
      messages.push({
        role: "tool",
        tool_call_id: item.tc.id,
        content: toolContent,
      });
      if (injectFrames?.length) {
        messages.push({
          role: "user",
          content: openAiUserContentFromTurn({
            text: "（以下为 vision.http_pull 抓取的远程图像帧；请客观描述画面并继续完成任务。）",
            visionFrames: injectFrames,
          }),
        });
      }
    }
    options?.onAfterToolBatch?.({
      roundIndex: round,
      assistantText: fullText,
      toolResults,
    });
  }

  return lastAssistantText;
}
