/**
 * L1 语义意图分类 + L2 路由决策（2026-09-05 前后台架构，根源化收敛）。
 *
 * 契约（classify-then-route）：
 *   L1 结构化意图分类器（一次小模型调用）：只输出封闭标签集内的
 *      {"intent","confidence"} JSON，并顺带产出情绪/话题辅助分析
 *      （与 MoodInferenceService 的每轮独立分析调用合并，省一次调用）。
 *   L2 路由决策层（纯代码）：意图→执行计划查 intent-router 路由表。
 *
 * 已删除（2026-09-05 前后台架构收敛）：
 *   - L0 高精度闲聊短路 / L0.5 显式写动作词法安全网：词表是打地鼠的根源。
 *     默认走前台自决模式（isForegroundDispatchMode），前台自带 task.dispatch
 *     原语 + 出口诚实闸，「写动作被误判」从入口词法问题变成出口契约校验，
 *     两层词法网都没有存在的必要。本函数仅在 AGENT_FOREGROUND_DISPATCH=0
 *     的遗留灰度模式下被调用。
 *   - 低置信 fail-safe（confidence<0.55 强转任务面）：前台自决模式下不存在
 *     「错放对话面=静默失败」——前台可 dispatch 可快查，无需 conservatism。
 *
 * 工程约束：
 *   - 输出预算小（JSON 单对象，max_tokens=192），超时 LLM_ROUTE_TIMEOUT_MS（默认 3000ms）；
 *   - 失败/超时/不可解析 → 保守降级（高精度闲聊外一律任务面，遗留模式语义）；
 *   - 同 (文本+上下文) 结果缓存 5 分钟：消息批处理重入、agent-core 复用 WS 决策时不重复计费；
 *   - 使用独立路由会话（llm-route:: 前缀），不污染聊天线程上下文。
 */
import type { ExternalChatProvider } from "../external-model/types.js";
import { isHighPrecisionChatText, type RouteDecision } from "./task-router.js";
import { isForegroundDispatchMode, foregroundSelfDispatchDecision } from "./task-router.js";
import {
  isIntentLabel,
  parseIntentJson,
  routePlanForIntent,
  type IntentLabel,
} from "./intent-router.js";

const CACHE_TTL_MS = 5 * 60_000;
const CACHE_MAX = 300;
const ROUTE_SESSION_PREFIX = "llm-route::";

function resolveTimeoutMs(): number {
  const raw = process.env.LLM_ROUTE_TIMEOUT_MS?.trim();
  const n = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : 3000;
}

function buildRoutePrompt(
  text: string,
  recentUserTurns: string[],
  activeTasksSummary?: string,
): string {
    const lines: string[] = [
      "你是双面架构的意图路由器。对话面对话直答（零工具）；任务面在后台真正调用工具把事办完。你的任务只有一个：判断这条用户消息的意图标签。",
      "",
      '只输出一个 JSON 对象，格式：{"intent":"标签","confidence":0.0到1.0,"sentiment":<-1到1的小数，用户情绪>,"tags":[<最多3个情绪标签>],"topics":[<1-3个话题关键词>]}。不要输出任何其他字符。',
      "intent 必须且只能取以下封闭集之一：",
      "- chat：纯对话。寒暄、情绪、观点交流、评价、闲聊追问，凭常识或已有上下文就能答的内容。问你的近况/想法/感受也是 chat。",
      "- knowledge_qa：常识/知识问答（不依赖实时信息，如原理、历史、解释）。",
      "- realtime_lookup：需要外部实时信息——新闻、某人近况、最新消息、价格行情、热搜、比分、排片、天气等，答准了必须现查的。",
      "- media_retrieval：找图片/照片/视频/壁纸/表情包。",
      "- action_write：写数据/有副作用的操作——创建或修改日程提醒、发消息、下单、支付等。",
      "- multi_step_task：多步操作、操作软件/电脑/设备、或以上都没贴切的办事请求。",
      "- meta_capability：询问你能做什么/系统状态。",
      "",
      "判定要点：",
      "- 实时信息类哪怕没有「查/搜」字样（如「刘浩存最近的消息」「今天A股怎么样」「比特币现在什么价」）也是 realtime_lookup。",
      "- 天气查询是 realtime_lookup（需要实时数据）；感叹天气（「今天天气真好」）是 chat。",
      "- confidence 表达你对标签判断的把握；判不准就给低分（<0.5），系统会自动走保守平面，不会出错。",
      "- 短追问（如「娱乐圈的」「新鲜的」）按它继承的话题判——语境见最近对话与后台任务。",
      "- sentiment/tags/topics 是顺带分析（情绪与话题），省略不报错，但尽量都给。",
      "",
    ];
  if (activeTasksSummary?.trim()) {
    lines.push("当前正在后台执行的任务（若本消息是在过问/修正这些任务，按其话题判意图）：");
    lines.push(activeTasksSummary.trim());
    lines.push("");
  }
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

function chatDecision(reason: string): RouteDecision {
  return {
    mode: "fast",
    reasons: [reason],
    segmentable: true,
    intent: "chat",
    confidence: 0.9,
    plane: "chat",
    capabilities: [],
    budget: 0,
    tier: "fast",
  };
}

/* ── 保守降级（遗留灰度模式专用）──
 * 路由失败时的兜底：高精度闲聊外一律任务面（无话题词表——保守原则本身就是兜底）。
 * 前台自决模式不经过这里（路由调用被整体跳过）。
 */
function conservativeFallback(text: string, reason: string): RouteDecision {
  if (isHighPrecisionChatText(text)) {
    return chatDecision(`${reason}:high_precision_chat`);
  }
  return {
    mode: "complex",
    reasons: [`${reason}:conservative_task_plane`],
    segmentable: false,
    plane: "task",
    capabilities: ["full"],
    budget: 2,
    tier: "fast",
  };
}

/**
 * 解析路由输出里顺带携带的情绪/话题辅助分析（缺省/解析失败返回 undefined，
 * 消费方回退独立情绪分析调用）。与意图 JSON 同体输出，省一次每轮 LLM 调用。
 */
function parseAuxAnalysis(
  raw: string | undefined | null,
): RouteDecision["auxAnalysis"] | undefined {
  if (!raw) return undefined;
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return undefined;
  try {
    const obj = JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>;
    const score = Number(obj.sentiment);
    if (!Number.isFinite(score)) return undefined;
    const tags = Array.isArray(obj.tags)
      ? obj.tags.map((t) => String(t)).filter(Boolean).slice(0, 3)
      : [];
    const topics = Array.isArray(obj.topics)
      ? obj.topics.map((t) => String(t).trim()).filter(Boolean).slice(0, 3)
      : [];
    return {
      sentimentScore: Math.max(-1, Math.min(1, score)),
      emotionTags: tags,
      topics,
    };
  } catch {
    return undefined;
  }
}

/**
 * 三层路由唯一权威入口。任何异常都不抛出——最坏情况保守降级为任务面。
 *
 * @param activeTasksSummary 当前会话后台活跃任务摘要（TaskHub 提供），
 *        让路由器把"怎么样了/改成明天"这类消息按任务话题分类。
 */
export async function routeTurnByLlm(
  externalChat: ExternalChatProvider | null,
  sessionId: string,
  text: string,
  recentUserTurns: string[] = [],
  activeTasksSummary?: string,
): Promise<RouteDecision> {
  // 前台自决模式（默认）：路由调用整体跳过——「要不要办事」由前台模型带着
  // task.dispatch 原语在一个主回复调用里顺带决定，每轮对话恒 1 次 LLM。
  if (isForegroundDispatchMode()) {
    return foregroundSelfDispatchDecision();
  }

  const trimmed = text.trim();
  if (!trimmed) {
    return {
      mode: "fast",
      reasons: ["llm_route:empty_text"],
      segmentable: true,
      intent: "chat",
      confidence: 1,
      plane: "chat",
      capabilities: [],
      budget: 0,
      tier: "fast",
    };
  }
  const key = JSON.stringify([trimmed, recentUserTurns]);
  const hit = cacheGet(key);
  if (hit) return hit;

  if (!externalChat?.isEnabled()) {
    const decision = conservativeFallback(trimmed, "llm_route_fallback:provider_disabled");
    cacheSet(key, decision);
    return decision;
  }

  const prompt = buildRoutePrompt(trimmed, recentUserTurns, activeTasksSummary);
  const timeoutMs = resolveTimeoutMs();
  try {
    const result = await Promise.race([
      externalChat.streamCompletion(
        `${ROUTE_SESSION_PREFIX}${sessionId}`,
        { text: prompt },
        () => {}, // 路由判定无需流式回传
        undefined,
        // 独立路由会话 + ephemeral：单次自包含调用，不累积历史也不污染聊天线程。
        // suppressRuntimeSuffixes 剥掉【回复规则】【展示形式】等聊天后缀——意图分类
        // 用不上排版/风格规则，带着它们每轮多花 ~1.7k 字符全价输入。
        // maxOutputTokens 需容纳 provider 注入的 [ts:...] 前缀 + JSON 单对象
        //（意图标签 + 顺带的情绪/话题辅助分析）。
        {
          maxOutputTokens: 192,
          ephemeralTurn: true,
          suppressRuntimeSuffixes: true,
          functionalSuffixes: false,
        },
      ),
      new Promise<undefined>((r) => setTimeout(() => r(undefined), timeoutMs)),
    ]);

    // ── L1 结构化意图解析（含顺带情绪/话题辅助分析）──
    const parsed = parseIntentJson(result);
    const auxAnalysis = parseAuxAnalysis(result);
    if (!parsed) {
      console.warn(
        `[LlmTaskRouter] 不可解析输出（${(result ?? "").slice(0, 40)}），保守降级任务面`,
      );
      const decision = conservativeFallback(trimmed, "llm_route_fallback:unparseable_output");
      cacheSet(key, decision);
      return decision;
    }
    if (!isIntentLabel(parsed.intent)) {
      const decision = conservativeFallback(trimmed, "llm_route_fallback:invalid_intent");
      cacheSet(key, decision);
      return decision;
    }

    // ── L2 路由决策层（纯代码裁决）──
    const plan = routePlanForIntent(parsed.intent);
    const reasons: string[] = [
      `llm_intent:${parsed.intent}@${parsed.confidence.toFixed(2)}`,
      `route_table:${plan.plane}/${plan.capabilities.join("+") || "none"}/b${plan.budget}/${plan.tier}`,
    ];

    const plane = plan.plane;
    const capabilities = [...plan.capabilities];
    const budget = plan.budget;
    const tier = plan.tier;

    const mode = plane === "task" ? "complex" : "fast";
    const decision: RouteDecision = {
      mode,
      reasons,
      segmentable: plane === "chat",
      intent: parsed.intent,
      confidence: parsed.confidence,
      plane,
      capabilities,
      budget,
      tier,
      ...(auxAnalysis ? { auxAnalysis } : {}),
    };
    cacheSet(key, decision);
    return decision;
  } catch (err) {
    console.warn(
      "[LlmTaskRouter] 路由调用失败，保守降级:",
      err instanceof Error ? err.message : String(err),
    );
    // 失败结果不缓存：provider 恢复后下一轮立即回到语义路由
    return conservativeFallback(trimmed, "llm_route_fallback:call_failed");
  }
}

export type { IntentLabel };
