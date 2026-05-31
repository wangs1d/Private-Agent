import { useCallback } from "react";

/** 桌面悬浮窗/Electron：鼠标进入球体时关闭穿透，离开后恢复 */
export function useOverlayPointerCapture(menuOpen: boolean) {
  const setMouseCapture = useCallback(
    (active: boolean) => {
      const ignore = !active && !menuOpen;
      window.sphereOverlay?.setIgnoreMouseEvents(ignore, true);
    },
    [menuOpen],
  );

  return { setMouseCapture };
}
