import type { Level3McpSchema } from "../registry/models.js";

export type McpConnectionState = {
  resource_id: string;
  endpoint: string;
  transport: Level3McpSchema["transport"];
  healthy: boolean;
  last_heartbeat_at: string | null;
  consecutive_failures: number;
};

export type McpCallResult =
  | { ok: true; result: unknown; state: McpConnectionState }
  | { ok: false; error_code: string; error_message: string; state: McpConnectionState };

/**
 * Phase-7 MCP connection pool.
 *
 * 目前支持 HTTP/SSE endpoint 的轻量复用与心跳；stdio 先保留状态位，避免在
 * tool-search 架构升级中引入额外进程生命周期复杂度。
 */
export class McpConnectionPool {
  private readonly states = new Map<string, McpConnectionState>();

  getOrCreate(schema: Level3McpSchema): McpConnectionState {
    const existing = this.states.get(schema.resource_id);
    if (existing) return existing;
    const state: McpConnectionState = {
      resource_id: schema.resource_id,
      endpoint: schema.endpoint,
      transport: schema.transport,
      healthy: true,
      last_heartbeat_at: null,
      consecutive_failures: 0,
    };
    this.states.set(schema.resource_id, state);
    return state;
  }

  async heartbeat(schema: Level3McpSchema): Promise<McpConnectionState> {
    const state = this.getOrCreate(schema);
    if (schema.transport === "stdio") {
      state.healthy = true;
      state.last_heartbeat_at = new Date().toISOString();
      return state;
    }
    try {
      await fetchWithTimeout(schema.endpoint, {
        method: "HEAD",
        timeoutMs: Math.min(schema.heartbeat_interval_ms, 5_000),
      });
      state.healthy = true;
      state.consecutive_failures = 0;
      state.last_heartbeat_at = new Date().toISOString();
    } catch (e) {
      state.healthy = false;
      state.consecutive_failures += 1;
      state.last_heartbeat_at = new Date().toISOString();
      console.warn("[tool-search:mcp-pool] heartbeat failed", e);
    }
    return state;
  }

  async call(
    schema: Level3McpSchema,
    method: string,
    params: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<McpCallResult> {
    const state = this.getOrCreate(schema);
    if (state.consecutive_failures >= 3) {
      return {
        ok: false,
        error_code: "MCP_CIRCUIT_OPEN",
        error_message: `MCP resource ${schema.resource_id} has too many failures`,
        state,
      };
    }
    if (schema.transport === "stdio") {
      return {
        ok: false,
        error_code: "MCP_STDIO_NOT_ATTACHED",
        error_message: "stdio MCP execution is not attached in this route layer",
        state,
      };
    }

    try {
      const response = await fetchWithTimeout(schema.endpoint, {
        method: "POST",
        timeoutMs,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method, params }),
      });
      const result = await response.json().catch(() => null);
      state.healthy = response.ok;
      state.consecutive_failures = response.ok ? 0 : state.consecutive_failures + 1;
      return response.ok
        ? { ok: true, result, state }
        : {
            ok: false,
            error_code: "MCP_CALL_FAILED",
            error_message: `MCP endpoint returned HTTP ${response.status}`,
            state,
          };
    } catch (e) {
      state.healthy = false;
      state.consecutive_failures += 1;
      return {
        ok: false,
        error_code: "MCP_CALL_EXCEPTION",
        error_message: e instanceof Error ? e.message : String(e),
        state,
      };
    }
  }

  listStates(): McpConnectionState[] {
    return [...this.states.values()];
  }
}

async function fetchWithTimeout(
  url: string,
  options: RequestInit & { timeoutMs: number },
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}
