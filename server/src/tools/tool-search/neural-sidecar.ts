/**
 * 神经检索 sidecar 客户端（docs/neural-retrieval-plan.md N1/N2/N3 的 TS 侧统一入口）。
 *
 * 边界军规（in-process-tool-search.md §5）在本模块的落点：
 *   - 常驻 HTTP JSON，绝不 spawn、不建长连接；
 *   - 每端点独立超时预算（embed 300ms / rerank 400ms / intent 300ms）；
 *   - 连续失败熔断（默认 2 次开闸、冷却 60s），开闸期零网络调用；
 *   - 一切失败返回 null 由调用方降级，绝不抛错阻塞检索主链路；
 *   - 模型无状态，缓存/学习状态留在 TS 侧。
 *
 * 所有对外函数都不抛错：sidecar 不可用 = 质量降级，不是故障。
 */
import { getToolSearchConfig } from "./env.js";
import {
  toolSearchMetrics,
  type NeuralMetricFeature,
} from "./observability/metrics.js";

export type NeuralFeature = NeuralMetricFeature;

export type NeuralEmbedResult = {
  model: string;
  dim: number;
  vectors: number[][];
};

export type NeuralRerankResult = {
  model: string;
  /** 与 documents 等长，按传入顺序对应 */
  scores: number[];
};

export type NeuralIntentResult = {
  domain: string;
  confidence: number;
  scores: Record<string, number>;
};

/**
 * 域标签向量缓存（N3 热路径优化）：labels 是静态词表（TOOL_CATEGORIES 派生），
 * 逐请求让 sidecar 重编码 18 条文本 ≈100ms 且与 embed/rerank 抢 CPU（曾把全开
 * p95 推到 570ms）。这里按模型名缓存预编码向量，请求改传 label_vectors——
 * sidecar 每次只编码 query（~5ms）。缓存是模型派生的纯函数值，不含业务状态
 * （状态归 Node 军规不破）。
 */
const _labelVectorCache = new Map<string, Record<string, number[]>>();
const _labelVectorInflight = new Map<string, Promise<Record<string, number[]> | null>>();

async function labelVectorsFor(modelHint: string, labels: Record<string, string>): Promise<Record<string, number[]> | null> {
  const cached = _labelVectorCache.get(modelHint);
  if (cached) return cached;
  let inflight = _labelVectorInflight.get(modelHint);
  if (!inflight) {
    inflight = neuralEmbedTextsBulk(Object.values(labels)).then((res) => {
      _labelVectorInflight.delete(modelHint);
      if (!res || res.dim <= 0) return null;
      const out: Record<string, number[]> = {};
      Object.keys(labels).forEach((domain, i) => {
        const vec = res.vectors[i];
        if (vec) out[domain] = vec;
      });
      if (Object.keys(out).length === Object.keys(labels).length) {
        _labelVectorCache.set(modelHint, out);
      }
      return out;
    });
    _labelVectorInflight.set(modelHint, inflight);
  }
  return inflight;
}

/**
 * 按特性独立的熔断器：连续 threshold 次失败开闸 cooldown 毫秒，
 * 开闸期 isOpen() 为 true（调用方直接走降级，零网络成本）；任何成功复位。
 */
class NeuralBreaker {
  private consecutiveFailures = 0;
  private openedAt = 0;

  constructor(
    private readonly threshold: number,
    private readonly cooldownMs: number,
  ) {}

  isOpen(now = Date.now()): boolean {
    if (this.consecutiveFailures < this.threshold) return false;
    if (now - this.openedAt >= this.cooldownMs) {
      // 冷却期满：半开，放行一次试探（失败会立即重新开闸）
      this.consecutiveFailures = this.threshold - 1;
      return false;
    }
    return true;
  }

  recordSuccess(): void {
    this.consecutiveFailures = 0;
  }

  recordFailure(now = Date.now()): void {
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures === this.threshold) {
      this.openedAt = now;
      console.warn(
        `[tool-search:neural] 熔断开闸：连续失败 ${this.consecutiveFailures} 次，冷却 ${this.cooldownMs}ms`,
      );
    }
  }
}

let _breakers: Record<NeuralFeature, NeuralBreaker> | null = null;

function breakers(): Record<NeuralFeature, NeuralBreaker> {
  if (!_breakers) {
    const cfg = getToolSearchConfig();
    _breakers = {
      embed: new NeuralBreaker(cfg.neuralBreakerThreshold, cfg.neuralBreakerCooldownMs),
      rerank: new NeuralBreaker(cfg.neuralBreakerThreshold, cfg.neuralBreakerCooldownMs),
      intent: new NeuralBreaker(cfg.neuralBreakerThreshold, cfg.neuralBreakerCooldownMs),
    };
  }
  return _breakers;
}

/** 测试用：重置熔断状态。 */
export function resetNeuralBreakers(): void {
  _breakers = null;
}

/** 特性开关是否挂载（off = 注入点根本不调用，回滚开关）。 */
export function isNeuralFeatureEnabled(feature: NeuralFeature): boolean {
  const cfg = getToolSearchConfig();
  if (feature === "embed") return cfg.neuralEmbedEnabled !== "off";
  if (feature === "rerank") return cfg.neuralRerankEnabled !== "off";
  return cfg.neuralIntentEnabled !== "off";
}

function isTimedOut(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "TimeoutError" || error.name === "AbortError" || /timed?out/i.test(error.message))
  );
}

async function postJson<T>(
  path: string,
  body: unknown,
  timeoutMs: number,
): Promise<T> {
  const cfg = getToolSearchConfig();
  const res = await fetch(`${cfg.neuralSidecarUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`neural sidecar HTTP ${res.status}: ${txt.slice(0, 200)}`);
  }
  return (await res.json()) as T;
}

/** 单特性调用包装：熔断检查 + 计数 + 失败静默返回 null。 */
async function guardedCall<T>(
  feature: NeuralFeature,
  run: () => Promise<T>,
): Promise<T | null> {
  if (!isNeuralFeatureEnabled(feature)) return null;
  const breaker = breakers()[feature];
  if (breaker.isOpen()) {
    toolSearchMetrics.recordNeural(feature, "breaker_skip");
    return null;
  }
  try {
    const out = await run();
    breaker.recordSuccess();
    toolSearchMetrics.recordNeural(feature, "ok");
    return out;
  } catch (error) {
    breaker.recordFailure();
    const timedOut = isTimedOut(error);
    toolSearchMetrics.recordNeural(feature, timedOut ? "timeout" : "fallback");
    if (!timedOut) {
      console.warn(
        `[tool-search:neural] ${feature} 调用失败（已降级）:`,
        error instanceof Error ? error.message : String(error),
      );
    }
    return null;
  }
}

/** sidecar 单次 /embed 的批量上限（与 main.py 的 MAX_BATCH 对齐）。 */
const SIDECAR_MAX_BATCH = 64;

/**
 * 批量语义 embedding（N1）：供工具向量后台补全用。
 * 查询热路径请用 neuralEmbedTexts（300ms 预算）——这里用独立的秒级批量预算
 * （单块 ≤32 条长文本，且可能是 sidecar 冷启动的第一个请求，含模型懒加载）。
 */
export async function neuralEmbedTextsBulk(texts: string[]): Promise<NeuralEmbedResult | null> {
  if (texts.length === 0) return { model: "", dim: 0, vectors: [] };
  const timeoutMs = getToolSearchConfig().neuralEmbedBulkTimeoutMs;
  let first: NeuralEmbedResult | null = null;
  const vectors: number[][] = [];
  for (let i = 0; i < texts.length; i += 32) {
    const chunk = texts.slice(i, i + 32);
    const part = await guardedCall("embed", () =>
      postJson<NeuralEmbedResult>("/embed", { texts: chunk }, timeoutMs),
    );
    if (!part) return null;
    if (!first) first = part;
    vectors.push(...part.vectors);
  }
  return first ? { ...first, vectors } : null;
}

/**
 * 批量语义 embedding（N1）。texts > 64 自动分块；任一块失败即返回 null
 * （部分成功不留半吊子向量，调用方整体走下一 provider 重来）。
 */
export async function neuralEmbedTexts(texts: string[]): Promise<NeuralEmbedResult | null> {
  if (texts.length === 0) return { model: "", dim: 0, vectors: [] };
  const timeoutMs = getToolSearchConfig().neuralEmbedTimeoutMs;
  let first: NeuralEmbedResult | null = null;
  const vectors: number[][] = [];
  for (let i = 0; i < texts.length; i += SIDECAR_MAX_BATCH) {
    const chunk = texts.slice(i, i + SIDECAR_MAX_BATCH);
    const part = await guardedCall("embed", () =>
      postJson<NeuralEmbedResult>("/embed", { texts: chunk }, timeoutMs),
    );
    if (!part) return null;
    if (!first) first = part;
    vectors.push(...part.vectors);
  }
  return first ? { ...first, vectors } : null;
}

/** 交叉编码重排（N2）：scores 与 documents 等长、按传入顺序对应。 */
export async function neuralRerank(
  query: string,
  documents: string[],
  topK?: number,
): Promise<NeuralRerankResult | null> {
  if (documents.length === 0) return null;
  const timeoutMs = getToolSearchConfig().neuralRerankTimeoutMs;
  return guardedCall("rerank", () =>
    postJson<NeuralRerankResult>("/rerank", { query, documents, top_k: topK }, timeoutMs),
  );
}

/**
 * 神经域分类（N3）：labels 为 { domain: 域描述文本 }，由 TS 侧持有词表
 * （状态归 Node 军规）。热路径自动改传预编码 label_vectors（sidecar 仅编码
 * query，~5ms）；预编码未就绪时回退文本形态（sidecar 全量编码，~100ms）。
 * label 缓存键含当前模型提示——provider 切换时向量与 embed 模型保持一致。
 */
export async function neuralClassifyIntent(
  query: string,
  labels: Record<string, string>,
): Promise<NeuralIntentResult | null> {
  const entries = Object.entries(labels).filter(([key, text]) => key && text.trim());
  if (entries.length === 0) return null;
  const cleanLabels = Object.fromEntries(entries);
  const timeoutMs = getToolSearchConfig().neuralIntentTimeoutMs;

  // 预编码 label 向量（bulk 预算 10s，与工具向量补全同款；缓存后零成本）。
  // 若在飞（首查询恰好撞上首次编码）则等待——inflight 去重保证只编一次。
  const modelHint = getToolSearchConfig().neuralEmbedModel;
  const labelVectors = await labelVectorsFor(modelHint, cleanLabels);

  return guardedCall("intent", () =>
    postJson<NeuralIntentResult>(
      "/classify-intent",
      labelVectors
        ? { query, label_vectors: labelVectors }
        : { query, labels: cleanLabels },
      timeoutMs,
    ),
  );
}

/** 提前预热域标签向量（路由器构造时调用）：首个真实查询到达时缓存已就绪。 */
export function warmLabelVectors(labels: Record<string, string>): void {
  if (!isNeuralFeatureEnabled("intent")) return;
  const modelHint = getToolSearchConfig().neuralEmbedModel;
  const entries = Object.entries(labels).filter(([key, text]) => key && text.trim());
  if (entries.length === 0) return;
  void labelVectorsFor(modelHint, Object.fromEntries(entries)).catch(() => {});
}

/** 健康探测（测试/运维用）：模型已加载返回 true，不可达/未就绪返回 false。 */
export async function probeNeuralSidecar(timeoutMs = 750): Promise<boolean> {
  try {
    const cfg = getToolSearchConfig();
    const res = await fetch(`${cfg.neuralSidecarUrl}/health`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return false;
    const data = (await res.json()) as { ok?: boolean; warm?: boolean };
    return Boolean(data.ok ?? data.warm);
  } catch {
    return false;
  }
}
