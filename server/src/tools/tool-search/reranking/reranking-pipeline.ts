import type { QueryConstraints } from "../intent-router/intent-router.js";
import type { HybridRetrievedResource } from "../retrieval/hybrid-retrieval.js";

export type RerankInput = {
  raw_query: string;
  agent_context_hash: string;
  previous_tool_result?: unknown;
  query_constraints: QueryConstraints;
  candidates: HybridRetrievedResource[];
  blacklist_resource_ids?: string[];
};

export type LlmReranker = (
  input: Omit<RerankInput, "candidates"> & {
    candidates: HybridRetrievedResource[];
  },
) => Promise<string[]>;

export type RerankingPipelineOptions = {
  llmReranker?: LlmReranker;
};

export type RerankResult = {
  candidates: HybridRetrievedResource[];
  rule_filtered_count: number;
  llm_seen_count: number;
};

export class ToolRerankingPipeline {
  private readonly llmReranker: LlmReranker | undefined;

  constructor(options?: RerankingPipelineOptions) {
    this.llmReranker = options?.llmReranker;
  }

  async rerank(input: RerankInput): Promise<RerankResult> {
    const blacklist = new Set(input.blacklist_resource_ids ?? []);
    const rulePassed = input.candidates.filter((candidate) =>
      passesRules(candidate, input.query_constraints, blacklist),
    );

    const crossEncoded = rulePassed
      .map((candidate) => ({
        ...candidate,
        final_score: crossEncoderScore(candidate),
      }))
      .sort((a, b) => b.final_score - a.final_score);

    const topForLlm = crossEncoded.slice(0, 10);
    if (!this.llmReranker || topForLlm.length <= 1) {
      return {
        candidates: crossEncoded,
        rule_filtered_count: input.candidates.length - rulePassed.length,
        llm_seen_count: 0,
      };
    }

    try {
      const orderedIds = await this.llmReranker({
        raw_query: input.raw_query,
        agent_context_hash: input.agent_context_hash,
        previous_tool_result: input.previous_tool_result,
        query_constraints: input.query_constraints,
        candidates: topForLlm,
        blacklist_resource_ids: input.blacklist_resource_ids,
      });
      const rank = new Map(orderedIds.map((id, idx) => [id, idx]));
      const rerankedTop = [...topForLlm].sort((a, b) => {
        const ra = rank.get(a.resource.level1.resource_id) ?? Number.MAX_SAFE_INTEGER;
        const rb = rank.get(b.resource.level1.resource_id) ?? Number.MAX_SAFE_INTEGER;
        return ra - rb;
      });
      const rest = crossEncoded.slice(10);
      return {
        candidates: [...rerankedTop, ...rest],
        rule_filtered_count: input.candidates.length - rulePassed.length,
        llm_seen_count: topForLlm.length,
      };
    } catch (e) {
      console.warn("[tool-search:rerank] LLM reranker failed, using cross-encoder order", e);
      return {
        candidates: crossEncoded,
        rule_filtered_count: input.candidates.length - rulePassed.length,
        llm_seen_count: topForLlm.length,
      };
    }
  }
}

function passesRules(
  candidate: HybridRetrievedResource,
  constraints: QueryConstraints,
  blacklist: Set<string>,
): boolean {
  const record = candidate.resource;
  if (blacklist.has(record.level1.resource_id)) return false;
  if (record.level1.status !== "online") return false;
  if (constraints.read_only && isLikelyWriteResource(candidate)) return false;
  return true;
}

function crossEncoderScore(candidate: HybridRetrievedResource): number {
  const c = candidate.components;
  const score =
    candidate.final_score * 0.55 +
    c.embedding_score * 0.2 +
    c.keyword_score * 0.15 +
    c.history_success_score * 0.1 -
    c.failure_penalty * 0.2;
  return Math.round(Math.max(0, Math.min(1, score)) * 10_000) / 10_000;
}

function isLikelyWriteResource(candidate: HybridRetrievedResource): boolean {
  const name = candidate.resource.level1.name.toLowerCase();
  return /(?:^|[._-])(?:accept|call|comment|create|delete|deliver|dispatch|execute|like|pay|post|purchase|reject|remove|respond|run|send|submit|transfer|update|upload|write)(?:[._-]|$)/.test(
    name,
  );
}
