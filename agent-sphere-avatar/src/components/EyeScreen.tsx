import { useFrame } from "@react-three/fiber";
import { useMemo, useRef } from "react";
import * as THREE from "three";
import { MODEL } from "../constants/model-proportions";
import type { AgentMood } from "../types/agent";
import { useEyeTexture } from "../hooks/useEyeTexture";

interface EyeScreenProps {
  mood: AgentMood;
  focused: boolean;
  radius?: number;
  onPointerOver?: () => void;
  onPointerOut?: () => void;
  onClick?: () => void;
  onInteractionChange?: (active: boolean) => void;
}

/** 前部大曲屏黑色玻璃态眼睛 — 主交互面 */
export function EyeScreen({
  mood,
  focused,
  radius = MODEL.eyeRadius,
  onPointerOver,
  onPointerOut,
  onClick,
  onInteractionChange,
}: EyeScreenProps) {
  const groupRef = useRef<THREE.Group>(null);
  const { texture, update } = useEyeTexture(mood, focused);

  const glassMaterial = useMemo(
    () =>
      new THREE.MeshPhysicalMaterial({
        color: new THREE.Color("#030306"),
        metalness: 0.02,
        roughness: 0.025,
        clearcoat: 1,
        clearcoatRoughness: 0.015,
        reflectivity: 1,
        envMapIntensity: 1.6,
        transparent: true,
        opacity: 0.96,
        side: THREE.FrontSide,
      }),
    [],
  );

  const displayMaterial = useMemo(
    () =>
      new THREE.MeshBasicMaterial({
        map: texture,
        transparent: true,
        toneMapped: false,
      }),
    [texture],
  );

  useFrame(({ clock }) => {
    update(clock.elapsedTime);
    if (groupRef.current) {
      const breathe = Math.sin(clock.elapsedTime * 1.1) * 0.003;
      groupRef.current.position.z = MODEL.eyeZ + breathe;
    }
  });

  return (
    <group ref={groupRef} position={[0, 0, MODEL.eyeZ]}>
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
          args={[radius, 72, 72, 0, Math.PI * 2, 0, Math.PI * MODEL.eyePhiLength]}
        />
        <primitive object={glassMaterial} attach="material" />
      </mesh>

      <mesh position={[0, 0, -0.018]} scale={0.94}>
        <sphereGeometry
          args={[radius * 0.97, 56, 56, 0, Math.PI * 2, 0, Math.PI * MODEL.eyeDisplayPhiLength]}
        />
        <primitive object={displayMaterial} attach="material" />
      </mesh>

      <mesh position={[0, 0, 0.012]}>
        <torusGeometry args={[radius * MODEL.eyeBezelRadius, 0.014, 16, 72]} />
        <meshStandardMaterial
          color="#f5f7fb"
          emissive="#c8dcff"
          emissiveIntensity={focused ? 0.65 : 0.18}
          metalness={0.85}
          roughness={0.12}
          transparent
          opacity={0.5}
        />
      </mesh>
    </group>
  );
}
