import type { DeferredToolEntry } from "./catalog.js";
import { describeDeferredTool, resolveCatalogToolName, searchDeferredTools } from "./catalog.js";
import { getToolSearchConfig } from "./env.js";

export type ToolSearchBridgeResult =
  | {
      kind: "search" | "describe";
      ok: boolean;
      result: Record<string, unknown>;
    }
  | {
      kind: "call";
      ok: true;
      registryToolName: string;
      parsedArgs: Record<string, unknown>;
    }
  | {
      kind: "call";
      ok: false;
      result: Record<string, unknown>;
    };

export function executeToolSearchBridge(
  bridgeName: string,
  args: Record<string, unknown>,
  catalog: DeferredToolEntry[],
): ToolSearchBridgeResult {
  const cfg = getToolSearchConfig();

  if (bridgeName === "tool_search") {
    const query = String(args.query ?? "").trim();
    if (!query) {
      return { kind: "search", ok: false, result: { error: "query 不能为空", matches: [] } };
    }
    const requested = Number(args.limit);
    const limit = Number.isFinite(requested) && requested > 0
      ? Math.min(Math.floor(requested), cfg.maxSearchLimit)
      : cfg.searchDefaultLimit;
    const matches = searchDeferredTools(catalog, query, limit);
    return { kind: "search", ok: true, result: { matches, query, count: matches.length } };
  }

  if (bridgeName === "tool_describe") {
    const name = String(args.name ?? "").trim();
    if (!name) {
      return { kind: "describe", ok: false, result: { error: "name 不能为空" } };
    }
    const schema = describeDeferredTool(catalog, name);
    if (!schema) {
      return { kind: "describe", ok: false, result: { error: `未找到延迟工具: ${name}` } };
    }
    return { kind: "describe", ok: true, result: schema };
  }

  if (bridgeName === "tool_call") {
    const name = String(args.name ?? "").trim();
    if (!name) {
      return { kind: "call", ok: false, result: { error: "name 不能为空" } };
    }
    const entry = resolveCatalogToolName(catalog, name);
    if (!entry) {
      return { kind: "call", ok: false, result: { error: `未找到延迟工具: ${name}` } };
    }
    const parsedArgs =
      args.arguments && typeof args.arguments === "object" && !Array.isArray(args.arguments)
        ? (args.arguments as Record<string, unknown>)
        : {};
    return {
      kind: "call",
      ok: true,
      registryToolName: entry.registryName,
      parsedArgs,
    };
  }

  return { kind: "search", ok: false, result: { error: `未知桥接工具: ${bridgeName}` } };
}
