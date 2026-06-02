import { createContext, useContext } from "react";
import type * as THREE from "three";

/** ScreenFace 绘制的 Canvas 纹理，供 DG2 玻璃曲面贴图（OLED） */
export const OledFaceTextureContext = createContext<THREE.CanvasTexture | null>(null);

export function useOledFaceTexture(): THREE.CanvasTexture | null {
  return useContext(OledFaceTextureContext);
}
