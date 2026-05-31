import { ContactShadows, Environment, OrbitControls, PerspectiveCamera } from "@react-three/drei";
import { Canvas } from "@react-three/fiber";
import { Physics } from "@react-three/cannon";
import { Suspense } from "react";
import type { SceneMode } from "../constants/model-proportions";
import type { AgentState } from "../types/agent";
import type { SphereTouchEvent } from "../hooks/useSphereUserDrag";
import { SphereAgent } from "./SphereAgent";

interface SphereAgentSceneProps {
  state: AgentState;
  onEyeFocus?: (focused: boolean) => void;
  onEyeClick?: () => void;
  physics?: boolean;
  autonomous?: boolean;
  mode?: SceneMode;
  onEyeInteractionChange?: (active: boolean) => void;
  userDragRotate?: boolean;
  onUserTouch?: (event: SphereTouchEvent) => void;
}

function Ground({ visible, invisibleCollision }: { visible: boolean; invisibleCollision?: boolean }) {
  if (!visible && !invisibleCollision) return null;
  return (
    <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0, 0]} receiveShadow>
      <planeGeometry args={[invisibleCollision ? 2.6 : 20, invisibleCollision ? 2.6 : 20]} />
      <meshStandardMaterial
        color="#0a0c12"
        metalness={0.2}
        roughness={0.85}
        transparent={!!invisibleCollision}
        opacity={invisibleCollision ? 0 : 1}
      />
    </mesh>
  );
}

/** 完整 3D 场景 — R3F Canvas + Cannon Physics + 灯光环境 */
export function SphereAgentScene({
  state,
  onEyeFocus,
  onEyeClick,
  physics = true,
  autonomous = true,
  mode = "demo",
  onEyeInteractionChange,
  userDragRotate = true,
  onUserTouch,
}: SphereAgentSceneProps) {
  const isOverlay = mode === "overlay";
  const isEmbed = mode === "embed";
  const transparentBg = isOverlay || isEmbed;
  const isDemo = mode === "demo";
  const scenePhysics = physics && isDemo;

  return (
    <Canvas
      shadows={isDemo}
      dpr={[1, 2]}
      gl={{ antialias: true, alpha: transparentBg }}
      style={{ background: transparentBg ? "transparent" : undefined }}
      onCreated={({ gl }) => {
        if (transparentBg) gl.setClearColor(0x000000, 0);
      }}
    >
      {!transparentBg && <color attach="background" args={["#07090f"]} />}
      {isDemo && <fog attach="fog" args={["#07090f", 6, 18]} />}

      <PerspectiveCamera
        makeDefault
        position={isOverlay ? [0, 1.2, 3.6] : isEmbed ? [0, 1.4, 3.2] : [0, 1.75, 4.1]}
        fov={isOverlay ? 38 : isEmbed ? 48 : 42}
      />

      {!isOverlay && (
        <OrbitControls
          enablePan={false}
          minDistance={2.2}
          maxDistance={7}
          minPolarAngle={Math.PI * 0.22}
          maxPolarAngle={Math.PI * 0.62}
          target={[0, 1.45, 0]}
          enableRotate
          enableZoom={isDemo}
        />
      )}

      <ambientLight intensity={isOverlay ? 0.55 : 0.35} />
      <directionalLight
        castShadow={!isOverlay}
        intensity={1.05}
        position={[3, 6, 4]}
        shadow-mapSize={[2048, 2048]}
      />
      <pointLight position={[-3, 2, 2]} intensity={0.42} color="#88bbff" />
      <spotLight position={[0, 4, 3]} angle={0.35} penumbra={0.8} intensity={0.55} color="#ffffff" />

      {isDemo && (
        <Suspense fallback={null}>
          <Environment preset="city" />
        </Suspense>
      )}

      <Physics
        gravity={isOverlay ? [0, 0, 0] : isEmbed ? [0, -5.5, 0] : [0, -9.82, 0]}
        allowSleep={!autonomous}
      >
        <Ground visible={isDemo} invisibleCollision={isEmbed} />
        <SphereAgent
          state={state}
          onEyeFocus={onEyeFocus}
          onEyeClick={onEyeClick}
          physics={scenePhysics}
          autonomous={autonomous}
          motionBounds={isEmbed ? 1.15 : 2.4}
          hardMotionClamp={isEmbed}
          onEyeInteractionChange={onEyeInteractionChange}
          userDragRotate={userDragRotate}
          onUserTouch={onUserTouch}
        />
      </Physics>

      {isDemo && (
        <ContactShadows position={[0, 0.01, 0]} opacity={0.45} scale={8} blur={2.5} far={4} />
      )}
    </Canvas>
  );
}
