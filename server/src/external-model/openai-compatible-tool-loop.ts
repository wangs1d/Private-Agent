import type OpenAI from "openai";
import type {
  ChatCompletionMessageParam,
  ChatCompletionMessageToolCall,
  ChatCompletionTool,
} from "openai/resources/chat/completions";

import { AGENT_WORLD_CHAT_TOOLS } from "@private-ai-agent/agent-world";
import { AIP_CHAT_TOOLS } from "../aip/aip-chat-completion-tools.js";
import { getDesktopVisualChatTools } from "../tools/desktop-visual-chat-tools.js";
import { SELF_PROGRAMMING_CHAT_TOOLS } from "../tools/self-programming-chat-tools.js";
import { openAiUserContentFromTurn } from "./build-user-message-content.js";
import { compactToolOutputForLlm } from "../tokenjuice/compactor.js";
import type {
  ChatToolExecutionContext,
  StreamDeltaHandler,
  ToolLoopAfterBatchInfo,
  VisionFrame,
} from "./types.js";

const TOOL_RESULT_VISION_INJECT_KEY = "_injectVisionUserMessage";

type ToolAcc = { id: string; name: string; arguments: string };

const DEFAULT_MAX_ROUNDS = 12;

/**
 * 清理消息数组中的孤立 tool 消息（tool_call_id 不匹配任何 assistant 消息的 tool_calls）。
 * 防止 Kimi/Moonshot 等 API 返回 "tool_call_id is not found" 错误。
 */
function sanitizeMessagesForApi(messages: ChatCompletionMessageParam[]): ChatCompletionMessageParam[] {
  const validToolCallIds = new Set<string>();

  for (const msg of messages) {
    if (msg.role === "assistant" && Array.isArray((msg as { tool_calls?: unknown }).tool_calls)) {
      const toolCalls = (msg as { tool_calls: ChatCompletionMessageToolCall[] }).tool_calls;
      for (const tc of toolCalls) {
        if (tc.id) validToolCallIds.add(tc.id);
      }
    }
  }

  return messages.filter((msg) => {
    if (msg.role !== "tool") return true;
    const tcId = (msg as { tool_call_id?: string }).tool_call_id;
    if (!tcId) {
      console.warn("[openai-tool-loop] Dropping tool message with empty tool_call_id");
      return false;
    }
    if (!validToolCallIds.has(tcId)) {
      console.warn(
        `[openai-tool-loop] Dropping orphan tool message: tool_call_id=${tcId} ` +
        `(not found in any assistant message's tool_calls). ` +
        `This prevents "tool_call_id is not found" API errors.`,
      );
      return false;
    }
    return true;
  });
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
      description: "联网搜索公开网页信息，返回标题、链接和摘要片段。",
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
        "【内置 Calendar】查询当前用户已创建的定时日程/提醒（含下次执行时间），便于在对话中确认或避免重复创建。",
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

const VISION_CHAT_TOOLS: ChatCompletionTool[] = [
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
            enum: ["wallet", "agent_link", "calendar", "weather", "sub_agent", "aip", "vision", "desktop", "web", "life_assistant", "phone", "self_programming", "agent_account", "world", "all"],
            description:
              "能力领域过滤。不传或传 'all' 返回全部；传具体域名仅返回该领域。建议优先指定领域以减少 token 消耗：wallet=钱包, agent_link=好友, calendar=日程, weather=天气, sub_agent=子Agent委派, aip=AIP协议, vision=视觉, desktop=桌面自动化, web=网页浏览, life_assistant=生活助手, phone=虚拟电话, self_programming=自我编程, agent_account=账号注册, world=Agent World。",
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
    ...getDesktopVisualChatTools(),
    ...SELF_PROGRAMMING_CHAT_TOOLS,
  ];
  return _builtinToolsCache;
}

/**
 * OpenAI 兼容 Chat Completions：流式输出 + tool_calls 多轮执行（Kimi / OpenAI 共用）。
 */
export async function streamCompletionWithDoudizhuTools(
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
  const maxRounds = options?.maxRounds ?? DEFAULT_MAX_ROUNDS;
  const registryTools = options?.tools ?? getBuiltinAgentChatTools();
  const { apiTools, resolveRegistryToolName } = prepareToolsForChatApi(registryTools);
  let lastAssistantText = "";

  for (let round = 0; round < maxRounds; round++) {
    const sanitizedMessages = sanitizeMessagesForApi(messages);
    const stream = await client.chat.completions.create({
      model,
      messages: sanitizedMessages,
      tools: apiTools,
      tool_choice: "auto",
      stream: true,
      ...(options?.extraBody ? { extra_body: options.extraBody } : {}),
    });

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
          onDelta(d.content);
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

    messages.push({
      role: "assistant",
      content: fullText || null,
      tool_calls: toolCalls,
      // Kimi k2.5 等开启 thinking 时，带 tool_calls 的 assistant 消息须含 reasoning_content
      reasoning_content: fullReasoning,
    } as ChatCompletionMessageParam);

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
      const registryToolName = resolveRegistryToolName(fn.name);
      ctx.onToolExecuteStart?.({
        toolName: registryToolName,
        input: args,
        assistantPreamble: fullText.trim() || undefined,
      });
      workItems.push({ tc, registryToolName, parsedArgs: args });
    }

    const settledResults = await Promise.allSettled(
      workItems.map(async (item) => {
        const exec = await ctx.executeTool(item.registryToolName, item.parsedArgs);
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
          toolName: item.registryToolName,
          ok: exec.ok,
          result: exec.ok ? resultForWire : { error: exec.result.error ?? exec.result },
        });
        return { exec, compacted, injectFrames, resultForWire } as const;
      }),
    );

    for (let i = 0; i < workItems.length; i++) {
      const item = workItems[i];
      const settled = settledResults[i];
      const exec = settled.status === "fulfilled" ? settled.value.exec : { ok: false, result: { error: settled.reason instanceof Error ? settled.reason.message : String(settled.reason) } };
      const compacted = settled.status === "fulfilled" ? settled.value.compacted : { content: JSON.stringify(exec.result), rawBytes: 0, compactBytes: 0, compacted: false };
      const injectFrames = settled.status === "fulfilled" ? settled.value.injectFrames : undefined;

      toolResults.push({ name: item.registryToolName, ok: exec.ok });
      ctx.onToolExecuted?.({
        toolName: item.registryToolName,
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
