/**
 * 轮级结构化 trace（2026-09-19 工具调用架构改造 P0）。
 *
 * 每次工具循环结束输出一行 JSON，把"这轮工具为什么没调/调错"的归因数据
 * 收敛到单一锚点（grep `[turn-trace]`）。此前散落的 console.info（[plan-execute]/
 * [openai-tool-loop]/[tool-search]/[prefix-cache]）保留不动，本 trace 是它们的
 * 结构化汇总视图，用于前后对比验收：
 *   - 工具成功率 = okCalls / totalCalls
 *   - 行为一致性 = 同 query 复测 visibleTools hash diff
 *   - 纠错成本 = exitGate / requestCard 触发次数
 */

export type ToolCallTraceEntry = {
  name: string;
  ok: boolean;
  /** 本调用方 await 落定的耗时（含确定性重试；去重共享调用按各自等待计） */
  ms: number;
  /** 是否经请求卡（tool_request）转正后才可达 */
  viaRequestCard?: boolean;
};

export type TurnTraceRecord = {
  ts: number;
  /** LLM 审计 stage（main_chat_tools / task_plane_* / …），近似车道标识 */
  stage: string;
  model?: string;
  /** 路由意图标签（2026-09-23 观测补全）：量化"路由误判率 vs 模型不自觉率" */
  turnIntent?: string;
  /** 本轮是否注入了前置检索证据块（realtime 轮零工具直答的豁免判据） */
  turnEvidenceInjected?: boolean;
  /** 路由置信度（与 turnIntent 同源，观测路由器质量） */
  routeConfidence?: number;
  /** 暴露给模型的可见工具数（含桥工具，不含请求卡追加） */
  visibleTools: number;
  /** 延迟目录是否激活及目录规模 */
  deferredActive: boolean;
  deferredCount: number;
  /** 预召回注入的工具名（无则空） */
  prerecall?: string;
  /** 实际使用的波次数 */
  waves: number;
  toolCalls: ToolCallTraceEntry[];
  /** 请求卡：是否触发、命中加载了哪些工具、已在可见集的（预召回先注入）、高危拦截（P1-1） */
  requestCard?: {
    fired: boolean;
    loaded: string[];
    alreadyVisible?: string[];
    blockedRisk?: string[];
  };
  /** 出口检查：是否触发续波及原因 */
  exitGate?: { fired: boolean; reason?: string };
  finalTextChars: number;
  durationMs: number;
};

export function recordTurnTrace(record: TurnTraceRecord): void {
  try {
    console.info(`[turn-trace] ${JSON.stringify(record)}`);
  } catch {
    /* 遥测失败静默 */
  }
}

export function summarizeTurnTraces(records: TurnTraceRecord[]): {
  turns: number;
  totalCalls: number;
  okCalls: number;
  okRate: number;
  avgWaves: number;
  requestCardFired: number;
  exitGateFired: number;
} {
  const totalCalls = records.reduce((n, r) => n + r.toolCalls.length, 0);
  const okCalls = records.reduce((n, r) => n + r.toolCalls.filter((c) => c.ok).length, 0);
  const avgWaves = records.length > 0
    ? records.reduce((n, r) => n + r.waves, 0) / records.length
    : 0;
  return {
    turns: records.length,
    totalCalls,
    okCalls,
    okRate: totalCalls > 0 ? okCalls / totalCalls : 0,
    avgWaves,
    requestCardFired: records.filter((r) => r.requestCard?.fired).length,
    exitGateFired: records.filter((r) => r.exitGate?.fired).length,
  };
}
