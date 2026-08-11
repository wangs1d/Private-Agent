export type ToolSearchMetricSnapshot = {
  http_requests_total: number;
  http_errors_total: number;
  search_requests_total: number;
  feedback_reports_total: number;
  graph_queries_total: number;
  lazy_load_requests_total: number;
  execute_requests_total: number;
  latency_ms: {
    count: number;
    p50: number;
    p95: number;
    p99: number;
  };
};

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
      latency_ms: {
        count: sorted.length,
        p50: percentile(sorted, 0.5),
        p95: percentile(sorted, 0.95),
        p99: percentile(sorted, 0.99),
      },
    };
  }

  toPrometheus(): string {
    const s = this.snapshot();
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
      "# TYPE tool_search_latency_ms summary",
      `tool_search_latency_ms{quantile="0.50"} ${s.latency_ms.p50}`,
      `tool_search_latency_ms{quantile="0.95"} ${s.latency_ms.p95}`,
      `tool_search_latency_ms{quantile="0.99"} ${s.latency_ms.p99}`,
      `tool_search_latency_ms_count ${s.latency_ms.count}`,
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
