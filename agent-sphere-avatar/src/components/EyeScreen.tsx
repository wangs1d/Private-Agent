import type { ThreeEvent } from "@react-three/fiber";
import { useRef } from "react";
import { MODEL } from "../constants/model-proportions";

interface EyeScreenProps {
  onPointerOver?: () => void;
  onPointerOut?: () => void;
  onClick?: () => void;
  onInteractionChange?: (active: boolean) => void;
  onDragPointerDown?: (e: ThreeEvent<PointerEvent>) => void;
  onDragPointerMove?: (e: ThreeEvent<PointerEvent>) => void;
  onDragPointerUp?: (e: ThreeEvent<PointerEvent>) => void;
}

/** DG2 玻璃面透明交互热区 — 短按开菜单，拖动转球 */
export function EyeScreen({
  onPointerOver,
  onPointerOut,
  onClick,
  onInteractionChange,
  onDragPointerDown,
  onDragPointerMove,
  onDragPointerUp,
}: EyeScreenProps) {
  const [gx, gy, gz] = MODEL.glassScreenPosition;
  const movedRef = useRef(false);

  return (
    <mesh
      position={[gx, gy, gz]}
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
      <circleGeometry args={[0.38, 48]} />
      <meshBasicMaterial transparent opacity={0} depthWrite={false} />
    </mesh>
  );
}
