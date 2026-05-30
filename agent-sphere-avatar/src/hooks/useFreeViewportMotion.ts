import { useCallback, useEffect, useRef, useState } from "react";
import type { EmbodimentCommandAction } from "../types/agent";

interface UseFreeViewportMotionOptions {
  enabled?: boolean;
  containerW?: number;
  containerH?: number;
}

interface FreeViewportMotionState {
  x: number;
  y: number;
  rotation: number;
  scale: number;
  transitioning: boolean;
  roaming: boolean;
}

function calcTilt(fromX: number, fromY: number, toX: number, toY: number): number {
  const dx = toX - fromX;
  const dy = toY - fromY;
  if (Math.abs(dx) < 2 && Math.abs(dy) < 2) return 0;
  const dist = Math.sqrt(dx * dx + dy * dy);
  const nx = dx / dist;
  const maxTilt = 11;
  return Math.round(Math.max(-maxTilt, Math.min(maxTilt, nx * maxTilt)));
}

export function useFreeViewportMotion({
  enabled = true,
  containerW = 300,
  containerH = 380,
}: UseFreeViewportMotionOptions = {}) {
  const [pos, setPos] = useState<FreeViewportMotionState>(() => ({
    x: Math.max(0, window.innerWidth - containerW - 24),
    y: Math.max(0, window.innerHeight - containerH - 24),
    rotation: 0,
    scale: 1,
    transitioning: false,
    roaming: false,
  }));

  const roamTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clampPos = useCallback(
    (x: number, y: number) => {
      const margin = 20;
      const maxX = Math.max(margin, window.innerWidth - containerW - margin);
      const maxY = Math.max(margin, window.innerHeight - containerH - margin);
      return {
        x: Math.round(Math.max(margin, Math.min(maxX, x))),
        y: Math.round(Math.max(margin, Math.min(maxY, y))),
      };
    },
    [containerW, containerH],
  );

  const moveTo = useCallback(
    (x: number, y: number, duration = 1200) => {
      const { x: cx, y: cy } = clampPos(x, y);
      const tilt = calcTilt(pos.x, pos.y, cx, cy);
      setPos((prev) => ({
        ...prev,
        x: cx,
        y: cy,
        rotation: tilt,
        scale: 1.04,
        transitioning: true,
      }));
      setTimeout(() => {
        setPos((prev) => ({ ...prev, scale: 1, transitioning: false }));
      }, duration);
    },
    [clampPos, pos.x, pos.y],
  );

  const roamOnce = useCallback(() => {
    const margin = 20;
    const maxX = Math.max(margin, window.innerWidth - containerW - margin);
    const maxY = Math.max(margin, window.innerHeight - containerH - margin);
    const tx = margin + Math.random() * Math.max(1, maxX - margin);
    const ty = margin + Math.random() * Math.max(1, maxY - margin);
    moveTo(tx, ty, 1000 + Math.random() * 400);
  }, [containerW, containerH, moveTo]);

  const stopRoaming = useCallback(() => {
    if (roamTimerRef.current) {
      clearTimeout(roamTimerRef.current);
      roamTimerRef.current = null;
    }
    setPos((prev) => ({ ...prev, roaming: false }));
  }, []);

  const startRoaming = useCallback(() => {
    stopRoaming();
    setPos((prev) => ({ ...prev, roaming: true }));

    const scheduleNext = () => {
      roamTimerRef.current = setTimeout(() => {
        roamOnce();
        roamTimerRef.current = setTimeout(scheduleNext, 5000 + Math.random() * 5000);
      }, 1500 + Math.random() * 2000);
    };
    scheduleNext();
  }, [roamOnce, stopRoaming]);

  const executeCommand = useCallback(
    (action: EmbodimentCommandAction, x?: number, y?: number) => {
      switch (action) {
        case "move":
          if (x != null && y != null) {
            moveTo(x, y, 1000);
          }
          break;
        case "roam":
          roamOnce();
          break;
        case "stop":
          stopRoaming();
          break;
        case "window_roam":
          startRoaming();
          break;
      }
    },
    [moveTo, roamOnce, stopRoaming, startRoaming],
  );

  useEffect(() => {
    if (!enabled) return;

    const onCustomEvent = (e: Event) => {
      const cmd = (e as CustomEvent<{ action: string; x?: number; y?: number }>).detail;
      if (!cmd?.action) return;
      executeCommand(cmd.action as EmbodimentCommandAction, cmd.x, cmd.y);
    };

    const onPostMessage = (ev: MessageEvent) => {
      const d = ev.data;
      if (!d || typeof d !== "object") return;
      if (d.type === "agent-sphere:command" && d.action) {
        executeCommand(d.action as EmbodimentCommandAction, d.x, d.y);
      }
    };

    window.addEventListener("agent-sphere:command", onCustomEvent);
    window.addEventListener("message", onPostMessage);

    return () => {
      window.removeEventListener("agent-sphere:command", onCustomEvent);
      window.removeEventListener("message", onPostMessage);
      stopRoaming();
    };
  }, [enabled, executeCommand, stopRoaming]);

  useEffect(() => {
    const onResize = () => {
      setPos((prev) => {
        const { x: cx, y: cy } = clampPos(prev.x, prev.y);
        return { ...prev, x: cx, y: cy };
      });
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [clampPos]);

  return {
    x: pos.x,
    y: pos.y,
    rotation: pos.rotation,
    scale: pos.scale,
    transitioning: pos.transitioning,
    roaming: pos.roaming,
    roamNow: roamOnce,
    moveTo,
    stop: stopRoaming,
    startRoaming,
    executeCommand,
  };
}
