import { useSphere } from "@react-three/cannon";
import { Suspense, useEffect, useRef, type Ref } from "react";
import * as THREE from "three";
import { bindEmbodimentCommand } from "../bridge/agent-bridge";
import { MODEL } from "../constants/model-proportions";
import { useAutonomousMotion } from "../hooks/useAutonomousMotion";
import { useVisualFloat } from "../hooks/useVisualFloat";
import type { AgentState, EmbodimentCommand } from "../types/agent";
import { DG2RobotModel } from "./DG2RobotModel";
import { EyeScreen } from "./EyeScreen";

interface SphereAgentProps {
  state: AgentState;
  onEyeFocus?: (focused: boolean) => void;
  onEyeClick?: () => void;
  physics?: boolean;
  autonomous?: boolean;
  motionBounds?: number;
  hardMotionClamp?: boolean;
  onEyeInteractionChange?: (active: boolean) => void;
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

  const motionStrength =
    state.mood === "speaking" ? 1.35 : state.mood === "thinking" ? 0.85 : 1;

  const { pickRandomTarget, setTarget, stopMotion, resumeMotion } = useAutonomousMotion({
    api,
    enabled: physics && autonomous,
    bounds: motionBounds,
    strength: motionStrength,
    hardClamp: hardMotionClamp,
  });

  useVisualFloat(visualRef, !physics && autonomous);

  useEffect(() => {
    const handleCommand = (cmd: EmbodimentCommand) => {
      switch (cmd.action) {
        case "roam":
          if (physics) {
            resumeMotion();
            if (typeof cmd.strength === "number") {
              /* strength applied on next frame via parent mood; pick new target */
            }
            pickRandomTarget();
          } else if (window.sphereOverlay?.roamNow) {
            void window.sphereOverlay.roamNow();
          }
          break;
        case "move":
          if (physics && cmd.x != null && cmd.z != null) {
            resumeMotion();
            setTarget(cmd.x, cmd.y ?? 1.6, cmd.z);
          }
          break;
        case "stop":
          if (physics) stopMotion();
          break;
        case "window_roam":
          window.sphereOverlay?.roamNow?.();
          break;
        default:
          break;
      }
    };
    return bindEmbodimentCommand(handleCommand);
  }, [physics, pickRandomTarget, setTarget, stopMotion, resumeMotion]);

  return (
    <group ref={ref as Ref<THREE.Group>}>
      <group ref={visualRef}>
        <Suspense fallback={null}>
          <DG2RobotModel energy={state.energy} focused={state.focused} />
        </Suspense>
        <EyeScreen
          onPointerOver={() => onEyeFocus?.(true)}
          onPointerOut={() => onEyeFocus?.(false)}
          onClick={() => onEyeClick?.()}
          onInteractionChange={onEyeInteractionChange}
        />
      </group>
    </group>
  );
}
