import { useCallback, useEffect } from "react";
import { SphereAgentScene } from "../components/SphereAgentScene";
import { useAgentState } from "../hooks/useAgentState";
import { useAgentWebSocket } from "../hooks/useAgentWebSocket";
import { useOverlayWindowMotion } from "../hooks/useOverlayWindowMotion";
import type { AgentMood } from "../types/agent";
import "../index.css";
import "./modes.css";

function readQuery(key: string): string | undefined {
  return new URLSearchParams(window.location.search).get(key) ?? undefined;
}

/** 桌面透明悬浮窗 — 点击穿透，仅曲屏眼可交互 */
export function OverlayApp() {
  const { state, apply, setFocused } = useAgentState({ mood: "idle", energy: 0.55 });
  const wsUrl = readQuery("ws");
  const sessionId = readQuery("sessionId");

  const stableApply = useCallback((patch: Parameters<typeof apply>[0]) => apply(patch), [apply]);

  const { connected } = useAgentWebSocket(stableApply, {
    wsUrl: wsUrl ?? undefined,
    sessionId: sessionId ?? undefined,
  });

  useOverlayWindowMotion({ enabled: true, mood: state.mood });

  const handleEyeInteraction = useCallback((active: boolean) => {
    window.sphereOverlay?.setIgnoreMouseEvents(!active, true);
    setFocused(active);
  }, [setFocused]);

  useEffect(() => {
    document.body.classList.add("overlay-body");
    window.sphereOverlay?.setIgnoreMouseEvents(true, true);

    window.sphereOverlay?.onPatch?.((patch: {
      mood?: AgentMood;
      energy?: number;
      caption?: string | null;
    }) => {
      apply({
        mood: patch.mood,
        energy: patch.energy,
        caption: patch.caption === null ? undefined : patch.caption,
      });
    });

    return () => document.body.classList.remove("overlay-body");
  }, [apply]);

  return (
    <div className="mode-shell mode-overlay">
      <SphereAgentScene
        state={state}
        mode="overlay"
        physics={false}
        autonomous
        onEyeFocus={setFocused}
        onEyeInteractionChange={handleEyeInteraction}
      />
      <div className="overlay-status">
        <span className={`mode-badge mode-badge--${state.mood}`}>{state.mood}</span>
        <span className="overlay-dot" data-connected={connected ? "1" : "0"} />
        <span className="overlay-hint">仅眼睛区域可点击</span>
      </div>
    </div>
  );
}
