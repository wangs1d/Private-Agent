import { useMemo } from "react";
import type * as THREE from "three";
import { MODEL } from "../constants/model-proportions";
import { createScreenCapGeometry } from "../utils/screen-cap-geometry";

interface OledScreenMeshProps {
  map: THREE.CanvasTexture;
}

/** OLED 显示层：直接贴在黑色曲屏同形球冠上，避免平面圆盘导致五官错位。 */
export function OledScreenMesh({ map }: OledScreenMeshProps) {
  const geometry = useMemo(
    () =>
      createScreenCapGeometry({
        radius: MODEL.screenCapRadius,
        halfAngle: MODEL.screenFaceHalfAngle,
        widthSegments: 96,
        heightSegments: 72,
        uvInset: 0.06,
        uvEdgeCurve: 1.16,
      }),
    [],
  );

  return (
    <mesh geometry={geometry} renderOrder={100} raycast={() => null}>
      <meshBasicMaterial
        map={map}
        transparent={false}
        depthWrite={false}
        depthTest={true}
        toneMapped={false}
      />
    </mesh>
  );
}
