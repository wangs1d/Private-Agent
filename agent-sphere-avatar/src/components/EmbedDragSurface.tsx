import { useCallback, useRef } from "react";
import { getSphereDrag } from "../bridge/sphere-drag-bridge";

interface EmbedDragSurfaceProps {
  disabled?: boolean;
  /** 短按（几乎未移动）时触发，例如打开菜单 */
  onTap?: () => void;
}

const TAP_MOVE_PX = 14;

/**
 * 网页 embed 专用 — 透明 DOM 层捕获鼠标/触摸，100% 可靠（不依赖 WebGL 射线）。
 */
export function EmbedDragSurface({ disabled = false, onTap }: EmbedDragSurfaceProps) {
  const activeRef = useRef(false);
  const pointerIdRef = useRef(-1);
  const lastRef = useRef({ x: 0, y: 0 });
  const movedRef = useRef(0);

  const end = useCallback(() => {
    if (!activeRef.current) return;
    activeRef.current = false;
    pointerIdRef.current = -1;
    getSphereDrag()?.endDrag();
  }, []);

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (disabled || e.button !== 0) return;
      if (e.shiftKey || e.altKey) return;

      const api = getSphereDrag();
      if (!api) return;

      const started = api.beginDrag(e.clientX, e.clientY, e.pointerId);
      if (!started) return;

      activeRef.current = true;
      pointerIdRef.current = e.pointerId;
      lastRef.current = { x: e.clientX, y: e.clientY };
      movedRef.current = 0;
      e.currentTarget.setPointerCapture(e.pointerId);
      e.preventDefault();
      e.stopPropagation();
    },
    [disabled],
  );

  const onPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!activeRef.current || e.pointerId !== pointerIdRef.current) return;
    const dx = e.clientX - lastRef.current.x;
    const dy = e.clientY - lastRef.current.y;
    lastRef.current = { x: e.clientX, y: e.clientY };
    movedRef.current += Math.abs(dx) + Math.abs(dy);
    getSphereDrag()?.moveBy(dx, dy);
    e.preventDefault();
  }, []);

  const onPointerUp = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!activeRef.current || e.pointerId !== pointerIdRef.current) return;
      const wasTap = movedRef.current < TAP_MOVE_PX;
      end();
      if (wasTap) onTap?.();
      e.preventDefault();
    },
    [end, onTap],
  );

  if (disabled) return null;

  return (
    <div
      className="embed-drag-surface"
      aria-label="拖动旋转球形 Agent"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    />
  );
}
