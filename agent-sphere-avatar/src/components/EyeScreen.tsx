import { useFrame } from "@react-three/fiber";
import { useMemo, useRef } from "react";
import * as THREE from "three";
import { MODEL } from "../constants/model-proportions";
import type { AgentMood } from "../types/agent";

interface EyeScreenProps {
  mood: AgentMood;
  focused: boolean;
  radius?: number;
  onPointerOver?: () => void;
  onPointerOut?: () => void;
  onClick?: () => void;
  onInteractionChange?: (active: boolean) => void;
}

/** 前部大黑玻璃穹顶 — 深凹曲面强反射 + 内部眼睛光标 */
export function EyeScreen({
  mood,
  focused,
  radius = MODEL.domeRadius,
  onPointerOver,
  onPointerOut,
  onClick,
  onInteractionChange,
}: EyeScreenProps) {
  const groupRef = useRef<THREE.Group>(null);
  const cursorRef = useRef<THREE.Mesh>(null);

  const glassMaterial = useMemo(
    () =>
      new THREE.MeshPhysicalMaterial({
        color: new THREE.Color("#050608"),
        metalness: 0.9,
        roughness: 0.02,
        clearcoat: 1,
        clearcoatRoughness: 0.01,
        reflectivity: 1,
        envMapIntensity: 2.0,
        transparent: true,
        opacity: 0.94,
        side: THREE.FrontSide,
      }),
    [],
  );

  const bezelMaterial = useMemo(
    () =>
      new THREE.MeshStandardMaterial({
        color: "#3a3c42",
        metalness: 0.82,
        roughness: 0.22,
        emissive: focused ? "#4a6a9a" : "#2a3040",
        emissiveIntensity: focused ? 0.5 : 0.12,
      }),
    [focused],
  );

  useFrame(({ clock }) => {
    const t = clock.elapsedTime;
    if (groupRef.current) {
      const breathe = Math.sin(t * 0.9) * 0.002;
      groupRef.current.position.z = MODEL.domeZ + breathe;
    }
    if (cursorRef.current) {
      const floatY = Math.sin(t * 1.8) * 0.003;
      cursorRef.current.position.y = floatY;
      const scalePulse = 1 + Math.sin(t * 2.4) * 0.04;
      cursorRef.current.scale.setScalar(scalePulse);
    }
  });

  return (
    <group ref={groupRef} position={[0, 0, MODEL.domeZ]}>
      <mesh
        onPointerOver={() => {
          onInteractionChange?.(true);
          onPointerOver?.();
        }}
        onPointerOut={() => {
          onInteractionChange?.(false);
          onPointerOut?.();
        }}
        onClick={onClick}
        castShadow
      >
        <sphereGeometry
          args={[radius, 72, 72, 0, Math.PI * 2, 0, Math.PI * MODEL.domePhiLength]}
        />
        <primitive object={glassMaterial} attach="material" />
      </mesh>

      {/* 穹顶边框环 */}
      <mesh position={[0, 0, 0.008]}>
        <torusGeometry args={[radius * 0.97, 0.016, 16, 72]} />
        <primitive object={bezelMaterial} attach="material" />
      </mesh>

      {/* 内部眼睛光标 — 白色圆环 + 微弱发光 */}
      <group position={[0, -radius * 0.15, -radius * 0.25]} ref={cursorRef}>
        {/* 外圈 */}
        <mesh>
          <torusGeometry args={[0.055, 0.006, 12, 32]} />
          <meshStandardMaterial
            color="#c0d8f0"
            emissive="#80b0e0"
            emissiveIntensity={focused ? 0.9 : 0.35}
            toneMapped={false}
          />
        </mesh>
        {/* 内核点 */}
        <mesh>
          <sphereGeometry args={[0.018, 16, 16]} />
          <meshBasicMaterial
            color="#ffffff"
            toneMapped={false}
          />
        </mesh>
        {/* 下方小三角指针 */}
        <mesh position={[0, -0.042, 0.005]} rotation={[0, 0, 0]}>
          <coneGeometry args={[0.012, 0.028, 3]} />
          <meshStandardMaterial
            color="#a0c8f0"
            emissive="#6090d0"
            emissiveIntensity={focused ? 0.7 : 0.25}
            toneMapped={false}
          />
        </mesh>
      </group>
    </group>
  );
}
