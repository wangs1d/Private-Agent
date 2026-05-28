import { useMemo } from "react";
import * as THREE from "three";
import { MODEL } from "../constants/model-proportions";

interface RobotEarsProps {
  radius?: number;
}

/** 单个耳朵组件 */
function EarMesh({
  position,
  rotation,
  earRadius,
  earLength,
  material,
}: {
  position: [number, number, number];
  rotation: [number, number, number];
  earRadius: number;
  earLength: number;
  material: THREE.MeshStandardMaterial;
}) {
  return (
    <group>
      <mesh position={position} rotation={rotation} castShadow material={material}>
        <cylinderGeometry args={[earRadius, earRadius * 0.85, earLength, 20]} />
      </mesh>
      <mesh
        position={[
          position[0] * 0.98 + (rotation[2] > 0 ? 0.01 : -0.01),
          position[1] * 0.98,
          position[2] * 0.98,
        ]}
        material={material}
      >
        <sphereGeometry args={[earRadius * 0.72, 14, 14]} />
      </mesh>
    </group>
  );
}

/** 4耳结构 — 两侧大圆柱耳 + 顶部前后小耳 — 深灰金属质感 */
export function SideEars({ radius = MODEL.bodyRadius }: RobotEarsProps) {
  const material = useMemo(
    () =>
      new THREE.MeshStandardMaterial({
        color: new THREE.Color(MODEL.shellColor),
        metalness: MODEL.shellMetalness + 0.05,
        roughness: MODEL.shellRoughness - 0.04,
      }),
    [],
  );

  const sx = radius * MODEL.sideEarX;
  const sr = radius * MODEL.sideEarRadius;
  const sl = radius * MODEL.sideEarLength;

  const ty = radius * MODEL.topEarY;
  const tfr = radius * MODEL.topEarFrontX;
  const tbr = radius * MODEL.topEarBackX;
  const tr = radius * MODEL.topEarRadius;
  const tl = radius * MODEL.topEarLength;

  return (
    <group>
      {/* 左侧大耳 */}
      <EarMesh
        position={[-sx, 0, 0]}
        rotation={[0, 0, Math.PI / 2]}
        earRadius={sr}
        earLength={sl}
        material={material}
      />
      {/* 右侧大耳 */}
      <EarMesh
        position={[sx, 0, 0]}
        rotation={[0, 0, Math.PI / 2]}
        earRadius={sr}
        earLength={sl}
        material={material}
      />
      {/* 顶部前小耳 */}
      <EarMesh
        position={[tfr, ty * 0.82, tfr * 0.3]}
        rotation={[Math.PI * 0.15, 0, Math.PI * 0.1]}
        earRadius={tr}
        earLength={tl}
        material={material}
      />
      {/* 顶部后小耳 */}
      <EarMesh
        position={[tbr, ty * 0.82, tbr * 0.3]}
        rotation={[-Math.PI * 0.15, 0, -Math.PI * 0.1]}
        earRadius={tr}
        earLength={tl}
        material={material}
      />
    </group>
  );
}
