import { getAgentRuntimeConfig, type AgentRuntimeConfig } from "./agent-runtime-config.js";
import { isPlanExecuteLoopEnabled, shouldUsePlanExecuteLoop } from "./plan-execute-loop.js";
import { isSimpleDirectTask } from "./simple-task.js";

export type LlmExecutionMode =
  | "master_only"
  | "master_delegate"
  | "plan_execute"
  | "direct_llm";

export type RouteDecision = {
  mode: LlmExecutionMode;
  reasons: string[];
};

/**
 * 单点 LLM 执行策略路由。
 *
 * 设计原则：主 agent 拥有基本能力，先尝试自己处理，
 * 只有需要子 agent 专属能力时才委派，避免不必要的延迟。
 */

// 需要委派给子agent的关键词模式（主agent无此能力）
const DELEGATE_KEYWORDS = [
  // life - 钱包写操作
  /转账|汇款|充值|红包.*发/,
  // life - 消费购物
  /买.*外卖|点餐|订.*外卖|订.*餐|叫外卖/,
  /订.*酒店|订.*民宿|订.*机票|订.*火车票|订.*电影票|订.*演唱/,
  /下单|支付|消费|花钱|购物|网购|买.*东西/,
  // life - 电脑操控
  /在电脑上|操作.*电脑|打开.*网站|打开.*携程|打开.*淘宝|打开.*京东/,
  /截图|录屏|操作.*app|操作.*软件/,
  // life - 游戏
  /五子棋|斗地主|炸金花|下.*棋|玩.*游戏|来.*局/,
  // tech - 技术
  /代码|编程|debug|调试|脚本|自动化|rpa|爬虫|批量.*处理/,
  /部署|服务器|运维|docker|容器|云服务/,
  /数据库|sql|mongodb|redis|api.*调试/,
  // info - 深度调研
  /搜索.*多个|对比.*商品|比价|调研|深度.*搜/,
  /监控.*价格|批量.*查询/,
  // creative - 专业创作
  /写.*文案|写.*策划|写.*方案|写.*故事|写.*文章/,
  /做ppt|制作.*演示|演示文稿/,
  /营销.*文案|广告.*语|社媒.*内容|品牌.*故事/,
  /翻译.*文章|润色.*文章/,
  // 多步骤复杂任务
  /第一步|第二步|先.*再.*然后/,
];

// 多步骤标志
const MULTI_STEP_RE = /然后|并且|同时|接着|并且|顺便|另外|先.+再|一方面|另一方面|首先|其次|最后/i;

/**
 * 判断任务是否需要委派给子agent
 * 原则：只有主agent无法处理时才委派
 */
function requiresSubAgent(message: string): boolean {
  const t = message.trim();

  // 明确需要子agent专属能力
  for (const pattern of DELEGATE_KEYWORDS) {
    if (pattern.test(t)) return true;
  }

  // 长文本+多步骤 = 可能复杂，需要委派
  if (t.length > 120 && MULTI_STEP_RE.test(t)) return true;

  return false;
}

export function routeLlmExecution(
  message: string,
  config: AgentRuntimeConfig = getAgentRuntimeConfig(),
): RouteDecision {
  const t = message.trim();
  const reasons: string[] = [];

  // 主agent优先自己处理，只有明确需要时才委派
  if (config.masterDelegation.enabled) {
    // 极简单任务 - 直接处理
    if (isSimpleDirectTask(t)) {
      reasons.push("simple_direct_task");
      return { mode: "master_only", reasons };
    }

    // 明确需要子agent专业能力时才委派
    if (requiresSubAgent(t)) {
      reasons.push("requires_subagent_capability");
      return { mode: "master_delegate", reasons };
    }

    // 默认：主agent先自己处理
    reasons.push("master_tries_first");
    return { mode: "master_only", reasons };
  }

  if (shouldUsePlanExecuteLoop(t)) {
    reasons.push("plan_execute_heuristic");
    return { mode: "plan_execute", reasons };
  }

  if (isPlanExecuteLoopEnabled() && !isSimpleDirectTask(t)) {
    reasons.push("plan_execute_available_but_skipped");
  }

  reasons.push("default_direct_llm");
  return { mode: "direct_llm", reasons };
}
