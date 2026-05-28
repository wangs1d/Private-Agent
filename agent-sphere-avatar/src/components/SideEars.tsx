import { useMemo } from "react";
import * as THREE from "three";
import { MODEL } from "../constants/model-proportions";

interface SideEarsProps {
  radius?: number;
}

/** 两侧短圆柱耳 — 参照实体原型比例 */
export function SideEars({ radius = MODEL.bodyRadius }: SideEarsProps) {
  const material = useMemo(
    () =>
      new THREE.MeshPhysicalMaterial({
        color: new THREE.Color(MODEL.shellColor),
        metalness: MODEL.shellMetalness,
        roughness: MODEL.shellRoughness + 0.04,
        clearcoat: MODEL.shellClearcoat * 0.8,
      }),
    [],
  );

  const x = radius * MODEL.earX;
  const earRadius = radius * MODEL.earRadius;
  const earLength = radius * MODEL.earLength;

  return (
    <group>
      <mesh position={[x, 0, 0]} rotation={[0, 0, Math.PI / 2]} castShadow material={material}>
        <cylinderGeometry args={[earRadius, earRadius * 0.88, earLength, 20]} />
      </mesh>
      <mesh position={[-x, 0, 0]} rotation={[0, 0, Math.PI / 2]} castShadow material={material}>
        <cylinderGeometry args={[earRadius, earRadius * 0.88, earLength, 20]} />
      </mesh>
      <mesh position={[x * 0.985, 0, 0]} material={material}>
        <sphereGeometry args={[earRadius * 0.75, 14, 14]} />
      </mesh>
      <mesh position={[-x * 0.985, 0, 0]} material={material}>
        <sphereGeometry args={[earRadius * 0.75, 14, 14]} />
      </mesh>
    </group>
  );
}
