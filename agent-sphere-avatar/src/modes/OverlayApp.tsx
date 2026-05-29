import { useCallback, useEffect, useRef, useState } from "react";
import { OverlayQuickMenu } from "../components/OverlayQuickMenu";
import { SphereAgentScene } from "../components/SphereAgentScene";
import type { QuickCommand } from "../constants/quick-commands";
import { useAgentState } from "../hooks/useAgentState";
import { useAgentWebSocket } from "../hooks/useAgentWebSocket";
import { useOverlaySpeech } from "../hooks/useOverlaySpeech";
import { useEmbodimentCommandRelay } from "../hooks/useEmbodimentCommandRelay";
import { useOverlayWindowMotion } from "../hooks/useOverlayWindowMotion";
import type { AgentMood } from "../types/agent";
import "../index.css";
import "./modes.css";

function readQuery(key: string): string | undefined {
  return new URLSearchParams(window.location.search).get(key) ?? undefined;
}

/** 桌面透明悬浮窗 — 直连主 Agent，快捷菜单 + 语音输入 */
export function OverlayApp() {
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

  const roamNowRef = useRef<(() => void) | null>(null);
  const { roamNow } = useOverlayWindowMotion({ enabled: true, mood: state.mood });
  roamNowRef.current = roamNow;

  const handleSpeechResult = useCallback(
    (text: string) => {
      setMenuOpen(false);
      window.sphereOverlay?.setIgnoreMouseEvents(true, true);
      if (connected) sendChat(text);
    },
    [connected, sendChat],
  );

  const speech = useOverlaySpeech({
    onResult: handleSpeechResult,
    onError: (msg) => apply({ mood: "alert", energy: 0.75, caption: msg }),
  });

  const setMenuOpenSafe = useCallback((open: boolean) => {
    setMenuOpen(open);
    window.sphereOverlay?.setIgnoreMouseEvents(!open, true);
  }, []);

  const handleEyeInteraction = useCallback(
    (active: boolean) => {
      if (menuOpen) return;
      window.sphereOverlay?.setIgnoreMouseEvents(!active, true);
      setFocused(active);
    },
    [menuOpen, setFocused],
  );

  const handleEyeClick = useCallback(() => {
    setMenuOpenSafe(true);
  }, [setMenuOpenSafe]);

  const handleCommand = useCallback(
    (cmd: QuickCommand) => {
      switch (cmd.action) {
        case "wake":
          if (connected) sendWake();
          setMenuOpenSafe(false);
          break;
        case "chat":
          if (connected && cmd.text) sendChat(cmd.text);
          setMenuOpenSafe(false);
          break;
        case "roam":
          roamNowRef.current?.();
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
    [apply, connected, sendChat, sendWake, setMenuOpenSafe, speech],
  );

  useEffect(() => {
    document.body.classList.add("overlay-body");
    window.sphereOverlay?.setIgnoreMouseEvents(true, true);

    window.sphereOverlay?.onPatch?.((patch: {
      mood?: AgentMood;
      energy?: number;
      caption?: string | null;
      phase?: string;
      subAgentType?: string;
      subAgentDisplayName?: string;
      source?: string;
    }) => {
      apply({
        mood: patch.mood,
        energy: patch.energy,
        caption: patch.caption === null ? undefined : patch.caption,
        phase: patch.phase,
        subAgentType: patch.subAgentType,
        subAgentDisplayName: patch.subAgentDisplayName,
        source: patch.source,
      });
    });

    window.sphereOverlay?.onRoam?.(() => roamNowRef.current?.());

    return () => document.body.classList.remove("overlay-body");
  }, [apply]);

  useEffect(() => {
    if (!menuOpen && !speech.listening) {
      window.sphereOverlay?.setIgnoreMouseEvents(true, true);
    }
  }, [menuOpen, speech.listening]);

  const statusLabel = state.subAgentDisplayName
    ? `${state.mood} · ${state.subAgentDisplayName}`
    : state.mood;

  return (
    <div className="mode-shell mode-overlay">
      <SphereAgentScene
        state={state}
        mode="overlay"
        physics={false}
        autonomous
        onEyeFocus={setFocused}
        onEyeClick={handleEyeClick}
        onEyeInteractionChange={handleEyeInteraction}
      />

      <OverlayQuickMenu
        open={menuOpen || speech.listening}
        connected={connected}
        voiceListening={speech.listening}
        voiceInterim={speech.interim}
        onSelect={handleCommand}
        onClose={() => {
          speech.stop();
          setMenuOpenSafe(false);
        }}
      />

      <div className="overlay-status">
        <span className={`mode-badge mode-badge--${state.mood}`}>{statusLabel}</span>
        <span className="overlay-dot" data-connected={connected ? "1" : "0"} />
        <span className="overlay-hint">
          {speech.listening ? "语音识别中…" : connected ? "点击玻璃屏打开菜单" : "连接中…"}
        </span>
      </div>
    </div>
  );
}
