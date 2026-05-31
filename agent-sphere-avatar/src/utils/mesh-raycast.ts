import * as THREE from "three";

/** 让 mesh 不参与 R3F 射线检测，交互交给专用热区 */
export function disableMeshRaycast(root: THREE.Object3D): void {
  root.traverse((node) => {
    if (node instanceof THREE.Mesh) {
      node.raycast = () => {};
    }
  });
}
