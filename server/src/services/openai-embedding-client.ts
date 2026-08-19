/**
 * OpenAI 兼容 Embedding API（`/v1/embeddings`），可用于 Qdrant 向量写入。
 */

import { isPlaceholderApiKey } from "../config/api-key-validator.js";

export type EmbeddingEndpoint = {
  baseUrl: string;
  apiKey: string;
  model: string;
};

/**
 * 解析当前可用的 Embedding 端点（OpenAI 兼容 /v1/embeddings）。
 * 优先级：AGENT_EMBEDDING_BASE_URL → OPENAI_EMBEDDINGS_URL → OPENAI_BASE_URL。
 * DeepSeek / Moonshot 等纯聊天渠道没有 /embeddings，返回 null（调用方跳过向量检索）。
 */
export function resolveEmbeddingEndpoint(): EmbeddingEndpoint | null {
  const apiKey =
    process.env.AGENT_EMBEDDING_API_KEY?.trim() ||
    process.env.OPENAI_API_KEY?.trim() ||
    "";
  if (!apiKey || isPlaceholderApiKey(apiKey)) return null;
  const model = process.env.AGENT_EMBEDDING_MODEL?.trim() || "text-embedding-3-small";

  const explicit = process.env.AGENT_EMBEDDING_BASE_URL?.trim();
  if (explicit) return { baseUrl: explicit.replace(/\/+$/, ""), apiKey, model };

  const embeddingsUrl = process.env.OPENAI_EMBEDDINGS_URL?.trim();
  if (embeddingsUrl) return { baseUrl: embeddingsUrl.replace(/\/+$/, ""), apiKey, model };

  const chatBase = process.env.OPENAI_BASE_URL?.trim();
  if (chatBase && !/deepseek|moonshot|kimi/i.test(chatBase)) {
    return { baseUrl: chatBase.replace(/\/+$/, ""), apiKey, model };
  }
  return null;
}

export async function fetchOpenAiCompatibleEmbedding(opts: {
  apiKey?: string;
  /** 默认 AGENT_EMBEDDING_BASE_URL → OPENAI_EMBEDDINGS_URL → 可用的 OPENAI_BASE_URL */
  baseUrl?: string;
  model?: string;
  input: string;
  /** 请求超时毫秒；默认 60s（兼容既有调用方，如 Qdrant 批量写入） */
  timeoutMs?: number;
}): Promise<{ vector: number[]; dimension: number }> {
  const ep = resolveEmbeddingEndpoint();

  // 未显式传 baseUrl 且没有可用的 Embedding 端点：直接抛错，避免拿聊天 Key 去打
  // api.openai.com 浪费时间（401 / 超时）。
  if (!opts.baseUrl && !ep) {
    throw new Error(
      "embeddings: no compatible endpoint configured; set AGENT_EMBEDDING_BASE_URL " +
        "(e.g. https://api.siliconflow.cn/v1) + AGENT_EMBEDDING_API_KEY",
    );
  }

  const base =
    opts.baseUrl?.replace(/\/$/, "") ??
    ep?.baseUrl ??
    process.env.OPENAI_EMBEDDINGS_URL?.replace(/\/$/, "") ??
    "https://api.openai.com/v1/embeddings";
  const apiKey = opts.apiKey ?? ep?.apiKey ?? "";
  if (!apiKey) {
    throw new Error("embeddings: no API key configured");
  }
  const model = opts.model ?? ep?.model ?? "text-embedding-3-small";

  const r = await fetch(base, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ model, input: opts.input.slice(0, 32_000) }),
    signal: AbortSignal.timeout(opts.timeoutMs ?? 60_000),
  });
  if (!r.ok) {
    const txt = await r.text().catch(() => "");
    throw new Error(`embeddings HTTP ${r.status}: ${txt.slice(0, 400)}`);
  }
  const data = (await r.json()) as {
    data?: Array<{ embedding?: number[] }>;
  };
  const vec = data.data?.[0]?.embedding;
  if (!vec?.length) {
    throw new Error("embeddings: empty embedding");
  }
  return { vector: vec, dimension: vec.length };
}
