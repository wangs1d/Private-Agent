import { useFrame } from "@react-three/fiber";
import { useMemo, useRef } from "react";
import * as THREE from "three";
import { MODEL } from "../constants/model-proportions";

interface BreathingShellProps {
  radius?: number;
  energy?: number;
}

/** 外壳白色呼吸灯 — 内嵌感 seam 发光（哑光 PLA 质感） */
export function BreathingShell({ radius = MODEL.bodyRadius, energy = 0.55 }: BreathingShellProps) {
  const shellRef = useRef<THREE.Group>(null);
  const ringsRef = useRef<THREE.Mesh[]>([]);

  const shellMaterial = useMemo(
    () =>
      new THREE.MeshPhysicalMaterial({
        color: new THREE.Color(MODEL.shellColor),
        metalness: MODEL.shellMetalness,
        roughness: MODEL.shellRoughness,
        clearcoat: MODEL.shellClearcoat,
        clearcoatRoughness: 0.28,
        emissive: new THREE.Color("#ffffff"),
        emissiveIntensity: 0.018,
      }),
    [],
  );

  const seamMaterial = useMemo(
    () =>
      new THREE.MeshStandardMaterial({
        color: "#fafcff",
        emissive: MODEL.seamEmissive,
        emissiveIntensity: 0.12,
        transparent: true,
        opacity: 0.42,
        side: THREE.DoubleSide,
        depthWrite: false,
      }),
    [],
  );

  const ringConfigs = useMemo(
    () => [
      { rot: [0, 0, 0] as const, scale: 1.001 },
      { rot: [Math.PI / 2, 0, 0] as const, scale: 0.999 },
      { rot: [0, Math.PI / 2, 0.08] as const, scale: 1.0005 },
    ],
    [],
  );

  useFrame(({ clock }) => {
    const t = clock.elapsedTime;
    const pulse = 0.1 + ((Math.sin(t * 1.15) + 1) * 0.5) * (0.3 + energy * 0.42);

    shellMaterial.emissiveIntensity = 0.012 + pulse * 0.06;

    ringsRef.current.forEach((ring, i) => {
      if (!ring) return;
      const mat = ring.material as THREE.MeshStandardMaterial;
      mat.emissiveIntensity = pulse * (0.28 + i * 0.1);
      mat.opacity = 0.18 + pulse * 0.38;
      ring.rotation.z = Math.sin(t * 0.4 + i) * 0.015;
    });

    if (shellRef.current) {
      shellRef.current.rotation.y = Math.sin(t * 0.12) * 0.035;
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
          <torusGeometry args={[radius * 0.945, 0.005, 8, 128]} />
          <primitive object={seamMaterial.clone()} attach="material" />
        </mesh>
      ))}

      <mesh rotation={[Math.PI / 2, 0, 0]}>
        <torusGeometry args={[radius * 0.992, 0.0025, 6, 128]} />
        <meshStandardMaterial
          color="#ffffff"
          emissive="#e8f2ff"
          emissiveIntensity={0.16}
          transparent
          opacity={0.28}
          depthWrite={false}
        />
      </mesh>
    </group>
  );
}
