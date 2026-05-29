import { MODEL } from "../constants/model-proportions";

interface EyeScreenProps {
  onPointerOver?: () => void;
  onPointerOut?: () => void;
  onClick?: () => void;
  onInteractionChange?: (active: boolean) => void;
}

/** DG2 玻璃面透明交互热区 */
export function EyeScreen({
  onPointerOver,
  onPointerOut,
  onClick,
  onInteractionChange,
}: EyeScreenProps) {
  const [gx, gy, gz] = MODEL.glassScreenPosition;

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
      onClick={onClick}
    >
      <circleGeometry args={[0.38, 48]} />
      <meshBasicMaterial transparent opacity={0} depthWrite={false} />
    </mesh>
  );
}
