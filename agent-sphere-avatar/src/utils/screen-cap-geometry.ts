import * as THREE from "three";
import { MODEL } from "../constants/model-proportions";

interface ScreenCapOptions {
  radius?: number;
  halfAngle?: number;
  widthSegments?: number;
  heightSegments?: number;
  uvInset?: number;
  uvEdgeCurve?: number;
}

/** 与 DG2 黑色曲屏同心的球冠 — 用于内嵌表情与交互热区 */
export function createScreenCapGeometry({
  radius = MODEL.screenCapRadius,
  halfAngle = MODEL.screenFaceHalfAngle,
  widthSegments = 64,
  heightSegments = 48,
  uvInset = 0,
  uvEdgeCurve = 1,
}: ScreenCapOptions = {}): THREE.BufferGeometry {
  const geo = new THREE.SphereGeometry(
    radius,
    widthSegments,
    heightSegments,
    0,
    Math.PI * 2,
    0,
    halfAngle,
  );
  // Three.js 球体默认极轴为 +Y，旋转后对齐模型曲屏朝向 +Z
  geo.rotateX(-Math.PI / 2);

  const pos = geo.attributes.position as THREE.BufferAttribute;
  const uv = geo.attributes.uv as THREE.BufferAttribute;
  const uvScale = 0.5 / Math.tan(halfAngle);
  const uvMin = THREE.MathUtils.clamp(uvInset, 0, 0.24);
  const uvMax = 1 - uvMin;
  const edgeCurve = Math.max(0.5, uvEdgeCurve);

  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    const len = Math.hypot(x, y, z) || 1;
    const nx = x / len;
    const ny = y / len;
    const nz = z / len;
    if (nz <= 0.02) continue;

    const rawU = THREE.MathUtils.clamp(0.5 + (nx / nz) * uvScale * 0.5, 0, 1);
    const rawV = THREE.MathUtils.clamp(0.5 + (ny / nz) * uvScale * 0.5, 0, 1);
    const signedU = (rawU - 0.5) * 2;
    const signedV = (rawV - 0.5) * 2;
    const curvedU = Math.sign(signedU) * Math.pow(Math.abs(signedU), edgeCurve);
    const curvedV = Math.sign(signedV) * Math.pow(Math.abs(signedV), edgeCurve);
    const u = THREE.MathUtils.clamp(0.5 + curvedU * 0.5, uvMin, uvMax);
    const v = THREE.MathUtils.clamp(0.5 + curvedV * 0.5, uvMin, uvMax);
    uv.setXY(i, u, v);
  }
  uv.needsUpdate = true;
  return geo;
}
