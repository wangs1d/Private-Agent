import { useFrame, useThree, type ThreeEvent } from "@react-three/fiber";
import { useCallback, useEffect, useRef, type RefObject } from "react";
import * as THREE from "three";
import type { PublicApi } from "@react-three/cannon";
import { MODEL } from "../constants/model-proportions";
import type { FaceSignals } from "../components/ScreenFace";
import { registerSphereDrag, type SphereDragApi } from "../bridge/sphere-drag-bridge";
import { postToHost, SPHERE_MSG } from "../embed-protocol";
import { pointerHitsSphere } from "../utils/sphere-hit";

export type SphereTouchPhase = "start" | "drag" | "end";

export interface SphereTouchEvent {
  phase: SphereTouchPhase;
  spinStrength?: number;
  totalRotationDeg?: number;
}

interface UseSphereUserDragOptions {
  userRotRef: RefObject<THREE.Group | null>;
  /** 物理体/根 group — 用于 Canvas 级命中检测 */
  bodyRef?: RefObject<THREE.Object3D | null>;
  faceSignalsRef?: RefObject<FaceSignals>;
  enabled?: boolean;
  /** Canvas DOM 级拖拽 */
  canvasCapture?: boolean;
  /** 任意 Canvas 点击即拖拽（demo 页） */
  canvasCaptureLenient?: boolean;
  /** 注册到 DOM 拖拽桥（embed 网页层） */
  registerBridge?: boolean;
  api?: PublicApi;
  onTouch?: (event: SphereTouchEvent) => void;
  onExcite?: (strength: number) => void;
  onBodyHover?: (active: boolean) => void;
  onEyeClick?: () => void;
  /** 左键拖动平移（无桌面 overlay API 时回调） */
  onPanDelta?: (dx: number, dy: number) => void;
  onPanEnd?: () => void;
}

type DragMode = "pan" | "rotate";

const SPIN_EXCITE_THRESHOLD = 0.35;
const HIT_RADIUS = MODEL.bodyRadius * 1.12;
const EYE_HIT_RADIUS = MODEL.bodyRadius * Math.sin(MODEL.screenHitHalfAngle);
const EYE_CLICK_DRAG_PX = 10;

/** 左键拖动平移、右键拖动旋转 */
export function useSphereUserDrag({
  userRotRef,
  bodyRef,
  faceSignalsRef,
  enabled = true,
  canvasCapture = true,
  canvasCaptureLenient = false,
  registerBridge = false,
  api,
  onTouch,
  onExcite,
  onBodyHover,
  onEyeClick,
  onPanDelta,
  onPanEnd,
}: UseSphereUserDragOptions) {
  const { camera, gl, raycaster } = useThree();
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;

  const draggingRef = useRef(false);
  const pointerIdRef = useRef<number | null>(null);
  const lastPointerRef = useRef({ x: 0, y: 0 });
  const spinVelRef = useRef({ x: 0, y: 0 });
  const totalRotRef = useRef(0);
  const touchPulseRef = useRef(0);
  const dragModeRef = useRef<DragMode>("pan");
  const activeButtonRef = useRef(0);
  const panMovedRef = useRef(0);
  const panRemainderRef = useRef({ x: 0, y: 0 });
  /** Electron 窗口拖拽须用 screen 坐标，否则 moveBy 后 client 坐标反馈导致抖动 */
  const panUseScreenSpaceRef = useRef(false);
  const bodyCenterRef = useRef(new THREE.Vector3(0, 1.6, 0));
  const eyeLocalRef = useRef(new THREE.Vector3(...MODEL.glassScreenPosition));
  const eyeWorldRef = useRef(new THREE.Vector3());

  const applyFaceSignals = useCallback(
    (touch: number, spin: number) => {
      const signals = faceSignalsRef?.current;
      if (!signals) return;
      signals.userTouch = Math.max(signals.userTouch, touch);
      signals.userSpin = Math.max(signals.userSpin, spin);
    },
    [faceSignalsRef],
  );

  const readPointer = useCallback((clientX: number, clientY: number, screenX: number, screenY: number) => {
    if (panUseScreenSpaceRef.current) {
      return { x: screenX, y: screenY };
    }
    return { x: clientX, y: clientY };
  }, []);

  const applyDragDelta = useCallback(
    (dx: number, dy: number) => {
      if (Math.abs(dx) < 0.01 && Math.abs(dy) < 0.01) return;

      if (dragModeRef.current === "pan") {
        panMovedRef.current += Math.abs(dx) + Math.abs(dy);

        if (window.sphereOverlay?.moveBy) {
          panRemainderRef.current.x += dx;
          panRemainderRef.current.y += dy;
          const ix = Math.trunc(panRemainderRef.current.x);
          const iy = Math.trunc(panRemainderRef.current.y);
          if (ix !== 0 || iy !== 0) {
            panRemainderRef.current.x -= ix;
            panRemainderRef.current.y -= iy;
            window.sphereOverlay.moveBy(ix, iy);
          }
        } else if (onPanDelta) {
          onPanDelta(dx, dy);
        } else if (window.parent !== window) {
          postToHost({ type: SPHERE_MSG.pan, dx, dy });
        }
        return;
      }

      const dt = 0.016;
      const rotY = dx * 0.014;
      const rotX = dy * 0.011;
      totalRotRef.current += Math.abs(dx) + Math.abs(dy);

      const group = userRotRef.current;
      if (group) {
        group.rotation.y += rotY;
        group.rotation.x = THREE.MathUtils.clamp(group.rotation.x + rotX, -0.65, 0.65);
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
    [api, applyFaceSignals, onPanDelta, onTouch, userRotRef],
  );

  const finishDrag = useCallback(() => {
    if (!draggingRef.current) return;
    const mode = dragModeRef.current;
    draggingRef.current = false;
    pointerIdRef.current = null;

    if (mode === "rotate") {
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
    } else {
      if (window.sphereOverlay?.moveBy) {
        const rx = Math.round(panRemainderRef.current.x);
        const ry = Math.round(panRemainderRef.current.y);
        if (rx !== 0 || ry !== 0) {
          window.sphereOverlay.moveBy(rx, ry);
        }
      }
      panRemainderRef.current = { x: 0, y: 0 };
      panUseScreenSpaceRef.current = false;
      onPanEnd?.();
    }

    dragModeRef.current = "pan";
    activeButtonRef.current = 0;
    panMovedRef.current = 0;
  }, [applyFaceSignals, onExcite, onPanEnd, onTouch]);

  const beginDrag = useCallback(
    (
      clientX: number,
      clientY: number,
      screenX: number,
      screenY: number,
      pointerId: number,
      mode: DragMode,
      button: number,
    ) => {
      if (!enabledRef.current || draggingRef.current) return false;
      draggingRef.current = true;
      pointerIdRef.current = pointerId;
      dragModeRef.current = mode;
      activeButtonRef.current = button;
      panUseScreenSpaceRef.current = mode === "pan" && !!window.sphereOverlay?.moveBy;
      const p = readPointer(clientX, clientY, screenX, screenY);
      lastPointerRef.current = { x: p.x, y: p.y };
      spinVelRef.current = { x: 0, y: 0 };
      totalRotRef.current = 0;
      panMovedRef.current = 0;
      panRemainderRef.current = { x: 0, y: 0 };
      touchPulseRef.current = 1;
      applyFaceSignals(1, 0);
      if (mode === "rotate") {
        onTouch?.({ phase: "start" });
      }
      return true;
    },
    [applyFaceSignals, onTouch, readPointer],
  );

  const resolveDragMode = (button: number): DragMode | null => {
    if (button === 0) return "pan";
    if (button === 2) return "rotate";
    return null;
  };

  const applyPointerMove = useCallback(
    (clientX: number, clientY: number, screenX: number, screenY: number) => {
      const p = readPointer(clientX, clientY, screenX, screenY);
      const dx = p.x - lastPointerRef.current.x;
      const dy = p.y - lastPointerRef.current.y;
      lastPointerRef.current = { x: p.x, y: p.y };
      applyDragDelta(dx, dy);
    },
    [applyDragDelta, readPointer],
  );

  const handlePointerDown = useCallback(
    (e: ThreeEvent<PointerEvent>) => {
      const mode = resolveDragMode(e.button);
      if (!enabledRef.current || mode == null) return;
      e.stopPropagation();
      beginDrag(e.clientX, e.clientY, e.screenX, e.screenY, e.pointerId, mode, e.button);
    },
    [beginDrag],
  );

  const handlePointerMove = useCallback(
    (e: ThreeEvent<PointerEvent>) => {
      if (!draggingRef.current || pointerIdRef.current !== e.pointerId) return;
      e.stopPropagation();
      applyPointerMove(e.clientX, e.clientY, e.screenX, e.screenY);
    },
    [applyPointerMove],
  );

  const handlePointerUp = useCallback(
    (e: ThreeEvent<PointerEvent>) => {
      if (!draggingRef.current || pointerIdRef.current !== e.pointerId) return;
      e.stopPropagation();
      const wasPan = dragModeRef.current === "pan";
      const panPx = panMovedRef.current;
      const button = activeButtonRef.current;
      finishDrag();
      if (
        onEyeClick &&
        wasPan &&
        button === 0 &&
        panPx < EYE_CLICK_DRAG_PX &&
        pointerHitsSphere(
          e.clientX,
          e.clientY,
          gl.domElement,
          camera,
          raycaster,
          eyeWorldRef.current,
          EYE_HIT_RADIUS,
        )
      ) {
        onEyeClick();
      }
    },
    [camera, finishDrag, gl.domElement, onEyeClick, raycaster],
  );

  const handleBodyHover = useCallback(
    (active: boolean) => {
      if (draggingRef.current) return;
      onBodyHover?.(active);
    },
    [onBodyHover],
  );

  useFrame((_, delta) => {
    const root = bodyRef?.current ?? userRotRef.current;
    root?.getWorldPosition(bodyCenterRef.current);
    const rotGroup = userRotRef.current;
    if (rotGroup) {
      eyeWorldRef.current.copy(eyeLocalRef.current);
      rotGroup.localToWorld(eyeWorldRef.current);
    }

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
    group.rotation.x = THREE.MathUtils.clamp(group.rotation.x + sv.x * dt, -0.65, 0.65);

    const decay = Math.exp(-3.2 * dt);
    spinVelRef.current = { x: sv.x * decay, y: sv.y * decay };

    if (api && (Math.abs(sv.x) + Math.abs(sv.y)) > 0.01) {
      api.angularVelocity.set(sv.x * 1.8, sv.y * 2.8, sv.x * 0.3);
    }
  });

  useEffect(() => {
    const onWindowMove = (e: PointerEvent) => {
      if (!draggingRef.current || pointerIdRef.current !== e.pointerId) return;
      e.preventDefault();
      applyPointerMove(e.clientX, e.clientY, e.screenX, e.screenY);
    };

    const onWindowUp = (e: PointerEvent) => {
      if (!draggingRef.current || pointerIdRef.current !== e.pointerId) return;
      finishDrag();
    };

    window.addEventListener("pointermove", onWindowMove, { passive: false });
    window.addEventListener("pointerup", onWindowUp);
    window.addEventListener("pointercancel", onWindowUp);
    return () => {
      window.removeEventListener("pointermove", onWindowMove);
      window.removeEventListener("pointerup", onWindowUp);
      window.removeEventListener("pointercancel", onWindowUp);
    };
  }, [applyPointerMove, finishDrag]);

  useEffect(() => {
    const dom = gl.domElement;
    const onContextMenu = (e: MouseEvent) => e.preventDefault();
    dom.addEventListener("contextmenu", onContextMenu);
    return () => dom.removeEventListener("contextmenu", onContextMenu);
  }, [gl]);

  useEffect(() => {
    if (!registerBridge) return;
    const bridgeApi: SphereDragApi = {
      beginDrag: (x, y, id) => beginDrag(x, y, x, y, id, "rotate", 2),
      moveBy: (dx, dy) => applyDragDelta(dx, dy),
      endDrag: () => finishDrag(),
    };
    registerSphereDrag(bridgeApi);
    return () => registerSphereDrag(null);
  }, [registerBridge, beginDrag, applyDragDelta, finishDrag]);

  useEffect(() => {
    if (!canvasCapture) return;
    const dom = gl.domElement;
    dom.style.touchAction = "none";

    const onCanvasDown = (e: PointerEvent) => {
      const mode = resolveDragMode(e.button);
      if (!enabledRef.current || mode == null || draggingRef.current) return;

      if (!canvasCaptureLenient) {
        if (
          !pointerHitsSphere(
            e.clientX,
            e.clientY,
            dom,
            camera,
            raycaster,
            bodyCenterRef.current,
            HIT_RADIUS,
          )
        ) {
          return;
        }
      }

      e.preventDefault();
      e.stopPropagation();
      beginDrag(e.clientX, e.clientY, e.screenX, e.screenY, e.pointerId, mode, e.button);
      dom.setPointerCapture(e.pointerId);
    };

    const onContextMenu = (e: MouseEvent) => e.preventDefault();

    const onCanvasUp = (e: PointerEvent) => {
      if (pointerIdRef.current !== e.pointerId) return;
      try {
        dom.releasePointerCapture(e.pointerId);
      } catch {
        /* already released */
      }
    };

    dom.addEventListener("pointerdown", onCanvasDown, { capture: true });
    dom.addEventListener("pointerup", onCanvasUp, { capture: true });
    dom.addEventListener("pointercancel", onCanvasUp, { capture: true });
    dom.addEventListener("contextmenu", onContextMenu);

    return () => {
      dom.removeEventListener("pointerdown", onCanvasDown, { capture: true });
      dom.removeEventListener("pointerup", onCanvasUp, { capture: true });
      dom.removeEventListener("pointercancel", onCanvasUp, { capture: true });
      dom.removeEventListener("contextmenu", onContextMenu);
    };
  }, [beginDrag, camera, canvasCapture, canvasCaptureLenient, gl, raycaster, userRotRef]);

  return {
    handlePointerDown,
    handlePointerMove,
    handlePointerUp,
    handleBodyHover,
    bodyRadius: HIT_RADIUS,
    isDragging: () => draggingRef.current,
    dragDistance: () => totalRotRef.current,
  };
}
