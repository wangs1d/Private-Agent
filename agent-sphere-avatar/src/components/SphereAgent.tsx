import { useSphere } from "@react-three/cannon";
import { useRef, type Ref } from "react";
import * as THREE from "three";
import { MODEL } from "../constants/model-proportions";
import { useAutonomousMotion } from "../hooks/useAutonomousMotion";
import { useVisualFloat } from "../hooks/useVisualFloat";
import type { AgentState } from "../types/agent";
import { BreathingShell } from "./BreathingShell";
import { EyeScreen } from "./EyeScreen";
import { SideEars } from "./SideEars";

interface SphereAgentProps {
  state: AgentState;
  onEyeFocus?: (focused: boolean) => void;
  onEyeClick?: () => void;
  physics?: boolean;
  autonomous?: boolean;
  onEyeInteractionChange?: (active: boolean) => void;
}

/** 球形主 Agent 形象 — 组合外壳、曲屏眼、侧耳与 Cannon 物理体 */
export function SphereAgent({
  state,
  onEyeFocus,
  onEyeClick,
  physics = true,
  autonomous = true,
  onEyeInteractionChange,
}: SphereAgentProps) {
  const visualRef = useRef<THREE.Group>(null);

  const [ref, api] = useSphere(() => ({
    mass: physics ? 1.2 : 0,
    type: physics ? "Dynamic" : "Static",
    position: [0, 1.6, 0],
    args: [MODEL.bodyRadius * 0.94],
    linearDamping: 0.82,
    angularDamping: 0.9,
    material: { friction: 0.35, restitution: 0.22 },
  }));

  useAutonomousMotion({
    api,
    enabled: physics && autonomous,
    bounds: 2.4,
    strength: state.mood === "speaking" ? 1.35 : state.mood === "thinking" ? 0.85 : 1,
  });

  useVisualFloat(visualRef, !physics && autonomous);

  return (
    <group ref={ref as Ref<THREE.Group>}>
      <group ref={visualRef}>
        <BreathingShell radius={MODEL.bodyRadius} energy={state.energy} />
        <SideEars radius={MODEL.bodyRadius} />
        <EyeScreen
          mood={state.mood}
          focused={state.focused}
          onPointerOver={() => onEyeFocus?.(true)}
          onPointerOut={() => onEyeFocus?.(false)}
          onClick={() => onEyeClick?.()}
          onInteractionChange={onEyeInteractionChange}
        />

        <mesh position={[0, 0, MODEL.eyeZ - 0.06]}>
          <torusGeometry args={[MODEL.bodyRadius * 0.56, 0.022, 12, 72]} />
          <meshStandardMaterial
            color="#eceff4"
            metalness={0.08}
            roughness={0.32}
            emissive="#ffffff"
            emissiveIntensity={0.03}
          />
        </mesh>
      </group>
    </group>
  );
}
