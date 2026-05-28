import { useFrame } from "@react-three/fiber";
import type { RefObject } from "react";
import * as THREE from "three";

/** 无物理时让球体在视区内轻微悬浮（嵌入/悬浮窗） */
export function useVisualFloat(
  ref: RefObject<THREE.Group | null>,
  enabled = true,
) {
  useFrame(({ clock }) => {
    if (!enabled || !ref.current) return;
    const t = clock.elapsedTime;
    ref.current.position.y = Math.sin(t * 1.15) * 0.07;
    ref.current.position.x = Math.sin(t * 0.55) * 0.04;
    ref.current.rotation.y = Math.sin(t * 0.35) * 0.1;
  });
}
