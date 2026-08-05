"""Windows 原生工具函数：工作区获取、鼠标穿透、圆角窗口等。"""
from __future__ import annotations

import ctypes
from ctypes import wintypes
from typing import Optional, Tuple

from PySide6.QtCore import QRect
from PySide6.QtGui import QWindow
from PySide6.QtWidgets import QApplication


# Windows API 常量
GWL_EXSTYLE = -20
WS_EX_LAYERED = 0x00080000
WS_EX_TRANSPARENT = 0x00000020
WS_EX_TOOLWINDOW = 0x00000080

DWMWA_WINDOW_CORNER_PREFERENCE = 33
DWMWCP_ROUND = 1
DWMWCP_DONOTROUND = 4

MONITOR_DEFAULTTONEAREST = 2


class MONITORINFO(ctypes.Structure):
    _fields_ = [
        ("cbSize", wintypes.DWORD),
        ("rcMonitor", wintypes.RECT),
        ("rcWork", wintypes.RECT),
        ("dwFlags", wintypes.DWORD),
    ]


def hwnd_from_window(widget) -> Optional[int]:
    """从 QWidget 获取 HWND。"""
    window = widget.windowHandle()
    if window is None:
        return None
    return int(window.winId())


def get_work_area(widget) -> dict:
    """获取窗口所在显示器的工作区（不含任务栏）。"""
    hwnd = hwnd_from_window(widget)
    if hwnd is None:
        screen = QApplication.primaryScreen().availableGeometry()
        return {"x": screen.x(), "y": screen.y(),
                "width": screen.width(), "height": screen.height()}

    user32 = ctypes.windll.user32
    hmonitor = user32.MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST)
    mi = MONITORINFO()
    mi.cbSize = ctypes.sizeof(MONITORINFO)
    user32.GetMonitorInfoW(hmonitor, ctypes.byref(mi))
    return {
        "x": mi.rcWork.left,
        "y": mi.rcWork.top,
        "width": mi.rcWork.right - mi.rcWork.left,
        "height": mi.rcWork.bottom - mi.rcWork.top,
    }


def set_click_through(widget, enable: bool) -> None:
    """设置窗口鼠标穿透（点击事件穿透到下层窗口）。"""
    hwnd = hwnd_from_window(widget)
    if hwnd is None:
        return
    user32 = ctypes.windll.user32
    ex_style = user32.GetWindowLongW(hwnd, GWL_EXSTYLE)
    if enable:
        ex_style |= WS_EX_LAYERED | WS_EX_TRANSPARENT
    else:
        ex_style &= ~(WS_EX_TRANSPARENT)
    user32.SetWindowLongW(hwnd, GWL_EXSTYLE, ex_style)


def apply_desk_pet_shell(widget) -> None:
    """应用桌宠窗口效果：Win11 圆角 + 工具窗口。"""
    hwnd = hwnd_from_window(widget)
    if hwnd is None:
        return
    try:
        dwm = ctypes.windll.dwmapi
        preference = ctypes.c_int(DWMWCP_ROUND)
        dwm.DwmSetWindowAttribute(
            hwnd,
            DWMWA_WINDOW_CORNER_PREFERENCE,
            ctypes.byref(preference),
            ctypes.sizeof(preference),
        )
    except OSError:
        pass

    user32 = ctypes.windll.user32
    ex_style = user32.GetWindowLongW(hwnd, GWL_EXSTYLE)
    ex_style |= WS_EX_TOOLWINDOW
    user32.SetWindowLongW(hwnd, GWL_EXSTYLE, ex_style)


def set_window_pos(hwnd: int, x: int, y: int) -> None:
    """无动画设置窗口位置。"""
    SWP_NOSIZE = 0x0001
    SWP_NOZORDER = 0x0004
    SWP_NOACTIVATE = 0x0010
    ctypes.windll.user32.SetWindowPos(
        hwnd, 0, x, y, 0, 0,
        SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE,
    )
