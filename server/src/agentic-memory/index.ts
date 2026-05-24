import { Memory } from "mem0ai/oss";

import { buildAgenticMemoryConfig } from "./config.js";
import { isAgenticMemoryEnabled } from "./env.js";
import { AgenticMemoryIngestService } from "./ingest.js";
import { AgenticMemoryRetrievalService } from "./retrieval.js";

export type AgenticMemoryRuntime = {
  memory: Memory;
  ingest: AgenticMemoryIngestService;
  retrieval: AgenticMemoryRetrievalService;
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
    singleton = {
      memory,
      ingest: new AgenticMemoryIngestService(memory),
      retrieval: new AgenticMemoryRetrievalService(memory),
    };
    console.info("[agentic-memory] Mem0 OSS runtime ready (entity linking + multi-signal retrieval)");
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
export {
  getAgenticMemoryCollection,
  getAgenticMemoryDir,
  getAgenticMemoryTopK,
  isAgenticMemoryEnabled,
} from "./env.js";
