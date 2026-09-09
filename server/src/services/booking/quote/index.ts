/**
 * 实时报价比价抽象层公共出口。
 */

export type {
  QuoteType,
  QuotePriceSource,
  QuoteRequest,
  TravelQuote,
  QuoteSourceResult,
  QuoteSource,
  QuoteSourceOutcome,
  QuoteAggregate,
  QuoteAggregatorOptions,
} from "./quote-source.js";
export { compareQuotes } from "./quote-source.js";
export { QuoteAggregator } from "./quote-aggregator.js";
export { LocalQuoteSource } from "./local-quote-source.js";
export {
  McpQuoteSource,
  type McpCaller,
  type McpQuoteSourceConfig,
} from "./mcp-quote-source.js";
export {
  BrowserQuoteSource,
  type BrowserRunner,
  type BrowserQuoteSourceConfig,
} from "./browser-quote-source.js";
export {
  createRollingGoHotelSource,
  createCtripFlightSource,
  parseCtripFlightText,
} from "./site-adapters.js";
export {
  buildDefaultQuoteSources,
  buildQuoteAggregator,
  type BuildQuoteAggregatorDeps,
} from "./aggregator-factory.js";
