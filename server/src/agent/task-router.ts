import { getAgentRuntimeConfig, type AgentRuntimeConfig } from "./agent-runtime-config.js";
import { isExplicitPhoneCallRequest } from "./phone-call-intent.js";
import { isPlanExecuteLoopEnabled, shouldUsePlanExecuteLoop } from "./plan-execute-loop.js";
import { isSimpleDirectTask, shouldSkipNarrativeRecall } from "./simple-task.js";

export type LlmExecutionMode =
  | "fast_chat"
  | "master_only"
  | "master_delegate"
  | "plan_execute"
  | "direct_llm";

export type RouteDecision = {
  mode: LlmExecutionMode;
  reasons: string[];
};

const DELEGATE_KEYWORDS = [
  /转账|汇款|充值|红包.*发/,
  /买.*外卖|点餐|订.*外卖|叫外卖/,
  /订.*酒店|订.*民宿|订.*机票|订.*火车票|订.*电影票|订.*演唱/,
  /下单|支付|消费|花钱|购物|网购|买.*东西/,
  /在电脑上|操作.*电脑|打开.*网站|打开.*携程|打开.*淘宝|打开.*京东/,
  /截图|录屏|操作.*app|操作.*软件/,
  /代码|编程|debug|调试|脚本|自动化|rpa|爬虫|批量.*处理/,
  /部署|服务器|运维|docker|容器|云服务/,
  /数据库|sql|mongodb|redis|api.*调试/,
  /搜索.*多个|对比.*商品|比价|调研|深度.*搜/,
  /监控.*价格|批量.*查询/,
  /写.*文案|写.*策划|写.*方案|写.*故事|写.*文章/,
  /做ppt|制作.*演示|演示文稿/,
  /营销.*文案|广告.*语|社媒.*内容|品牌.*故事/,
  /翻译.*文章|润色.*文章/,
  /第一步.*第二步|先.*再.*然后/,
];

const MULTI_STEP_RE =
  /然后|并且|同时|接着|以及|顺便|另外|一方面|另一方面|首先|其次|最后/i;

const CHAT_ONLY_RE =
  /^(你好|hello|hi|hey|早上好|下午好|晚上好|谢谢|thanks|thank you|bye|再见|你是谁)[!！。.，,？?\s]*$/i;

const TOOL_OR_REALTIME_RE =
  /时间|日期|星期|几点|天气|新闻|最新|最近|价格|汇率|股价|行情|余额|流水|日程|提醒|搜索|查询|查一下|联网|浏览|网页|链接|截图|相册|摄像头|位置|navigation|search|browse|weather|news|latest|recent|price|stock|schedule|calendar|remind|time|date/i;

const INFORMATIONAL_REQUEST_RE =
  /解释|怎么理解|为什么|为何|原理|区别|对比|比较|分析|总结|摘要|翻译|改写|润色|介绍|教我|帮我|python|javascript|typescript|sql|code|debug|rewrite|rephrase|summarize|translate|explain|compare|analysis|analyze|difference|why|how|what|which|when/i;

const PARALLEL_SUBAGENT_RE =
  /同时|并行|一起|协作|分头|多份|多件事|多线|两头|一边.*一边|一方面.*另一方面/i;

const CASUAL_FAST_CHAT_RE =
  /^(在吗|还在吗|哈哈|haha|lol|ok|okay|嗯|嗯嗯|欸|诶|哎|唉|哦|噢|喔|在|忙吗|睡了吗|吃了吗|收到|行|好嘞|好的呀|谢啦|谢谢啦|bye bye|晚安)[!！。.，,？?\s]*$/i;

const FAST_CHAT_QUESTION_RE = /[?？]|什么|怎么|为什么|why|how|what|which|when/i;

function suggestsParallelSubAgents(message: string): boolean {
  const text = message.trim();
  if (!PARALLEL_SUBAGENT_RE.test(text)) return false;
  return text.length > 12 || MULTI_STEP_RE.test(text);
}

function requiresSubAgent(message: string): boolean {
  const text = message.trim();
  if (suggestsParallelSubAgents(text)) return true;
  for (const pattern of DELEGATE_KEYWORDS) {
    if (pattern.test(text)) return true;
  }
  return text.length > 120 && MULTI_STEP_RE.test(text);
}

function shouldUseFastChatLane(message: string): boolean {
  const text = message.trim();
  if (!text) return true;
  if (CHAT_ONLY_RE.test(text)) return true;
  if (CASUAL_FAST_CHAT_RE.test(text)) return true;
  if (requiresSubAgent(text)) return false;
  if (!shouldSkipNarrativeRecall(text)) return false;
  if (TOOL_OR_REALTIME_RE.test(text)) return false;
  if (INFORMATIONAL_REQUEST_RE.test(text)) return false;
  if (FAST_CHAT_QUESTION_RE.test(text) && text.length > 8) return false;
  if (MULTI_STEP_RE.test(text) && text.length > 48) return false;
  return text.length <= 12;
}

export type RouteLlmExecutionOptions = {
  preferFullPipeline?: boolean;
};

export function routeLlmExecution(
  message: string,
  config: AgentRuntimeConfig = getAgentRuntimeConfig(),
  options?: RouteLlmExecutionOptions,
): RouteDecision {
  const text = message.trim();
  const reasons: string[] = [];

  if (config.masterDelegation.enabled) {
    if (isExplicitPhoneCallRequest(text)) {
      reasons.push("explicit_phone_call_request");
      return { mode: "master_only", reasons };
    }

    if (!options?.preferFullPipeline && shouldUseFastChatLane(text)) {
      reasons.push("fast_chat_lane");
      return { mode: "fast_chat", reasons };
    }

    if (isSimpleDirectTask(text)) {
      reasons.push("simple_direct_task");
      return { mode: "master_only", reasons };
    }

    if (requiresSubAgent(text)) {
      reasons.push("requires_subagent_capability");
      return { mode: "master_delegate", reasons };
    }

    reasons.push("master_tries_first");
    return { mode: "master_only", reasons };
  }

  if (shouldUsePlanExecuteLoop(text)) {
    reasons.push("plan_execute_heuristic");
    return { mode: "plan_execute", reasons };
  }

  if (isPlanExecuteLoopEnabled() && !isSimpleDirectTask(text)) {
    reasons.push("plan_execute_available_but_skipped");
  }

  reasons.push("default_direct_llm");
  return { mode: "direct_llm", reasons };
}
