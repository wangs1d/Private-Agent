import { useFrame } from "@react-three/fiber";
import { useMemo, useRef } from "react";
import * as THREE from "three";
import { MODEL } from "../constants/model-proportions";

interface BreathingShellProps {
  radius?: number;
  energy?: number;
}

/** 深灰拉丝金属壳 — 微弱呼吸发光缝线 */
export function BreathingShell({ radius = MODEL.bodyRadius, energy = 0.55 }: BreathingShellProps) {
  const shellRef = useRef<THREE.Group>(null);
  const ringsRef = useRef<THREE.Mesh[]>([]);

  const shellMaterial = useMemo(
    () =>
      new THREE.MeshStandardMaterial({
        color: new THREE.Color(MODEL.shellColor),
        metalness: MODEL.shellMetalness,
        roughness: MODEL.shellRoughness,
      }),
    [],
  );

  const seamMaterial = useMemo(
    () =>
      new THREE.MeshStandardMaterial({
        color: "#8898ac",
        emissive: MODEL.seamEmissive,
        emissiveIntensity: 0.15,
        transparent: true,
        opacity: 0.35,
        side: THREE.DoubleSide,
        depthWrite: false,
      }),
    [],
  );

  const ringConfigs = useMemo(
    () => [
      { rot: [0, 0, 0] as const, scale: 1.001 },
      { rot: [Math.PI / 2, 0, 0] as const, scale: 0.999 },
    ],
    [],
  );

  useFrame(({ clock }) => {
    const t = clock.elapsedTime;
    const pulse = 0.08 + ((Math.sin(t * 1.15) + 1) * 0.5) * (0.2 + energy * 0.3);

    ringsRef.current.forEach((ring) => {
      if (!ring) return;
      const mat = ring.material as THREE.MeshStandardMaterial;
      mat.emissiveIntensity = pulse * 0.22;
      mat.opacity = 0.12 + pulse * 0.28;
    });

    if (shellRef.current) {
      shellRef.current.rotation.y = Math.sin(t * 0.1) * 0.02;
    }
  });

  return (
    <group ref={shellRef}>
      <mesh castShadow receiveShadow>
        <sphereGeometry args={[radius, 96, 96]} />
        <primitive object={shellMaterial} attach="material" />
      </mesh>

      {ringConfigs.map((cfg, i) => (
        <mesh
          key={i}
          ref={(el) => {
            if (el) ringsRef.current[i] = el;
          }}
          rotation={[cfg.rot[0], cfg.rot[1], cfg.rot[2]]}
          scale={cfg.scale}
        >
          <torusGeometry args={[radius * 0.945, 0.004, 8, 128]} />
          <primitive object={seamMaterial.clone()} attach="material" />
        </mesh>
      ))}
    </group>
  );
}
