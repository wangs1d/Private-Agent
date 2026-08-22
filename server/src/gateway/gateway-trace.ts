/**
 * GatewayTrace — 网关全链路路由追踪。
 *
 * 网关每个调度阶段（task_route / tool_prepare / forced_tool / resource_search /
 * bridge_execute / render_route / tool_feedback）记录一条 Trace，滚动保留最近
 * TRACE_LIMIT 条，供 /api/gateway/traces 诊断端点查询。
 */

export type GatewayTracePhase =
  | "task_route"
  | "tool_prepare"
  | "forced_tool"
  | "resource_search"
  | "bridge_execute"
  | "render_route"
  | "tool_feedback";

export interface GatewayTraceRecord {
  traceId: string;
  phase: GatewayTracePhase;
  /** 决策结果摘要（如 mode=complex / tool=weather.get_local / render=result_card） */
  decision: string;
  reasons: string[];
  durationMs: number;
  timestamp: number;
}

const TRACE_LIMIT = 200;

const records: GatewayTraceRecord[] = [];

export function recordGatewayTrace(record: GatewayTraceRecord): void {
  records.push(record);
  if (records.length > TRACE_LIMIT) {
    records.splice(0, records.length - TRACE_LIMIT);
  }
}

/** 最近 N 条（默认 50），按时间倒序。 */
export function listGatewayTraces(limit = 50): GatewayTraceRecord[] {
  return records.slice(-Math.max(1, Math.min(limit, TRACE_LIMIT))).reverse();
}

export function getGatewayTraceStats(): {
  total: number;
  byPhase: Record<string, number>;
} {
  const byPhase: Record<string, number> = {};
  for (const record of records) {
    byPhase[record.phase] = (byPhase[record.phase] ?? 0) + 1;
  }
  return { total: records.length, byPhase };
}
