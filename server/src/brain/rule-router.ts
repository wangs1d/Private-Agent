// Agent Brain Center — RuleRouter（规则驱动路由器）
//
// 职责：双模式路由判定，基于多维度规则匹配产出 fast / complex 决策。
//
// 设计原则：
//  1. 不调用 LLM——纯规则匹配，结果可预测、可调试
//  2. 多维度匹配：关键词 + 信号类型 + 工具能力 + 上下文指代
//  3. 输出完整决策：{mode, confidence, reason, matchedRules, system}
//  4. 置信度由规则命中强度计算，不依赖 LLM 语义评判
//
// 路由分类：
//  - fast: 闲聊/简单问答/简单工具调用/追问（主 Agent 自带工具，前台秒回）
//  - complex: 深度调研/写代码/桌面自动化/转账下单/写文案/复杂多步（后台委派子 Agent）

import type {
  CognitiveContext,
  SystemRouteDecision,
  SystemRouteMode,
} from "./types.js";
import { isActionableTaskRequest } from "../agent/task-intent.js";

// ---- 规则匹配结果 --------------------------------------------------------

export interface RuleRouteDecision {
  mode: SystemRouteMode;
  confidence: number;       // 0-1，规则匹配强度
  reason: string;           // 规则命中说明
  matchedRules: string[];   // 命中的规则列表（用于调试）
  system: "system1" | "system2";
  /** 委派目标子 Agent 类型（仅 complex 时有值） */
  agentType?: "tech" | "info" | "life";
}

// ---- 关键词词典 ----------------------------------------------------------

/**
 * 闲聊白名单：命中即走 direct_llm，confidence=0.9。
 * 优先级最高，避免"你好"被误判为委派任务。
 */
const CHITCHAT_KEYWORDS: string[] = [
  // 打招呼
  "你好", "早上好", "中午好", "晚上好", "嗨", "hi", "hello", "嘿",
  // 道别
  "再见", "拜拜", "晚安", "bye",
  // 感谢
  "谢谢", "感谢", "thanks", "多谢",
  // 简单应答
  "好的", "嗯", "哦", "ok", "okay",
];

/**
 * 简单工具关键词：命中即走 direct_llm + needsToolLoop=true，confidence=0.85。
 * 这些场景主 Agent 自带工具能力（天气/时钟/日历/search_web），无需委派。
 */
const SIMPLE_TOOL_KEYWORDS: string[] = [
  // 时间类
  "几点", "什么时间", "现在时间", "时间", "日期", "今天几号",
  // 天气类
  "天气", "气温", "下雨", "下雪",
  // 日历类
  "日历", "日程", "提醒我",
  // 简单查询
  "搜索", "查一下", "查查", "search",
];

/**
 * 紧急/敏感事务关键词：命中即走 master_delegate，confidence=0.95。
 * 需要走子 Agent + 严格安全检查。
 */
const URGENT_TRANSACTION_KEYWORDS: string[] = [
  // 资金类
  "转账", "付款", "支付", "充值", "提现", "退款", "还款",
  // 订单类
  "下单", "订票", "订餐", "购买", "买", "预订",
  // 敏感操作
  "删除账户", "修改密码", "实名认证",
];

/**
 * 委派倾向词：按子 Agent 类型分组。
 * 与 PlannerCortex DELEGATE_KEYWORDS 保持一致，扩展后用于 RuleRouter。
 */
const DELEGATE_KEYWORDS: Record<"tech" | "info" | "life", string[]> = {
  tech: [
    "打开", "操作", "rpa", "自动化", "批量", "安装", "配置", "系统",
    "浏览器", "运行", "桌面", "写代码", "调试", "部署", "脚本", "截屏",
    "截图", "操作电脑",
  ],
  info: [
    "研究", "调研", "对比", "比较", "深度分析", "查找", "查多个",
    "分析", "评测", "比价", "推荐", "测评",
  ],
  life: [
    "订餐", "购物", "预订", "打车", "点外卖", "买菜", "预约",
  ],
};

/**
 * 多步连词：每命中一个，估算步骤数 +1。
 */
const STEP_CONJUNCTIONS: string[] = [
  "然后", "接着", "再", "之后", "第一步", "第二步", "第三步",
  "第四步", "第五步", "最后", "并", "且",
];

/**
 * 动作动词：用于步骤数估算。
 */
const ACTION_VERBS: string[] = [
  "打开", "搜索", "查找", "查询", "检索", "对比", "比较", "分析",
  "生成", "操作", "配置", "运行", "安装", "发送", "下载", "上传",
  "处理", "计算", "统计", "创建", "删除", "修改", "调研", "研究",
  "预订", "下单", "购买", "打车", "浏览", "重命名", "整理", "执行",
  "收集", "清理", "汇总", "结束", "导入", "导出", "归档", "压缩",
  "打包", "登录", "填写", "提交", "截图", "克隆", "批量", "重启", "验证",
];

/** 步骤数阈值：估算步骤数 > 该值才考虑委派 */
const DELEGATE_STEP_THRESHOLD = 3;

/**
 * 追问指代词：检测用户是否在追问上文。
 * 命中追问词时，倾向于 direct_llm（让 streamCompletion 基于上下文回答），
 * 避免 LLM 路由幻觉。
 * 扩展（2026-07-29）：覆盖「再具体一点呢 / 展开说说 / 细说 / 怎么弄」等常见追问
 * —— 原列表只覆盖了指代词类，遗漏了大量语义类追问，导致 followUpAnchor 不注入、
 * 追问时记忆字段被压缩丢失，出现"对话岔开"现象。
 */
const FOLLOWUP_INDICATORS: string[] = [
  // 指代类（原有）
  "那个", "它", "这个", "前面那个", "刚才说的", "继续", "然后呢",
  "接着说", "还有呢", "另外呢",
  // 追问动词类（新增）—— 让 direct_llm 走 streamCompletion 上下文
  "再具体", "具体点", "具体一点", "具体一些", "具体讲讲", "具体说说",
  "再详细", "详细点", "详细一点", "详细一些", "详细讲讲", "详细说说",
  "展开", "展开说说", "展开讲讲", "展开聊聊", "展开描述", "展开一下",
  "细说", "细讲", "说细点", "讲细点",
  "解释", "解释一下", "解释下",
  "继续说", "继续讲", "继续聊", "往下说", "往下讲",
  "怎么弄", "怎么办", "咋办", "为何", "为啥",
  "你说呢", "你觉得呢", "给我看看", "给我讲讲", "给我说说", "给我聊聊",
  "聊一聊", "讲一讲", "说一说", "说说看", "讲讲看", "聊聊看",
  "具体咋办", "具体怎么弄",
];

/**
 * 用户陈述类信号：消息里包含具体数值/事实时，判定为"用户在陈述/分享"，
 * 不是"用户在查询"。此时不走 userLocation 反查、不主动反问"你是不是在 XX"，
 * 避免 LLM 把"用户给数据"误判成"用户要数据"导致答非所问。
 *
 * 例：
 *   "今天20到26度，出门带把伞" → 用户在陈述，不需要查天气
 *   "我下个月去贵州兴义玩"     → 用户在陈述行程，不需要查位置
 */
const USER_STATING_DATA_RE = [
  // 天气类陈述：含具体温度/降水/风力数值
  /\d+\s*(?:到|~|～|-)\s*\d+\s*(?:度|℃|°|celsius)/i,
  /(?:气温|温度|体感)[^，。]*?\d+/i,
  /\d+\s*%(?:\s*(?:降水|降雨|湿度|相对湿度|概率))?/i,
  /(?:微风|大风|阵风|台风|暴雨|大雨|中雨|小雨|雷阵雨)[^，。]*?(?:预报|预计|报告)/i,
  // 行程/位置类陈述：含"我(要|准备|打算|下|明|后)...去/到/在"
  /(?:我|我们)\s*(?:要|准备|打算|计划|下(?:周|个月)|明(?:天|年)?|后(?:天|年)?|这(?:周|个月))\s*(?:去|到|在|回|出发|飞|坐|开车|坐车|赶)/i,
  /(?:我|我们)\s*(?:已经|已)\s*(?:到|在|抵达|到达)\s*\S+/i,
  // 时间陈述：含具体日期+动作
  /(?:今天|昨天|明天|后天|大后天)\s*(?:上午|下午|晚上|凌晨|\d+\s*点)\s*(?:我|我们|你|他|她)\s*(?:要|准备|打算|已经)/i,
];

/**
 * 是否命中"用户在陈述数据"模式（不是查询）
 */
function isUserStatingData(text: string): boolean {
  return USER_STATING_DATA_RE.some((re) => re.test(text));
}

// ---- RuleRouter 主类 ----------------------------------------------------

/**
 * 规则驱动路由器。
 *
 * 替代 cognize 阶段 2 的 LLM 路由判断，纯规则匹配产出完整路由决策。
 *
 * 匹配优先级（高到低）：
 *  1. 紧急/敏感事务关键词 → complex, conf=0.95
 *  2. 闲聊白名单 → fast, conf=0.9
 *  3. 简单工具关键词 → fast, conf=0.85
 *  4. 追问指代词 → fast, conf=0.7（让 streamCompletion 基于上下文回答）
 *  5. 委派倾向词 + 步骤数 > 3 → complex, conf=0.8
 *  6. 委派倾向词 + 步骤数 ≤ 3 → fast, conf=0.6（轻量场景主 Agent 自处理）
 *  7. 无匹配 → fast, conf=0.5（默认走主 Agent）
 */
export class RuleRouter {
  /**
   * 规则路由主入口。
   *
   * @param userText 用户消息文本
   * @param _context 认知上下文（含能力/记忆等，当前规则未用，预留扩展）
   * @returns 路由决策
   */
  route(
    userText: string,
    _context?: CognitiveContext,
  ): RuleRouteDecision {
    const now = new Date().toISOString();
    const text = (userText ?? "").trim();
    if (!text) {
      return {
        mode: "fast",
        confidence: 0.5,
        reason: "empty_input",
        matchedRules: ["empty_input"],
        system: "system1",
      };
    }

    const msg = text.toLowerCase();
    const matchedRules: string[] = [];

    // === 规则 1：紧急/敏感事务关键词（最高优先级）===
    for (const kw of URGENT_TRANSACTION_KEYWORDS) {
      if (msg.includes(kw.toLowerCase())) {
        matchedRules.push(`urgent:${kw}`);
        // 紧急事务都映射到 life 子 Agent（资金/订单/敏感操作）
        return {
          mode: "complex",
          confidence: 0.95,
          reason: `紧急/敏感事务关键词命中：${kw}（委派 life 子 Agent + 安全检查）`,
          matchedRules,
          system: "system2",
          agentType: "life",
        };
      }
    }

    // === 规则 2：闲聊白名单 ===
    for (const kw of CHITCHAT_KEYWORDS) {
      if (msg.includes(kw.toLowerCase())) {
        matchedRules.push(`chitchat:${kw}`);
        return {
          mode: "fast",
          confidence: 0.9,
          reason: `闲聊关键词命中：${kw}（主 Agent 直接回复，无需工具）`,
          matchedRules,
          system: "system1",
        };
      }
    }

    // === 规则 3：简单工具关键词 ===
    const matchedSimpleTools: string[] = [];
    for (const kw of SIMPLE_TOOL_KEYWORDS) {
      if (msg.includes(kw.toLowerCase())) {
        matchedSimpleTools.push(kw);
      }
    }
    if (matchedSimpleTools.length > 0) {
      matchedRules.push(`simple_tool:${matchedSimpleTools.join(",")}`);
      return {
        mode: "fast",
        confidence: 0.85,
        reason: `简单工具关键词命中：${matchedSimpleTools.join(",")}（主 Agent 自带工具，走工具循环）`,
        matchedRules,
        system: "system1",
      };
    }

    // === 规则 4：追问指代词 ===
    for (const kw of FOLLOWUP_INDICATORS) {
      if (msg.includes(kw)) {
        matchedRules.push(`followup:${kw}`);
        return {
          mode: "fast",
          confidence: 0.7,
          reason: `追问指代词命中：${kw}（让 streamCompletion 基于上下文回答，避免 LLM 路由幻觉）`,
          matchedRules,
          system: "system1",
        };
      }
    }

    // === 规则 4.5：用户陈述数据（含具体数值/事实）→ direct_llm，跳过 userLocation 反查 ===
    // 原 BUG：用户给"今天20到26度"会被 LLM 误判为"用户要查天气"，
    // 触发 userLocation 反问"你是不是在 XX"导致答非所问、对话岔开。
    // 新增（2026-07-29）：含具体温度/降水/行程/日期动作的句子，判定为"陈述"而非"查询"，
    // 让主 Agent 走 direct_llm 正常回复，userLocation 不主动注入反问语境。
    if (isUserStatingData(text)) {
      matchedRules.push("user_stating_data:skip_location_probe");
      return {
        mode: "fast",
        confidence: 0.8,
        reason:
          "用户陈述具体数据（含温度/降水/行程/日期动作），非查询；跳过 userLocation 反问，主 Agent 直接回复",
        matchedRules,
        system: "system1",
      };
    }

    // === 规则 5/6：委派倾向词 + 步骤数估算 ===
    let stepCount = 1;
    for (const conj of STEP_CONJUNCTIONS) {
      if (msg.includes(conj)) stepCount++;
    }
    for (const verb of ACTION_VERBS) {
      if (msg.includes(verb)) stepCount++;
    }

    // 匹配委派倾向词，按 tech > info > life 优先级
    let matchedAgentType: "tech" | "info" | "life" | undefined;
    const matchedDelegateKws: string[] = [];
    for (const agentType of ["tech", "info", "life"] as const) {
      const keywords = DELEGATE_KEYWORDS[agentType];
      for (const kw of keywords) {
        if (msg.includes(kw.toLowerCase())) {
          matchedDelegateKws.push(`${agentType}:${kw}`);
          if (!matchedAgentType) matchedAgentType = agentType;
        }
      }
      if (matchedAgentType) break;
    }

    if (matchedAgentType && stepCount > DELEGATE_STEP_THRESHOLD) {
      // 规则 5：多步 + 委派倾向词 → master_delegate
      matchedRules.push(`delegate_multi_step:${matchedAgentType}(steps=${stepCount})`);
      matchedRules.push(...matchedDelegateKws);
      return {
        mode: "complex",
        confidence: 0.8,
        reason: `多步任务委派（步骤数≈${stepCount}，匹配${matchedAgentType}类关键词：${matchedDelegateKws.length}个）`,
        matchedRules,
        system: "system2",
        agentType: matchedAgentType,
      };
    }

    if (matchedAgentType && stepCount <= DELEGATE_STEP_THRESHOLD) {
      // 规则 6：单步 + 委派倾向词 → direct_llm（主 Agent 自处理，工具循环）
      matchedRules.push(`delegate_single_step:${matchedAgentType}(steps=${stepCount})`);
      matchedRules.push(...matchedDelegateKws);
      return {
        mode: "fast",
        confidence: 0.6,
        reason: `单步任务带工具意图（步骤数≈${stepCount}，匹配${matchedAgentType}类关键词，主 Agent 自处理）`,
        matchedRules,
        system: "system1",
      };
    }

    // === 规则 6.5：泛化任务执行意图（无强域名关键词时兜底） ===
    // 与 task-router 共用单一来源 task-intent.ts，避免两套分类漂移。
    // fast 是 maxRounds=1 + 轻量工具 的有损模式，带做事意图但无法自信判定为
    // 简单闲聊/纯提问/实时单一查询的指令 → complex，确保自由表达的任务指令被真正执行。
    // 注：路由最终门控为 OR（agent-core: shouldGoComplex = routeTask复杂 || routeLight复杂），
    // 此处的 complex 只会让任务升级，不会把 fast 降级，因此安全。
    if (isActionableTaskRequest(text)) {
      matchedRules.push("task_execution_intent");
      return {
        mode: "complex",
        confidence: 0.75,
        reason: "泛化任务执行意图命中（祈使/动作-对象，无法自信判定为闲聊/纯提问，升 complex 确保执行）",
        matchedRules,
        system: "system2",
        agentType: "tech",
      };
    }

    // === 规则 7：无匹配 → 默认 direct_llm ===
    matchedRules.push("no_match:default_fast");
    return {
      mode: "fast",
      confidence: 0.5,
      reason: "无关键词命中（默认主 Agent 自处理，走工具循环）",
      matchedRules,
      system: "system1",
    };
  }

  /**
   * 把 RuleRouteDecision 转换为 SystemRouteDecision（用于 cognize 返回）。
   */
  toSystemRouteDecision(
    userMessage: string,
    decision: RuleRouteDecision,
  ): SystemRouteDecision {
    return {
      userMessage,
      system: decision.system,
      mode: decision.mode,
      rationale: decision.reason,
      decidedAt: new Date().toISOString(),
    };
  }
}
