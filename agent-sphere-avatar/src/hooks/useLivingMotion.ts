import { useCallback, useEffect, useRef } from "react";
import type { AgentMood, EmbodimentCommandAction } from "../types/agent";

type Behavior = "idle" | "exploring" | "pausing" | "approaching" | "excited";

const RESTITUTION = 0.44;

interface MoodMotion {
  speed: [number, number];
  roam: number;
  pauseSec: [number, number];
  curiosity: number;
  vitality: number;
}

const MOOD_MOTION: Record<AgentMood, MoodMotion> = {
  idle: { speed: [22, 48], roam: 0.9, pauseSec: [1.2, 2.8], curiosity: 0.45, vitality: 0.2 },
  listening: { speed: [12, 28], roam: 0.5, pauseSec: [2, 4], curiosity: 0.7, vitality: 0.25 },
  thinking: { speed: [18, 42], roam: 0.98, pauseSec: [1, 2.5], curiosity: 0.55, vitality: 0.3 },
  speaking: { speed: [36, 72], roam: 0.85, pauseSec: [0.4, 1.2], curiosity: 0.6, vitality: 0.5 },
  happy: { speed: [42, 88], roam: 1, pauseSec: [0.3, 1], curiosity: 0.75, vitality: 0.65 },
  alert: { speed: [30, 62], roam: 0.65, pauseSec: [0.6, 1.5], curiosity: 0.85, vitality: 0.45 },
};

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

interface UseLivingMotionOptions {
  enabled?: boolean;
  containerW?: number;
  containerH?: number;
  mood?: AgentMood;
  energy?: number;
}

export function useLivingMotion({
  enabled = true,
  containerW = 150,
  containerH = 220,
  mood = "idle",
  energy = 0.55,
}: UseLivingMotionOptions = {}) {
  const moodRef = useRef(mood);
  const energyRef = useRef(energy);
  moodRef.current = mood;
  energyRef.current = energy;

  useEffect(() => {
    if (mood === "happy") {
      impulseRef.current = Math.max(impulseRef.current, 0.95);
      excitedUntilRef.current = performance.now() + 4000;
      behaviorRef.current = "excited";
    } else if (mood === "speaking") {
      impulseRef.current = Math.max(impulseRef.current, 0.35 + energy * 0.4);
    }
  }, [mood, energy]);

  const behaviorRef = useRef<Behavior>("idle");
  const posRef = useRef({ x: 0, y: 0 });
  const velRef = useRef({ vx: 0, vy: 0 });
  const rotRef = useRef(0);
  const userRotRef = useRef(0);
  const userRotVelRef = useRef(0);
  const scaleRef = useRef(1);
  const waypointRef = useRef<{ x: number; y: number } | null>(null);
  const pauseUntilRef = useRef(0);
  const visitRef = useRef<Map<string, number>>(new Map());
  const approachTargetRef = useRef<{ x: number; y: number } | null>(null);
  const elRef = useRef<HTMLDivElement | null>(null);
  const boundsRef = useRef({ minX: 0, minY: 0, maxX: 0, maxY: 0 });
  const pausedRef = useRef(false);
  const mouseRef = useRef({ x: -9999, y: -9999, active: false });
  const rafIdRef = useRef(0);
  const lastTimeRef = useRef(0);
  const stimuliRef = useRef<{ type: string; bornAt: number; decayMs: number; impulse: number }[]>([]);
  const impulseRef = useRef(0);
  const excitedUntilRef = useRef(0);
  const lastBoundaryAtRef = useRef(0);
  const boundaryStimulateGuardRef = useRef(false);
  const lastSignificantMoveAtRef = useRef(0);
  const stuckGuardRef = useRef(false);

  const refreshBounds = useCallback(() => {
    const margin = 20;
    boundsRef.current = {
      minX: margin,
      minY: margin,
      maxX: Math.max(margin, window.innerWidth - containerW - margin),
      maxY: Math.max(margin, window.innerHeight - containerH - margin),
    };
  }, [containerW, containerH]);

  const clampPos = useCallback((x: number, y: number) => {
    const b = boundsRef.current;
    return { x: clamp(x, b.minX, b.maxX), y: clamp(y, b.minY, b.maxY) };
  }, []);

  const applyTransform = useCallback(() => {
    const el = elRef.current;
    if (!el) return;
    const p = posRef.current;
    const rot = rotRef.current + userRotRef.current;
    const s = scaleRef.current;
    el.style.transform = `translate3d(${p.x}px, ${p.y}px, 0) rotate(${rot}deg) scale(${s})`;
  }, []);

  const pickWaypoint = useCallback(() => {
    const b = boundsRef.current;
    const profile = MOOD_MOTION[moodRef.current];
    const cx = (b.minX + b.maxX) / 2;
    const cy = (b.minY + b.maxY) / 2;
    const rangeX = (b.maxX - b.minX) * profile.roam * 0.5;
    const rangeY = (b.maxY - b.minY) * profile.roam * 0.5;

    const safetyMargin = 60;
    const safeMinX = b.minX + safetyMargin;
    const safeMaxX = b.maxX - safetyMargin;
    const safeMinY = b.minY + safetyMargin;
    const safeMaxY = b.maxY - safetyMargin;

    let bestX = cx;
    let bestY = cy;
    let bestScore = -Infinity;

    for (let i = 0; i < 10; i++) {
      const tx = cx + (Math.random() - 0.5) * 2 * rangeX;
      const ty = cy + (Math.random() - 0.5) * 2 * rangeY;
      const clampedTx = clamp(tx, safeMinX, safeMaxX);
      const clampedTy = clamp(ty, safeMinY, safeMaxY);
      const key = `${Math.round(clampedTx / 80)}_${Math.round(clampedTy / 80)}`;
      const visits = visitRef.current.get(key) ?? 0;
      const edgePenalty =
        Math.min(clampedTx - safeMinX, safeMaxX - clampedTx, clampedTy - safeMinY, safeMaxY - clampedTy) < 40 ? 2 : 0;
      const score = -visits - edgePenalty + Math.random() * 0.4;
      if (score > bestScore) {
        bestScore = score;
        bestX = clampedTx;
        bestY = clampedTy;
      }
    }

    const key = `${Math.round(bestX / 80)}_${Math.round(bestY / 80)}`;
    visitRef.current.set(key, (visitRef.current.get(key) ?? 0) + 1);
    if (visitRef.current.size > 64) {
      const first = visitRef.current.keys().next().value;
      if (first) visitRef.current.delete(first);
    }

    waypointRef.current = { x: bestX, y: bestY };
    behaviorRef.current = "exploring";
    pauseUntilRef.current = 0;
  }, []);

  const setContainerRef = useCallback(
    (el: HTMLDivElement | null) => {
      elRef.current = el;
      if (el) {
        refreshBounds();
        const initX = Math.max(0, window.innerWidth - containerW - 24);
        const initY = Math.max(0, window.innerHeight - containerH - 24);
        posRef.current = { x: initX, y: initY };
        lastSignificantMoveAtRef.current = performance.now();
        el.style.position = "fixed";
        el.style.left = "0";
        el.style.top = "0";
        el.style.willChange = "transform";
        el.style.contain = "layout style paint";
        applyTransform();
        pickWaypoint();
      }
    },
    [applyTransform, containerH, containerW, pickWaypoint, refreshBounds],
  );

  const pauseMotion = useCallback(() => {
    pausedRef.current = true;
  }, []);

  const resumeMotion = useCallback((overrideX?: number, overrideY?: number) => {
    pausedRef.current = false;
    if (overrideX != null && overrideY != null) {
      posRef.current.x = overrideX;
      posRef.current.y = overrideY;
      velRef.current.vx *= 0.15;
      velRef.current.vy *= 0.15;
    }
    lastSignificantMoveAtRef.current = performance.now();
    stuckGuardRef.current = false;
    behaviorRef.current = "exploring";
    pauseUntilRef.current = 0;
    approachTargetRef.current = null;
    velRef.current.vx += (Math.random() - 0.5) * 30;
    velRef.current.vy += (Math.random() - 0.5) * 20;
    impulseRef.current = Math.max(impulseRef.current, 0.25);
    pickWaypoint();
    applyTransform();
  }, [applyTransform, pickWaypoint]);

  const setUserRotation = useCallback(
    (deg: number, velocity?: number) => {
      userRotRef.current = deg;
      if (velocity != null) userRotVelRef.current = velocity;
      applyTransform();
    },
    [applyTransform],
  );

  const stimulate = useCallback(
    (
      type: string,
      opts: { intensity?: number; soulImpact?: { impulse?: number }; decayMs?: number } = {},
    ) => {
      if (!enabled) return;
      const impulse =
        opts.soulImpact?.impulse ??
        (type === "user_spoke" || type === "wake_call"
          ? 0.45
          : type === "touched"
            ? 0.35
            : type === "dragged"
              ? 0.5
              : 0.2);
      stimuliRef.current.push({
        type,
        bornAt: performance.now(),
        decayMs: opts.decayMs ?? 2800,
        impulse: impulse * (opts.intensity ?? 0.7),
      });

      if (type === "user_spoke" || type === "wake_call" || type === "boredom_spike") {
        behaviorRef.current = "exploring";
        pickWaypoint();
      }
      if (type === "external_move") {
        behaviorRef.current = "approaching";
      }
      if (type === "touched" || type === "dragged") {
        impulseRef.current = clamp(impulseRef.current + 0.25, 0, 1);
      }
    },
    [enabled, pickWaypoint],
  );

  useEffect(() => {
    let stopped = false;
    const tick = (now: number) => {
      if (stopped) return;
      if (document.hidden || document.visibilityState === "hidden") {
        rafIdRef.current = requestAnimationFrame(tick);
        lastTimeRef.current = 0;
        return;
      }
      if (!lastTimeRef.current) {
        lastTimeRef.current = now;
        rafIdRef.current = requestAnimationFrame(tick);
        return;
      }

      let dt = (now - lastTimeRef.current) / 1000;
      lastTimeRef.current = now;
      if (dt > 0.05) dt = 0.016;

      if (!pausedRef.current) {
        const profile = MOOD_MOTION[moodRef.current];
        const e = energyRef.current;

        let impu = impulseRef.current;
        for (const s of stimuliRef.current) {
          const age = now - s.bornAt;
          if (age < s.decayMs) {
            const fade = Math.cos((age / s.decayMs) * Math.PI * 0.5);
            impu += s.impulse * fade * dt * 0.5;
          }
        }
        stimuliRef.current = stimuliRef.current.filter((s) => now - s.bornAt < s.decayMs);
        impulseRef.current = clamp(impu - dt * 0.35, 0, 1);

        const excited = behaviorRef.current === "excited" || now < excitedUntilRef.current;
        if (excited && now >= excitedUntilRef.current && behaviorRef.current === "excited") {
          behaviorRef.current = "exploring";
        }

        const baseSpeed =
          lerp(profile.speed[0], profile.speed[1], e) *
          (1 + impulseRef.current * 0.55) *
          (excited ? 2.15 : 1);
        const behavior = behaviorRef.current;
        const tSec = now / 1000;
        const vel = velRef.current;

        vel.vx += Math.sin(tSec * 2.2) * profile.vitality * 8 * dt;
        vel.vy += Math.sin(tSec * 1.6) * profile.vitality * 5 * dt;

        if (moodRef.current === "speaking") {
          const syllable = Math.sin(tSec * 12);
          if (syllable > 0.7) {
            const kick = (syllable - 0.7) * 4 * e;
            vel.vx += (Math.random() - 0.5) * kick * 18 * dt;
            vel.vy += (Math.random() - 0.4) * kick * 12 * dt;
          }
        }

        let targetX = posRef.current.x;
        let targetY = posRef.current.y;

        if (behavior === "approaching" && approachTargetRef.current) {
          targetX = approachTargetRef.current.x;
          targetY = approachTargetRef.current.y;
          const dx = targetX - posRef.current.x;
          const dy = targetY - posRef.current.y;
          if (Math.sqrt(dx * dx + dy * dy) < 28) {
            approachTargetRef.current = null;
            behaviorRef.current = "pausing";
            pauseUntilRef.current = now + 1200;
          }
        } else if (waypointRef.current) {
          targetX = waypointRef.current.x;
          targetY = waypointRef.current.y;
          const dx = targetX - posRef.current.x;
          const dy = targetY - posRef.current.y;
          const dist = Math.sqrt(dx * dx + dy * dy);

          if (dist < 24) {
            if (pauseUntilRef.current === 0) {
              const [lo, hi] = profile.pauseSec;
              pauseUntilRef.current = now + (lo + Math.random() * (hi - lo)) * 1000;
              behaviorRef.current = "pausing";
            } else if (now >= pauseUntilRef.current) {
              pickWaypoint();
            }
          }
        } else {
          pickWaypoint();
        }

        const mouse = mouseRef.current;
        if (mouse.active && behavior !== "approaching") {
          const mdx = mouse.x - (posRef.current.x + containerW / 2);
          const mdy = mouse.y - (posRef.current.y + containerH / 2);
          const mDist = Math.sqrt(mdx * mdx + mdy * mdy);
          if (mDist < 280 && mDist > 40) {
            const pull = ((280 - mDist) / 280) * profile.curiosity * 0.35;
            targetX = lerp(targetX, mouse.x - containerW / 2, pull);
            targetY = lerp(targetY, mouse.y - containerH / 2, pull * 0.85);
          }
        }

        const b = boundsRef.current;
        const isApproaching = behavior === "approaching";
        const softMargin = isApproaching ? 8 : 60;
        if (posRef.current.x < b.minX + softMargin) targetX = Math.max(targetX, b.minX + softMargin + (isApproaching ? 0 : 20));
        if (posRef.current.x > b.maxX - softMargin) targetX = Math.min(targetX, b.maxX - softMargin - (isApproaching ? 0 : 20));
        if (posRef.current.y < b.minY + softMargin) targetY = Math.max(targetY, b.minY + softMargin + (isApproaching ? 0 : 20));
        if (posRef.current.y > b.maxY - softMargin) targetY = Math.min(targetY, b.maxY - softMargin - (isApproaching ? 0 : 20));

        const dx = targetX - posRef.current.x;
        const dy = targetY - posRef.current.y;
        const moving = behavior === "exploring" || behavior === "approaching" || excited;

        if (excited && Math.random() < dt * 5.5) {
          vel.vx += (Math.random() - 0.5) * 220 * dt;
          vel.vy += (Math.random() - 0.5) * 170 * dt;
          if (Math.random() < 0.55) pickWaypoint();
        }
        const springK = moving ? (excited ? 3.6 : 2.9) : 1.3;
        const damping = excited ? 4.2 : 5.5;

        if (moving || Math.sqrt(dx * dx + dy * dy) > 8) {
          vel.vx += dx * springK * baseSpeed * 0.028 * dt;
          vel.vy += dy * springK * baseSpeed * 0.028 * dt;
        } else {
          vel.vx *= Math.exp(-6 * dt);
          vel.vy *= Math.exp(-6 * dt);
        }
        vel.vx *= Math.exp(-damping * dt);
        vel.vy *= Math.exp(-damping * dt);

        const breath = Math.sin(now / 900) * 0.6 + Math.sin(now / 1700) * 0.3;
        if (behavior === "pausing") {
          vel.vx += breath * 0.35 * dt + Math.sin(tSec * 1.3) * profile.vitality * 6 * dt;
          vel.vy += Math.cos(now / 1100) * 0.28 * dt + Math.cos(tSec * 1.1) * profile.vitality * 4 * dt;
        }

        let newX = posRef.current.x + vel.vx * dt;
        let newY = posRef.current.y + vel.vy * dt;
        const clamped = clampPos(newX, newY);
        if (clamped.x !== newX) {
          newX = clamped.x;
          vel.vx *= -RESTITUTION;
          if (now - lastBoundaryAtRef.current > 200 && !boundaryStimulateGuardRef.current) {
            lastBoundaryAtRef.current = now;
            boundaryStimulateGuardRef.current = true;
            stimulate("boundary_hit", { intensity: 0.85, soulImpact: { impulse: 0.35 } });
            setTimeout(() => { boundaryStimulateGuardRef.current = false; }, 100);
          }
        }
        if (clamped.y !== newY) {
          newY = clamped.y;
          vel.vy *= -RESTITUTION;
          if (now - lastBoundaryAtRef.current > 200 && !boundaryStimulateGuardRef.current) {
            lastBoundaryAtRef.current = now;
            boundaryStimulateGuardRef.current = true;
            stimulate("boundary_hit", { intensity: 0.85, soulImpact: { impulse: 0.35 } });
            setTimeout(() => { boundaryStimulateGuardRef.current = false; }, 100);
          }
        }

        posRef.current.x = newX;
        posRef.current.y = newY;

        const frameDist = Math.sqrt(vel.vx * vel.vx + vel.vy * vel.vy) * dt;
        if (frameDist > 0.6) {
          lastSignificantMoveAtRef.current = now;
        }
        const stuckMs = now - lastSignificantMoveAtRef.current;
        if (stuckMs > 3000 && !stuckGuardRef.current && behavior !== "approaching") {
          stuckGuardRef.current = true;
          behaviorRef.current = "exploring";
          pauseUntilRef.current = 0;
          impulseRef.current = Math.max(impulseRef.current, 0.4);
          vel.vx += (Math.random() - 0.5) * 60;
          vel.vy += (Math.random() - 0.5) * 40;
          pickWaypoint();
          setTimeout(() => { stuckGuardRef.current = false; }, 2000);
        }

        const speed = Math.sqrt(vel.vx * vel.vx + vel.vy * vel.vy);
        const tiltTarget = speed > 2 ? clamp(vel.vx / Math.max(speed, 1) * 8, -8, 8) : 0;
        rotRef.current = lerp(rotRef.current, tiltTarget, 0.06 + speed * 0.004);

        scaleRef.current =
          1 +
          impulseRef.current * 0.04 +
          (behavior === "pausing" ? breath * 0.006 : 0) +
          (moodRef.current === "speaking" ? Math.sin(tSec * 12) * 0.012 * e : 0) +
          (excited ? Math.sin(tSec * 14) * 0.018 : 0);

        userRotVelRef.current *= 0.9;
        userRotRef.current += userRotVelRef.current * dt;
        userRotRef.current *= 0.96;
        if (Math.abs(userRotRef.current) < 0.2 && Math.abs(userRotVelRef.current) < 0.2) {
          userRotRef.current = 0;
          userRotVelRef.current = 0;
        }

        applyTransform();
      }

      rafIdRef.current = requestAnimationFrame(tick);
    };

    if (enabled) {
      lastTimeRef.current = 0;
      rafIdRef.current = requestAnimationFrame(tick);
    }
    return () => {
      stopped = true;
      cancelAnimationFrame(rafIdRef.current);
    };
  }, [applyTransform, clampPos, containerH, containerW, enabled, pickWaypoint]);

  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => {
      mouseRef.current = { x: e.clientX, y: e.clientY, active: true };
    };
    const onMouseLeave = () => {
      mouseRef.current = { x: -9999, y: -9999, active: false };
    };
    window.addEventListener("mousemove", onMouseMove, { passive: true });
    window.addEventListener("mouseleave", onMouseLeave, { passive: true });
    return () => {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseleave", onMouseLeave);
    };
  }, []);

  useEffect(() => {
    const onResize = () => {
      refreshBounds();
      const c = clampPos(posRef.current.x, posRef.current.y);
      posRef.current.x = c.x;
      posRef.current.y = c.y;
      applyTransform();
    };
    window.addEventListener("resize", onResize, { passive: true });
    return () => window.removeEventListener("resize", onResize);
  }, [applyTransform, clampPos, refreshBounds]);

  const executeCommand = useCallback(
    (action: EmbodimentCommandAction, x?: number, y?: number, strength?: number) => {
      switch (action) {
        case "move":
          if (x != null && y != null) {
            approachTargetRef.current = { x, y };
            behaviorRef.current = "approaching";
            stimulate("external_move", { intensity: 0.8 });
          }
          break;
        case "roam": {
          pickWaypoint();
          const s = strength ?? 1;
          if (s >= 1.12) {
            behaviorRef.current = "excited";
            excitedUntilRef.current = performance.now() + 2000 + s * 700;
            impulseRef.current = Math.min(1, 0.5 + s * 0.3);
          }
          stimulate("boredom_spike", { intensity: 0.7 });
          break;
        }
        case "excite": {
          behaviorRef.current = "excited";
          const s = strength ?? 1.5;
          excitedUntilRef.current = performance.now() + 3000 + s * 1000;
          impulseRef.current = Math.min(1, 0.75 + s * 0.22);
          velRef.current.vx += (Math.random() - 0.5) * 140 * s;
          velRef.current.vy += (Math.random() - 0.5) * 110 * s;
          pickWaypoint();
          stimulate("wake_call", { intensity: 1, soulImpact: { impulse: 0.75 } });
          break;
        }
        case "stop":
          velRef.current.vx = 0;
          velRef.current.vy = 0;
          impulseRef.current = 0;
          stimuliRef.current = [];
          behaviorRef.current = "pausing";
          pauseUntilRef.current = performance.now() + 4000;
          break;
        case "window_roam":
          pickWaypoint();
          stimulate("wake_call", { intensity: 0.9 });
          break;
      }
    },
    [pickWaypoint, stimulate],
  );

  useEffect(() => {
    if (!enabled) return;
    const onCustomEvent = (e: Event) => {
      const cmd = (e as CustomEvent<{ action: string; x?: number; y?: number; strength?: number }>).detail;
      if (!cmd?.action) return;
      executeCommand(cmd.action as EmbodimentCommandAction, cmd.x, cmd.y, cmd.strength);
    };
    const onPostMessage = (ev: MessageEvent) => {
      const d = ev.data;
      if (!d || typeof d !== "object") return;
      if (d.type === "agent-sphere:command" && d.action) {
        executeCommand(d.action as EmbodimentCommandAction, d.x, d.y, d.strength);
      }
    };
    window.addEventListener("agent-sphere:command", onCustomEvent);
    window.addEventListener("message", onPostMessage);
    return () => {
      window.removeEventListener("agent-sphere:command", onCustomEvent);
      window.removeEventListener("message", onPostMessage);
    };
  }, [enabled, executeCommand]);

  return {
    get x() {
      return posRef.current.x;
    },
    get y() {
      return posRef.current.y;
    },
    get rotation() {
      return rotRef.current + userRotRef.current;
    },
    get tilt() {
      return rotRef.current;
    },
    get userRotation() {
      return userRotRef.current;
    },
    get scale() {
      return scaleRef.current;
    },
    get phase() {
      return behaviorRef.current;
    },
    get isMoving() {
      return (
        behaviorRef.current === "exploring" ||
        behaviorRef.current === "approaching" ||
        behaviorRef.current === "excited"
      );
    },
    get behavior() {
      return behaviorRef.current;
    },
    get roaming() {
      return behaviorRef.current === "exploring";
    },
    setContainerRef,
    pauseMotion,
    resumeMotion,
    setUserRotation,
    roamNow: () => {
      pickWaypoint();
      stimulate("boredom_spike");
    },
    moveTo: (tx: number, ty: number) => {
      approachTargetRef.current = { x: tx, y: ty };
      behaviorRef.current = "approaching";
      stimulate("external_move", { intensity: 0.8 });
    },
    stop: () => executeCommand("stop"),
    startRoaming: () => executeCommand("window_roam"),
    executeCommand,
    stimulate,
  };
}
