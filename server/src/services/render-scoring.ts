/**
 * 展示路由共享评分内核。
 *
 * 消息级路由（render-hint-service）与卡片级路由（display-effect-router）
 * 共用同一套聚合方法论：候选并行评分 → 内容分为主判据、工具分为兜底/加成
 * → 最高分当选 → 平局保留先评分者。本模块只放两家共享的常量与纯函数，
 * 避免权重在两处各自漂移。
 */

/** 内容形态分权重：文本/内容形态决定效果（主判据）。 */
export const CONTENT_WEIGHT = 0.78;
/** 工具场景分权重：无内容信号时保证落到正确场景；弱工具只是倾向。 */
export const TOOL_WEIGHT = 0.45;

/** 命中比例：matched / total，total 为 0 时返回 0。 */
export function ratio(matched: number, total: number): number {
  return total === 0 ? 0 : matched / total;
}

/** 归一到 [0,1]。 */
export function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/**
 * 对比意图词表（两层路由共用，单一维护点）。
 *
 * 词边界 \b 只对 ASCII 词（vs/pk）有意义：中文词后跟 \b 时，JS 把汉字
 * 视为非 \w，「区别」后面紧跟汉字永远不满足边界——导致中文对比意图
 * 几乎全灭（真实漏判案例：「方案A和方案B有什么区别」出不了对比卡）。
 * 因此 \b 仅保留在 vs/pk 之后；「跟/和…相比」限定 ≤8 字跨度并只认
 * 相比/比起来/比较收尾，避免「和朋友聚餐比萨」这类伪对比。
 */
export const COMPARISON_INTENT_RE =
  /(?:vs\.?|pk)\b|对比|区别|怎么选|优缺点|哪个(?:更)?(?:好|合适|值得)|(?:跟|和|与).{0,8}(?:相比|比起来|比较)/i;

/** 单个候选效果的评分明细（路由决策可观测、可测试、可审计）。 */
export interface EffectScore {
  type: string;
  /** 文本形态分（0-1），未命中为 0。 */
  contentScore: number;
  /** 工具场景分（0-1），未命中为 0。 */
  toolScore: number;
  /** 聚合分 = contentScore×CONTENT_WEIGHT + toolScore×TOOL_WEIGHT（截断 1）。 */
  score: number;
}

/**
 * 聚合单候选评分：score = content×CONTENT_WEIGHT + tool×TOOL_WEIGHT（截断 1）。
 * 两层路由共用，保证「内容为主、工具兜底」的语义一致。
 */
export function aggregateScore(contentScore: number, toolScore: number): number {
  return clamp01(contentScore * CONTENT_WEIGHT + toolScore * TOOL_WEIGHT);
}

/**
 * 在评分明细分上取最高分当选；得分相同（含浮点误差）时保留先被评分者。
 * 传入的 scores 需已按候选优先序排列。
 */
export function pickBestScore<T extends EffectScore>(scores: T[]): T | null {
  let best: T | null = null;
  let bestScore = 0;
  for (const d of scores) {
    if (d.score > bestScore + 1e-9) {
      bestScore = d.score;
      best = d;
    }
  }
  return best;
}
