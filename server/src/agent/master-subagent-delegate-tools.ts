/**
 * Chat tools used by the master Agent to delegate work to sub-agents.
 */

import type { ChatCompletionTool } from "openai/resources/chat/completions";

import type { SubAgentCapability, SubAgentType } from "../services/master-agent-types.js";

export const MASTER_INVOKE_SUB_AGENT_REGISTRY = "master.invoke_sub_agent";
export const MASTER_LIST_SUB_AGENTS_REGISTRY = "master.list_sub_agents";
export const MASTER_POLL_SUB_AGENT_TASKS_REGISTRY = "master.poll_sub_agent_tasks";

/** 内置子 Agent 类型（life/tech/info）。外部注册的自定义类型不在此列，
 *  运行时校验时若传入 validTypes 则以传入集合为准。 */
const SUB_AGENT_TYPES: SubAgentType[] = [
  "life",
  "tech",
  "info",
];

/**
 * 解析子 Agent 类型字符串。
 *
 * @param raw 原始输入
 * @param validTypes 可选的合法类型集合（来自 registry.types()）。
 *                   传入时按该集合校验，支持外部注册的自定义子 Agent；
 *                   不传则回退到内置 SUB_AGENT_TYPES。
 */
export function parseSubAgentType(
  raw: unknown,
  validTypes?: ReadonlySet<SubAgentType> | readonly SubAgentType[],
): SubAgentType | null {
  const t = String(raw ?? "")
    .trim()
    .toLowerCase();
  const set =
    validTypes instanceof Set
      ? (validTypes as Set<string>)
      : validTypes
        ? new Set(validTypes as readonly string[])
        : new Set(SUB_AGENT_TYPES as string[]);
  return set.has(t) ? (t as SubAgentType) : null;
}

function formatCapabilities(caps: string[]): string {
  if (!caps || caps.length === 0) return "";
  return `\n    能力: ${caps.join(" · ")}`;
}

export function buildMasterSubAgentDelegateChatTools(
  capabilities: Iterable<SubAgentCapability>,
): ChatCompletionTool[] {
  const capList = Array.from(capabilities);
  const lines: string[] = [];
  // 动态枚举：从已注册 capabilities 派生，支持外部注册的自定义子 Agent
  const enumTypes: SubAgentType[] = capList.map((c) => c.type);
  for (const cap of capList) {
    const capLine = formatCapabilities(cap.capabilities);
    lines.push(`- ${cap.type} (${cap.name}): ${cap.description.split("\n")[0]}${capLine}`);
  }
  const catalog = lines.length ? lines.join("\n") : SUB_AGENT_TYPES.map((t) => `- ${t}`).join("\n");

  const capabilityTable = [
    "",
    "【3个核心子Agent — 按能力维度划分】",
    "",
    "🏠 life 生活全能助手",
    "   能力: wallet · purchase",
    "   工具: wallet.transfer / wallet.recharge / wallet.purchase(全场景消费) + desktop.visual.*(电脑操控)",
    "   场景: 涉及钱包写操作(转账/消费/充值) + 电脑操控时才委派",
    "   ⚠️ 主 agent 自己能查余额/看流水/查天气/设日程/搜信息，不需要委派 life",
    "",
    "💻 tech 技术操控助手",
    "   能力: deep_rpa · code_dev · system_ops",
    "   工具: desktop.visual.* / vision.* / self.*(完全访问) / search_web（深度RPA与技能开发）",
    "   场景: 复杂自动化流程、代码任务、系统管理、批量操作",
    "   视觉使用: 深度用（复杂多步流程、批量处理、长时间运行）",
    "",
    "🔍 info 信息助手",
    "   能力: search_info",
    "   工具: search_web / fetch_web / browser.session.list / browser.fetch_page（用户授权 Cookie+完全访问）/ shopping.suggest（只查不买）",
    "   场景: 购前决策支持、深度比价调研、多轮信息检索",
    "",
    "【访问权限】默认「沙箱」：desktop.visual.run_task、vision.periodic_*、self.* 仅当用户开启「完全访问」后可用；沙箱下委派 life/tech 做电脑操控会失败，须先提醒用户开权限。",
    "",
    "【视觉操控】desktop.visual.* 在「完全访问」或电脑桥接在线时主 agent 可直接调用；复杂 RPA 可委派 life / tech。",
    "life: 单次任务（订票/下单/填表单），10-40步",
    "tech: 复杂流程（批量处理/自动化测试/持续监控），40-120步+",
    "",
    "【路由规则 — 先自己处理，搞不定才委派】",
    "- 大部分任务：主 agent 直接用基本工具处理，不需要委派",
    "- 需要钱包写操作(转账/消费/充值) → 委派 life",
    "- 需要电脑操控(操作网站/App) → 委派 life 或 tech（视复杂度）",
    "- 写代码/调试/部署/自动化脚本/运维/批量处理 → 委派 tech",
    "- 深度搜索/多轮调研/商品比价 → 委派 info",
    "- 普通文案/邮件/简单写作 → 主 agent 自己处理（无 creative 子 Agent）",
    "",
  ].join("\n");

  return [
    {
      type: "function",
      function: {
        name: MASTER_INVOKE_SUB_AGENT_REGISTRY,
        description: [
          "主 Agent 派一名小弟（子 Agent）执行一个专业子任务。你是带头大哥，手下有 life/tech/info。",
          "简单事项用普通工具自己处理；复杂、多步骤或跨领域时再派小弟。",
          "收到小弟报告后整合回复用户，或再派另一个不同小弟接力（forwardToAgent）。",
          "⚠️ 信任小弟报告：子 Agent 已完成的搜索/查询不要用相同工具重复执行；要补信息就换不同 query 或派不同小弟接力，不要自己重做。",
          "用户一次提多件互不依赖的事：在同一轮并行多次调用本工具（服务端限流 MAX_PARALLEL_SUB_AGENTS）；无依赖务必并行，不要无谓排队。",
          "长任务：runInBackground=true 立即返回，再用 master_poll_sub_agent_tasks 收齐结果。",
          "特性：失败自动重试、语义去重、小弟间转发 forwardToAgent。",
          "userStatusLine 必填：口语化、有活人感（如「我让小弟去查价，你稍等」），禁止只写工具名或固定套话。",
          "不确定派谁时先 master_list_sub_agents 看名册。",
          "用户处于「沙箱」时勿派需要 desktop.visual.run_task / vision.periodic_* / self.* 的任务；须提醒开启「完全访问」。",
          `Available sub-agents:\n${catalog}`,
          capabilityTable,
        ].join("\n"),
        parameters: {
          type: "object",
          properties: {
            agentType: {
              type: "string",
              enum: enumTypes.length ? enumTypes : [...SUB_AGENT_TYPES],
              description: "Sub-agent type. Routes: life=复杂生活操作(钱包写+视觉操控), tech=技术操控(RPA+代码+运维), info=信息检索(深度调研).",
            },
            taskDescription: {
              type: "string",
              description: "Concrete task for the sub-agent, including required context. Life agent will auto-select appropriate tool (wallet.purchase / desktop.visual.run_task / etc).",
            },
            userStatusLine: {
              type: "string",
              description:
                "Required. A short user-visible progress line written naturally by the master Agent.",
            },
            priorContext: {
              type: "string",
              description: "Optional extra background for the sub-agent, such as prior conclusions.",
            },
            directive: {
              type: "string",
              description: "Optional. Direct instruction to the sub-agent on HOW to accomplish the task (strategy, approach, constraints, gotchas). Distinct from taskDescription (which is WHAT to do). Use this to tell the sub-agent 该怎么做 — e.g. '先用 search_web 查 3 个来源再交叉验证' or '截图后先 OCR 再操作'. Leave empty if no specific approach is needed.",
            },
            forwardToAgent: {
              type: "string",
              description: "Optional. Forward this task's result to another sub-agent type (life/tech/info) for further processing. Enables inter-agent communication.",
            },
            runInBackground: {
              type: "boolean",
              description:
                "Optional. Use only for clearly long-running work like monitoring, polling, batch processing, deployment, or tasks that should finish later. Ordinary search, ordinary Q&A, and simple one-shot delegations should not use this. When allowed, the sub-agent starts in the background and returns immediately with taskId; poll via master_poll_sub_agent_tasks.",
            },
          },
          required: ["agentType", "taskDescription", "userStatusLine"],
          additionalProperties: false,
        },
      },
    },
    {
      type: "function",
      function: {
        name: MASTER_LIST_SUB_AGENTS_REGISTRY,
        description: [
          "List available sub-agent types and their built-in capabilities.",
          "Each agent shows its capabilities array describing what it can do natively.",
        ].join(" "),
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
        name: MASTER_POLL_SUB_AGENT_TASKS_REGISTRY,
        description: [
          "Poll background sub-agent delegations, completed reports, and shared message bus for the current user turn.",
          "Use after runInBackground=true invocations or when synthesizing parallel sub-agent results.",
          "sharedMessages 字段返回本轮所有 Agent 间协作消息（主→子 directive、子→子 ask_peer/handoff、子→主 report），用于监督子 Agent 协作链。",
        ].join(" "),
        parameters: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
      },
    },
  ];
}

/** subagent.ask_peer —— 子 Agent 运行中向另一个子 Agent 类型发起同步咨询（真正的 Agent-to-Agent 对话） */
export const SUBAGENT_ASK_PEER_REGISTRY = "subagent.ask_peer";

export const SUBAGENT_ASK_PEER_TOOL: ChatCompletionTool = {
  type: "function",
  function: {
    name: SUBAGENT_ASK_PEER_REGISTRY,
    description: [
      "向另一个类型的子 Agent 发起同步咨询（Agent-to-Agent 协作）。",
      "你是当前正在执行的子 Agent，当发现某子任务超出自己的能力范围、或需要其他专业子 Agent 的产出时调用。",
      "例如：info Agent 搜到 JS 渲染页面抓不到 → ask_peer(tech, '帮我截图抓取 URL X 的正文')；",
      "life Agent 要下单前 → ask_peer(info, '帮我比价商品 Y 的最低价')。",
      "调用后 peer 会同步执行并返回结论；收到结论后继续你的任务。",
      "约束：不可嵌套（peer 不能再 ask_peer）；问题要具体、可一次回答。",
    ].join("\n"),
    parameters: {
      type: "object",
      properties: {
        peerType: {
          type: "string",
          description: "要咨询的子 Agent 类型：life/tech/info。",
        },
        question: {
          type: "string",
          description: "向 peer 提出的具体问题/请求（要明确、可执行，peer 会当作独立小任务处理）。",
        },
      },
      required: ["peerType", "question"],
      additionalProperties: false,
    },
  },
};

