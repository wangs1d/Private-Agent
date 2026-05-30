import { useCallback, useEffect, useRef, useState } from "react";
import type { EmbodimentCommandAction } from "../types/agent";

interface UseFreeViewportMotionOptions {
  enabled?: boolean;
  containerW?: number;
  containerH?: number;
}

type MotionPhase = "idle" | "prepare" | "launch" | "cruise" | "brake" | "settle";

interface FreeViewportMotionState {
  x: number;
  y: number;
  rotation: number;
  scale: number;
  phase: MotionPhase;
  roaming: boolean;
}

function calcTilt(fromX: number, fromY: number, toX: number, toY: number): number {
  const dx = toX - fromX;
  const dy = toY - fromY;
  if (Math.abs(dx) < 3 && Math.abs(dy) < 3) return 0;
  const dist = Math.sqrt(dx * dx + dy * dy);
  const nx = dx / dist;
  const maxTilt = 10;
  return Math.round(Math.max(-maxTilt, Math.min(maxTilt, nx * maxTilt)));
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
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
    phase: "idle",
    roaming: false,
  }));

  const timersRef = useRef<ReturnType<typeof setTimeout>[]>([]);
  const clearTimers = () => {
    timersRef.current.forEach(clearTimeout);
    timersRef.current = [];
  };

  const addTimer = (fn: () => void, ms: number) => {
    const id = setTimeout(fn, ms);
    timersRef.current.push(id);
  };

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
    (tx: number, ty: number) => {
      clearTimers();
      const { x: cx, y: cy } = clampPos(tx, ty);
      const sx = pos.x;
      const sy = pos.y;
      const tilt = calcTilt(sx, sy, cx, cy);

      setPos((prev) => ({ ...prev, phase: "prepare", rotation: tilt, scale: 1.02 }));

      addTimer(() => {
        const p1x = lerp(sx, cx, 0.22);
        const p1y = lerp(sy, cy, 0.22);
        setPos((prev) => ({ ...prev, x: p1x, y: p1y, phase: "launch", scale: 1.05 }));
      }, 160);

      addTimer(() => {
        const p2x = lerp(sx, cx, 0.6);
        const p2y = lerp(sy, cy, 0.6);
        setPos((prev) => ({ ...prev, x: p2x, y: p2y, phase: "cruise", rotation: Math.round(tilt * 0.6), scale: 1.03 }));
      }, 480);

      addTimer(() => {
        const p3x = lerp(sx, cx, 0.85);
        const p3y = lerp(sy, cy, 0.85);
        setPos((prev) => ({ ...prev, x: p3x, y: p3y, phase: "brake", rotation: Math.round(tilt * 0.25), scale: 1.01 }));
      }, 930);

      addTimer(() => {
        setPos((prev) => ({
          ...prev,
          x: cx,
          y: cy,
          rotation: 0,
          scale: 1,
          phase: "settle",
        }));
      }, 1300);

      addTimer(() => {
        setPos((prev) => ({ ...prev, phase: "idle" }));
      }, 1520);
    },
    [clampPos, pos.x, pos.y],
  );

  const roamOnce = useCallback(() => {
    const margin = 20;
    const maxX = Math.max(margin, window.innerWidth - containerW - margin);
    const maxY = Math.max(margin, window.innerHeight - containerH - margin);
    const tx = margin + Math.random() * Math.max(1, maxX - margin);
    const ty = margin + Math.random() * Math.max(1, maxY - margin);
    moveTo(tx, ty);
  }, [containerW, containerH, moveTo]);

  const stopRoaming = useCallback(() => {
    clearTimers();
    setPos((prev) => ({ ...prev, roaming: false, phase: "idle", rotation: 0, scale: 1 }));
  }, []);

  const startRoaming = useCallback(() => {
    stopRoaming();
    setPos((prev) => ({ ...prev, roaming: true }));

    const scheduleNext = () => {
      const id = setTimeout(() => {
        roamOnce();
        const nextId = setTimeout(scheduleNext, 5000 + Math.random() * 5000);
        timersRef.current.push(nextId);
      }, 1500 + Math.random() * 2000);
      timersRef.current.push(id);
    };
    scheduleNext();
  }, [roamOnce, stopRoaming]);

  const executeCommand = useCallback(
    (action: EmbodimentCommandAction, x?: number, y?: number) => {
      switch (action) {
        case "move":
          if (x != null && y != null) moveTo(x, y);
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
    phase: pos.phase,
    isMoving: pos.phase !== "idle",
    roaming: pos.roaming,
    roamNow: roamOnce,
    moveTo,
    stop: stopRoaming,
    startRoaming,
    executeCommand,
  };
}
