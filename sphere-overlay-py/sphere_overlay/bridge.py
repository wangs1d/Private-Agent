"""QWebChannel 桥接对象：暴露 window.sphereOverlay API 给前端。"""
from __future__ import annotations

from PySide6.QtCore import QObject, Signal, Slot


class SphereOverlayBridge(QObject):
    """前端通过 window.sphereOverlay 调用的对象。

    实现 API（与 Tauri preload 对齐）：
      - getWorkArea() -> {x,y,width,height}
      - moveTo(x, y, animateMs=0)
      - moveBy(dx, dy)
      - setPosition(x, y)
      - getPosition() -> {x,y}
      - setIgnoreMouseEvents(ignore, forward=True)
      - setMenuExpanded(expanded)
      - setScheduleCollapsed(collapsed)
      - onPatch(cb) / onRoam(cb)
    """

    # 前端订阅的信号（Python 侧 emit -> JS 回调）
    patch_event = Signal(dict)
    roam_event = Signal()

    def __init__(self, host_window, parent: QObject | None = None) -> None:
        super().__init__(parent)
        self._host = host_window

    # ---- JS 可调用的槽 ----
    @Slot(result=dict)
    def getWorkArea(self) -> dict:
        return self._host.work_area()

    @Slot(int, int, int)
    def moveTo(self, x: int, y: int, animate_ms: int = 0) -> None:
        self._host.move_window_to(x, y, animate_ms)

    @Slot(int, int)
    def moveBy(self, dx: int, dy: int) -> None:
        self._host.move_window_by(dx, dy)

    @Slot(int, int)
    def setPosition(self, x: int, y: int) -> None:
        self._host.set_window_position(x, y)

    @Slot(result=dict)
    def getPosition(self) -> dict:
        pos = self._host.pos()
        return {"x": pos.x(), "y": pos.y()}

    @Slot(bool, bool)
    def setIgnoreMouseEvents(self, ignore: bool, forward: bool = True) -> None:
        self._host.set_click_through(ignore)

    @Slot(bool)
    def setMenuExpanded(self, expanded: bool) -> None:
        self._host.set_menu_expanded(expanded)

    @Slot(bool)
    def setScheduleCollapsed(self, collapsed: bool) -> None:
        self._host.set_schedule_collapsed(collapsed)

    # ---- Python 侧触发 ----
    def emit_patch(self, payload: dict) -> None:
        self.patch_event.emit(payload)

    def emit_roam(self) -> None:
        self.roam_event.emit()
