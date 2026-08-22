/**
 * AgentGateway — 统一资源路由网关（唯一收口）。
 *
 * 所有工具/技能/MCP 资源的「准备、检索、桥接执行、强制路由」都经由本模块发起，
 * 底层委托：
 *   - tool-search/：tool-router 对接层（deferred catalog 构建 + HTTP/stdio 检索 + 桥接执行）
 *   - gateway/forced-tool.ts：强制工具路由（phone/clock/search_web）
 *
 * 网关职责：
 *   1. prepareTools：core/deferred 工具切分 + 意图预召回 + tool_discover 桥注入（trace: tool_prepare）
 *   2. resolveForcedTool：事实型问题强制工具选择（trace: forced_tool）
 *   3. executeBridge：tool_discover / tool_call 桥接执行（trace: bridge_execute）
 *   4. searchResources：直接检索延迟目录（诊断/管理端，trace: resource_search）
 *
 * 调用方一律 import gateway（不直接 import tool-search），保证路由行为可追踪、可治理。
 */

import type { ChatCompletionTool } from "openai/resources/chat/completions";

import type { AgentRuntimeConfig } from "../agent/agent-runtime-config.js";
import {
  routeLlmExecution,
  type RouteDecision,
  type RouteLlmExecutionOptions,
} from "../agent/task-router.js";
import {
  classifyRenderHint,
  type RenderHint,
  type RenderHintContext,
} from "../services/render-hint-service.js";
import {
  executeToolSearchBridge,
  prepareToolsWithToolSearch,
  type DeferredToolCatalog,
  type ToolSearchBridgeResult,
  type ToolSearchPreparedTurn,
} from "../tools/tool-search/index.js";
import { searchDeferredToolsViaToolRouter } from "../tools/tool-search/tool-router-adapter.js";
import { resolveForcedToolChoice, type ForcedToolChoice } from "./forced-tool.js";
import { recordGatewayTrace } from "./gateway-trace.js";

let _traceCounter = 0;

function nextTraceId(): string {
  _traceCounter += 1;
  return `gw-${Date.now().toString(36)}-${_traceCounter}`;
}

function traced<T>(
  phase: "tool_prepare" | "forced_tool" | "bridge_execute" | "resource_search",
  decision: string,
  reasons: string[],
  fn: () => T,
): T {
  const traceId = nextTraceId();
  const startedAt = Date.now();
  try {
    const result = fn();
    recordGatewayTrace({
      traceId,
      phase,
      decision,
      reasons,
      durationMs: Date.now() - startedAt,
      timestamp: startedAt,
    });
    return result;
  } catch (error) {
    recordGatewayTrace({
      traceId,
      phase,
      decision: `${decision} (failed)`,
      reasons: [...reasons, error instanceof Error ? error.message : String(error)],
      durationMs: Date.now() - startedAt,
      timestamp: startedAt,
    });
    throw error;
  }
}

async function tracedAsync<T>(
  phase: "tool_prepare" | "forced_tool" | "bridge_execute" | "resource_search",
  decision: string,
  reasons: string[],
  fn: () => Promise<T>,
): Promise<T> {
  const traceId = nextTraceId();
  const startedAt = Date.now();
  try {
    const result = await fn();
    recordGatewayTrace({
      traceId,
      phase,
      decision,
      reasons,
      durationMs: Date.now() - startedAt,
      timestamp: startedAt,
    });
    return result;
  } catch (error) {
    recordGatewayTrace({
      traceId,
      phase,
      decision: `${decision} (failed)`,
      reasons: [...reasons, error instanceof Error ? error.message : String(error)],
      durationMs: Date.now() - startedAt,
      timestamp: startedAt,
    });
    throw error;
  }
}

// ===== 意图预召回（speculative preload）=====
// 延迟目录激活时，用用户文本提前跑一次 tool-router 检索（短超时），
// top-1 高置信度命中时直接把该工具 schema 注入 visibleTools——
// LLM 无需再走 tool_discover → tool_call 两轮往返即可直接调用。
// 预召回失败/超时/低置信度一律静默跳过，LLM 仍可走 tool_discover 兜底。

function parsePrerecallTimeoutMs(): number {
  const raw = Number.parseInt(process.env.GATEWAY_PRERECALL_TIMEOUT_MS ?? "", 10);
  // 默认 600ms：覆盖 stdio worker 冷启动（实测 250~560ms）；
  // 首轮超时则静默走 tool_discover 兜底，worker 由 prewarm 常驻后后续轮次命中缓存。
  return Number.isFinite(raw) && raw > 0 ? Math.min(raw, 2000) : 600;
}

function parsePrerecallMinScore(): number {
  const raw = Number.parseFloat(process.env.GATEWAY_PRERECALL_MIN_SCORE ?? "");
  return Number.isFinite(raw) && raw > 0 && raw <= 1 ? raw : 0.5;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function visibleToolNames(tools: ChatCompletionTool[]): Set<string> {
  const names = new Set<string>();
  for (const tool of tools) {
    if (tool.type === "function" && tool.function?.name) names.add(tool.function.name);
  }
  return names;
}

async function preloadTopDeferredTool(
  prepared: ToolSearchPreparedTurn,
  userText: string,
): Promise<string | null> {
  try {
    const matches = await withTimeout(
      searchDeferredToolsViaToolRouter(prepared.deferredCatalog, userText, 1, {
        includeSchema: true,
      }),
      parsePrerecallTimeoutMs(),
    );
    const top = matches?.[0];
    if (!top || top.score < parsePrerecallMinScore()) return null;

    const catalog = prepared.deferredCatalog;
    const entry =
      catalog.byName.get(top.name) ??
      catalog.byApiName.get(top.name.replace(/\./g, "_"));
    if (!entry) return null;
    if (visibleToolNames(prepared.visibleTools).has(entry.registryName)) return null;

    prepared.visibleTools = [...prepared.visibleTools, entry.tool];
    return entry.registryName;
  } catch {
    // 预召回失败静默：LLM 仍可通过 tool_discover 桥接发现该工具
    return null;
  }
}

/**
 * 工具准备：core 工具直接暴露，其余进 deferred catalog（由 tool-router 召回），
 * 激活时注入 tool_discover / tool_call 桥接工具。
 *
 * 传入 userText 时执行意图预召回：top-1 高置信度延迟工具直接注入 visibleTools，
 * 省去 LLM 的 tool_discover 发现往返（fast/complex 模式均受益）。
 */
export async function prepareTools(
  visibleCandidateTools: ChatCompletionTool[],
  searchableSourceTools: ChatCompletionTool[] = visibleCandidateTools,
  options?: { userText?: string },
): Promise<ToolSearchPreparedTurn> {
  const traceId = nextTraceId();
  const startedAt = Date.now();
  try {
    const prepared = prepareToolsWithToolSearch(visibleCandidateTools, searchableSourceTools);
    const userText = options?.userText?.trim();
    let prerecall: string | null = null;
    if (
      prepared.toolSearchActive &&
      userText &&
      prepared.deferredCatalog.entries.length > 0
    ) {
      prerecall = await preloadTopDeferredTool(prepared, userText);
    }
    recordGatewayTrace({
      traceId,
      phase: "tool_prepare",
      decision:
        `visible=${prepared.visibleTools.length} deferred=${prepared.deferredToolCount}` +
        (prerecall ? ` prerecall=${prerecall}` : ""),
      reasons: prerecall
        ? [`预召回注入 ${prerecall}（省 tool_discover 发现往返）`]
        : prepared.toolSearchActive
          ? ["延迟目录激活，预召回未命中（LLM 走 tool_discover 兜底）"]
          : ["延迟目录未激活（小工具集/阈值未达）"],
      durationMs: Date.now() - startedAt,
      timestamp: startedAt,
    });
    return prepared;
  } catch (error) {
    recordGatewayTrace({
      traceId,
      phase: "tool_prepare",
      decision: "tool_prepare (failed)",
      reasons: [error instanceof Error ? error.message : String(error)],
      durationMs: Date.now() - startedAt,
      timestamp: startedAt,
    });
    throw error;
  }
}

/**
 * 强制工具路由：phone/clock/search_web 场景强制 tool_choice，
 * 避免 LLM 在事实型问题上编造（weather 已并入 tool-router 由检索召回）。
 */
export function resolveForcedTool(
  userText: string,
  apiTools: ChatCompletionTool[],
  fastProfile?: boolean,
): ForcedToolChoice {
  const choice = resolveForcedToolChoice(userText, apiTools, fastProfile);
  const decision = choice === "auto" ? "auto" : `forced:${choice.function.name}`;
  return traced("forced_tool", decision, [`fastProfile=${fastProfile ?? false}`], () => choice);
}

/**
 * 桥接工具执行：tool_discover（搜索/加载延迟工具 schema）与 tool_call（执行）。
 * 检索后端为 Python tool-router（HTTP 优先，stdio 兜底）。
 */
export function executeBridge(
  bridgeName: string,
  args: Record<string, unknown>,
  catalog: DeferredToolCatalog,
): Promise<ToolSearchBridgeResult> {
  return tracedAsync(
    "bridge_execute",
    `bridge=${bridgeName}`,
    [`catalog=${catalog.entries.length}`],
    () => executeToolSearchBridge(bridgeName, args, catalog),
  );
}

/**
 * 直接检索延迟目录（不经 LLM 桥接）：管理端/诊断端用。
 * 正常对话流程走 executeBridge("tool_discover", ...)。
 */
export function searchResources(
  catalog: DeferredToolCatalog,
  query: string,
  limit: number,
  options?: { includeSchema?: boolean; tenantId?: string; agentContextHash?: string },
): Promise<Awaited<ReturnType<typeof searchDeferredToolsViaToolRouter>>> {
  return tracedAsync(
    "resource_search",
    `query=${query.slice(0, 40)} limit=${limit}`,
    ["tool-router 混合检索"],
    () => searchDeferredToolsViaToolRouter(catalog, query, limit, options),
  );
}

/**
 * 任务路由：Fast（前台秒回）vs Complex（后台并行 + 子 Agent 委派）。
 * 包装 routeLlmExecution 并记录 trace（phase: task_route）。
 */
export function routeTask(
  message: string,
  config?: AgentRuntimeConfig,
  options?: RouteLlmExecutionOptions,
): RouteDecision {
  const startedAt = Date.now();
  const decision = routeLlmExecution(message, config, options);
  recordGatewayTrace({
    traceId: nextTraceId(),
    phase: "task_route",
    decision: `mode=${decision.mode} segmentable=${decision.segmentable}`,
    reasons: decision.reasons.slice(0, 5),
    durationMs: Date.now() - startedAt,
    timestamp: startedAt,
  });
  return decision;
}

/**
 * 渲染路由：assistant 文本的渲染形态判定（卡片/摘要/brief/结构化/纯文本）。
 * 包装 classifyRenderHint 并记录 trace（phase: render_route）。
 */
export function routeRender(text: string, ctx?: RenderHintContext): RenderHint {
  const startedAt = Date.now();
  const hint = classifyRenderHint(text, ctx);
  recordGatewayTrace({
    traceId: nextTraceId(),
    phase: "render_route",
    decision: `type=${hint.type}`,
    reasons: [hint.reason],
    durationMs: Date.now() - startedAt,
    timestamp: startedAt,
  });
  return hint;
}
