/**
 * LLM 任务路由（2026-08-29）：语义级 fast/complex 判定，替代词法硬规则主路径。
 *
 * 背景：routeLlmExecution 的正则信号永远覆盖不了未写入的表达——没写过的句式、
 * 新话题、自由口语的查询请求都会从关键词夹缝漏进 fast。本模块用一次轻量 LLM
 * 调用做唯一权威判定，双脑架构语义直接写进判定标准：
 *   - fast（对话脑）：纯对话——寒暄、情绪、观点交流、凭已有上下文/自身知识就能答的话；
 *     判定标准是"不看任何外部实时信息、不动任何工具就能答"。
 *   - complex（执行脑）：要真正办事——查实时/外部信息、多步操作、任何工具活；
 *     短追问（"娱乐圈的""新鲜的""景甜的"）按继承的话题判定，语境由 recentUserTurns 提供。
 *
 * 工程约束：
 *   - 输出预算极小（单标签，max_tokens=16），超时 LLM_ROUTE_TIMEOUT_MS（默认 3000ms）；
 *   - 失败/超时/输出不可解析 → 降级回 routeLlmExecution 词法判定（reasons 标注
 *     llm_route_fallback），保证 provider 异常时路由不瘫痪——此时行为等价于旧架构；
 *   - 同 (文本+上下文) 结果缓存 5 分钟：消息批处理重入、agent-core 复用 WS 决策时不重复计费；
 *   - 使用独立路由会话（llm-route:: 前缀），不污染聊天线程上下文。
 */
import type { ExternalChatProvider } from "../external-model/types.js";
import {
  routeLlmExecution,
  determineSegmentable,
  type RouteDecision,
} from "./task-router.js";

const CACHE_TTL_MS = 5 * 60_000;
const CACHE_MAX = 300;
const ROUTE_SESSION_PREFIX = "llm-route::";

function resolveTimeoutMs(): number {
  const raw = process.env.LLM_ROUTE_TIMEOUT_MS?.trim();
  const n = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : 3000;
}

function buildRoutePrompt(text: string, recentUserTurns: string[]): string {
  const lines: string[] = [
    "你是双脑架构的路由器。对话脑(fast)只负责像朋友一样聊天；执行脑(complex)在后台真正调用工具把事办完，再把结果讲给用户。判断这条用户消息该交给哪个脑。",
    "",
    "判定标准：",
    "- fast：纯对话。寒暄、情绪、观点交流、评价、闲聊追问，以及凭常识或已有对话上下文就能答的内容——不需要查任何外部实时信息，不需要动任何工具。问你的近况/想法/感受也是 fast。",
    "- fast 例外：时间/日期/星期这类单点轻查询也算 fast——对话脑手头就有这些轻量工具，不必进后台。",
    "- complex：需要真正办事。凡是答案依赖外部实时信息（新闻、八卦吃瓜、热搜、价格行情、某人某事近况、版本发布等），或多步操作，或要操作软件/设备/文件，或要查日程记忆以外的数据，都是 complex。",
    "- complex 典型例：设置提醒/定闹钟/写日程（要写数据）、搜索/查一下任何东西、X是谁/X怎么样了这类你答不准的实体问题。",
    "- 判不清时选 complex：错放 fast 的代价是任务静默失败，错放 complex 只是慢一点。",
    "- 短追问（哪怕只有几个字，如「娱乐圈的」「新鲜的」「景甜的」）：按它继承的话题判——继承的话题要查/要办就是 complex，继承的是纯闲聊就是 fast。",
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
  lines.push("");
  lines.push("只输出一个词：fast 或 complex");
  return lines.join("\n");
}

function parseLlmRouteLabel(raw: string | undefined | null): "fast" | "complex" | null {
  // provider 会在输出前注入 [ts:...] 元数据标记（与 chat-user-message 的 TS_PREFIX_RE 同源），
  // 解析前必须剥离，否则首块带标记的输出全部 unparseable。
  const t = (raw ?? "")
    .replace(/^\[ts:[^\]]*\]\s*/gm, "")
    .trim()
    .toLowerCase();
  if (!t) return null;
  if (/^complex|desktop|task/.test(t)) return "complex";
  if (/^fast|^chat/.test(t)) return "fast";
  // 容错：输出夹带解释时找首个出现的合法标签
  if (/\bcomplex\b/.test(t)) return "complex";
  if (/\bfast\b/.test(t)) return "fast";
  return null;
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
 * 语义路由唯一权威入口。任何异常都不抛出——最坏情况降级为词法判定。
 */
export async function routeTurnByLlm(
  externalChat: ExternalChatProvider | null,
  sessionId: string,
  text: string,
  recentUserTurns: string[] = [],
): Promise<RouteDecision> {
  const trimmed = text.trim();
  if (!trimmed) {
    return { mode: "fast", reasons: ["llm_route:empty_text"], segmentable: true };
  }
  const key = JSON.stringify([trimmed, recentUserTurns]);
  const hit = cacheGet(key);
  if (hit) return hit;

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
        // maxOutputTokens 需容纳 provider 注入的 [ts:...] 前缀（约 20 token）+ 标签本身。
        { maxOutputTokens: 64, maxThreadMessages: 2 },
      ),
      new Promise<undefined>((r) => setTimeout(() => r(undefined), timeoutMs)),
    ]);
    const label = parseLlmRouteLabel(result);
    if (!label) {
      console.warn(
        `[LlmTaskRouter] 不可解析输出（${(result ?? "").slice(0, 40)}），降级词法路由`,
      );
      const decision = lexicalFallback(trimmed, recentUserTurns, "unparseable_output");
      cacheSet(key, decision);
      return decision;
    }
    const decision: RouteDecision = {
      mode: label,
      reasons: [`llm_route:${label}`],
      segmentable: label === "fast" ? determineSegmentable(trimmed, "fast") : false,
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
