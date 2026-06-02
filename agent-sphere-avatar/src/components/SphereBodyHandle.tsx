import type { ThreeEvent } from "@react-three/fiber";
import { DoubleSide } from "three";

interface SphereBodyHandleProps {
  radius: number;
  onPointerDown: (e: ThreeEvent<PointerEvent>) => void;
  onPointerMove: (e: ThreeEvent<PointerEvent>) => void;
  onPointerUp: (e: ThreeEvent<PointerEvent>) => void;
  onBodyHover?: (active: boolean) => void;
}

/** 透明球形热区 — 唯一身体射线目标（模型网格已禁用 raycast） */
export function SphereBodyHandle({
  radius,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onBodyHover,
}: SphereBodyHandleProps) {
  return (
    <mesh
      renderOrder={4}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerOver={() => onBodyHover?.(true)}
      onPointerOut={() => onBodyHover?.(false)}
    >
      <sphereGeometry args={[radius, 40, 32]} />
      <meshBasicMaterial transparent opacity={0} depthWrite={false} side={DoubleSide} />
    </mesh>
  );
}
