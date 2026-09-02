/**
 * L1 意图分类 + L2 路由决策（2026-09-02 架构收敛：分类与决策分离）。
 *
 * 根因回顾：旧架构让一次轻量 LLM 调用直接回答"fast 还是 complex"——模型在替
 * 架构做主，开放词汇下误判即静默失败（「刘浩存最近的消息」「帮我搜索景甜的照片」
 * 两个真实案例），只能靠正则打地鼠。新契约（成熟 router 模式：classify-then-route）：
 *
 *   L0 规则短路层（纯代码，零 LLM 成本）：高精度寒暄/口头禅直接判 chat；
 *      短追问继承活动任务上下文；词法判 complex 直接采纳。
 *   L1 结构化意图分类器（一次小模型调用）：只输出封闭标签集内的
 *      {"intent","confidence"} JSON——模型只做语义理解，不对车道做主。
 *   L2 路由决策层（纯代码）：意图→车道查 intent-router 的路由表；
 *      置信度 < 阈值 fail-safe 转 complex；词法硬信号只能升不能降。
 *
 * 工程约束：
 *   - 输出预算小（JSON 单对象，max_tokens=128），超时 LLM_ROUTE_TIMEOUT_MS（默认 3000ms）；
 *   - 失败/超时/不可解析 → 降级 routeLlmExecution 词法判定（reasons 标注
 *     llm_route_fallback），provider 异常时路由不瘫痪；
 *   - 同 (文本+上下文) 结果缓存 5 分钟：消息批处理重入、agent-core 复用 WS 决策时不重复计费；
 *   - 使用独立路由会话（llm-route:: 前缀），不污染聊天线程上下文。
 */
import type { ExternalChatProvider } from "../external-model/types.js";
import {
  routeLlmExecution,
  determineSegmentable,
  shouldInheritTaskContinuation,
  shouldUseFastChatLane,
  type RouteDecision,
} from "./task-router.js";
import {
  isIntentLabel,
  parseIntentJson,
  routePlanForIntent,
  type IntentLabel,
} from "./intent-router.js";
import { getAgentRuntimeConfig, type AgentRuntimeConfig } from "./agent-runtime-config.js";

const CACHE_TTL_MS = 5 * 60_000;
const CACHE_MAX = 300;
const ROUTE_SESSION_PREFIX = "llm-route::";
/** 置信度 fail-safe 阈值：低于它不放回 fast（错放 fast 代价是静默失败，错放 complex 只是慢）。 */
const INTENT_CONFIDENCE_FAIL_SAFE = 0.55;

function resolveTimeoutMs(): number {
  const raw = process.env.LLM_ROUTE_TIMEOUT_MS?.trim();
  const n = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : 3000;
}

function buildRoutePrompt(text: string, recentUserTurns: string[]): string {
  const lines: string[] = [
    "你是双脑架构的意图路由器。对话脑(fast)像朋友一样聊天；执行脑(complex)在后台真正调用工具把事办完。你的任务只有一个：判断这条用户消息的意图标签。",
    "",
    '只输出一个 JSON 对象，格式：{"intent":"标签","confidence":0.0到1.0}。不要输出任何其他字符。',
    "intent 必须且只能取以下封闭集之一：",
    "- chat：纯对话。寒暄、情绪、观点交流、评价、闲聊追问，凭常识或已有上下文就能答的内容。问你的近况/想法/感受也是 chat。",
    "- knowledge_qa：常识/知识问答（不依赖实时信息，如原理、历史、解释）。",
    "- realtime_lookup：需要外部实时信息——新闻、某人近况、最新消息、价格行情、热搜、比分、排片等，答准了必须现查的。",
    "- media_retrieval：找图片/照片/视频/壁纸/表情包。",
    "- action_write：写数据/有副作用的操作——创建或修改日程提醒、发消息、下单、支付等。",
    "- multi_step_task：多步操作、操作软件/电脑/设备、或以上都没贴切的办事请求。",
    "- meta_capability：询问你能做什么/系统状态。",
    "",
    "判定要点：",
    "- 实时信息类哪怕没有「查/搜」字样（如「刘浩存最近的消息」「今天A股怎么样」）也是 realtime_lookup。",
    "- confidence 表达你对标签判断的把握；判不准就给低分（<0.5），系统会自动走保守车道，不会出错。",
    "- 短追问（如「娱乐圈的」「新鲜的」）按它继承的话题判——语境见最近对话。",
    "",
  ];
  if (recentUserTurns.length > 0) {
    lines.push("最近对话（最旧在前，仅供理解话题）：");
    for (const turn of recentUserTurns.slice(-4)) {
      lines.push(`- ${turn}`);
    }
    lines.push("");
  }
  lines.push(`用户消息：${text}`);
  return lines.join("\n");
}

const routeCache = new Map<string, { decision: RouteDecision; at: number }>();

function cacheGet(key: string): RouteDecision | undefined {
  const hit = routeCache.get(key);
  if (!hit) return undefined;
  if (Date.now() - hit.at > CACHE_TTL_MS) {
    routeCache.delete(key);
    return undefined;
  }
  return hit.decision;
}

function cacheSet(key: string, decision: RouteDecision): void {
  if (routeCache.size >= CACHE_MAX) {
    const oldest = routeCache.keys().next().value;
    if (oldest !== undefined) routeCache.delete(oldest);
  }
  routeCache.set(key, { decision, at: Date.now() });
}

function lexicalFallback(
  text: string,
  recentUserTurns: string[],
  reason: string,
): RouteDecision {
  const decision = routeLlmExecution(text, undefined, { recentUserTurns });
  return {
    ...decision,
    reasons: [`llm_route_fallback:${reason}`, ...decision.reasons],
  };
}

/**
 * 三层路由唯一权威入口。任何异常都不抛出——最坏情况降级为词法判定。
 */
export async function routeTurnByLlm(
  externalChat: ExternalChatProvider | null,
  sessionId: string,
  text: string,
  recentUserTurns: string[] = [],
): Promise<RouteDecision> {
  const trimmed = text.trim();
  if (!trimmed) {
    return {
      mode: "fast",
      reasons: ["llm_route:empty_text"],
      segmentable: true,
      intent: "chat",
      confidence: 1,
    };
  }
  const key = JSON.stringify([trimmed, recentUserTurns]);
  const hit = cacheGet(key);
  if (hit) return hit;

  const config: AgentRuntimeConfig = getAgentRuntimeConfig();

  // ── L0 规则短路层（零 LLM 成本）──
  // 高精度寒暄/口头禅 + 词法认同 fast → 直接判 chat（如「在吗」「好的」）。
  // 短追问继承判定优先（「就这些吗」跟活动任务走）。
  // 词法与 L0 相左（判 complex）时不盲信词法——落给 L1 分类 + L2 细分裁决
  // （词法的 task_execution_intent 会把「给我几张美照」这类 fast 可执行的
  // 媒体请求误判 complex，细分规则在下方 L2 才有意图标签可依）。
  if (
    shouldUseFastChatLane(trimmed) &&
    !shouldInheritTaskContinuation(trimmed, recentUserTurns, config) &&
    routeLlmExecution(trimmed, undefined, { recentUserTurns }).mode === "fast"
  ) {
    const decision: RouteDecision = {
      mode: "fast",
      reasons: ["l0_short_circuit:chat"],
      segmentable: true,
      intent: "chat",
      confidence: 0.9,
    };
    cacheSet(key, decision);
    return decision;
  }

  if (!externalChat?.isEnabled()) {
    const decision = lexicalFallback(trimmed, recentUserTurns, "provider_disabled");
    cacheSet(key, decision);
    return decision;
  }

  const prompt = buildRoutePrompt(trimmed, recentUserTurns);
  const timeoutMs = resolveTimeoutMs();
  try {
    const result = await Promise.race([
      externalChat.streamCompletion(
        `${ROUTE_SESSION_PREFIX}${sessionId}`,
        { text: prompt },
        () => {}, // 路由判定无需流式回传
        undefined,
        // 独立路由会话 + 裁剪到最近 2 条：上下文不随轮数增长，也不污染聊天线程。
        // maxOutputTokens 需容纳 provider 注入的 [ts:...] 前缀 + JSON 单对象。
        { maxOutputTokens: 128, maxThreadMessages: 2 },
      ),
      new Promise<undefined>((r) => setTimeout(() => r(undefined), timeoutMs)),
    ]);

    // ── L1 结构化意图解析 ──
    const parsed = parseIntentJson(result);
    if (!parsed) {
      console.warn(
        `[LlmTaskRouter] 不可解析输出（${(result ?? "").slice(0, 40)}），降级词法路由`,
      );
      const decision = lexicalFallback(trimmed, recentUserTurns, "unparseable_output");
      cacheSet(key, decision);
      return decision;
    }
    if (!isIntentLabel(parsed.intent)) {
      const decision = lexicalFallback(trimmed, recentUserTurns, "invalid_intent");
      cacheSet(key, decision);
      return decision;
    }

    // ── L2 路由决策层（纯代码裁决）──
    const plan = routePlanForIntent(parsed.intent);
    const reasons: string[] = [
      `llm_intent:${parsed.intent}@${parsed.confidence.toFixed(2)}`,
      `route_table:${plan.lane}/${plan.toolset}/arbiter-${plan.arbiter}`,
    ];

    // 词法硬底线（只能升不能降）：LLM 判 fast 车道但词法命中硬信号 → 否决升 complex。
    // 此前 LLM 路由是"唯一权威"，判错时词法信号被整个绕过——新契约：LLM 管开放
    // 词汇的语义理解，词法管已知硬信号，且词法单向（只能升级）。
    // 分寸（2026-09-02）：realtime_lookup / media_retrieval 的"任务性"词法信号
    // （time_sensitive / task_execution_intent / fresh_external_info）在 fast 车道
    // 是可执行的（fast 已携搜索+媒体工具）——只对 fast 真正办不了的能力否决
    // （委派/桌面自动化/多步编排/短追问继承）；chat/knowledge_qa/meta 无工具，
    // 保留全量否决。
    if (plan.lane === "fast") {
      const lexical = routeLlmExecution(trimmed, undefined, { recentUserTurns });
      if (lexical.mode === "complex") {
        const fastExecutableReasons = new Set([
          "time_sensitive_intent",
          "task_execution_intent",
          "fresh_external_info",
        ]);
        const searchCapableIntent =
          parsed.intent === "realtime_lookup" || parsed.intent === "media_retrieval";
        const allReasonsFastExecutable =
          searchCapableIntent &&
          lexical.reasons.length > 0 &&
          lexical.reasons.every((r) => fastExecutableReasons.has(r));
        if (!allReasonsFastExecutable || parsed.intent === "chat") {
          const decision: RouteDecision = {
            mode: "complex",
            reasons: [...reasons, "lexical_veto_hard_signal", ...lexical.reasons],
            segmentable: false,
            intent: parsed.intent,
            confidence: parsed.confidence,
          };
          cacheSet(key, decision);
          return decision;
        }
      }
      // 置信度 fail-safe：低置信 chat 不放回 fast（错放 fast = 静默失败，错放 complex 只是慢）
      if (parsed.intent === "chat" && parsed.confidence < INTENT_CONFIDENCE_FAIL_SAFE) {
        const decision: RouteDecision = {
          mode: "complex",
          reasons: [...reasons, `low_confidence_fail_safe(<${INTENT_CONFIDENCE_FAIL_SAFE})`],
          segmentable: false,
          intent: parsed.intent,
          confidence: parsed.confidence,
        };
        cacheSet(key, decision);
        return decision;
      }
    }

    const decision: RouteDecision = {
      mode: plan.lane,
      reasons,
      segmentable: plan.lane === "fast" ? determineSegmentable(trimmed, "fast") : false,
      intent: parsed.intent,
      confidence: parsed.confidence,
    };
    cacheSet(key, decision);
    return decision;
  } catch (err) {
    console.warn(
      "[LlmTaskRouter] 路由调用失败，降级词法路由:",
      err instanceof Error ? err.message : String(err),
    );
    // 失败结果不缓存：provider 恢复后下一轮立即回到语义路由
    return lexicalFallback(trimmed, recentUserTurns, "call_failed");
  }
}

export type { IntentLabel };
