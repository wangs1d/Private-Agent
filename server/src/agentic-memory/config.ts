import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { QdrantClient } from "@qdrant/js-client-rest";
import type { MemoryConfig } from "mem0ai/oss";

import {
  getAgenticMemoryCollection,
  getAgenticMemoryCustomInstructions,
  getAgenticMemoryDir,
  getAgenticMemoryEmbeddingModel,
  getAgenticMemoryLlmModel,
  resolveOpenAiApiKey,
} from "./env.js";

const EMBEDDING_DIMS = 1536;

/** 构建 Mem0 OSS 配置；缺少 OPENAI_API_KEY 时返回 null。 */
export function buildAgenticMemoryConfig(): Partial<MemoryConfig> | null {
  const apiKey = resolveOpenAiApiKey();
  if (!apiKey) return null;

  const rootDir = getAgenticMemoryDir();
  mkdirSync(rootDir, { recursive: true });

  const qdrantUrl = process.env.AGENT_QDRANT_URL?.trim();
  const base: Partial<MemoryConfig> = {
    embedder: {
      provider: "openai",
      config: {
        apiKey,
        model: getAgenticMemoryEmbeddingModel(),
        embeddingDims: EMBEDDING_DIMS,
      },
    },
    llm: {
      provider: "openai",
      config: {
        apiKey,
        model: getAgenticMemoryLlmModel(),
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
          embeddingModelDims: EMBEDDING_DIMS,
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
        dimension: EMBEDDING_DIMS,
        dbPath: join(rootDir, "vectors.db"),
      },
    },
  };
}
