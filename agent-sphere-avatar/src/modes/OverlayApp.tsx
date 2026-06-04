import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { EntranceAnimation } from "../components/EntranceAnimation";
import { InnerThought } from "../components/InnerThought";
import { OverlayQuickMenu } from "../components/OverlayQuickMenu";
import { SphereAgentScene } from "../components/SphereAgentScene";
import { TaskFeed } from "../components/TaskFeed";
import { TaskNotificationCenter } from "../components/TaskNotificationCenter";
import type { QuickCommand } from "../constants/quick-commands";
import { useAgentState } from "../hooks/useAgentState";
import { useAgentWebSocket } from "../hooks/useAgentWebSocket";
import { useOverlaySpeech } from "../hooks/useOverlaySpeech";
import { useEmbodimentCommandRelay } from "../hooks/useEmbodimentCommandRelay";
import { useOverlayPointerCapture } from "../hooks/useOverlayPointerCapture";
import { useOverlayWindowMotion } from "../hooks/useOverlayWindowMotion";
import { useTaskEventAccumulator } from "../hooks/useTaskEventAccumulator";
import { useTaskEventStream } from "../hooks/useTaskEventStream";
import { createGomokuRoom, openGameUrl } from "../utils/game-center";
import type { AgentMood } from "../types/agent";
import type { SphereTouchEvent } from "../hooks/useSphereUserDrag";
import "../index.css";
import "./modes.css";

function readQuery(key: string): string | undefined {
  return new URLSearchParams(window.location.search).get(key) ?? undefined;
}

/** 桌面透明桌宠 — Electron 无框 3D（DG2 写实机器人），直连主 Agent */
export function OverlayApp() {
  const { state, apply, setFocused } = useAgentState({ mood: "idle", energy: 0.55 });
  const [menuOpen, setMenuOpen] = useState(false);
  const menuWasOpenOnPointerDown = useRef(false);
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

  const { onTaskEvent } = useTaskEventAccumulator({ apply });
  useTaskEventStream({ onTaskEvent });
  const taskEvents = useMemo(() => state.taskEvents ?? [], [state.taskEvents]);

  const closeMenuRef = useRef<() => void>(() => {});

  const handleSpeechResult = useCallback(
    (text: string) => {
      closeMenuRef.current();
      if (connected) sendChat(text);
    },
    [connected, sendChat],
  );

  const speech = useOverlaySpeech({
    onResult: handleSpeechResult,
    onError: (msg) => apply({ mood: "alert", energy: 0.75, caption: msg }),
  });

  const menuVisible = menuOpen || speech.listening;

  const closeMenu = useCallback(() => {
    speech.stop();
    setMenuOpen(false);
    window.sphereOverlay?.setMenuExpanded?.(false);
    window.sphereOverlay?.setIgnoreMouseEvents(true, true);
  }, [speech]);

  closeMenuRef.current = closeMenu;

  const openMenu = useCallback(() => {
    setMenuOpen(true);
    window.sphereOverlay?.setMenuExpanded?.(true);
    window.sphereOverlay?.setIgnoreMouseEvents(false, true);
  }, []);

  const { setMouseCapture } = useOverlayPointerCapture(menuVisible);

  const handleSphereTouch = useCallback(
    (event: SphereTouchEvent) => {
      if (menuVisible && event.phase === "start") {
        closeMenu();
        return;
      }

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
    [apply, closeMenu, menuVisible, setMouseCapture],
  );

  const handleEyeInteraction = useCallback(
    (active: boolean) => {
      if (menuVisible) return;
      setMouseCapture(active);
      setFocused(active);
    },
    [menuVisible, setFocused, setMouseCapture],
  );

  const handleEyeClick = useCallback(() => {
    if (menuVisible) return;
    openMenu();
  }, [menuVisible, openMenu]);

  const handlePetPanePointerDown = useCallback(() => {
    menuWasOpenOnPointerDown.current = menuVisible;
  }, [menuVisible]);

  const handlePetPanePointerUp = useCallback(() => {
    if (menuWasOpenOnPointerDown.current) {
      closeMenu();
    }
  }, [closeMenu]);

  const handleCommand = useCallback(
    (cmd: QuickCommand) => {
      switch (cmd.action) {
        case "wake":
          if (connected) sendWake();
          closeMenu();
          break;
        case "chat":
          if (connected && cmd.text) sendChat(cmd.text);
          closeMenu();
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
          closeMenu();
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
    [apply, closeMenu, connected, sendChat, sendWake, speech, sessionId],
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
    if (!menuVisible) {
      window.sphereOverlay?.setIgnoreMouseEvents(true, true);
    }
  }, [menuVisible]);

  return (
    <div className={`mode-shell mode-overlay${menuVisible ? " mode-overlay--menu-open" : ""}`}>
      <EntranceAnimation />
      <div
        className="overlay-pet-pane"
        onPointerDown={handlePetPanePointerDown}
        onPointerUp={handlePetPanePointerUp}
      >
        <SphereAgentScene
          state={state}
          mode="overlay"
          physics={false}
          autonomous={false}
          onEyeFocus={setFocused}
          onEyeClick={handleEyeClick}
          onEyeInteractionChange={handleEyeInteraction}
          onUserTouch={handleSphereTouch}
          onBodyHover={setMouseCapture}
        />
        {state.caption ? <div className="mode-caption overlay-pet-caption">{state.caption}</div> : null}
        <InnerThought state={state} />
      </div>

      <TaskFeed events={taskEvents} />
      <TaskNotificationCenter events={taskEvents} />

      <OverlayQuickMenu
        open={menuVisible}
        layout="side"
        connected={connected}
        voiceListening={speech.listening}
        voiceInterim={speech.interim}
        onSelect={handleCommand}
        onClose={closeMenu}
      />
    </div>
  );
}
