/**
 * 本地嵌入端点编排：无远端 Embedding 配置时的零配置底座。
 *
 * - bootstrap 在装配记忆系统前调用 ensureLocalEmbeddingEndpoint()（仅当
 *   resolveEmbeddingEndpoint() 为空，即没有任何远端端点时）；
 * - openai-embedding-client.resolveEmbeddingEndpoint() 末位读取
 *   getLocalEmbeddingEndpoint() 作兜底——显式远端永远优先；
 * - 引擎失败（模型缺失 / AGENT_LOCAL_EMBEDDING_DISABLED=1 / 加载异常）一律
 *   返回 null，回退到旧行为（嵌入消费方跳过、agentic-memory 禁用）。
 */

import {
  initLocalEmbeddingEngine,
  isLocalEmbeddingDisabled,
  resolveLocalEmbeddingModelDir,
} from "./local-embedding-engine.js";
import { startLocalEmbeddingServer, type LocalEmbeddingEndpoint } from "./local-embedding-server.js";

let endpointPromise: Promise<LocalEmbeddingEndpoint | null> | null = null;
let started: LocalEmbeddingEndpoint | null = null;

export function getLocalEmbeddingEndpoint(): LocalEmbeddingEndpoint | null {
  return started;
}

/** 幂等；同一进程只启动一次 */
export function ensureLocalEmbeddingEndpoint(): Promise<LocalEmbeddingEndpoint | null> {
  if (!endpointPromise) endpointPromise = doEnsure();
  return endpointPromise;
}

async function doEnsure(): Promise<LocalEmbeddingEndpoint | null> {
  if (isLocalEmbeddingDisabled()) {
    console.info("[local-embedding] AGENT_LOCAL_EMBEDDING_DISABLED=1，内置向量引擎关闭");
    return null;
  }
  const engine = await initLocalEmbeddingEngine();
  if (!engine) {
    const dir = resolveLocalEmbeddingModelDir();
    console.warn(
      "[local-embedding] 内置向量引擎不可用（模型资产缺失" +
        (dir ? "" : "：未找到 models/bge-small-zh-v1.5") +
        "），记忆向量化将维持禁用；可配置 AGENT_EMBEDDING_BASE_URL + AGENT_EMBEDDING_API_KEY 走远端",
    );
    return null;
  }
  try {
    started = await startLocalEmbeddingServer(engine);
    return started;
  } catch (err) {
    console.warn(
      "[local-embedding] 回环端点启动失败:",
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}
