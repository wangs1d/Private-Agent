import { useEffect } from "react";
import { dispatchEmbodimentCommand } from "../bridge/agent-bridge";
import type { EmbodimentCommand } from "../types/agent";

function parseCommand(payload: Record<string, unknown>): EmbodimentCommand | null {
  const action = payload.action;
  if (
    action !== "roam" &&
    action !== "move" &&
    action !== "stop" &&
    action !== "window_roam"
  ) {
    return null;
  }
  return {
    action,
    x: typeof payload.x === "number" ? payload.x : undefined,
    y: typeof payload.y === "number" ? payload.y : undefined,
    z: typeof payload.z === "number" ? payload.z : undefined,
    strength: typeof payload.strength === "number" ? payload.strength : undefined,
    mood: payload.mood as EmbodimentCommand["mood"],
    energy: typeof payload.energy === "number" ? payload.energy : undefined,
    caption:
      payload.caption === null
        ? null
        : payload.caption != null
          ? String(payload.caption)
          : undefined,
    source: payload.source ? String(payload.source) : undefined,
  };
}

/** 接收 postMessage 的具身指令（父页 WS 转发） */
export function useEmbodimentCommandRelay(enabled = true) {
  useEffect(() => {
    if (!enabled) return;

    const onMessage = (ev: MessageEvent) => {
      const d = ev.data as { type?: string } & Record<string, unknown>;
      if (d?.type !== "agent-sphere:command") return;
      const cmd = parseCommand(d);
      if (cmd) dispatchEmbodimentCommand(cmd);
    };

    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [enabled]);
}

export function relayEmbodimentCommandFromWs(payload: Record<string, unknown>) {
  const cmd = parseCommand(payload);
  if (cmd) dispatchEmbodimentCommand(cmd);
}
