import { useCallback, useEffect } from "react";
import { bindAgentBridge } from "../bridge/agent-bridge";
import { SphereAgentScene } from "../components/SphereAgentScene";
import { useAgentState } from "../hooks/useAgentState";
import { useAgentWebSocket } from "../hooks/useAgentWebSocket";
import "./modes.css";

function readQuery(key: string): string | undefined {
  return new URLSearchParams(window.location.search).get(key) ?? undefined;
}

/** 网页聊天侧边嵌入 — 独立 WS + 可接收父页 postMessage */
export function EmbedApp() {
  const { state, apply, setFocused } = useAgentState({ mood: "idle", energy: 0.55 });
  const wsUrl = readQuery("ws");
  const sessionId = readQuery("sessionId");

  const stableApply = useCallback((patch: Parameters<typeof apply>[0]) => apply(patch), [apply]);

  useAgentWebSocket(stableApply, {
    wsUrl: wsUrl ?? undefined,
    sessionId: sessionId ?? undefined,
    enabled: readQuery("wsOff") !== "1",
  });

  useEffect(() => bindAgentBridge({
    onMood: (mood) => apply({ mood }),
    onEnergy: (energy) => apply({ energy }),
    onCaption: (caption) => apply({ caption }),
  }), [apply]);

  useEffect(() => {
    const onMessage = (ev: MessageEvent) => {
      if (!ev.data || typeof ev.data !== "object") return;
      const d = ev.data as { type?: string; mood?: string; caption?: string; energy?: number };
      if (d.type === "agent-sphere:patch") {
        apply({
          mood: d.mood as typeof state.mood | undefined,
          caption: d.caption === null ? undefined : d.caption,
          energy: d.energy,
        });
      }
    };
    window.addEventListener("message", onMessage);
    window.parent?.postMessage({ type: "agent-sphere:ready" }, "*");
    return () => window.removeEventListener("message", onMessage);
  }, [apply]);

  return (
    <div className="mode-shell mode-embed">
      <SphereAgentScene
        state={state}
        mode="embed"
        physics={false}
        autonomous
        onEyeFocus={setFocused}
      />
    </div>
  );
}
