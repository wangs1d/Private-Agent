/**
 * Chat tools used by the master Agent to delegate work to sub-agents.
 */

import type { ChatCompletionTool } from "openai/resources/chat/completions";

import type { SubAgentCapability, SubAgentType } from "../services/master-agent-types.js";

export const MASTER_INVOKE_SUB_AGENT_REGISTRY = "master.invoke_sub_agent";
export const MASTER_LIST_SUB_AGENTS_REGISTRY = "master.list_sub_agents";
export const MASTER_POLL_SUB_AGENT_TASKS_REGISTRY = "master.poll_sub_agent_tasks";

const SUB_AGENT_TYPES: SubAgentType[] = [
  "life",
  "tech",
  "info",
  "creative",
  "security",
];

export function parseSubAgentType(raw: unknown): SubAgentType | null {
  const t = String(raw ?? "")
    .trim()
    .toLowerCase();
  return (SUB_AGENT_TYPES as string[]).includes(t) ? (t as SubAgentType) : null;
}

function formatCapabilities(caps: string[]): string {
  if (!caps || caps.length === 0) return "";
  return `\n    能力: ${caps.join(" · ")}`;
}

export function buildMasterSubAgentDelegateChatTools(
  capabilities: Iterable<SubAgentCapability>,
): ChatCompletionTool[] {
  const lines: string[] = [];
  for (const cap of capabilities) {
    const capLine = formatCapabilities(cap.capabilities);
    lines.push(`- ${cap.type} (${cap.name}): ${cap.description.split("\n")[0]}${capLine}`);
  }
  const catalog = lines.length ? lines.join("\n") : SUB_AGENT_TYPES.map((t) => `- ${t}`).join("\n");

  const capabilityTable = [
    "",
    "【5个核心子Agent — 按能力维度划分】",
    "",
    "🏠 life 生活全能助手",
    "   能力: wallet · purchase",
    "   工具: wallet.transfer / wallet.recharge / wallet.purchase(全场景消费) + desktop.visual.*(电脑操控)",
    "   场景: 涉及钱包写操作(转账/消费/充值) + 电脑操控时才委派",
    "   ⚠️ 主 agent 自己能查余额/看流水/查天气/设日程/搜信息/玩游戏，不需要委派 life",
    "",
    "💻 tech 技术操控助手",
    "   能力: deep_rpa · code_dev · system_ops",
    "   工具: desktop.visual.* / vision.* / self.*(完全访问) / search_web（深度RPA与技能开发）",
    "   场景: 复杂自动化流程、代码任务、系统管理、批量操作",
    "   视觉使用: 深度用（复杂多步流程、批量处理、长时间运行）",
    "",
    "🔍 info 信息助手",
    "   能力: search_info",
    "   工具: search_web / fetch_web / info.inspect_webpage / info.navigate_site / shopping.suggest（只查不买）",
    "   场景: 购前决策支持、深度比价调研、多轮信息检索",
    "",
    "✨ creative 创意内容助手",
    "   能力: content_creation",
    "   工具: search_web / fetch_web / info.*(深度调研) / weather + care(场景感知) / self.*(创建内容模板) / shopping.suggest(带货参考)",
    "   场景: 写文案/做策划/写邮件/创意写作/PPT大纲/社媒内容/翻译润色",
    "   ⚠️ creative 拥有专属的深度调研+内容创作工具链，简单文案主 agent 也能写，但专业的委派 creative",
    "",
    "🛡️ security 安全审计助手",
    "   能力: security_audit",
    "   工具: wallet.get_balance / wallet.get_transactions（只读审计，不执行转账/消费）",
    "   场景: 大额转账确认/敏感操作审批/安全策略检查/异常拦截",
    "   注意: 涉及钱包大额操作时，Master 应先委派 security 审批再委派 life 执行",
    "",
    "【访问权限】默认「沙箱」：desktop.visual.run_task、vision.periodic_*、self.* 仅当用户开启「完全访问」后可用；沙箱下委派 life/tech 做电脑操控会失败，须先提醒用户开权限。",
    "",
    "【视觉操控】仅 life / tech 子 Agent 拥有 desktop.visual.* 能力，主 agent 无此权限。",
    "life: 单次任务（订票/下单/填表单），10-40步",
    "tech: 复杂流程（批量处理/自动化测试/持续监控），40-120步+",
    "",
    "【路由规则 — 先自己处理，搞不定才委派】",
    "- 大部分任务：主 agent 直接用基本工具处理，不需要委派",
    "- 游戏(五子棋/斗地主等)：主 agent 直接陪玩，不委派",
    "- 需要钱包写操作(转账/消费/充值) → 委派 life",
    "- 需要电脑操控(操作网站/App) → 委派 life 或 tech（视复杂度）",
    "- 写代码/调试/部署/自动化脚本/运维/批量处理 → 委派 tech",
    "- 深度搜索/多轮调研/商品比价 → 委派 info",
    "- 专业创作(文案/策划/PPT/社媒/翻译润色) → 委派 creative",
    "- 大额交易/敏感操作/安全检查 → 先委派 security 审批",
    "",
  ].join("\n");

  return [
    {
      type: "function",
      function: {
        name: MASTER_INVOKE_SUB_AGENT_REGISTRY,
        description: [
          "Master Agent delegates one professional sub-task to one sub-agent.",
          "Call this only when delegation is useful; simple tasks should use normal tools directly.",
          "After receiving a report, synthesize for the user or delegate another distinct sub-task.",
          "Independent sub-tasks may be invoked in parallel in one tool batch (server enforces MAX_PARALLEL_SUB_AGENTS).",
          "Long-running tasks: set runInBackground=true to return immediately, then call master_poll_sub_agent_tasks.",
          "Features: automatic retry on failure, semantic deduplication, inter-agent forwarding via forwardToAgent.",
          `Available sub-agents:\n${catalog}`,
          capabilityTable,
        ].join("\n"),
        parameters: {
          type: "object",
          properties: {
            agentType: {
              type: "string",
              enum: [...SUB_AGENT_TYPES],
              description: "Sub-agent type. Routes: life=复杂生活操作(钱包写+视觉操控), tech=技术操控(RPA+代码+运维), info=信息检索(深度调研), creative=创意内容(文案/策划/写作/PPT), security=安全审计(风险检测/审批/拦截). 注意：游戏由主agent直接处理，不委派life。",
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
            forwardToAgent: {
              type: "string",
              description: "Optional. Forward this task's result to another sub-agent type (life/tech/info/creative/security) for further processing. Enables inter-agent communication.",
            },
            runInBackground: {
              type: "boolean",
              description:
                "Optional. When true, start the sub-agent in the background and return immediately with taskId; poll via master_poll_sub_agent_tasks.",
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
          "Poll background sub-agent delegations and completed reports for the current user turn.",
          "Use after runInBackground=true invocations or when synthesizing parallel sub-agent results.",
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
