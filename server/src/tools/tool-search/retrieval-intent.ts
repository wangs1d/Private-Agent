/**
 * 检索意图类型（2026-10-01 分类归一：从 intent-router/ 迁出）。
 *
 * IntentRouter 规则分类器已退役——单评分器架构下，"意图"退化为检索结果的
 * 结构化视图：fast-path 正则命中的策展意图（保留高置信短路资格）与词面边际
 * 自派生意图（marginConfidence）共用此形状。rerank/top-p 的约束输入同源。
 */

export type QueryConstraints = {
  max_latency_ms: number;
  read_only: boolean;
  file_type: string | null;
  auth_level: "default" | "admin" | "guest";
};

export type ParsedIntent = {
  intent: string;
  domain_candidates: string[];
  primary_capability: string;
  confidence: number;
  query_constraints: QueryConstraints;
  param_extract: Record<string, unknown>;
  is_compound_task: boolean;
  sub_intents: ParsedIntent[];
};

/** 非 fast-path query 的默认约束（单评分器下不再由规则分类器产出）。 */
export const DEFAULT_QUERY_CONSTRAINTS: QueryConstraints = {
  max_latency_ms: 200,
  read_only: false,
  file_type: null,
  auth_level: "default",
};
