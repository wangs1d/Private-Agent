/**
 * 报价聚合器工厂：组装默认源集（local 保底 + 可选 MCP/浏览器实时源）。
 *
 * bootstrap 调用一次，注入 TravelTicketProvider。源可用性由各自 fetch 内部判定
 * （MCP 未启用/浏览器未装 Playwright 都返回空，聚合器如实汇总），故这里无条件挂载。
 */

import type { McpCaller } from "./mcp-quote-source.js";
import type { BrowserRunner } from "./browser-quote-source.js";
import type { QuoteSource, QuoteAggregatorOptions } from "./quote-source.js";
import { QuoteAggregator } from "./quote-aggregator.js";
import { LocalQuoteSource } from "./local-quote-source.js";
import { createRollingGoHotelSource, createCtripFlightSource } from "./site-adapters.js";

export interface BuildQuoteAggregatorDeps {
  mcpCaller?: McpCaller | null;
  browserRunner?: BrowserRunner | null;
  /** 显式覆盖源集（测试用）；缺省 = local + 已配置的实时源 */
  sources?: QuoteSource[];
  options?: QuoteAggregatorOptions;
}

export function buildDefaultQuoteSources(deps: BuildQuoteAggregatorDeps): QuoteSource[] {
  if (deps.sources) return deps.sources;
  const sources: QuoteSource[] = [new LocalQuoteSource()];
  if (deps.mcpCaller) sources.push(createRollingGoHotelSource(deps.mcpCaller));
  if (deps.browserRunner) sources.push(createCtripFlightSource(deps.browserRunner));
  return sources;
}

export function buildQuoteAggregator(deps: BuildQuoteAggregatorDeps): QuoteAggregator {
  return new QuoteAggregator(buildDefaultQuoteSources(deps), deps.options);
}
