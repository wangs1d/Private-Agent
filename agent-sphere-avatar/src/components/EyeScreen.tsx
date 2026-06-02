import type { ThreeEvent } from "@react-three/fiber";
import { useMemo, useRef } from "react";
import { MODEL } from "../constants/model-proportions";
import { createScreenCapGeometry } from "../utils/screen-cap-geometry";

interface EyeScreenProps {
  onPointerOver?: () => void;
  onPointerOut?: () => void;
  onClick?: () => void;
  onInteractionChange?: (active: boolean) => void;
  onDragPointerDown?: (e: ThreeEvent<PointerEvent>) => void;
  onDragPointerMove?: (e: ThreeEvent<PointerEvent>) => void;
  onDragPointerUp?: (e: ThreeEvent<PointerEvent>) => void;
}

/** DG2 玻璃面透明交互热区 — 与曲屏同形，短按开菜单，拖动转球 */
export function EyeScreen({
  onPointerOver,
  onPointerOut,
  onClick,
  onInteractionChange,
  onDragPointerDown,
  onDragPointerMove,
  onDragPointerUp,
}: EyeScreenProps) {
  const hitGeometry = useMemo(
    () =>
      createScreenCapGeometry({
        radius: MODEL.bodyRadius,
        halfAngle: MODEL.screenHitHalfAngle,
      }),
    [],
  );
  const movedRef = useRef(false);

  return (
    <mesh
      geometry={hitGeometry}
      renderOrder={3}
      onPointerOver={() => {
        onInteractionChange?.(true);
        onPointerOver?.();
      }}
      onPointerOut={() => {
        onInteractionChange?.(false);
        onPointerOut?.();
      }}
      onPointerDown={(e) => {
        movedRef.current = false;
        e.stopPropagation();
        onDragPointerDown?.(e);
      }}
      onPointerMove={(e) => {
        if (!e.buttons) return;
        movedRef.current = true;
        e.stopPropagation();
        onDragPointerMove?.(e);
      }}
      onPointerUp={(e) => {
        e.stopPropagation();
        onDragPointerUp?.(e);
        if (!movedRef.current) onClick?.();
      }}
    >
      <meshBasicMaterial transparent opacity={0} depthWrite={false} />
    </mesh>
  );
}
