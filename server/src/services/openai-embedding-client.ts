/**
 * OpenAI 兼容 Embedding API（`/v1/embeddings`），可用于 Qdrant 向量写入。
 */

export async function fetchOpenAiCompatibleEmbedding(opts: {
  apiKey: string;
  /** 默认 OPENAI_EMBEDDINGS_URL → https://api.openai.com/v1/embeddings */
  baseUrl?: string;
  model: string;
  input: string;
}): Promise<{ vector: number[]; dimension: number }> {
  const base =
    opts.baseUrl?.replace(/\/$/, "") ??
    process.env.OPENAI_EMBEDDINGS_URL?.replace(/\/$/, "") ??
    "https://api.openai.com/v1/embeddings";
  const r = await fetch(base, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${opts.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ model: opts.model, input: opts.input.slice(0, 32_000) }),
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
