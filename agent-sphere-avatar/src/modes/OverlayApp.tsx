import { useCallback, useEffect, useRef, useState } from "react";
import { OverlayQuickMenu } from "../components/OverlayQuickMenu";
import { SphereAgentScene } from "../components/SphereAgentScene";
import { EntranceAnimation } from "../components/EntranceAnimation";
import type { QuickCommand } from "../constants/quick-commands";
import { useAgentState } from "../hooks/useAgentState";
import { useAgentWebSocket } from "../hooks/useAgentWebSocket";
import { useOverlaySpeech } from "../hooks/useOverlaySpeech";
import { useEmbodimentCommandRelay } from "../hooks/useEmbodimentCommandRelay";
import { useOverlayPointerCapture } from "../hooks/useOverlayPointerCapture";
import { useOverlayWindowMotion } from "../hooks/useOverlayWindowMotion";
import { createGomokuRoom, openGameUrl } from "../utils/game-center";
import type { AgentMood } from "../types/agent";
import type { SphereTouchEvent } from "../hooks/useSphereUserDrag";
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

  const { setMouseCapture } = useOverlayPointerCapture(menuOpen || speech.listening);

  const setMenuOpenSafe = useCallback((open: boolean) => {
    setMenuOpen(open);
    window.sphereOverlay?.setIgnoreMouseEvents(!open, true);
  }, []);

  const handleSphereTouch = useCallback(
    (event: SphereTouchEvent) => {
      if (event.phase === "start") {
        setMouseCapture(true);
        apply({ mood: "listening", energy: 0.62, focused: true });
      } else if (event.phase === "end") {
        const spin = event.spinStrength ?? 0;
        if (spin > 0.45) {
          apply({ mood: "happy", energy: 0.72, caption: "哈哈，转晕我了！" });
        }
      }
    },
    [apply, setMouseCapture],
  );

  const handleEyeInteraction = useCallback(
    (active: boolean) => {
      if (menuOpen) return;
      setMouseCapture(active);
      setFocused(active);
    },
    [menuOpen, setFocused, setMouseCapture],
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
        case "game": {
          const sid = sessionId ?? "default-user";
          setMenuOpenSafe(false);
          apply({ mood: "happy", energy: 0.7, caption: "正在创建游戏房间…" });
          createGomokuRoom(sid).then((url) => {
            if (url) {
              openGameUrl(url);
              apply({ mood: "happy", energy: 0.75, caption: "游戏房间已打开！" });
            } else {
              apply({ mood: "alert", energy: 0.65, caption: "创建房间失败，请稍后重试" });
            }
          });
          break;
        }
        default:
          break;
      }
    },
    [apply, connected, sendChat, sendWake, setMenuOpenSafe, speech, sessionId],
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
      <EntranceAnimation />
      <SphereAgentScene
        state={state}
        mode="overlay"
        physics={false}
        autonomous
        onEyeFocus={setFocused}
        onEyeClick={handleEyeClick}
        onEyeInteractionChange={handleEyeInteraction}
        onUserTouch={handleSphereTouch}
        onBodyHover={setMouseCapture}
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
          {speech.listening ? "语音识别中…" : connected ? "左键拖动移动 · 右键拖动旋转 · 点击曲屏开菜单" : "连接中…"}
        </span>
      </div>
    </div>
  );
}
