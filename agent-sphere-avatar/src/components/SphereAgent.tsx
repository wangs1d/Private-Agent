import { useSphere } from "@react-three/cannon";
import { useFrame } from "@react-three/fiber";
import { Suspense, useCallback, useEffect, useRef, type Ref, type RefObject } from "react";
import * as THREE from "three";
import { bindEmbodimentCommand } from "../bridge/agent-bridge";
import { triggerOverlayRoam } from "../utils/overlay-roam-bridge";
import { MODEL } from "../constants/model-proportions";
import { postToHost, SPHERE_MSG } from "../embed-protocol";
import { useAgentBodyMotion } from "../hooks/useAgentBodyMotion";
import { useAutonomousMotion } from "../hooks/useAutonomousMotion";
import { useSphereUserDrag, type SphereTouchEvent } from "../hooks/useSphereUserDrag";
import type { AgentState, EmbodimentCommand } from "../types/agent";
import { DG2RobotModel } from "./DG2RobotModel";
import { ScreenFace, type FaceSignals } from "./ScreenFace";
import { SphereBodyHandle } from "./SphereBodyHandle";

const HEADPHONE_MODEL_URL = `${import.meta.env.BASE_URL}models/DG.obj`;

interface SphereAgentProps {
  state: AgentState;
  onEyeFocus?: (focused: boolean) => void;
  onEyeClick?: () => void;
  physics?: boolean;
  autonomous?: boolean;
  motionBounds?: number;
  hardMotionClamp?: boolean;
  /** 覆盖默认刚体/视觉中心（桌宠固定机位） */
  bodyPosition?: [number, number, number];
  /** 关闭 DG2 待机呼吸位移（桌宠保持尺寸稳定） */
  idleBodyMotion?: boolean;
  /** 桌宠视觉缩放 */
  modelScale?: number;
  onEyeInteractionChange?: (active: boolean) => void;
  /** 允许用户拖拽旋转球体 */
  userDragRotate?: boolean;
  onUserTouch?: (event: SphereTouchEvent) => void;
  onBodyHover?: (active: boolean) => void;
  registerDragBridge?: boolean;
  canvasCaptureLenient?: boolean;
  onPanDelta?: (dx: number, dy: number) => void;
  onPanEnd?: () => void;
  /** 实时拖动/旋转反应：每次达到反应阈值时回调，可用于触发身体晃动与说话 */
  onLiveReact?: (intensity: number, mode: "pan" | "rotate") => void;
  /** 旋转中累计 yaw/pitch 角度（弧度）回调 */
  onSpinDelta?: (deltaYaw: number, deltaPitch: number) => void;
  /** 拖动结束回调 */
  onDragRelease?: (info: { mode: "pan" | "rotate"; totalRotationDeg: number; panDistance: number; spinStrength: number }) => void;
  /** 触发身体晃动函数（可由外部任何时机调用） */
  onShakeRequest?: (strength: number, durationMs: number) => void;
}

function relayBoundaryToParent(edge: string) {
  if (window.parent === window) return;
  postToHost({ type: SPHERE_MSG.boundary, edge: edge as "left" | "right" | "top" | "bottom" });
}

/** DG2 深灰金属球形机器人 — OBJ 一比一还原 */
export function SphereAgent({
  state,
  onEyeFocus,
  onEyeClick,
  physics = true,
  autonomous = true,
  motionBounds = 2.4,
  hardMotionClamp = false,
  bodyPosition,
  idleBodyMotion = true,
  modelScale = 1,
  onEyeInteractionChange,
  userDragRotate = true,
  onUserTouch,
  onBodyHover,
  registerDragBridge = false,
  canvasCaptureLenient = false,
  onPanDelta,
  onPanEnd,
  onLiveReact,
  onSpinDelta,
  onDragRelease,
  onShakeRequest,
}: SphereAgentProps) {
  const visualRef = useRef<THREE.Group>(null);
  const userRotRef = useRef<THREE.Group>(null);
  const baseModelRef = useRef<THREE.Group>(null);
  const headphoneModelRef = useRef<THREE.Group>(null);
  const transitionFxRef = useRef<THREE.Group>(null);
  const leftPodRef = useRef<THREE.Group>(null);
  const rightPodRef = useRef<THREE.Group>(null);
  const headbandRef = useRef<THREE.Group>(null);
  const faceSignalsRef = useRef<FaceSignals>({
    boundaryBump: 0,
    excitement: 0,
    speed: 0,
    speakPulse: 0,
    userTouch: 0,
    userSpin: 0,
  });
  const listenTransitionRef = useRef(0);

  const [ref, api] = useSphere(() => ({
    mass: physics ? 1.2 : 0,
    type: physics ? "Dynamic" : "Static",
    position: bodyPosition ?? [0, 1.6, 0],
    args: [MODEL.bodyRadius * 0.94],
    linearDamping: physics ? 0.82 : 0.95,
    angularDamping: 0.9,
    material: { friction: 0.35, restitution: 0.22 },
  }));

  const motionStrength =
    state.mood === "thinking" ? 0.85 : 1;

  const kinematic = !physics && autonomous;

  const bodyMotion = useAgentBodyMotion({
    api: kinematic ? api : undefined,
    visualRef,
    faceSignalsRef,
    enabled: kinematic,
    bounds: motionBounds,
    mood: state.mood,
    energy: state.energy,
    focused: state.focused,
    onBoundaryHit: (edge) => relayBoundaryToParent(edge),
  });

  const physicsMotion = useAutonomousMotion({
    api,
    enabled: physics && autonomous,
    bounds: motionBounds,
    strength: motionStrength,
    hardClamp: hardMotionClamp,
  });

  const motion = kinematic ? bodyMotion : physicsMotion;
  const exciteMotion = kinematic ? bodyMotion.excite : undefined;
  const shakeMotion = kinematic ? bodyMotion.shake : undefined;
  const verticalBiasMotion = kinematic ? bodyMotion.applyVerticalBias : undefined;
  const shakeBridgeRef = useRef<((strength: number, durationMs: number) => void) | null>(null);

  /** 触发身体晃动（内部或外部均可） */
  const triggerShake = useCallback((strength: number, durationMs: number) => {
    shakeMotion?.(strength, durationMs);
    verticalBiasMotion?.(Math.sin(performance.now() * 0.013) * strength);
  }, [shakeMotion, verticalBiasMotion]);

  // 外部 onShakeRequest 也可触发身体晃动
  useEffect(() => {
    if (!onShakeRequest) return;
    shakeBridgeRef.current = triggerShake;
    return () => {
      shakeBridgeRef.current = null;
    };
  }, [onShakeRequest, triggerShake]);

  const relayTouchToParent = useCallback(
    (event: SphereTouchEvent) => {
      onUserTouch?.(event);
      if (window.parent === window) return;
      postToHost({
        type: SPHERE_MSG.touch,
        phase: event.phase,
        spinStrength: event.spinStrength,
        totalRotationDeg: event.totalRotationDeg,
      });
    },
    [onUserTouch],
  );

  const dragHandlers = useSphereUserDrag({
    userRotRef,
    bodyRef: ref as unknown as RefObject<THREE.Object3D | null>,
    faceSignalsRef,
    enabled: userDragRotate,
    canvasCapture: false,
    canvasCaptureLenient,
    registerBridge: registerDragBridge,
    api: physics ? api : undefined,
    onTouch: relayTouchToParent,
    onEyeClick,
    onPanDelta,
    onPanEnd,
    onLiveReact: (intensity, mode) => {
      onLiveReact?.(intensity, mode);
      // 实时身体晃动 + 物理冲量
      triggerShake(0.35 + intensity * 0.5, 600);
      if (kinematic) bodyMotion.excite?.(0.25 + intensity * 0.45);
    },
    onSpinDelta,
    onDragRelease: (info) => {
      onDragRelease?.(info);
      // 松手时给一个最终的身体晃动 + 物理抖动
      const endShake = Math.min(1, info.spinStrength * 1.4 + Math.min(1, info.totalRotationDeg / 360) * 0.6);
      triggerShake(0.5 + endShake * 0.5, 950);
    },
    onBodyHover: (active) => {
      onBodyHover?.(active);
      onEyeInteractionChange?.(active);
      if (active) onEyeFocus?.(true);
      else onEyeFocus?.(false);
    },
    onExcite: (strength) => {
      if (kinematic) exciteMotion?.(strength);
      else if (physics && autonomous) {
        motion.resumeMotion();
        motion.pickRandomTarget();
      }
      if (faceSignalsRef.current) {
        faceSignalsRef.current.excitement = Math.max(faceSignalsRef.current.excitement, 0.5 + strength * 0.35);
      }
      triggerShake(0.6 + strength * 0.3, 1100);
    },
  });

  useEffect(() => {
    const handleCommand = (cmd: EmbodimentCommand) => {
      switch (cmd.action) {
        case "roam":
          if (kinematic) {
            motion.resumeMotion();
            const s = typeof cmd.strength === "number" ? cmd.strength : 1;
            if (s >= 1.05) exciteMotion?.(s);
            else motion.pickRandomTarget();
          } else if (physics) {
            motion.resumeMotion();
            motion.pickRandomTarget();
          } else {
            triggerOverlayRoam();
          }
          break;
        case "excite":
          if (kinematic) {
            motion.resumeMotion();
            exciteMotion?.(cmd.strength ?? 1.4);
          } else if (physics) {
            motion.resumeMotion();
            motion.pickRandomTarget();
          } else {
            postToHost({
              type: SPHERE_MSG.command,
              action: "excite",
              strength: cmd.strength ?? 1.4,
            });
          }
          break;
        case "move":
          if (kinematic || physics) {
            motion.resumeMotion();
            if (cmd.x != null && cmd.z != null) {
              motion.setTarget(cmd.x, cmd.y ?? 1.6, cmd.z);
            }
          }
          break;
        case "stop":
          motion.stopMotion();
          break;
        case "window_roam":
          triggerOverlayRoam();
          if (window.parent !== window) {
            postToHost({ type: SPHERE_MSG.command, action: "window_roam" });
          }
          break;
        default:
          break;
      }
    };
    return bindEmbodimentCommand(handleCommand);
  }, [kinematic, physics, motion, exciteMotion]);

  useFrame((_, delta) => {
    const target = state.mood === "listening" ? 1 : 0;
    const blend = 1 - Math.exp(-delta * 5.5);
    listenTransitionRef.current += (target - listenTransitionRef.current) * blend;
    const p = THREE.MathUtils.clamp(listenTransitionRef.current, 0, 1);
    const pulse = Math.sin(performance.now() * 0.01) * 0.5 + 0.5;

    if (baseModelRef.current) {
      const scale = 1 - p * 0.08;
      baseModelRef.current.scale.setScalar(scale);
      baseModelRef.current.position.y = p * 0.012;
      baseModelRef.current.rotation.z = -p * 0.08;
    }

    if (headphoneModelRef.current) {
      const scale = 0.9 + p * 0.1;
      headphoneModelRef.current.scale.setScalar(scale);
      headphoneModelRef.current.position.y = (1 - p) * -0.025;
      headphoneModelRef.current.rotation.z = (1 - p) * 0.12;
    }

    if (transitionFxRef.current) {
      transitionFxRef.current.visible = p > 0.02 && p < 0.98;
      transitionFxRef.current.scale.setScalar(0.62 + p * 0.28 + pulse * 0.035);
      transitionFxRef.current.rotation.z += delta * (0.45 + p * 1.2);
      transitionFxRef.current.position.z = 0.015 + p * 0.02;
    }

    const podTravel = THREE.MathUtils.smoothstep(p, 0.16, 0.82);
    const podLift = Math.sin(podTravel * Math.PI) * 0.06;
    const podVisibility = p > 0.06 && p < 0.96;
    const podScale = 0.3 + podTravel * 0.9;

    if (leftPodRef.current) {
      leftPodRef.current.visible = podVisibility;
      leftPodRef.current.position.set(-0.12 - podTravel * 0.46, 0.03 + podLift, 0.02 + podTravel * 0.12);
      leftPodRef.current.rotation.set(0.15 - podTravel * 0.2, -0.3 - podTravel * 0.75, 0.2 - podTravel * 0.35);
      leftPodRef.current.scale.setScalar(podScale);
    }

    if (rightPodRef.current) {
      rightPodRef.current.visible = podVisibility;
      rightPodRef.current.position.set(0.12 + podTravel * 0.46, 0.03 + podLift, 0.02 + podTravel * 0.12);
      rightPodRef.current.rotation.set(0.15 - podTravel * 0.2, 0.3 + podTravel * 0.75, -0.2 + podTravel * 0.35);
      rightPodRef.current.scale.setScalar(podScale);
    }

    if (headbandRef.current) {
      const bandProgress = THREE.MathUtils.smoothstep(p, 0.52, 0.96);
      headbandRef.current.visible = bandProgress > 0.02 && p < 0.995;
      headbandRef.current.position.y = 0.16 + bandProgress * 0.31;
      headbandRef.current.position.z = 0.04 + bandProgress * 0.08;
      headbandRef.current.rotation.x = Math.PI / 2;
      headbandRef.current.scale.set(
        0.42 + bandProgress * 0.82,
        0.42 + bandProgress * 0.82,
        0.42 + bandProgress * 0.82,
      );
    }
  });

  return (
    <group ref={ref as Ref<THREE.Group>}>
      <group ref={visualRef}>
        <group ref={userRotRef} scale={modelScale}>
          <ScreenFace
            mood={state.mood}
            energy={state.energy}
            focused={state.focused}
            signalsRef={faceSignalsRef}
          >
            <Suspense
              fallback={
                <mesh>
                  <sphereGeometry args={[MODEL.bodyRadius * 0.7, 24, 24]} />
                  <meshStandardMaterial color="#5a6a7a" wireframe />
                </mesh>
              }
            >
              <group ref={baseModelRef}>
                <DG2RobotModel
                  energy={state.energy}
                  focused={state.focused}
                  idleMotion={idleBodyMotion}
                  standaloneLighting={modelScale !== 1}
                  opacity={1 - listenTransitionRef.current}
                />
              </group>
              <group ref={transitionFxRef}>
                <mesh rotation={[Math.PI / 2, 0, 0]}>
                  <torusGeometry args={[MODEL.bodyRadius * 0.72, MODEL.bodyRadius * 0.024, 20, 80]} />
                  <meshBasicMaterial color="#7dc4ff" transparent opacity={0.22} depthWrite={false} />
                </mesh>
                <mesh>
                  <sphereGeometry args={[MODEL.bodyRadius * 0.08, 20, 20]} />
                  <meshBasicMaterial color="#b9e7ff" transparent opacity={0.2} depthWrite={false} />
                </mesh>
              </group>
              <group ref={leftPodRef}>
                <mesh>
                  <sphereGeometry args={[MODEL.bodyRadius * 0.1, 18, 18]} />
                  <meshStandardMaterial color="#aeb6c2" metalness={0.88} roughness={0.28} emissive="#7dc4ff" emissiveIntensity={0.08} />
                </mesh>
                <mesh position={[0, 0, 0.06]}>
                  <sphereGeometry args={[MODEL.bodyRadius * 0.054, 16, 16]} />
                  <meshStandardMaterial color="#11161d" metalness={0.45} roughness={0.22} />
                </mesh>
              </group>
              <group ref={rightPodRef}>
                <mesh>
                  <sphereGeometry args={[MODEL.bodyRadius * 0.1, 18, 18]} />
                  <meshStandardMaterial color="#aeb6c2" metalness={0.88} roughness={0.28} emissive="#7dc4ff" emissiveIntensity={0.08} />
                </mesh>
                <mesh position={[0, 0, 0.06]}>
                  <sphereGeometry args={[MODEL.bodyRadius * 0.054, 16, 16]} />
                  <meshStandardMaterial color="#11161d" metalness={0.45} roughness={0.22} />
                </mesh>
              </group>
              <group ref={headbandRef}>
                <mesh>
                  <torusGeometry args={[MODEL.bodyRadius * 0.55, MODEL.bodyRadius * 0.038, 18, 48, Math.PI]} />
                  <meshStandardMaterial color="#98a3b3" metalness={0.92} roughness={0.26} emissive="#9fd5ff" emissiveIntensity={0.06} />
                </mesh>
              </group>
              <group ref={headphoneModelRef}>
                <DG2RobotModel
                  modelUrl={HEADPHONE_MODEL_URL}
                  energy={state.energy}
                  focused={state.focused}
                  idleMotion={idleBodyMotion}
                  standaloneLighting={modelScale !== 1}
                  opacity={listenTransitionRef.current}
                />
              </group>
            </Suspense>
            {userDragRotate ? (
              <SphereBodyHandle
                radius={dragHandlers.bodyRadius}
                onPointerDown={dragHandlers.handlePointerDown}
                onPointerMove={dragHandlers.handlePointerMove}
                onPointerUp={dragHandlers.handlePointerUp}
                onBodyHover={dragHandlers.handleBodyHover}
              />
            ) : null}
          </ScreenFace>
        </group>
      </group>
    </group>
  );
}
