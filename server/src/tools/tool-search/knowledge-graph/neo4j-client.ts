import type { ResourceRecord } from "../registry/models.js";
import type { ToolRegistryStore } from "../registry/store.js";
import {
  normalizeGraphRelation,
  ToolGraphRelation,
  type ToolGraphRelation as ToolGraphRelationType,
} from "./graph-relations.js";

export type GraphEdge = {
  source_resource_id: string;
  relation_type: ToolGraphRelationType;
  target_resource_id: string;
  weight: number;
  updated_at?: string;
};

export type GraphQueryInput = {
  source_resource_id?: string;
  target_resource_id?: string;
  relation_type?: string;
  limit?: number;
};

/**
 * Neo4j-facing knowledge graph service with a SQLite fallback.
 *
 * 当前仓库尚未引入 neo4j-driver；为了不阻塞主链路，本服务保持 Neo4j 语义接口，
 * 具体持久化先落在 ToolRegistryStore 的 resource_graph_edge 表。后续接入驱动时
 * 可在本文件内部替换实现，调用方不需要变化。
 */
export class ToolKnowledgeGraphService {
  constructor(private readonly store: ToolRegistryStore) {}

  async upsertEdge(edge: Omit<GraphEdge, "updated_at">): Promise<void> {
    await this.store.upsertGraphEdge(edge);
  }

  async query(input: GraphQueryInput): Promise<GraphEdge[]> {
    const relation = input.relation_type
      ? normalizeGraphRelation(input.relation_type)
      : null;
    const rows = await this.store.queryGraphEdges({
      source_resource_id: input.source_resource_id,
      target_resource_id: input.target_resource_id,
      relation_type: relation ?? undefined,
      limit: input.limit,
    });
    const edges: GraphEdge[] = [];
    for (const row of rows) {
      const normalized = normalizeGraphRelation(row.relation_type);
      if (!normalized) continue;
      edges.push({
        source_resource_id: row.source_resource_id,
        relation_type: normalized,
        target_resource_id: row.target_resource_id,
        weight: row.weight,
        updated_at: row.updated_at,
      });
    }
    return edges;
  }

  async getAlternatives(resourceId: string, limit = 5): Promise<ResourceRecord[]> {
    const edges = await this.query({
      source_resource_id: resourceId,
      relation_type: ToolGraphRelation.AlternativeTo,
      limit,
    });
    const out: ResourceRecord[] = [];
    for (const edge of edges) {
      const record = await this.store.getRecord(edge.target_resource_id);
      if (record && record.level1.status === "online") out.push(record);
    }
    return out;
  }

  async expandCandidates(
    candidates: ResourceRecord[],
    limit = 25,
  ): Promise<ResourceRecord[]> {
    const byId = new Map(candidates.map((r) => [r.level1.resource_id, r]));
    const relationTypes = [
      ToolGraphRelation.SimilarTo,
      ToolGraphRelation.CombineWith,
      ToolGraphRelation.DependsOn,
      ToolGraphRelation.Requires,
    ];
    for (const record of candidates) {
      for (const relation of relationTypes) {
        const edges = await this.query({
          source_resource_id: record.level1.resource_id,
          relation_type: relation,
          limit: 10,
        });
        for (const edge of edges) {
          if (byId.size >= limit) break;
          const target = await this.store.getRecord(edge.target_resource_id);
          if (target && target.level1.status === "online") {
            byId.set(target.level1.resource_id, target);
          }
        }
      }
    }
    return [...byId.values()].slice(0, limit);
  }

  async buildCombinationChain(resourceId: string, limit = 5): Promise<string[]> {
    const edges = await this.query({
      source_resource_id: resourceId,
      relation_type: ToolGraphRelation.CombineWith,
      limit,
    });
    return [resourceId, ...edges.map((e) => e.target_resource_id)];
  }
}
