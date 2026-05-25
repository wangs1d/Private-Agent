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
  "general",
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
    "【6个核心子Agent — 按能力维度划分】",
    "",
    "🏠 life 生活全能助手",
    "   能力: wallet · purchase · social · daily_life · entertainment",
    "   工具: 钱包全部(转账/消费50+类/充值) + 视觉操控电脑(通用) + 社交 + 天气日程 + 游戏",
    "   场景: 用户说任何消费/生活相关的事 → life 直接搞定",
    "   视觉使用: 偶尔用（订酒店时顺手操作一下网站）",
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
    "   场景: 购前决策支持、比价调研",
    "",
    "✨ creative 创意内容助手",
    "   能力: content_creation",
    "   工具: 主要依赖 LLM 创作；search_web/fetch_web 用于资料调研",
    "   场景: 写文案/做策划/写邮件/创意写作/PPT大纲/社媒内容/翻译润色",
    "",
    "🛡️ security 安全审计助手",
    "   能力: security_audit",
    "   工具: wallet.get_balance / wallet.get_transactions（只读审计，不执行转账/消费）",
    "   场景: 大额转账确认/敏感操作审批/安全策略检查/异常拦截",
    "   注意: 涉及钱包大额操作时，Master 应先委派 security 审批再委派 life 执行",
    "",
    "🤖 general 通用助手 → 兜底，拥有全部工具包括视觉操控",
    "",
    "【访问权限】默认「沙箱」：desktop.visual.run_task、vision.periodic_*、self.* 仅当用户开启「完全访问」后可用；沙箱下委派 life/tech 做电脑操控会失败，须先提醒用户开权限。",
    "",
    "【视觉操控 = 通用基础设施】",
    "desktop.visual.run_task 不是某个Agent专属能力。",
    "life / tech / general 都可以通过 tools 白名单使用它（须完全访问 + 服务端/桥接已配置）。",
    "区别只在使用的深度和场景：",
    "- life: 单次任务（订票/下单/填表单），10-40步",
    "- tech: 复杂流程（批量处理/自动化测试/持续监控），40-120步+",
    "",
    "【路由规则】",
    "- 用户说买/购/订/支付/花钱/消费等 → 委派 life",
    "- 用户说写代码/调试/部署/自动化脚本/运维/批量处理 → 委派 tech",
    "- 用户说搜索/比价/查询/哪个好 → 委派 info",
    "- 用户说写文案/做策划/写邮件/创意/PPT/社媒/翻译/润色 → 委派 creative",
    "- 大额转账(>阈值)/敏感操作/安全检查/权限审批 → 先委派 security，通过后再执行",
    "- 其他无法归类 → 委派 general",
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
              description: "Sub-agent type. Routes: life=生活全能(钱包+视觉+社交+日常), tech=技术操控(RPA+代码+运维), info=信息检索(只查不买), creative=创意内容(文案/策划/写作/PPT), security=安全审计(风险检测/审批/拦截), general=兜底.",
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
              description: "Optional. Forward this task's result to another sub-agent type (life/tech/info/creative/security/general) for further processing. Enables inter-agent communication.",
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
