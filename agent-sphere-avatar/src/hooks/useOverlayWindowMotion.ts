import { useCallback, useEffect, useRef } from "react";
import type { AgentMood } from "../types/agent";
import {
  OVERLAY_PET_HEIGHT,
  OVERLAY_PET_WIDTH,
} from "../constants/overlay-layout";
import { setOverlayRoamHandler } from "../utils/overlay-roam-bridge";

declare global {
  interface Window {
    sphereOverlay?: {
      moveTo: (x: number, y: number, animateMs?: number) => void;
      moveBy: (dx: number, dy: number) => void;
      getWorkArea: () => Promise<{ x: number; y: number; width: number; height: number }>;
      setIgnoreMouseEvents: (ignore: boolean, forward?: boolean) => void;
      setMenuExpanded?: (expanded: boolean) => void;
      onPatch?: (cb: (patch: Record<string, unknown>) => void) => void;
      onRoam?: (cb: () => void) => void;
    };
    SpeechRecognition?: typeof SpeechRecognition;
    webkitSpeechRecognition?: typeof SpeechRecognition;
  }
}

interface UseOverlayWindowMotionOptions {
  enabled?: boolean;
  mood?: AgentMood;
}

/** 桌面 overlay 模式 — Electron 窗口在屏幕上自主漫游 */
export function useOverlayWindowMotion({ enabled = false, mood = "idle" }: UseOverlayWindowMotionOptions) {
  const targetRef = useRef<{ x: number; y: number } | null>(null);
  const nextMoveAt = useRef(0);

  const roamNow = useCallback(async () => {
    if (!window.sphereOverlay) return;
    const area = await window.sphereOverlay.getWorkArea();
    const margin = 12;
    const w = Number(new URLSearchParams(window.location.search).get("petW")) || OVERLAY_PET_WIDTH;
    const h = Number(new URLSearchParams(window.location.search).get("petH")) || OVERLAY_PET_HEIGHT;
    const x = area.x + margin + Math.random() * Math.max(40, area.width - w - margin * 2);
    const y = area.y + margin + Math.random() * Math.max(40, area.height - h - margin * 2);
    targetRef.current = { x, y };
    window.sphereOverlay.moveTo(Math.round(x), Math.round(y), mood === "speaking" ? 900 : 1200);
    nextMoveAt.current = Date.now() + 5000;
  }, [mood]);

  useEffect(() => {
    if (!enabled || !window.sphereOverlay) return;

    const runRoam = () => void roamNow();
    setOverlayRoamHandler(runRoam);
    window.sphereOverlay.onRoam?.(runRoam);

    let cancelled = false;

    const schedule = async () => {
      if (cancelled) return;
      await roamNow();
    };

    const tick = () => {
      if (cancelled) return;
      const now = Date.now();
      const interval = mood === "speaking" ? 3500 : mood === "thinking" ? 5000 : 7000;
      if (now >= nextMoveAt.current) {
        void schedule();
        nextMoveAt.current = now + interval;
      }
      window.requestAnimationFrame(tick);
    };

    // 启动后先停留 45s，避免一出现就漫游到屏幕外被误认为“消失”
    nextMoveAt.current = Date.now() + 45_000;
    const raf = window.requestAnimationFrame(tick);

    return () => {
      cancelled = true;
      setOverlayRoamHandler(null);
      window.cancelAnimationFrame(raf);
    };
  }, [enabled, mood, roamNow]);

  return { roamNow };
}
