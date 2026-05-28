import { Memory } from "mem0ai/oss";

import { buildAgenticMemoryConfig } from "./config.js";
import { isAgenticMemoryEnabled } from "./env.js";
import { AgenticMemoryIngestService } from "./ingest.js";
import { AgenticMemoryRetrievalService } from "./retrieval.js";
import { AgenticMemoryLifecycleService } from "./memory-lifecycle.js";
import { AgenticMemoryRecallCompressor } from "./recall-compressor.js";

export type AgenticMemoryRuntime = {
  memory: Memory;
  ingest: AgenticMemoryIngestService;
  retrieval: AgenticMemoryRetrievalService;
  lifecycle: AgenticMemoryLifecycleService;
  compressor: AgenticMemoryRecallCompressor;
};

let singleton: AgenticMemoryRuntime | null | undefined;

export function getAgenticMemoryRuntime(): AgenticMemoryRuntime | null {
  if (singleton !== undefined) return singleton;
  if (!isAgenticMemoryEnabled()) {
    singleton = null;
    return null;
  }

  const config = buildAgenticMemoryConfig();
  if (!config) {
    console.warn("[agentic-memory] disabled: OPENAI_API_KEY required for Mem0 OSS");
    singleton = null;
    return null;
  }

  try {
    const memory = new Memory(config);
    const lifecycle = new AgenticMemoryLifecycleService(memory);
    lifecycle.start();

    singleton = {
      memory,
      ingest: new AgenticMemoryIngestService(memory),
      retrieval: new AgenticMemoryRetrievalService(memory),
      lifecycle,
      compressor: new AgenticMemoryRecallCompressor(),
    };
    console.info("[agentic-memory] Mem0 OSS runtime ready (entity linking + multi-signal retrieval + lifecycle + compressor)");
    return singleton;
  } catch (e) {
    console.warn(
      "[agentic-memory] init failed:",
      e instanceof Error ? e.message : e,
    );
    singleton = null;
    return null;
  }
}

export { AgenticMemoryIngestService } from "./ingest.js";
export { AgenticMemoryRetrievalService } from "./retrieval.js";
export { AgenticMemoryLifecycleService } from "./memory-lifecycle.js";
export { AgenticMemoryRecallCompressor } from "./recall-compressor.js";
export {
  getAgenticMemoryCollection,
  getAgenticMemoryDir,
  getAgenticMemoryTopK,
  isAgenticMemoryEnabled,
} from "./env.js";
