"""进程级 DPI 感知设置。

调用时机：任何截屏/鼠标/UIA 操作之前（进程启动时调用一次即可）。

背景：Windows 上未声明 DPI 感知的进程会被系统"虚拟化"坐标——截图拿到物理
像素，而 SetCursorPos / UIA ElementFromPoint 拿到的是逻辑像素，缩放屏
（125% / 150%）上两者错位。声明 Per-Monitor V2 后全链路统一为物理像素。
"""
from __future__ import annotations

import logging
import os

logger = logging.getLogger(__name__)

_applied = False


def ensure_per_monitor_dpi_aware() -> bool:
    """设置 Per-Monitor V2 DPI aware；已设置或非 Windows 时幂等返回。"""
    global _applied
    if _applied:
        return True
    if os.name != "nt":
        _applied = True
        return False
    import ctypes

    try:
        # Per-Monitor V2：DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2 = -4
        ctypes.windll.user32.SetProcessDpiAwarenessContext(ctypes.c_void_p(-4))
        _applied = True
        return True
    except Exception:
        pass
    try:
        # Win8.1+：PROCESS_PER_MONITOR_DPI_AWARE = 2
        ctypes.windll.shcore.SetProcessDpiAwareness(2)
        _applied = True
        return True
    except Exception:
        pass
    try:
        # Vista+：SYSTEM_DPI_AWARE
        ctypes.windll.user32.SetProcessDPIAware()
        _applied = True
        return True
    except Exception as exc:
        logger.warning("设置 DPI aware 失败（坐标在高缩放屏上可能错位）: %s", exc)
        _applied = True
        return False
