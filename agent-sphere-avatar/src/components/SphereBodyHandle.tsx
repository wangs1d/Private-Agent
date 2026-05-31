import type { ThreeEvent } from "@react-three/fiber";

interface SphereBodyHandleProps {
  radius: number;
  onPointerDown: (e: ThreeEvent<PointerEvent>) => void;
  onPointerMove: (e: ThreeEvent<PointerEvent>) => void;
  onPointerUp: (e: ThreeEvent<PointerEvent>) => void;
}

/** 透明球形热区 — 捕获拖拽旋转，不影响眼睛区域点击（眼睛 mesh 在前方优先命中） */
export function SphereBodyHandle({
  radius,
  onPointerDown,
  onPointerMove,
  onPointerUp,
}: SphereBodyHandleProps) {
  return (
    <mesh
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerLeave={onPointerUp}
    >
      <sphereGeometry args={[radius, 32, 24]} />
      <meshBasicMaterial transparent opacity={0} depthWrite={false} />
    </mesh>
  );
}
