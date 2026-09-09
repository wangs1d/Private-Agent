/**
 * MCP 报价源：把一个 MCP 工具（官方/合作方实时报价）适配成 `QuoteSource`。
 *
 * 抽象点：不同 MCP 的入参/出参结构各异（滴滴 taxi_estimate、RollingGo
 * searchHotels…），这里用两个回调把差异隔离在注册处：
 *   - mapRequest：QuoteRequest → MCP 工具入参（返回 null 表示该源不处理此请求）
 *   - parseResult：MCP 工具返回 → TravelQuote[]
 *
 * 注册示例（bootstrap，RollingGo 酒店启用后）：
 *   new McpQuoteSource({
 *     id: "mcp.rollinggo", label: "RollingGo 酒店",
 *     serverAlias: "rollinggo", toolName: "searchHotels",
 *     supports: (t) => t === "hotel",
 *     mapRequest: (req) => ({ city: req.city, checkIn: req.checkInDate, ... }),
 *     parseResult: (raw) => (raw.hotels ?? []).map(h => ({ ... })),
 *   })
 *
 * 诚实边界：MCP 返回的价格标 priceSource=api；解析失败/无数据返回空 quotes，
 * 聚合器会如实说明「该源本次未取到报价」，绝不编造。
 */

import type { ToolContext } from "../../../tools/tool-registry.js";
import type {
  QuoteRequest,
  QuoteSource,
  QuoteSourceResult,
  QuoteType,
  TravelQuote,
} from "./quote-source.js";

/** MCP 客户端最小依赖面（便于测试注入桩）。 */
export interface McpCaller {
  callTool(
    serverAlias: string,
    toolName: string,
    args: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<{ ok: boolean; result: Record<string, unknown> }>;
  listServers(): Array<{ alias: string; enabled?: boolean }>;
}

export interface McpQuoteSourceConfig {
  /** 源标识（建议 `mcp.<alias>`） */
  id: string;
  label: string;
  serverAlias: string;
  toolName: string;
  supports(type: QuoteType): boolean;
  /** QuoteRequest → MCP 入参；返回 null = 本源跳过该请求 */
  mapRequest(req: QuoteRequest): Record<string, unknown> | null;
  /** MCP 返回 → 报价数组（解析失败返回 []） */
  parseResult(raw: Record<string, unknown>, req: QuoteRequest): TravelQuote[];
  /** 单源调用超时（默认 25s，MCP 报价通常较慢） */
  timeoutMs?: number;
}

export class McpQuoteSource implements QuoteSource {
  readonly id: string;
  readonly label: string;

  constructor(
    private readonly caller: McpCaller,
    private readonly config: McpQuoteSourceConfig,
  ) {
    this.id = config.id;
    this.label = config.label;
  }

  supports(type: QuoteType): boolean {
    return this.config.supports(type);
  }

  async fetch(req: QuoteRequest, _ctx: ToolContext): Promise<QuoteSourceResult> {
    const server = this.caller.listServers().find((s) => s.alias === this.config.serverAlias);
    if (!server || server.enabled === false) {
      return { ok: false, error: `MCP 服务 ${this.config.serverAlias} 未启用` };
    }
    const args = this.config.mapRequest(req);
    if (!args) return { ok: true, quotes: [], note: `${this.label} 不处理该查询` };

    const call = await this.caller.callTool(
      this.config.serverAlias,
      this.config.toolName,
      args,
      this.config.timeoutMs ?? 25_000,
    );
    if (!call.ok) {
      const err = typeof call.result?.error === "string" ? call.result.error : "MCP 调用失败";
      return { ok: false, error: `${this.label}：${err}` };
    }
    try {
      const quotes = this.config.parseResult(call.result, req);
      return {
        ok: true,
        quotes,
        note: quotes.length > 0 ? undefined : `${this.label} 本次未取到报价`,
      };
    } catch (e) {
      return { ok: false, error: `${this.label} 解析失败：${e instanceof Error ? e.message : String(e)}` };
    }
  }
}
