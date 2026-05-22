import { QdrantNarrativeStore } from "../services/qdrant-narrative-store.js";
import { isMemoryTreeDualWriteHybrid, isMemoryTreeEnabled } from "./env.js";
import { MemoryTreeIngestService } from "./ingest.js";
import { MemoryTreeRetrievalService } from "./retrieval.js";
import { MemoryTreeScheduler } from "./scheduler.js";
import { MemoryTreeStore } from "./store.js";
import { createMemoryTreeWorkerPool, MemoryTreeWorkerPool } from "./worker.js";

export type MemoryTreeRuntime = {
  store: MemoryTreeStore;
  ingest: MemoryTreeIngestService;
  retrieval: MemoryTreeRetrievalService;
  workers: MemoryTreeWorkerPool;
  scheduler: MemoryTreeScheduler;
};

let singleton: MemoryTreeRuntime | null = null;

export function createMemoryTreeRuntime(): MemoryTreeRuntime | null {
  if (!isMemoryTreeEnabled()) return null;

  const store = new MemoryTreeStore();
  const ingest = new MemoryTreeIngestService(store);
  const retrieval = new MemoryTreeRetrievalService(store, new QdrantNarrativeStore());
  const workers = createMemoryTreeWorkerPool(store, retrieval);
  ingest.onChunkEnqueued = () => workers.wake();
  const scheduler = new MemoryTreeScheduler(store);

  workers.start();
  scheduler.start();

  return { store, ingest, retrieval, workers, scheduler };
}

export function getMemoryTreeRuntime(): MemoryTreeRuntime | null {
  if (!singleton) singleton = createMemoryTreeRuntime();
  return singleton;
}

export function isMemoryTreeDualWriteEnabled(): boolean {
  return isMemoryTreeDualWriteHybrid();
}

export type { MemoryTreeIngestEvent, MemoryTreeRetrievalQuery } from "./types.js";
