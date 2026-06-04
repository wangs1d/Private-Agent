import { useLayoutEffect } from "react";
import { useThree } from "@react-three/fiber";
import { OVERLAY_SCENE } from "../constants/model-proportions";

/** 桌宠固定机位 — 始终看向模型中心，避免裁切与远近缩放 */
export function OverlayCameraRig() {
  const camera = useThree((s) => s.camera);

  useLayoutEffect(() => {
    const [px, py, pz] = OVERLAY_SCENE.cameraPosition;
    const [tx, ty, tz] = OVERLAY_SCENE.lookAt;
    camera.position.set(px, py, pz);
    camera.lookAt(tx, ty, tz);
    if ("fov" in camera) {
      camera.fov = OVERLAY_SCENE.cameraFov;
      camera.updateProjectionMatrix();
    }
  }, [camera]);

  return null;
}
