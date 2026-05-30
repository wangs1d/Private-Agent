import { useCallback, useEffect, useState } from "react";
import { OverlayQuickMenu } from "../components/OverlayQuickMenu";
import { InnerThought } from "../components/InnerThought";
import { SphereAgentScene } from "../components/SphereAgentScene";
import type { QuickCommand } from "../constants/quick-commands";
import { useAgentState } from "../hooks/useAgentState";
import { useAgentWebSocket } from "../hooks/useAgentWebSocket";
import { useOverlaySpeech } from "../hooks/useOverlaySpeech";
import { useEmbodimentCommandRelay } from "../hooks/useEmbodimentCommandRelay";
import { useFreeViewportMotion } from "../hooks/useFreeViewportMotion";
import type { AgentMood, EmbodimentCommandAction } from "../types/agent";
import "./modes.css";

function readQuery(key: string): string | undefined {
  return new URLSearchParams(window.location.search).get(key) ?? undefined;
}

const PHASE_TRANSITION: Record<string, string> = {
  idle: "rotate 500ms ease-out, scale 300ms ease-out",
  prepare: "rotate 180ms ease-out, scale 180ms ease-out",
  launch: "left 320ms cubic-bezier(0.33, 1, 0.68, 1), top 320ms cubic-bezier(0.33, 1, 0.68, 1), rotate 320ms ease-out, scale 200ms ease-out",
  cruise: "left 450ms linear, top 450ms linear, rotate 450ms ease-out, scale 300ms ease-out",
  brake: "left 380ms cubic-bezier(0.22, 1, 0.36, 1), top 380ms cubic-bezier(0.22, 1, 0.36, 1), rotate 380ms ease-out, scale 250ms ease-out",
  settle: "left 220ms cubic-bezier(0.22, 1, 0.36, 1), top 220ms cubic-bezier(0.22, 1, 0.36, 1), rotate 220ms ease-out, scale 220ms ease-out",
};

export function FreeApp() {
  const { state, apply, setFocused } = useAgentState({ mood: "idle", energy: 0.55 });
  const [menuOpen, setMenuOpen] = useState(false);
  const wsUrl = readQuery("ws");
  const sessionId = readQuery("sessionId");

  const stableApply = useCallback((patch: Parameters<typeof apply>[0]) => apply(patch), [apply]);

  const { connected, sendWake, sendChat } = useAgentWebSocket(stableApply, {
    wsUrl: wsUrl ?? undefined,
    sessionId: sessionId ?? undefined,
  });

  useEmbodimentCommandRelay(true);

  const { x, y, rotation, scale, phase, roamNow } = useFreeViewportMotion({
    enabled: true,
    containerW: 150,
    containerH: 220,
  });

  const handleSpeechResult = useCallback(
    (text: string) => {
      setMenuOpen(false);
      if (connected) sendChat(text);
    },
    [connected, sendChat],
  );

  const speech = useOverlaySpeech({
    onResult: handleSpeechResult,
    onError: (msg) => apply({ mood: "alert", energy: 0.75, caption: msg }),
  });

  const handleEyeClick = useCallback(() => {
    setMenuOpen(true);
  }, []);

  const handleCommand = useCallback(
    (cmd: QuickCommand) => {
      switch (cmd.action) {
        case "wake":
          if (connected) sendWake();
          setMenuOpen(false);
          break;
        case "chat":
          if (connected && cmd.text) sendChat(cmd.text);
          setMenuOpen(false);
          break;
        case "roam":
          roamNow();
          break;
        case "voice":
          if (!speech.supported) {
            apply({ mood: "alert", energy: 0.75, caption: "不支持语音识别" });
            break;
          }
          speech.start();
          apply({ mood: "listening", energy: 0.68, caption: "请说话…" });
          break;
        default:
          break;
      }
    },
    [apply, connected, sendChat, sendWake, speech],
  );

  useEffect(() => {
    const onMessage = (ev: MessageEvent) => {
      if (!ev.data || typeof ev.data !== "object") return;
      const d = ev.data as {
        type?: string;
        mood?: string;
        caption?: string | null;
        energy?: number;
        phase?: string;
        subAgentType?: string;
        subAgentDisplayName?: string;
        source?: string;
        action?: EmbodimentCommandAction;
        x?: number;
        y?: number;
        z?: number;
        strength?: number;
      };
      if (d.type === "agent-sphere:patch") {
        apply({
          mood: d.mood as AgentMood | undefined,
          caption: d.caption === null ? undefined : d.caption,
          energy: d.energy,
          phase: d.phase,
          subAgentType: d.subAgentType,
          subAgentDisplayName: d.subAgentDisplayName,
          source: d.source,
        });
      }
    };
    window.addEventListener("message", onMessage);
    window.parent?.postMessage({ type: "agent-sphere:ready" }, "*");
    return () => window.removeEventListener("message", onMessage);
  }, [apply]);

  useEffect(() => {
    document.body.classList.add("overlay-body");
    return () => document.body.classList.remove("overlay-body");
  }, []);

  const sphereW = 150;
  const sphereH = 220;

  return (
    <div
      style={{
        position: "fixed",
        left: 0,
        top: 0,
        width: "100vw",
        height: "100vh",
        pointerEvents: "none",
        zIndex: 9999,
        overflow: "visible",
      }}
    >
      <div
        style={{
          position: "absolute",
          left: x,
          top: y,
          width: sphereW,
          height: sphereH,
          overflow: "visible",
          pointerEvents: "auto",
          transformOrigin: "center center",
          transform: `rotate(${rotation}deg) scale(${scale})`,
          transition: PHASE_TRANSITION[phase] ?? PHASE_TRANSITION.idle,
        }}
      >
        <InnerThought state={state} />

        <SphereAgentScene
          state={state}
          mode="overlay"
          physics={false}
          autonomous={false}
          onEyeFocus={setFocused}
          onEyeClick={handleEyeClick}
        />

        <OverlayQuickMenu
          open={menuOpen || speech.listening}
          connected={connected}
          voiceListening={speech.listening}
          voiceInterim={speech.interim}
          onSelect={handleCommand}
          onClose={() => {
            speech.stop();
            setMenuOpen(false);
          }}
        />
      </div>
    </div>
  );
}
