/** Electron preload 暴露的 sphereOverlay 为只读代理，不可挂载 roamNow。 */
let roamHandler: (() => void) | null = null;

export function setOverlayRoamHandler(handler: (() => void) | null) {
  roamHandler = handler;
}

export function triggerOverlayRoam() {
  roamHandler?.();
}
