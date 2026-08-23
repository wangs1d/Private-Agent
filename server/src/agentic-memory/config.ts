import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { QdrantClient } from "@qdrant/js-client-rest";
import type { MemoryConfig } from "mem0ai/oss";

import {
  getAgenticMemoryCollection,
  getAgenticMemoryCustomInstructions,
  getAgenticMemoryDir,
  getAgenticMemoryEmbeddingBaseUrl,
  getAgenticMemoryEmbeddingDims,
  getAgenticMemoryEmbeddingModel,
  getAgenticMemoryLlmModel,
  resolveEmbeddingApiKey,
  resolveOpenAiApiKey,
} from "./env.js";

/** 构建 Mem0 OSS 配置；缺少可用 Embedding 端点（如仅配置了 DeepSeek 等纯聊天渠道）时返回 null。 */
export function buildAgenticMemoryConfig(): Partial<MemoryConfig> | null {
  const embeddingBaseUrl = getAgenticMemoryEmbeddingBaseUrl();
  const apiKey = resolveEmbeddingApiKey();
  if (!embeddingBaseUrl || !apiKey) {
    console.warn(
      "[agentic-memory] 未找到可用的 Embedding 端点，agentic-memory 已禁用。请配置 " +
        "AGENT_EMBEDDING_BASE_URL + AGENT_EMBEDDING_API_KEY（如硅基流动 https://api.siliconflow.cn/v1，模型 BAAI/bge-m3）。" +
        "当前 OPENAI_BASE_URL=" +
        (process.env.OPENAI_BASE_URL ?? "(未设置)") +
        " 不提供 /embeddings。",
    );
    return null;
  }

  const rootDir = getAgenticMemoryDir();
  mkdirSync(rootDir, { recursive: true });

  const embeddingModel = getAgenticMemoryEmbeddingModel();
  // 向量库需要维度（本地向量库/维度校验），但 embeddingDims 不能传给 mem0ai 的
  // OpenAIEmbedder：它会作为 OpenAI 的 `dimensions` 请求参数，而 BAAI/bge-m3 等模型
  // 不支持该参数，导致 siliconflow 返回 400（code 20015）。
  const embeddingDims = getAgenticMemoryEmbeddingDims(embeddingModel);
  const llmModel = getAgenticMemoryLlmModel();

  const qdrantUrl = process.env.AGENT_QDRANT_URL?.trim();
  const base: Partial<MemoryConfig> = {
    embedder: {
      provider: "openai",
      config: {
        apiKey,
        model: embeddingModel,
        baseURL: embeddingBaseUrl,
      },
    },
    llm: {
      provider: "openai",
      config: {
        // LLM 必须用对话 key（OPENAI_API_KEY，如 DeepSeek）；embedding key 打 DeepSeek 端点会 401
        apiKey: resolveOpenAiApiKey() ?? undefined,
        model: llmModel,
        baseURL: process.env.OPENAI_BASE_URL?.trim() || undefined,
      },
    },
    disableHistory: true,
    customInstructions: getAgenticMemoryCustomInstructions(),
  };

  if (qdrantUrl) {
    const client = new QdrantClient({
      url: qdrantUrl,
      apiKey: process.env.AGENT_QDRANT_API_KEY?.trim(),
    });
    return {
      ...base,
      vectorStore: {
        provider: "qdrant",
        config: {
          client,
          collectionName: getAgenticMemoryCollection(),
          embeddingModelDims: embeddingDims,
        },
      },
    };
  }

  return {
    ...base,
    vectorStore: {
      provider: "memory",
      config: {
        collectionName: getAgenticMemoryCollection(),
        dimension: embeddingDims,
        dbPath: join(rootDir, "vectors.db"),
      },
    },
  };
}
