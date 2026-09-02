"""显示器枚举（物理像素）。

进程启动时已设置 Per-Monitor V2 DPI aware（见 stdio_worker._ensure_dpi_awareness），
因此 EnumDisplayMonitors / GetMonitorInfo 返回的就是物理屏幕坐标，
与截图、鼠标（SetCursorPos）、UIA（ElementFromPoint / BoundingRectangle）一致。

display 编号约定：1-based，按 EnumDisplayMonitors 枚举顺序，主屏不保证是 1。
"""
from __future__ import annotations

import logging
import os
from dataclasses import dataclass

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class MonitorInfo:
    index: int  # 1-based
    left: int
    top: int
    width: int
    height: int
    primary: bool

    @property
    def rect(self) -> tuple[int, int, int, int]:
        """虚拟屏幕坐标系下的 (left, top, width, height)。"""
        return (self.left, self.top, self.width, self.height)


def _fallback_primary() -> list[MonitorInfo]:
    """非 Windows / 枚举失败时退化为主屏（pyautogui.size 是物理像素）。"""
    try:
        import pyautogui

        w, h = pyautogui.size()
        return [MonitorInfo(1, 0, 0, int(w), int(h), True)]
    except Exception:
        return [MonitorInfo(1, 0, 0, 1920, 1080, True)]


def list_monitors() -> list[MonitorInfo]:
    """枚举所有显示器（虚拟屏幕坐标，物理像素）。"""
    if os.name != "nt":
        return _fallback_primary()
    try:
        return _list_monitors_win32()
    except Exception as exc:
        logger.warning("EnumDisplayMonitors 失败，退化为主屏: %s", exc)
        return _fallback_primary()


def _list_monitors_win32() -> list[MonitorInfo]:
    import ctypes
    from ctypes import wintypes

    user32 = ctypes.windll.user32
    monitors: list[MonitorInfo] = []

    MonitorEnumProc = ctypes.WINFUNCTYPE(
        wintypes.BOOL, wintypes.HMONITOR, wintypes.HDC, ctypes.POINTER(wintypes.RECT), wintypes.LPARAM
    )

    class MONITORINFOEXW(ctypes.Structure):
        _fields_ = [
            ("cbSize", wintypes.DWORD),
            ("rcMonitor", wintypes.RECT),
            ("rcWork", wintypes.RECT),
            ("dwFlags", wintypes.DWORD),
            ("szDevice", wintypes.WCHAR * 32),
        ]

    def _cb(hmon, _hdc, lprc, _lparam):
        info = MONITORINFOEXW()
        info.cbSize = ctypes.sizeof(MONITORINFOEXW)
        if user32.GetMonitorInfoW(hmon, ctypes.byref(info)):
            r = info.rcMonitor
            monitors.append(
                MonitorInfo(
                    index=len(monitors) + 1,
                    left=int(r.left),
                    top=int(r.top),
                    width=int(r.right - r.left),
                    height=int(r.bottom - r.top),
                    primary=bool(info.dwFlags & 1),  # MONITORINFOF_PRIMARY
                )
            )
        return True

    user32.EnumDisplayMonitors(None, None, MonitorEnumProc(_cb), 0)
    if not monitors:
        return _fallback_primary()
    return monitors


def resolve_monitor(display: int | None) -> MonitorInfo:
    """按 1-based 编号取显示器；None 返回主屏；越界抛 ValueError。"""
    monitors = list_monitors()
    if display is None:
        for m in monitors:
            if m.primary:
                return m
        return monitors[0]
    if not 1 <= display <= len(monitors):
        raise ValueError(
            f"display={display} 超出范围，当前共 {len(monitors)} 个显示器: "
            + ", ".join(f"{m.index}({m.width}x{m.height}{'主' if m.primary else ''})" for m in monitors)
        )
    return monitors[display - 1]
