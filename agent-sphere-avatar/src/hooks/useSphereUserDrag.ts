import { useFrame, type ThreeEvent } from "@react-three/fiber";
import { useCallback, useRef, type RefObject } from "react";
import * as THREE from "three";
import type { PublicApi } from "@react-three/cannon";
import { MODEL } from "../constants/model-proportions";
import type { FaceSignals } from "../components/ScreenFace";

export type SphereTouchPhase = "start" | "drag" | "end";

export interface SphereTouchEvent {
  phase: SphereTouchPhase;
  /** 释放时的角速度量级 0–1 */
  spinStrength?: number;
  /** 本次拖拽总角度（度） */
  totalRotationDeg?: number;
}

interface UseSphereUserDragOptions {
  userRotRef: RefObject<THREE.Group | null>;
  faceSignalsRef?: RefObject<FaceSignals>;
  enabled?: boolean;
  /** 物理体模式：拖拽时施加角速度 */
  api?: PublicApi;
  onTouch?: (event: SphereTouchEvent) => void;
  onExcite?: (strength: number) => void;
}

const SPIN_EXCITE_THRESHOLD = 0.35;

/** 用户拖拽旋转球形身体 — 带惯性、表情反馈与物理角速度 */
export function useSphereUserDrag({
  userRotRef,
  faceSignalsRef,
  enabled = true,
  api,
  onTouch,
  onExcite,
}: UseSphereUserDragOptions) {
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;

  const draggingRef = useRef(false);
  const pointerIdRef = useRef<number | null>(null);
  const lastPointerRef = useRef({ x: 0, y: 0 });
  const spinVelRef = useRef({ x: 0, y: 0 });
  const totalRotRef = useRef(0);
  const touchPulseRef = useRef(0);

  const applyFaceSignals = useCallback(
    (touch: number, spin: number) => {
      const signals = faceSignalsRef?.current;
      if (!signals) return;
      signals.userTouch = Math.max(signals.userTouch, touch);
      signals.userSpin = Math.max(signals.userSpin, spin);
    },
    [faceSignalsRef],
  );

  const handlePointerDown = useCallback(
    (e: ThreeEvent<PointerEvent>) => {
      if (!enabledRef.current || e.button !== 0) return;
      e.stopPropagation();
      draggingRef.current = true;
      pointerIdRef.current = e.pointerId;
      lastPointerRef.current = { x: e.clientX, y: e.clientY };
      spinVelRef.current = { x: 0, y: 0 };
      totalRotRef.current = 0;
      touchPulseRef.current = 1;
      applyFaceSignals(1, 0);
      const captureTarget = e.nativeEvent.target as Element | null;
      captureTarget?.setPointerCapture?.(e.pointerId);
      onTouch?.({ phase: "start" });
    },
    [applyFaceSignals, onTouch],
  );

  const handlePointerMove = useCallback(
    (e: ThreeEvent<PointerEvent>) => {
      if (!draggingRef.current || pointerIdRef.current !== e.pointerId) return;
      e.stopPropagation();

      const dx = e.clientX - lastPointerRef.current.x;
      const dy = e.clientY - lastPointerRef.current.y;
      lastPointerRef.current = { x: e.clientX, y: e.clientY };

      if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) return;

      const dt = 0.016;
      const rotY = dx * 0.012;
      const rotX = dy * 0.009;
      totalRotRef.current += Math.abs(dx) + Math.abs(dy);

      const group = userRotRef.current;
      if (group) {
        group.rotation.y += rotY;
        group.rotation.x = THREE.MathUtils.clamp(group.rotation.x + rotX, -0.55, 0.55);
      }

      spinVelRef.current = {
        x: THREE.MathUtils.lerp(spinVelRef.current.x, rotX / dt, 0.35),
        y: THREE.MathUtils.lerp(spinVelRef.current.y, rotY / dt, 0.35),
      };

      if (api) {
        api.angularVelocity.set(spinVelRef.current.x * 2.2, spinVelRef.current.y * 3.5, spinVelRef.current.x * 0.4);
      }

      const spin = Math.min(1, (Math.abs(spinVelRef.current.x) + Math.abs(spinVelRef.current.y)) * 0.18);
      applyFaceSignals(1, spin);
      onTouch?.({ phase: "drag", spinStrength: spin });
    },
    [api, applyFaceSignals, onTouch, userRotRef],
  );

  const handlePointerUp = useCallback(
    (e: ThreeEvent<PointerEvent>) => {
      if (!draggingRef.current || pointerIdRef.current !== e.pointerId) return;
      e.stopPropagation();
      draggingRef.current = false;
      pointerIdRef.current = null;

      const spinStrength = Math.min(
        1,
        (Math.abs(spinVelRef.current.x) + Math.abs(spinVelRef.current.y)) * 0.22,
      );
      const totalRotationDeg = totalRotRef.current * 0.35;

      if (spinStrength > SPIN_EXCITE_THRESHOLD) {
        onExcite?.(0.6 + spinStrength * 0.9);
        applyFaceSignals(0.6, spinStrength);
      } else if (totalRotRef.current > 8) {
        applyFaceSignals(0.45, spinStrength * 0.5);
      }

      onTouch?.({ phase: "end", spinStrength, totalRotationDeg });
    },
    [applyFaceSignals, onExcite, onTouch],
  );

  useFrame((_, delta) => {
    if (!enabledRef.current) return;

    const dt = Math.min(delta, 0.032);
    touchPulseRef.current = Math.max(0, touchPulseRef.current - dt * 2.8);

    const signals = faceSignalsRef?.current;
    if (signals) {
      signals.userTouch = Math.max(touchPulseRef.current, signals.userTouch - dt * 2.5);
      signals.userSpin = Math.max(0, signals.userSpin - dt * 1.8);
    }

    if (draggingRef.current) return;

    const group = userRotRef.current;
    if (!group) return;

    const sv = spinVelRef.current;
    if (Math.abs(sv.x) + Math.abs(sv.y) < 0.002) {
      spinVelRef.current = { x: 0, y: 0 };
      group.rotation.x = THREE.MathUtils.lerp(group.rotation.x, 0, dt * 2.2);
      return;
    }

    group.rotation.y += sv.y * dt;
    group.rotation.x = THREE.MathUtils.clamp(
      group.rotation.x + sv.x * dt,
      -0.55,
      0.55,
    );

    const decay = Math.exp(-3.2 * dt);
    spinVelRef.current = { x: sv.x * decay, y: sv.y * decay };

    if (api && (Math.abs(sv.x) + Math.abs(sv.y)) > 0.01) {
      api.angularVelocity.set(sv.x * 1.8, sv.y * 2.8, sv.x * 0.3);
    }
  });

  return {
    handlePointerDown,
    handlePointerMove,
    handlePointerUp,
    bodyRadius: MODEL.bodyRadius * 0.96,
  };
}
