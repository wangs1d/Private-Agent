/** iframe / 网页 DOM 拖拽层 ↔ Canvas 内球体旋转的桥接 */
export interface SphereDragApi {
  beginDrag: (clientX: number, clientY: number, pointerId: number) => boolean;
  moveBy: (dx: number, dy: number) => void;
  endDrag: () => void;
}

let active: SphereDragApi | null = null;

export function registerSphereDrag(api: SphereDragApi | null): void {
  active = api;
}

export function getSphereDrag(): SphereDragApi | null {
  return active;
}
