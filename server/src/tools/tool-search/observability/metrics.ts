export type ToolSearchMetricSnapshot = {
  http_requests_total: number;
  http_errors_total: number;
  search_requests_total: number;
  feedback_reports_total: number;
  graph_queries_total: number;
  lazy_load_requests_total: number;
  execute_requests_total: number;
  /** 召回质量：检索返回后模型实际选中的工具在 matches 中的排名分布 */
  recall: {
    samples: number;
    top1: number;
    top3: number;
    top5: number;
    /** 实际选中的工具不在召回结果里（检索面漏报） */
    miss: number;
  };
  latency_ms: {
    count: number;
    p50: number;
    p95: number;
    p99: number;
  };
  /** 神经通道（sidecar）调用计数，按特性拆分（docs/neural-retrieval-plan.md §6） */
  neural: Record<
    NeuralMetricFeature,
    { requests: number; ok: number; fallback: number; timeout: number; breaker_skips: number }
  >;
};

export type NeuralMetricFeature = "embed" | "rerank" | "intent";

export type NeuralCallOutcome = "ok" | "fallback" | "timeout" | "breaker_skip";

export class ToolSearchMetrics {
  private httpRequests = 0;
  private httpErrors = 0;
  private searchRequests = 0;
  private feedbackReports = 0;
  private graphQueries = 0;
  private lazyLoadRequests = 0;
  private executeRequests = 0;
  private readonly latencySamples: number[] = [];
  private readonly maxLatencySamples = 2_000;
  // 召回质量计数（阶段优化⑤：此前只有延迟指标，检索准确率在线上不可见）
  private recallSamples = 0;
  private recallTop1 = 0;
  private recallTop3 = 0;
  private recallTop5 = 0;
  private recallMiss = 0;
  // 神经通道计数（N1/N2/N3）：requests 含成功，fallback = 质量降级到下一 provider，
  // timeout 是 fallback 的子集但单独计数（p95 预算是否被打穿在线上不可见）
  private readonly neural: Record<
    NeuralMetricFeature,
    { requests: number; ok: number; fallback: number; timeout: number; breaker_skips: number }
  > = {
    embed: { requests: 0, ok: 0, fallback: 0, timeout: 0, breaker_skips: 0 },
    rerank: { requests: 0, ok: 0, fallback: 0, timeout: 0, breaker_skips: 0 },
    intent: { requests: 0, ok: 0, fallback: 0, timeout: 0, breaker_skips: 0 },
  };

  /** 记录一次神经 sidecar 调用结果（breaker_skip = 熔断开闸期直接走降级路径） */
  recordNeural(feature: NeuralMetricFeature, outcome: NeuralCallOutcome): void {
    const slot = this.neural[feature];
    if (!slot) return;
    if (outcome === "breaker_skip") {
      slot.breaker_skips += 1;
      return;
    }
    slot.requests += 1;
    if (outcome === "ok") slot.ok += 1;
    else if (outcome === "timeout") {
      slot.timeout += 1;
      slot.fallback += 1;
    } else slot.fallback += 1;
  }

  recordHttp(ok: boolean, elapsedMs: number): void {
    this.httpRequests += 1;
    if (!ok) this.httpErrors += 1;
    this.latencySamples.push(Math.max(0, elapsedMs));
    if (this.latencySamples.length > this.maxLatencySamples) {
      this.latencySamples.splice(0, this.latencySamples.length - this.maxLatencySamples);
    }
  }

  recordSearch(): void {
    this.searchRequests += 1;
  }

  /**
   * 记录一次召回结果的实际使用排名：模型在 tool_call 时选中的工具在
   * matches 列表中的下标（0 = top-1）。不在列表中记 -1（检索漏报）。
   */
  recordRecall(rank: number): void {
    this.recallSamples += 1;
    if (rank < 0) this.recallMiss += 1;
    else {
      if (rank === 0) this.recallTop1 += 1;
      if (rank < 3) this.recallTop3 += 1;
      if (rank < 5) this.recallTop5 += 1;
    }
  }

  recordFeedback(count: number): void {
    this.feedbackReports += Math.max(0, count);
  }

  recordGraphQuery(): void {
    this.graphQueries += 1;
  }

  recordLazyLoad(): void {
    this.lazyLoadRequests += 1;
  }

  recordExecute(): void {
    this.executeRequests += 1;
  }

  snapshot(): ToolSearchMetricSnapshot {
    const sorted = [...this.latencySamples].sort((a, b) => a - b);
    return {
      http_requests_total: this.httpRequests,
      http_errors_total: this.httpErrors,
      search_requests_total: this.searchRequests,
      feedback_reports_total: this.feedbackReports,
      graph_queries_total: this.graphQueries,
      lazy_load_requests_total: this.lazyLoadRequests,
      execute_requests_total: this.executeRequests,
      recall: {
        samples: this.recallSamples,
        top1: this.recallTop1,
        top3: this.recallTop3,
        top5: this.recallTop5,
        miss: this.recallMiss,
      },
      latency_ms: {
        count: sorted.length,
        p50: percentile(sorted, 0.5),
        p95: percentile(sorted, 0.95),
        p99: percentile(sorted, 0.99),
      },
      neural: {
        embed: { ...this.neural.embed },
        rerank: { ...this.neural.rerank },
        intent: { ...this.neural.intent },
      },
    };
  }

  toPrometheus(): string {
    const s = this.snapshot();
    const rate = (n: number): number => (s.recall.samples > 0 ? Math.round((n / s.recall.samples) * 10000) / 10000 : 0);
    return [
      "# TYPE tool_search_http_requests_total counter",
      `tool_search_http_requests_total ${s.http_requests_total}`,
      "# TYPE tool_search_http_errors_total counter",
      `tool_search_http_errors_total ${s.http_errors_total}`,
      "# TYPE tool_search_search_requests_total counter",
      `tool_search_search_requests_total ${s.search_requests_total}`,
      "# TYPE tool_search_feedback_reports_total counter",
      `tool_search_feedback_reports_total ${s.feedback_reports_total}`,
      "# TYPE tool_search_graph_queries_total counter",
      `tool_search_graph_queries_total ${s.graph_queries_total}`,
      "# TYPE tool_search_lazy_load_requests_total counter",
      `tool_search_lazy_load_requests_total ${s.lazy_load_requests_total}`,
      "# TYPE tool_search_execute_requests_total counter",
      `tool_search_execute_requests_total ${s.execute_requests_total}`,
      "# TYPE tool_search_recall_samples_total counter",
      `tool_search_recall_samples_total ${s.recall.samples}`,
      "# TYPE tool_search_recall_hit_rate gauge",
      `tool_search_recall_hit_rate{rank="top1"} ${rate(s.recall.top1)}`,
      `tool_search_recall_hit_rate{rank="top3"} ${rate(s.recall.top3)}`,
      `tool_search_recall_hit_rate{rank="top5"} ${rate(s.recall.top5)}`,
      `tool_search_recall_hit_rate{rank="miss"} ${rate(s.recall.miss)}`,
      "# TYPE tool_search_latency_ms summary",
      `tool_search_latency_ms{quantile="0.50"} ${s.latency_ms.p50}`,
      `tool_search_latency_ms{quantile="0.95"} ${s.latency_ms.p95}`,
      `tool_search_latency_ms{quantile="0.99"} ${s.latency_ms.p99}`,
      `tool_search_latency_ms_count ${s.latency_ms.count}`,
      ...Object.entries(s.neural).flatMap(([feature, n]) => [
        `# TYPE tool_search_neural_${feature}_requests_total counter`,
        `tool_search_neural_${feature}_requests_total ${n.requests}`,
        `# TYPE tool_search_neural_${feature}_fallback_total counter`,
        `tool_search_neural_${feature}_fallback_total ${n.fallback}`,
        `# TYPE tool_search_neural_${feature}_timeout_total counter`,
        `tool_search_neural_${feature}_timeout_total ${n.timeout}`,
        `# TYPE tool_search_neural_${feature}_breaker_skips_total counter`,
        `tool_search_neural_${feature}_breaker_skips_total ${n.breaker_skips}`,
      ]),
      "",
    ].join("\n");
  }
}

export const toolSearchMetrics = new ToolSearchMetrics();

function percentile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * q) - 1));
  return Math.round((sorted[idx] ?? 0) * 100) / 100;
}
