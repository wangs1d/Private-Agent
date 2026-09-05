/**
 * 记忆系统健康快照（P2-16）。
 *
 * 此前各层有零散 telemetry（recall 命中率、token audit、lifecycle 日志），
 * 排查"记忆为什么没召回/为什么没忘"时要翻多处。本模块把所有层的规模与
 * 健康指标聚合成一个快照，经 GET /api/memory/health 暴露（调试用）。
 */

import { getAgenticMemoryRuntime, getMemoryComponents } from "./index.js";
import { getHumanLikeMemoryService } from "../services/human-like-memory-service.js";
import { resolveHumanMemoryStoreMode } from "../services/graph-sqlite-store.js";

export function getMemoryHealthSnapshot(): Record<string, unknown> {
  const runtime = getAgenticMemoryRuntime();
  const { ledger, commitmentBoard, provenance, bridge, understandingStore } =
    getMemoryComponents();
  const humanLike = getHumanLikeMemoryService();

  return {
    generatedAt: new Date().toISOString(),
    mem0: runtime ? { enabled: true } : { enabled: false },
    graph: {
      persistence: resolveHumanMemoryStoreMode(),
      telemetry: humanLike?.getTelemetrySnapshot() ?? null,
      nodeCount: humanLike ? countGraphNodes(humanLike) : null,
    },
    ledger: ledger?.stats() ?? null,
    commitments: commitmentBoard?.statsByStatus() ?? null,
    provenance: provenance?.stats() ?? null,
    bridge: bridge
      ? {
          activeLinks: bridge.listLinks({ activeOnly: true }).length,
          totalLinks: bridge.listLinks().length,
        }
      : null,
    userUnderstanding: understandingStore?.stats() ?? null,
  };
}

function countGraphNodes(service: NonNullable<ReturnType<typeof getHumanLikeMemoryService>>): number {
  try {
    const store = (service as unknown as { store?: { nodes?: Record<string, unknown> } }).store;
    return store?.nodes ? Object.keys(store.nodes).length : 0;
  } catch {
    return 0;
  }
}
