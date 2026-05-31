import * as THREE from "three";

/** 射线是否与球体相交（世界坐标） */
export function rayHitsSphere(ray: THREE.Ray, center: THREE.Vector3, radius: number): boolean {
  const oc = ray.origin.clone().sub(center);
  const b = oc.dot(ray.direction);
  const c = oc.dot(oc) - radius * radius;
  if (c > 0 && b > 0) return false;
  return b * b - c >= 0;
}

export function pointerHitsSphere(
  clientX: number,
  clientY: number,
  dom: HTMLElement,
  camera: THREE.Camera,
  raycaster: THREE.Raycaster,
  center: THREE.Vector3,
  radius: number,
): boolean {
  const rect = dom.getBoundingClientRect();
  if (rect.width < 2 || rect.height < 2) return false;

  const ndc = new THREE.Vector2(
    ((clientX - rect.left) / rect.width) * 2 - 1,
    -((clientY - rect.top) / rect.height) * 2 + 1,
  );
  raycaster.setFromCamera(ndc, camera);
  return rayHitsSphere(raycaster.ray, center, radius);
}
