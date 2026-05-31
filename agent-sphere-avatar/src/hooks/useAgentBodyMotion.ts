import { useFrame } from "@react-three/fiber";
import { useCallback, useEffect, useRef, type RefObject } from "react";
import * as THREE from "three";
import type { PublicApi } from "@react-three/cannon";
import type { AgentMood } from "../types/agent";
import type { FaceSignals } from "../components/ScreenFace";

const MOOD_PROFILE: Record<
  AgentMood,
  { speed: number; roam: number; pauseSec: number; breath: number; vitality: number }
> = {
  idle: { speed: 0.48, roam: 0.78, pauseSec: 1.6, breath: 0.045, vitality: 0.22 },
  listening: { speed: 0.32, roam: 0.42, pauseSec: 2.8, breath: 0.032, vitality: 0.28 },
  thinking: { speed: 0.4, roam: 0.88, pauseSec: 1.4, breath: 0.038, vitality: 0.32 },
  speaking: { speed: 0.68, roam: 0.82, pauseSec: 0.6, breath: 0.052, vitality: 0.55 },
  happy: { speed: 0.85, roam: 1, pauseSec: 0.35, breath: 0.062, vitality: 0.75 },
  alert: { speed: 0.58, roam: 0.62, pauseSec: 0.8, breath: 0.035, vitality: 0.5 },
};

const MASS = 1.1;
const RESTITUTION = 0.48;
const RESTITUTION_EXCITED = 0.62;

interface UseAgentBodyMotionOptions {
  api?: PublicApi;
  visualRef: RefObject<THREE.Group | null>;
  faceSignalsRef?: RefObject<FaceSignals>;
  enabled?: boolean;
  bounds?: number;
  mood?: AgentMood;
  energy?: number;
  focused?: boolean;
  onBoundaryHit?: (edge: "left" | "right" | "top" | "bottom" | "front" | "back") => void;
}

/** 具身物理 — 持续有生命力，兴奋时更狂，说话时有节奏摆动感 */
export function useAgentBodyMotion({
  api,
  visualRef,
  faceSignalsRef,
  enabled = true,
  bounds = 1.15,
  mood = "idle",
  energy = 0.55,
  focused = false,
  onBoundaryHit,
}: UseAgentBodyMotionOptions) {
  const pos = useRef(new THREE.Vector3(0, 1.45, 0));
  const vel = useRef(new THREE.Vector3());
  const target = useRef(new THREE.Vector3(0, 1.45, 0));
  const pauseUntil = useRef(0);
  const visitRef = useRef<Map<string, number>>(new Map());
  const excitementRef = useRef(0);
  const excitedUntilRef = useRef(0);
  const lastBoundaryAt = useRef(0);
  const fidgetAt = useRef(0);

  const enabledRef = useRef(enabled);
  const moodRef = useRef(mood);
  const energyRef = useRef(energy);
  const focusedRef = useRef(focused);
  const boundsRef = useRef(bounds);
  const onBoundaryHitRef = useRef(onBoundaryHit);
  enabledRef.current = enabled;
  moodRef.current = mood;
  energyRef.current = energy;
  focusedRef.current = focused;
  boundsRef.current = bounds;
  onBoundaryHitRef.current = onBoundaryHit;

  useEffect(() => {
    if (mood === "happy") {
      excitementRef.current = Math.max(excitementRef.current, 0.95);
      excitedUntilRef.current = performance.now() + 4500;
    } else if (mood === "speaking") {
      excitementRef.current = Math.max(excitementRef.current, 0.25 + energy * 0.35);
    }
  }, [mood, energy]);

  const pickTarget = useCallback((clock: number) => {
    const profile = MOOD_PROFILE[moodRef.current];
    const b = boundsRef.current;
    const excited = excitementRef.current > 0.28;
    const roam = profile.roam * b * (0.6 + energyRef.current * 0.5) * (excited ? 1.35 : 1);

    let bestX = 0;
    let bestZ = 0;
    let bestScore = -Infinity;
    const samples = excited ? 14 : 9;

    for (let i = 0; i < samples; i++) {
      const angle = (Math.PI * 2 * i) / samples + (Math.random() - 0.5) * (excited ? 1.6 : 0.5);
      const dist = (excited ? 0.55 + Math.random() * 0.45 : 0.4 + Math.random() * 0.6) * roam;
      const tx = Math.cos(angle) * dist;
      const tz = Math.sin(angle) * dist * 0.85;
      const key = `${Math.round(tx * 4)}_${Math.round(tz * 4)}`;
      const visits = visitRef.current.get(key) ?? 0;
      const score = -visits + Math.random() * 0.4;
      if (score > bestScore) {
        bestScore = score;
        bestX = tx;
        bestZ = tz;
      }
    }

    visitRef.current.set(`${Math.round(bestX * 4)}_${Math.round(bestZ * 4)}`, (visitRef.current.get(`${Math.round(bestX * 4)}_${Math.round(bestZ * 4)}`) ?? 0) + 1);

    target.current.set(bestX, 1.28 + Math.random() * 0.45 + profile.breath, bestZ);
    pauseUntil.current = clock + (excited ? 0.15 + Math.random() * 0.25 : profile.pauseSec * (0.45 + Math.random() * 0.55));
  }, []);

  const resolveBoundary = useCallback(
    (axis: "x" | "y" | "z", edge: "left" | "right" | "top" | "bottom" | "front" | "back", limit: number) => {
      const now = performance.now();
      if (now - lastBoundaryAt.current < 140) return;
      lastBoundaryAt.current = now;

      if (faceSignalsRef?.current) faceSignalsRef.current.boundaryBump = 1;
      onBoundaryHitRef.current?.(edge);

      const rest = excitementRef.current > 0.35 ? RESTITUTION_EXCITED : RESTITUTION;
      if (axis === "x") vel.current.x *= -rest;
      if (axis === "y") vel.current.y *= -rest * 0.55;
      if (axis === "z") vel.current.z *= -rest;
      pos.current[axis] = limit;

      if (excitementRef.current > 0.4) {
        vel.current.x += (Math.random() - 0.5) * 1.2;
        vel.current.z += (Math.random() - 0.5) * 1.2;
      }
    },
    [faceSignalsRef],
  );

  useEffect(() => {
    pickTarget(0);
    if (api) {
      api.position.set(pos.current.x, pos.current.y, pos.current.z);
      api.velocity.set(0, 0, 0);
      api.angularVelocity.set(0, 0, 0);
    }
  }, [api, pickTarget]);

  useFrame(({ clock }, delta) => {
    const dt = Math.min(delta, 0.032);
    if (!enabledRef.current) return;

    const t = clock.elapsedTime;
    const profile = MOOD_PROFILE[moodRef.current];
    const b = boundsRef.current;
    const nowMs = performance.now();

    if (nowMs > excitedUntilRef.current) {
      excitementRef.current = Math.max(0, excitementRef.current - dt * 0.28);
    } else {
      excitementRef.current = Math.min(1, Math.max(excitementRef.current, 0.65));
    }

    const excited = excitementRef.current > 0.28;
    const speaking = moodRef.current === "speaking";
    const speedMul =
      profile.speed * (0.7 + energyRef.current * 0.55) * (1 + excitementRef.current * 1.25);

    const vitality = profile.vitality * (0.5 + energyRef.current * 0.5);
    vel.current.x += Math.sin(t * 2.1 + 0.5) * vitality * 0.022;
    vel.current.y += Math.sin(t * 1.55) * profile.breath * 0.35;
    vel.current.z += Math.cos(t * 1.85) * vitality * 0.018;

    if (speaking) {
      const syllable = Math.sin(t * 12.5);
      if (syllable > 0.72) {
        const kick = (syllable - 0.72) * 3.5 * energyRef.current;
        vel.current.x += (Math.random() - 0.5) * kick * 0.55;
        vel.current.z += (Math.random() - 0.5) * kick * 0.45;
        vel.current.y += kick * 0.18;
        if (faceSignalsRef?.current) {
          faceSignalsRef.current.speakPulse = Math.min(1, kick * 0.8);
        }
      }
    }

    if (excited) {
      const burstRate = 4.5 + excitementRef.current * 4;
      if (Math.random() < dt * burstRate) {
        const f = 1.5 + excitementRef.current * 2.8;
        vel.current.x += (Math.random() - 0.5) * f * 2.2;
        vel.current.z += (Math.random() - 0.5) * f * 2.2;
        vel.current.y += (Math.random() - 0.15) * f * 1.4;
      }
    }

    const dx = target.current.x - pos.current.x;
    const dz = target.current.z - pos.current.z;
    const horizDist = Math.sqrt(dx * dx + dz * dz);

    if (t >= pauseUntil.current && horizDist < (excited ? 0.28 : 0.14)) {
      pickTarget(t);
    }

    if (!excited && t > fidgetAt.current && horizDist < 0.08 && Math.random() < dt * 0.55) {
      fidgetAt.current = t + 1.8 + Math.random() * 2.5;
      vel.current.x += (Math.random() - 0.5) * 0.45;
      vel.current.z += (Math.random() - 0.5) * 0.45;
      pickTarget(t);
    }

    const breathY =
      Math.sin(t * 1.65) * profile.breath * (0.5 + energyRef.current * 0.5) +
      Math.sin(t * 3.4) * profile.breath * 0.22;
    const dy = target.current.y + breathY - pos.current.y;

    const springK = (focusedRef.current ? 2.6 : 4.8) * (excited ? 1.65 : 1) * (speaking ? 1.15 : 1);
    const forceScale = speedMul / MASS;

    vel.current.x += dx * springK * forceScale * dt;
    vel.current.y += dy * springK * forceScale * 0.9 * dt;
    vel.current.z += dz * springK * forceScale * dt;

    const drag = excited ? 2.8 : speaking ? 5.2 : 5.8;
    vel.current.multiplyScalar(Math.exp(-drag * dt));

    const maxSpeed = excited ? 3.8 : speaking ? 2.4 : 1.85;
    if (vel.current.length() > maxSpeed) vel.current.setLength(maxSpeed);

    pos.current.addScaledVector(vel.current, dt);

    if (pos.current.x < -b) resolveBoundary("x", "left", -b);
    else if (pos.current.x > b) resolveBoundary("x", "right", b);
    if (pos.current.y < 1.05) resolveBoundary("y", "bottom", 1.05);
    else if (pos.current.y > 2.15) resolveBoundary("y", "top", 2.15);
    if (pos.current.z < -b) resolveBoundary("z", "back", -b);
    else if (pos.current.z > b) resolveBoundary("z", "front", b);

    if (api) {
      api.position.set(pos.current.x, pos.current.y, pos.current.z);
      api.velocity.set(vel.current.x, vel.current.y, vel.current.z);
    }

    const speed = vel.current.length();
    if (faceSignalsRef?.current) {
      faceSignalsRef.current.excitement = excitementRef.current;
      faceSignalsRef.current.speed = speed;
    }

    const group = visualRef.current;
    if (!group) return;

    const leanX = THREE.MathUtils.clamp(-vel.current.x * 0.34, -0.28, 0.28);
    const leanZ = THREE.MathUtils.clamp(vel.current.z * 0.28, -0.22, 0.22);
    const wobble = excited
      ? Math.sin(t * 14) * 0.08 * excitementRef.current
      : speaking
        ? Math.sin(t * 10) * 0.025 * energyRef.current
        : Math.sin(t * 1.2) * 0.012;

    group.rotation.z = THREE.MathUtils.lerp(group.rotation.z, leanX + wobble, dt * 7);
    group.rotation.x = THREE.MathUtils.lerp(group.rotation.x, leanZ, dt * 7);

    const spin = excited ? Math.sin(t * 9) * 0.12 * excitementRef.current : 0;
    if (speed < 0.05 && !excited) {
      group.rotation.y = THREE.MathUtils.lerp(
        group.rotation.y,
        Math.sin(t * 0.4) * 0.12 * profile.vitality + spin,
        dt * 3.5,
      );
    } else {
      const face = Math.atan2(-vel.current.x, vel.current.z) * 0.28 + spin;
      group.rotation.y = THREE.MathUtils.lerp(group.rotation.y, face, dt * 6);
    }
  });

  const pickRandomTarget = useCallback(() => {
    pauseUntil.current = 0;
  }, []);

  const setTarget = useCallback((x: number, y: number, z: number) => {
    const b = boundsRef.current;
    target.current.set(
      THREE.MathUtils.clamp(x, -b, b),
      THREE.MathUtils.clamp(y, 1.05, 2.15),
      THREE.MathUtils.clamp(z, -b, b),
    );
    pauseUntil.current = 0;
  }, []);

  const excite = useCallback((strength = 1) => {
    const s = Math.min(2.2, Math.max(0.4, strength));
    excitementRef.current = Math.min(1, 0.7 + s * 0.28);
    excitedUntilRef.current = performance.now() + 3200 + s * 1200;
    vel.current.x += (Math.random() - 0.5) * 3.8 * s;
    vel.current.z += (Math.random() - 0.5) * 3.8 * s;
    vel.current.y += 1.1 * s;
    pauseUntil.current = 0;
    const b = boundsRef.current;
    target.current.set(
      (Math.random() - 0.5) * b * 1.85,
      1.22 + Math.random() * 0.65,
      (Math.random() - 0.5) * b * 1.65,
    );
  }, []);

  const stopMotion = useCallback(() => {
    enabledRef.current = false;
    excitementRef.current = 0;
    vel.current.set(0, 0, 0);
    if (api) api.velocity.set(0, 0, 0);
  }, [api]);

  const resumeMotion = useCallback(() => {
    enabledRef.current = true;
  }, []);

  return { pickRandomTarget, setTarget, stopMotion, resumeMotion, excite };
}
