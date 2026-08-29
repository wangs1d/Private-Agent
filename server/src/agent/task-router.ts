import { getAgentRuntimeConfig, type AgentRuntimeConfig } from "./agent-runtime-config.js";
import { isExplicitPhoneCallRequest } from "./phone-call-intent.js";
import { isPlanExecuteLoopEnabled, shouldUsePlanExecuteLoop } from "./plan-execute-loop.js";
import { isSimpleDirectTask, shouldSkipNarrativeRecall } from "./simple-task.js";
import { isActionableTaskRequest } from "./task-intent.js";

export type LlmExecutionMode = "fast" | "complex";

export type RouteDecision = {
  mode: LlmExecutionMode;
  reasons: string[];
  /** 是否需要对回复做短句分段（闲聊式对话分段，工具/搜索/知识问答不分段）。 */
  segmentable: boolean;
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
  /数据库.*(调试|迁移|部署|连接|优化|配置|备份)|调试.*数据库|sql.*调试|mongodb.*部署|redis.*配置|api.*调试/,
  /搜索.*\d+|搜索.*多个|搜索.*几个|对比.*商品|对比.*价格|对比.*结果|比价|调研|深度.*搜/,
  /监控.*价格|批量.*查询/,
  /写.*文案|写.*策划|写.*方案|写.*故事|写.*文章/,
  /做ppt|制作.*演示|演示文稿/,
  /营销.*文案|广告.*语|社媒.*内容|品牌.*故事/,
  /翻译.*文章|润色.*文章/,
  /生成.*报告|输出.*报告|汇总.*报告/,
  /第一步.*第二步|先.*再.*然后/,
];

/**
 * 本地可执行代码任务（"用 Python 算一下" / "计算一下" / "运行代码"）
 * 直接走 direct_llm + code.run，避免 master agent 派子 agent（实测能把 TTFT 从 20s+ 降到 6-8s）。
 *
 * 注意排除「写/实现/开发/debug/部署」这类仍需委派的任务。
 */
const LOCAL_CODE_TASK_RE =
  /(?:^(?:用|使用|用一下)\s*(?:python|javascript|js|typescript|ts|node|go|rust|java|c\+\+|c#|ruby|php|swift|kotlin)\s*(?:算|计算|运行|执行|验证|验算))|(?:^(?:算|计算|验证|验算)\s*一下)|(?:^运行\s*(?:代码|脚本|命令))/i;

/**
 * 仍然属于「需要写代码 / 调试 / 部署」等开发型任务，应保留 master_delegate。
 * 用来从 DELEGATE_KEYWORDS 命中里把「写代码」与「本地算一下」区分开。
 */
const DEV_WORK_RE =
  /写.*(?:代码|脚本|程序|爬虫)|实现|开发|部署|debug|调试|重构|优化.*(?:算法|架构|代码)|从零|做一个|搭建/i;

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

/**
 * 状态机模式触发关键词:需要操控 Windows 桌面完成真实任务的指令。
 * 命中后路由到 state_machine,由 AgentTaskOrchestrator 状态机编排多轮工具调用。
 */
const STATE_MACHINE_KEYWORDS = [
  /打开.*(微信|qq|钉钉|飞书|浏览器|软件|应用|app|notepad|记事本|word|excel|ppt)/i,
  /操作.*电脑|控制.*电脑|操控.*电脑/i,
  /(微信|qq|钉钉|飞书).*(发消息|发.*消息|找.*联系人|搜索.*联系人|输入.*发送)/i,
  /在电脑上.*(打开|操作|执行|运行|发送|输入)/i,
  /帮.*(打开|操作|发送|输入|点击).*({微信|qq|软件|应用|电脑|桌面)/i,
  /桌面.*(自动化|操控|操作|任务)/i,
  /(点击|输入|按键|截图).*(按钮|框|输入框|搜索框|坐标|位置)/i,
];

/**
 * 自我进化相关关键词：用户说"自我进化"/"扫描新版本"/"升级依赖"/"沙箱测试"等时
 * 必须路由到 complex（因为需要 LLM 评估 + 沙箱真实执行，是多步异步任务）。
 *
 * 注：这些是 Agent 触发自我驱动进化管线的入口，命中后 Agent 会调
 * self_evolution.trigger_tech_scan / check_dependencies 工具。
 */
const SELF_EVOLUTION_KEYWORDS = [
  /自我进化|自主进化|自我升级|自进化/i,
  /扫描.*新版本|检查.*更新|检查.*升级|扫描.*依赖|扫描.*技术/i,
  /升级.*依赖|升级.*包|升级.*sdk|升级.*sdk/i,
  /沙箱.*测试|沙箱.*升级|sandbox.*test|沙箱.*运行/i,
  /应用.*自我.?升级|触发.*自我.?升级|执行.*自我.?升级/i,
  /self.?evolution|self.?upgrade|self.?driven/i,
  /进化.*提案|进化.*管线|进化.*状态|查看.*提案/i,
];

/** 判断是否应走状态机模式(桌面自动化任务) */
function shouldUseStateMachineMode(message: string): boolean {
  const text = message.trim();
  if (!text) return false;
  for (const pattern of STATE_MACHINE_KEYWORDS) {
    if (pattern.test(text)) return true;
  }
  return false;
}

/**
 * 判断是否触发自我进化管线（必须 complex）
 * 命中后路由到 complex，由 PlanExecuteLoopStrategy 编排多步工具调用：
 *   1. self_evolution.trigger_tech_scan 触发技术扫描 + LLM 评估
 *   2. self_evolution.list_proposals 查看提案
 *   3. self_evolution.execute_proposal 执行沙箱测试
 */
function shouldUseSelfEvolutionPipeline(message: string): boolean {
  const text = message.trim();
  if (!text) return false;
  for (const pattern of SELF_EVOLUTION_KEYWORDS) {
    if (pattern.test(text)) return true;
  }
  return false;
}

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

/**
 * 任务执行意图检测已收敛到单一来源 task-intent.ts（Option A）：
 * 被 task-router(routeTask) 与 brain/rule-router(routeLight) 共同消费，
 * 避免三套分类各自漂移。此处仅复用其判定。
 *
 * 背景：fast 模式被限制为 toolLoop.maxRounds=1 + 轻量工具子集，无法完成真实多步任务；
 * 而 DELEGATE_KEYWORDS 覆盖太窄，大量自由表达的任务指令（整理/下载/翻译/设置/美化/
 * 做成图表/同步进度…）从关键词夹缝落到 default_fast，导致"完成任务基本不成功"。
 */

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
  /** 最近几条用户消息（时间正序），供短追问继承上一轮的任务意图。 */
  recentUserTurns?: string[];
};

// ── 联网信息需求信号（路由级，2026-08-29）──
// fast 车道只有轻量工具（clock/calendar 等），没有 search_web/deep_search；
// 凡回答必须依赖外部实时信息（吃瓜/新闻/近况/行情/比分…）的轮次都是"要完成查询任务"，
// 一律下沉 complex，由后台真正调搜索工具后回传结果。
// 不复用 forced-tool 的 FRESH_WEB_LOOKUP_RE：它含"怎么样了/什么情况"等宽泛问候语，
// 在路由级会把"你最近怎么样"这类寒暄误升级 complex。
const FRESH_INFO_LOOKUP_RE =
  /搜一搜|搜下|搜索|查查|查一下|查一查|帮我查|联网|八卦|吃瓜|爆料|热搜|头条|资讯|近况|的瓜|新瓜|有什么瓜|扒一扒|扒下|新闻|比分|票房|股价|行情|汇率|上新|新出了|发布了|上映|排片|影讯/i;
const FRESH_INFO_CHAT_OVERRIDE_RE =
  /你最近(怎么样|如何|咋样)|最近(过得|过|咋|怎)么样|最近忙|在忙(什么|啥)|你的近况|你近况/i;

function requiresFreshExternalInfo(text: string): boolean {
  if (!text) return false;
  if (FRESH_INFO_CHAT_OVERRIDE_RE.test(text)) return false;
  return FRESH_INFO_LOOKUP_RE.test(text);
}

// ── 短追问任务意图继承（2026-08-29）──
// "娱乐圈的""新鲜的""景甜的"这类短追问，单看消息本身没有任何任务信号，
// 但在"上一轮还在要求查/办某事"的语境里，它们是同一任务的继续 → 应继承 complex。
// 判定 = 当前消息是短追问（非寒暄/非时间天气）+ 向前找到的第一个"话题锚点"轮次
// 是任务/联网查询（锚点之前连续的短追问视为同一话题链的一部分，跳过）。
const FOLLOWUP_MAX_LEN = 16;

export function isInheritableFollowUpText(text: string): boolean {
  const t = text.trim();
  if (!t || t.length > FOLLOWUP_MAX_LEN) return false;
  if (CHAT_ONLY_RE.test(t) || CASUAL_FAST_CHAT_RE.test(t)) return false;
  if (SIMPLE_CHAT_OVERRIDE_RE.test(t)) return false;
  return true;
}

/**
 * 判断短追问是否应继承任务模式（complex）。
 * recentUserTurns 为时间正序（最旧→最新，不含当前消息）。
 */
export function shouldInheritTaskContinuation(
  text: string,
  recentUserTurns: string[],
  config?: AgentRuntimeConfig,
): boolean {
  if (!isInheritableFollowUpText(text)) return false;
  for (let i = recentUserTurns.length - 1; i >= 0; i--) {
    const turn = (recentUserTurns[i] ?? "").trim();
    if (!turn) continue;
    // 先判任务信号：短任务轮（如"帮我写个方案"）本身就是话题锚点，不能当短追问跳过
    if (routeLlmExecution(turn, config).mode === "complex" || requiresFreshExternalInfo(turn)) {
      return true;
    }
    // 短而无任务信号 → 同一话题链的中间一环，继续回溯；长且无信号 → 锚点是闲聊
    if (isInheritableFollowUpText(turn)) continue;
    return false;
  }
  return false;
}

/**
 * 时效性实体检测：用户消息含"最新/最近/版本号/新发布"等时效信号时,
 * 直接判 complex,避免 fast 凭印象答后检测 hedging 再升级(省一次重复 LLM 调用)。
 * 排除明显闲聊("今天天气真好"/"现在几点"由简单工具处理)。
 */
const TIME_SENSITIVITY_RE =
  /最新|最近|新出的|新出|刚出|刚发布|今年|去年|上周|本周|这周|这个月|上个月/i;
const VERSION_SIGNAL_RE =
  /kimi\s*3|gpt[-\s]*5|claude[-\s]*4|iphone\s*17|macbook\s*m\d|新版|最新款|旗舰款|20\d{2}/i;
const SIMPLE_CHAT_OVERRIDE_RE =
  /几点|天气怎么样|天气如何|今日天气|今天.*天气|天气.*今天|你最近(怎么样|如何|咋样)|最近(过得|过|咋|怎)么样|过得(怎么样|如何|咋样)|在忙(什么|啥)|忙什么呢/i;

function hasTimeSensitiveIntent(text: string): boolean {
  if (SIMPLE_CHAT_OVERRIDE_RE.test(text)) return false;
  return TIME_SENSITIVITY_RE.test(text) || VERSION_SIGNAL_RE.test(text);
}

/**
 * 判断是否为桌面自动化任务(用于 complex 分支区分后台 vs 同步)。
 * 导出供 agent-core 复用,避免重复调 shouldUseStateMachineMode。
 */
export function isDesktopAutomationTask(text: string): boolean {
  return shouldUseStateMachineMode(text);
}

/**
 * 判断回复是否需要做短句分段。
 *
 * 规则：
 *  - complex 模式 → 不分段（工具/搜索/子Agent/桌面自动化，全是信息性文本）
 *  - fast 模式：
 *     - 纯寒暄/闲聊（CHAT_ONLY_RE / CASUAL_FAST_CHAT_RE）→ 分段
 *     - 工具查询/知识问答（TOOL_OR_REALTIME_RE / INFORMATIONAL_REQUEST_RE）→ 不分段
 *     - 其他普通短对话 → 分段
 */
export function determineSegmentable(text: string, mode: LlmExecutionMode): boolean {
  if (mode === "complex") return false;
  const t = text.trim();
  if (CHAT_ONLY_RE.test(t) || CASUAL_FAST_CHAT_RE.test(t)) return true;
  if (TOOL_OR_REALTIME_RE.test(t) || INFORMATIONAL_REQUEST_RE.test(t)) return false;
  return true;
}

/**
 * 双模式路由：Fast（前台秒回 + 垫词 + 轻工具）vs Complex（后台并行 + 子 Agent 委派）。
 *
 * 映射规则：
 *  - 旧 fast_chat / direct_llm / master_only / cognize 直返 → fast
 *  - 旧 master_delegate / plan_execute / state_machine → complex
 *  - complex 时 Fast 仍并行运行（垫词 + 即时反馈），Complex 在后台执行
 */
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
      return { mode: "fast", reasons, segmentable: determineSegmentable(text, "fast") };
    }

    // 桌面自动化任务 → complex
    if (shouldUseStateMachineMode(text)) {
      reasons.push("desktop_automation");
      return { mode: "complex", reasons, segmentable: false };
    }

    // 需要委派子 Agent 的任务 → complex
    if (requiresSubAgent(text)) {
      reasons.push("requires_sub_agent");
      return { mode: "complex", reasons, segmentable: false };
    }

    // 时效性实体前置：含"最新/最近/版本号"等 → 直接 complex(避免 fast 凭印象答后升级)
    if (hasTimeSensitiveIntent(text)) {
      reasons.push("time_sensitive_intent");
      return { mode: "complex", reasons, segmentable: false };
    }

    // 任务执行意图：整理/下载/翻译/设置/美化/做成图表/同步进度等祈使指令 →
    // complex（fast 只有 maxRounds=1 + 轻量工具，无法完成真实多步任务）
    if (isActionableTaskRequest(text)) {
      reasons.push("task_execution_intent");
      return { mode: "complex", reasons, segmentable: false };
    }

    // 多步任务 / 明确做事意图 → complex（让 plan-execute 在本分支也生效）
    if (shouldUsePlanExecuteLoop(text)) {
      reasons.push("plan_execute_heuristic");
      return { mode: "complex", reasons, segmentable: false };
    }

    // 联网信息需求 → complex：fast 没有搜索工具，"要查才能答"的轮次必须后台真查
    if (requiresFreshExternalInfo(text)) {
      reasons.push("fresh_external_info");
      return { mode: "complex", reasons, segmentable: false };
    }

    // 短追问继承：单条消息无任务信号，但话题锚点轮次是任务/查询 → 沿用 complex
    if (
      options?.recentUserTurns?.length &&
      shouldInheritTaskContinuation(text, options.recentUserTurns, config)
    ) {
      reasons.push("follow_up_task_continuation");
      return { mode: "complex", reasons, segmentable: false };
    }

    // 其余全部走 fast（含简单工具、寒暄、追问、本地代码任务）
    reasons.push("fast_lane");
    return { mode: "fast", reasons, segmentable: determineSegmentable(text, "fast") };
  }

  // masterDelegation 未启用时，多步任务走 complex
  if (shouldUsePlanExecuteLoop(text)) {
    reasons.push("plan_execute_heuristic");
    return { mode: "complex", reasons, segmentable: false };
  }

  reasons.push("default_fast");
  return { mode: "fast", reasons, segmentable: determineSegmentable(text, "fast") };
}
