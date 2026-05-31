import { useCallback, useEffect, useRef, useState } from "react";
import { OverlayQuickMenu } from "../components/OverlayQuickMenu";
import { InnerThought } from "../components/InnerThought";
import { SphereAgentScene } from "../components/SphereAgentScene";
import type { QuickCommand } from "../constants/quick-commands";
import { mapUserMessageSent } from "../bridge/ws-agent-mapper";
import {
  isWsOffMode,
  postToHost,
  readSphereQuery,
  SPHERE_MSG,
} from "../embed-protocol";
import { useAgentState } from "../hooks/useAgentState";
import { useAgentWebSocket } from "../hooks/useAgentWebSocket";
import { useOverlaySpeech } from "../hooks/useOverlaySpeech";
import { useEmbedParentBridge } from "../hooks/useEmbedParentBridge";
import { useLivingMotion } from "../hooks/useLivingMotion";
import type { AgentMood } from "../types/agent";
import type { SphereTouchEvent } from "../hooks/useSphereUserDrag";
import "./modes.css";

export function FreeApp() {
  const wsOff = isWsOffMode();
  const { state, apply, setFocused } = useAgentState({ mood: "idle", energy: 0.55 });
  const [menuOpen, setMenuOpen] = useState(false);
  const wsUrl = readSphereQuery("ws");
  const sessionId = readSphereQuery("sessionId");
  const prevMoodRef = useRef<AgentMood | undefined>(undefined);

  const stableApply = useCallback((patch: Parameters<typeof apply>[0]) => apply(patch), [apply]);

  const { connected, sendWake, sendChat } = useAgentWebSocket(stableApply, {
    wsUrl: wsUrl ?? undefined,
    sessionId: sessionId ?? undefined,
    enabled: !wsOff,
  });

  const sphereW = 140;
  const sphereH = 190;

  const { setContainerRef, roamNow, stimulate, pauseMotion, resumeMotion, setUserRotation } =
    useLivingMotion({
      enabled: true,
      containerW: sphereW,
      containerH: sphereH,
      mood: state.mood,
      energy: state.energy,
    });

  const onParentPatch = useCallback(
    (patch: Partial<typeof state>, raw: unknown) => {
      const newMood = patch.mood;
      if (newMood && newMood !== prevMoodRef.current) {
        prevMoodRef.current = newMood;
        stimulate("mood_change", { intensity: 0.5 });
      }
      const d = raw as { caption?: string | null };
      if (d.caption != null && d.caption !== "") {
        stimulate("user_spoke", { intensity: 0.4 });
      }
    },
    [stimulate],
  );

  useEmbedParentBridge({ apply, onPatch: onParentPatch });

  const sendToAgent = useCallback(
    (action: "wake" | "chat", text?: string) => {
      if (wsOff) {
        postToHost({ type: SPHERE_MSG.send, action, text });
        apply(mapUserMessageSent());
        return true;
      }
      if (action === "wake") return sendWake();
      if (action === "chat" && text) return sendChat(text);
      return false;
    },
    [apply, sendChat, sendWake, wsOff],
  );

  const isDraggingRef = useRef(false);
  const dragStartRef = useRef({ x: 0, y: 0, mx: 0, my: 0 });
  const hasMovedRef = useRef(false);
  const wheelAccumRef = useRef(0);
  const lastWheelTimeRef = useRef(0);
  const moveListenersAttached = useRef(false);

  const handleSpeechResult = useCallback(
    (text: string) => {
      setMenuOpen(false);
      stimulate("user_spoke", { intensity: Math.min(0.5 + text.length * 0.02, 1) });
      sendToAgent("chat", text);
    },
    [sendToAgent, stimulate],
  );

  const speech = useOverlaySpeech({
    onResult: handleSpeechResult,
    onError: (msg) => {
      apply({ mood: "alert", energy: 0.75, caption: msg });
      stimulate("mood_change", { soulImpact: { impulse: 0.3 }, intensity: 0.6 });
    },
  });

  const handleEyeClick = useCallback(() => {
    if (!hasMovedRef.current) {
      stimulate("touched", { intensity: 0.8 });
      setMenuOpen(true);
    }
  }, [stimulate]);

  const getContainerEl = useCallback((): HTMLDivElement | null => {
    return document.querySelector("[data-sphere-container]") as HTMLDivElement | null;
  }, []);

  const ensureMoveListeners = useCallback(() => {
    if (moveListenersAttached.current) return;
    moveListenersAttached.current = true;

    const onMove = (e: MouseEvent | TouchEvent) => {
      if (!isDraggingRef.current) return;
      const clientX = "touches" in e ? e.touches[0].clientX : e.clientX;
      const clientY = "touches" in e ? e.touches[0].clientY : e.clientY;
      const ds = dragStartRef.current;
      const dx = clientX - ds.mx;
      const dy = clientY - ds.my;

      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) {
        hasMovedRef.current = true;
      }

      const margin = 20;
      const newX = Math.max(margin, Math.min(window.innerWidth - sphereW - margin, ds.x + dx));
      const newY = Math.max(margin, Math.min(window.innerHeight - sphereH - margin, ds.y + dy));

      const el = getContainerEl();
      if (el) {
        el.style.transform = `translate3d(${newX}px, ${newY}px, 0)`;
      }
    };

    const onEnd = () => {
      if (!isDraggingRef.current) return;
      isDraggingRef.current = false;

      const el = getContainerEl();
      if (el) {
        el.style.cursor = "grab";
        el.style.transition = "";
        const rect = el.getBoundingClientRect();
        resumeMotion(rect.left, rect.top);
      }

      if (hasMovedRef.current) {
        const ds = dragStartRef.current;
        const rect = getContainerEl()?.getBoundingClientRect();
        const distPx = Math.sqrt(
          ((rect?.left ?? 0) - ds.x) ** 2 + ((rect?.top ?? 0) - ds.y) ** 2,
        );
        const dragIntensity = Math.min(distPx / 200, 1);
        stimulate("dragged", {
          intensity: 0.4 + dragIntensity * 0.6,
          soulImpact: { impulse: 0.25 + dragIntensity * 0.35 },
        });
      }

      hasMovedRef.current = false;
    };

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onEnd);
    window.addEventListener("touchmove", onMove, { passive: false });
    window.addEventListener("touchend", onEnd);
    window.addEventListener("touchcancel", onEnd);
  }, [getContainerEl, resumeMotion, stimulate, sphereW, sphereH]);

  const startDrag = useCallback(
    (clientX: number, clientY: number) => {
      const el = getContainerEl();
      if (!el) return;
      const rect = el.getBoundingClientRect();
      isDraggingRef.current = true;
      hasMovedRef.current = false;
      dragStartRef.current = { x: rect.left, y: rect.top, mx: clientX, my: clientY };
      el.style.transition = "none";
      el.style.cursor = "grabbing";
      el.style.transformOrigin = "center center";
      pauseMotion();
      ensureMoveListeners();
      stimulate("touched", { intensity: 0.5 });
    },
    [getContainerEl, pauseMotion, ensureMoveListeners, stimulate],
  );

  const handleMouseDown = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (e.button !== 0) return;
      if ((e.target as HTMLElement).closest("canvas")) return;
      e.preventDefault();
      startDrag(e.clientX, e.clientY);
    },
    [startDrag],
  );

  const handleWheel = useCallback(
    (e: React.WheelEvent<HTMLDivElement>) => {
      e.preventDefault();
      const now = performance.now();
      const delta = e.deltaY > 0 ? 12 : -12;
      wheelAccumRef.current += delta;
      lastWheelTimeRef.current = now;

      const currentRot = wheelAccumRef.current;
      setUserRotation(currentRot, delta * 2);
      stimulate("spun", { intensity: Math.min(Math.abs(delta) / 10, 1), soulImpact: { impulse: 0.15 } });

      setTimeout(() => {
        if (performance.now() - lastWheelTimeRef.current > 150) {
          wheelAccumRef.current *= 0.4;
          if (Math.abs(wheelAccumRef.current) < 2) wheelAccumRef.current = 0;
          setUserRotation(wheelAccumRef.current, 0);
        }
      }, 150);
    },
    [setUserRotation, stimulate],
  );

  const handleTouchStart = useCallback(
    (e: React.TouchEvent<HTMLDivElement>) => {
      if (e.touches.length !== 1) return;
      if ((e.target as HTMLElement).closest("canvas")) return;
      e.preventDefault();
      const touch = e.touches[0];
      startDrag(touch.clientX, touch.clientY);
    },
    [startDrag],
  );

  const handleSphereTouch = useCallback(
    (event: SphereTouchEvent) => {
      if (event.phase === "start") {
        stimulate("touched", { intensity: 0.65 });
        apply({ mood: "listening", energy: 0.62, focused: true });
        return;
      }
      if (event.phase === "drag") {
        const spin = event.spinStrength ?? 0;
        if (spin > 0.2) {
          setUserRotation(0, spin * 18);
          stimulate("spun", { intensity: spin, soulImpact: { impulse: 0.12 } });
        }
        return;
      }
      if (event.phase === "end") {
        const spin = event.spinStrength ?? 0;
        if (spin > 0.4) {
          stimulate("dragged", {
            intensity: 0.5 + spin * 0.5,
            soulImpact: { impulse: 0.3 + spin * 0.25 },
          });
          apply({ mood: "happy", energy: 0.7, caption: "哇，转起来了！" });
        } else if ((event.totalRotationDeg ?? 0) > 20) {
          stimulate("touched", { intensity: 0.75 });
        }
      }
    },
    [apply, setUserRotation, stimulate],
  );

  const handleCommand = useCallback(
    (cmd: QuickCommand) => {
      switch (cmd.action) {
        case "wake":
          sendToAgent("wake");
          stimulate("wake_call", { intensity: 0.8 });
          setMenuOpen(false);
          break;
        case "chat":
          if (cmd.text) {
            stimulate("user_spoke", { intensity: 0.7 });
            sendToAgent("chat", cmd.text);
          }
          setMenuOpen(false);
          break;
        case "roam":
          roamNow();
          break;
        case "voice":
          if (!speech.supported) {
            apply({ mood: "alert", energy: 0.75, caption: "不支持语音识别" });
            stimulate("mood_change", { soulImpact: { impulse: 0.2 }, intensity: 0.5 });
            break;
          }
          speech.start();
          stimulate("listening_start", { intensity: 0.6 });
          apply({ mood: "listening", energy: 0.68, caption: "请说话…" });
          break;
        default:
          break;
      }
    },
    [apply, sendToAgent, speech, stimulate, roamNow],
  );

  useEffect(() => {
    document.body.classList.add("overlay-body");
    return () => document.body.classList.remove("overlay-body");
  }, []);

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
        data-sphere-container
        ref={setContainerRef}
        onMouseDown={handleMouseDown}
        onWheel={handleWheel}
        onTouchStart={handleTouchStart}
        style={{
          position: "fixed",
          left: 0,
          top: 0,
          width: sphereW,
          height: sphereH,
          overflow: "visible",
          pointerEvents: "auto",
          cursor: "grab",
          transformOrigin: "center center",
          userSelect: "none",
          touchAction: "none",
          willChange: "transform",
          contain: "layout style paint",
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
          onUserTouch={handleSphereTouch}
        />

        <OverlayQuickMenu
          open={menuOpen || speech.listening}
          connected={wsOff || connected}
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
