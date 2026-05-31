import { useEffect } from "react";
import { postToHost, SPHERE_MSG } from "../embed-protocol";

/** iframe 内 Shift/Alt + 拖动时，将位移 relay 给父页移动浮层 */
export function useEmbedFloatPan(enabled = true) {
  useEffect(() => {
    if (!enabled || window.parent === window) return;

    let dragging = false;
    let lastX = 0;
    let lastY = 0;

    const onPointerDown = (e: PointerEvent) => {
      if (e.button !== 0 || (!e.shiftKey && !e.altKey)) return;
      dragging = true;
      lastX = e.clientX;
      lastY = e.clientY;
      e.preventDefault();
    };

    const onPointerMove = (e: PointerEvent) => {
      if (!dragging) return;
      const dx = e.clientX - lastX;
      const dy = e.clientY - lastY;
      lastX = e.clientX;
      lastY = e.clientY;
      if (dx !== 0 || dy !== 0) {
        postToHost({ type: SPHERE_MSG.pan, dx, dy });
      }
    };

    const endDrag = () => {
      dragging = false;
    };

    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", endDrag);
    window.addEventListener("pointercancel", endDrag);

    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", endDrag);
      window.removeEventListener("pointercancel", endDrag);
    };
  }, [enabled]);
}
