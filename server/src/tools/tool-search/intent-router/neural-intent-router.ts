/**
 * 神经意图域分类（N3，docs/neural-retrieval-plan.md §3）。
 *
 * 实现 IntentRouter 的 SemanticIntentRouter 钩子：把 query 交给 sidecar
 * /classify-intent 做 query→域 最近质心分类（域词表由本模块从 TOOL_CATEGORIES
 * 派生，状态归 Node 军规）。正则/BM25 路径完整保留：
 *   - adaptive-catalog 的 tryFastPathIntent（高频 query 正则短路）在本钩子之前；
 *   - sidecar 不可用 / 置信度 < 0.6 / 复合查询 → 返回 null，走 routeByKeywords；
 *   - 约束推断（read_only/latency/file_type）与参数抽取仍是正则实现——
 *     这些规则精确且廉价，神经化的收益在域分类，不在约束。
 */
import type {
  IntentRouterInput,
  ParsedIntent,
  SemanticIntentRouter,
} from "./intent-router.js";
import {
  extractParams,
  inferConstraints,
  inferCapability,
  splitCompoundQuery,
} from "./intent-router.js";
import { TOOL_CATEGORIES } from "../tool-category.js";
import {
  isNeuralFeatureEnabled,
  neuralClassifyIntent,
  warmLabelVectors,
} from "../neural-sidecar.js";

/** 域 → 描述文本（与 BM25 类别索引同源同词表，分类语义一致可对照） */
const DOMAIN_LABELS: Record<string, string> = Object.fromEntries(
  TOOL_CATEGORIES.map((cat) => [
    cat.name,
    [...cat.aliases, ...cat.prefixes].join(" "),
  ]),
);

/** 次优域并入条件：其概率 ≥ 最优域的 30%（分类器犹豫时保留双域倾向） */
const SECOND_DOMAIN_RATIO = 0.3;
/**
 * 采纳规则（18 类 softmax 实测标定）：绝对置信度在多分类下失真（正确域也只有
 * 0.4 左右），改用相对差值——top ≥ 2.5×second 且 top ≥ 3×均匀分布才采纳；
 * 置信度由 ln(ratio) 映射（0.6~0.95）：ratio 2.5→0.69、4→0.74、24→0.92。
 * 不达标返回 null 走正则兜底，绝不硬猜。
 */
const ADOPT_TOP_RATIO = 2.5;
const ADOPT_TOP_UNIFORM_MULT = 3;
const CONF_BASE = 0.6;
const CONF_MARGIN_GAIN = 0.1;
const CONF_MAX = 0.95;

export function createNeuralIntentRouter(): SemanticIntentRouter | undefined {
  if (!isNeuralFeatureEnabled("intent")) return undefined;

  // 域标签向量预热（fire-and-forget）：首个真实查询到达时缓存大概率已就绪，
  // 避免 classify 首调同步等待 18 条文本编码（曾在合成基准上打出 538ms p95 尖刺）
  warmLabelVectors(DOMAIN_LABELS);

  return async (input: IntentRouterInput): Promise<ParsedIntent | null> => {
    const query = input.raw_user_query.trim();
    if (!query) return null;
    // 复合查询（「查天气然后定闹钟」）拆分合并逻辑在正则路径，单域分类反而更差
    if (splitCompoundQuery(query).length > 1) return null;

    const result = await neuralClassifyIntent(query, DOMAIN_LABELS);
    if (!result || !result.domain) return null;

    const ranked = Object.entries(result.scores)
      .sort((a, b) => b[1] - a[1]);
    const top = ranked[0];
    const second = ranked[1];
    if (!top) return null;
    const uniform = 1 / Math.max(1, ranked.length);
    const ratio = top[1] / Math.max(second?.[1] ?? 1e-9, 1e-9);
    if (top[0] !== result.domain) return null;
    if (ratio < ADOPT_TOP_RATIO || top[1] < uniform * ADOPT_TOP_UNIFORM_MULT) return null;

    const confidence = Math.min(
      CONF_MAX,
      CONF_BASE + CONF_MARGIN_GAIN * Math.log(ratio),
    );

    const domains =
      second && second[1] >= top[1] * SECOND_DOMAIN_RATIO
        ? [result.domain, second[0]]
        : [result.domain];

    return {
      intent: query,
      domain_candidates: domains,
      primary_capability: inferCapability(result.domain, query),
      confidence,
      query_constraints: inferConstraints(query),
      param_extract: extractParams(query),
      is_compound_task: false,
      sub_intents: [],
    };
  };
}
