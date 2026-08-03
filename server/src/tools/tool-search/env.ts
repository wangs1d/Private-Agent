export type ToolSearchEnabledMode = "auto" | "on" | "off";

export type ToolSearchBridgeMode = "merged" | "legacy";

export type ToolSearchEmbeddingMode = "auto" | "on" | "off";

function parseEnabledMode(raw: string | undefined): ToolSearchEnabledMode {
  const v = raw?.trim().toLowerCase();
  if (!v || v === "auto") return "auto";
  if (v === "0" || v === "off" || v === "false" || v === "no") return "off";
  if (v === "1" || v === "on" || v === "true" || v === "yes") return "on";
  return "auto";
}

function parseBridgeMode(raw: string | undefined): ToolSearchBridgeMode {
  const v = raw?.trim().toLowerCase();
  if (v === "legacy" || v === "split" || v === "3") return "legacy";
  return "merged";
}

function parseEmbeddingMode(raw: string | undefined): ToolSearchEmbeddingMode {
  const v = raw?.trim().toLowerCase();
  if (!v || v === "auto") return "auto";
  if (v === "0" || v === "off" || v === "false" || v === "no") return "off";
  if (v === "1" || v === "on" || v === "true" || v === "yes") return "on";
  return "auto";
}

export function getToolSearchConfig() {
  return {
    enabled: parseEnabledMode(process.env.AGENT_TOOL_SEARCH_ENABLED),
    bridgeMode: parseBridgeMode(process.env.AGENT_TOOL_SEARCH_BRIDGE_MODE),
    thresholdPct: clampInt(process.env.AGENT_TOOL_SEARCH_THRESHOLD_PCT, 10, 0, 100),
    searchDefaultLimit: clampInt(process.env.AGENT_TOOL_SEARCH_DEFAULT_LIMIT, 5, 1, 50),
    maxSearchLimit: clampInt(process.env.AGENT_TOOL_SEARCH_MAX_LIMIT, 20, 1, 50),
    contextTokens: clampInt(process.env.AGENT_TOOL_SEARCH_CONTEXT_TOKENS, 32_000, 2_000, 2_000_000),
    /** merged 模式下 search 是否自动为 top-1 附带完整 schema（省一轮 describe） */
    discoverAutoSchemaTop1: parseBool(process.env.AGENT_TOOL_SEARCH_DISCOVER_AUTO_SCHEMA, true),
    /**
     * Embedding 召回模式（hybrid: BM25 + 余弦相似度 → RRF 融合）。
     *   - auto: 优先用磁盘缓存 + 可用 OPENAI_API_KEY 自动启用；缺失则降级纯 BM25
     *   - on: 强制启用；缺 key 报错
     *   - off: 禁用，仅用 BM25
     */
    embedding: parseEmbeddingMode(process.env.AGENT_TOOL_SEARCH_EMBEDDING),
    /** 工具 embedding 召回用的模型；缺省 text-embedding-3-small（1536 维） */
    embeddingModel: process.env.AGENT_TOOL_SEARCH_EMBEDDING_MODEL?.trim() || "text-embedding-3-small",
    /** 缓存文件路径，缺省 data/tool-embeddings.json */
    embeddingCachePath: process.env.AGENT_TOOL_SEARCH_EMBEDDING_CACHE?.trim() || "",
    /** 召回融合时 embedding ranking 的权重（0~1，剩余权重给 BM25 + 其他 ranking） */
    embeddingRankWeight: clampFloat(process.env.AGENT_TOOL_SEARCH_EMBEDDING_WEIGHT, 0.55, 0, 1),
    /** 触发 embedding 召回的最小工具数（避免小工具集上浪费 RTT） */
    embeddingMinTools: clampInt(process.env.AGENT_TOOL_SEARCH_EMBEDDING_MIN_TOOLS, 12, 1, 1000),
    /**
     * 动态筛选：绝对下限。cosine 低于此值的工具直接丢弃。
     * 0.20 ≈ 弱相关，适合宽松召回；0.30 ≈ 中等相关，适合精确召回。
     */
    embeddingDynamicFloor: clampFloat(process.env.AGENT_TOOL_SEARCH_EMBEDDING_FLOOR, 0.20, 0, 1),
    /**
     * 动态筛选：相对比例。仅保留 score >= maxScore * ratio 的结果。
     * 0.60 = 保留 top score 60% 以上的；越低越宽松。
     */
    embeddingDynamicRatio: clampFloat(process.env.AGENT_TOOL_SEARCH_EMBEDDING_RATIO, 0.60, 0, 1),
    /** 动态筛选：安全上限，防止极宽 query 候选爆炸 */
    embeddingDynamicMaxKeep: clampInt(process.env.AGENT_TOOL_SEARCH_EMBEDDING_MAX_KEEP, 30, 1, 200),
  };
}

function parseBool(raw: string | undefined, fallback: boolean): boolean {
  const v = raw?.trim().toLowerCase();
  if (!v) return fallback;
  if (v === "0" || v === "off" || v === "false" || v === "no") return false;
  if (v === "1" || v === "on" || v === "true" || v === "yes") return true;
  return fallback;
}

function clampInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  const n = raw ? Number.parseInt(raw, 10) : fallback;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function clampFloat(raw: string | undefined, fallback: number, min: number, max: number): number {
  const n = raw ? Number.parseFloat(raw) : fallback;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}
