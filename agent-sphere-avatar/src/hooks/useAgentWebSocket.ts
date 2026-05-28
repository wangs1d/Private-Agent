import { useEffect, useRef, useState } from "react";
import {
  mapProcessingIdle,
  mapUserMessageSent,
  mapWsToAgentUpdate,
  resetWsMapperState,
} from "../bridge/ws-agent-mapper";
import type { AgentState } from "../types/agent";
import { DEFAULT_AGENT_STATE } from "../types/agent";

function resolveWsUrl(explicit?: string): string {
  if (explicit?.trim()) return explicit.trim();
  if (typeof window !== "undefined") {
    const u = new URL("/ws", window.location.href);
    u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
    return u.href;
  }
  return "ws://127.0.0.1:3000/ws";
}

function resolveSessionId(explicit?: string): string {
  if (explicit?.trim()) return explicit.trim();
  const key = "pai_web_session_id";
  let id = localStorage.getItem(key);
  if (!id) {
    id = `web-${Date.now().toString(36)}`;
    localStorage.setItem(key, id);
  }
  return id;
}

interface UseAgentWebSocketOptions {
  wsUrl?: string;
  sessionId?: string;
  enabled?: boolean;
  onConnected?: () => void;
  onDisconnected?: () => void;
}

export function useAgentWebSocket(
  apply: (patch: Partial<AgentState>) => void,
  options: UseAgentWebSocketOptions = {},
) {
  const { wsUrl, sessionId, enabled = true, onConnected, onDisconnected } = options;
  const [connected, setConnected] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectRef = useRef<number | null>(null);
  const applyRef = useRef(apply);
  applyRef.current = apply;

  useEffect(() => {
    if (!enabled) return;

    const sid = resolveSessionId(sessionId);
    const url = resolveWsUrl(wsUrl);
    resetWsMapperState();
    applyRef.current({ ...DEFAULT_AGENT_STATE });

    const connect = () => {
      const ws = new WebSocket(url);
      wsRef.current = ws;

      ws.addEventListener("open", () => {
        setConnected(true);
        ws.send(JSON.stringify({ type: "session.init", payload: { sessionId: sid, userId: sid } }));
        onConnected?.();
      });

      ws.addEventListener("close", () => {
        setConnected(false);
        onDisconnected?.();
        reconnectRef.current = window.setTimeout(connect, 3000);
      });

      ws.addEventListener("message", (ev) => {
        let msg: { type: string; payload?: Record<string, unknown> };
        try {
          msg = JSON.parse(String(ev.data));
        } catch {
          return;
        }

        if (msg.type === "chat.user_message") {
          applyRef.current(mapUserMessageSent());
          return;
        }

        const patch = mapWsToAgentUpdate(msg);
        if (patch) {
          applyRef.current(patch);
          if (patch.mood === "happy") {
            window.setTimeout(() => applyRef.current(mapProcessingIdle()), 1800);
          }
        }
      });
    };

    connect();

    return () => {
      if (reconnectRef.current) window.clearTimeout(reconnectRef.current);
      wsRef.current?.close();
      wsRef.current = null;
    };
  }, [enabled, wsUrl, sessionId, onConnected, onDisconnected]);

  return { connected, sessionId: resolveSessionId(sessionId) };
}
