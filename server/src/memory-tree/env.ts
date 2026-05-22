import { join } from "node:path";

function envPositiveInt(name: string, fallback: number): number {
  const v = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

function envBool(name: string, defaultOn: boolean): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) return defaultOn;
  if (raw === "0" || raw === "off" || raw === "false" || raw === "no") return false;
  return true;
}

export function isMemoryTreeEnabled(): boolean {
  return envBool("AGENT_MEMORY_TREE_ENABLED", true);
}

export function getMemoryTreeRootDir(): string {
  return process.env.AGENT_MEMORY_TREE_DIR?.trim() || join(process.cwd(), "data", "memory_tree");
}

export function getMemoryTreeChunkMaxTokens(): number {
  return envPositiveInt("AGENT_MEMORY_TREE_CHUNK_MAX_TOKENS", 3000);
}

export function getMemoryTreeWorkerCount(): number {
  return envPositiveInt("AGENT_MEMORY_TREE_WORKERS", 3);
}

export function getMemoryTreeBufferMaxLeaves(): number {
  return envPositiveInt("AGENT_MEMORY_TREE_BUFFER_MAX_LEAVES", 8);
}

export function getMemoryTreeBm25Top(): number {
  return envPositiveInt("AGENT_MEMORY_TREE_BM25_TOP", 24);
}

export function getMemoryTreeVecTop(): number {
  return envPositiveInt("AGENT_MEMORY_TREE_VEC_TOP", 24);
}

export function getMemoryTreeFuseTop(): number {
  return envPositiveInt("AGENT_MEMORY_TREE_FUSE_TOP", 8);
}

export function getMemoryTreeRrfK(): number {
  return envPositiveInt("AGENT_MEMORY_TREE_RRF_K", 60);
}

export function isMemoryTreeDualWriteHybrid(): boolean {
  return envBool("AGENT_MEMORY_TREE_DUAL_WRITE_HYBRID", false);
}

export function getKvSummaryAppendMode(): "full" | "minimal" {
  const raw = process.env.AGENT_KV_SUMMARY_APPEND_MODE?.trim().toLowerCase();
  return raw === "minimal" ? "minimal" : "full";
}
