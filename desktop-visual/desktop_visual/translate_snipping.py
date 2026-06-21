"""
全屏透明截图选区工具（Windows）。

提供：
  - capture_region()                 阻塞一次，返回 PNG 字节
  - define_region()                  阻塞一次，返回 (x, y, w, h)
  - live_mode_loop(on_select, on_cancel)   反复选区，每次回调 on_select(PNG 字节)；ESC 退出
  - start_continuous_capture(region, on_update, interval, stop_event)   定时截 region 回调
  - stop_continuous_capture(handle)   停止连续截屏
"""
from __future__ import annotations

import io
import logging
import sys
import threading
import time
import tkinter as tk
from typing import Callable, Optional

LOG = logging.getLogger("translate_snipping")

try:
    from PIL import ImageGrab
except ImportError as exc:  # pragma: no cover
    LOG.error("Pillow 缺失：%s", exc)
    raise


def _get_virtual_screen_bounds() -> tuple[int, int, int, int]:
    """返回 (left, top, right, bottom) 覆盖所有显示器的虚拟屏幕。"""
    if sys.platform != "win32":
        try:
            root = tk.Tk()
            root.withdraw()
            w = root.winfo_screenwidth()
            h = root.winfo_screenheight()
            root.destroy()
            return (0, 0, w, h)
        except Exception:
            return (0, 0, 1920, 1080)
    try:
        import ctypes

        user32 = ctypes.windll.user32
        SM_XVIRTUALSCREEN = 76
        SM_YVIRTUALSCREEN = 77
        SM_CXVIRTUALSCREEN = 78
        SM_CYVIRTUALSCREEN = 79
        left = user32.GetSystemMetrics(SM_XVIRTUALSCREEN)
        top = user32.GetSystemMetrics(SM_YVIRTUALSCREEN)
        width = user32.GetSystemMetrics(SM_CXVIRTUALSCREEN)
        height = user32.GetSystemMetrics(SM_CYVIRTUALSCREEN)
        return (left, top, left + width, top + height)
    except Exception as e:
        LOG.warning("获取虚拟屏幕失败: %s", e)
        return (0, 0, 1920, 1080)


# ============================================================
# 一次性的截图选区
# ============================================================

def capture_region() -> Optional[bytes]:
    """弹出全屏选区；用户框选完成后返回 PNG 字节，ESC 取消返回 None。"""
    return _snip_once(return_image=True)


def define_region() -> Optional[tuple[int, int, int, int]]:
    """弹出全屏选区；用户框选完成后返回 (x, y, w, h)，ESC 取消返回 None。"""
    return _snip_once(return_image=False)


def _snip_once(return_image: bool):
    """核心：起一个 Tk 主循环，弹一个全屏蒙版，拖选后返回结果。"""
    left, top, right, bottom = _get_virtual_screen_bounds()
    width = right - left
    height = bottom - top

    try:
        root = tk.Tk()
    except Exception as e:
        LOG.exception("无法创建 Tk 根窗口")
        raise RuntimeError(f"无法创建窗口: {e}") from e

    state: dict = {
        "x0": 0,
        "y0": 0,
        "x1": 0,
        "y1": 0,
        "rect": None,
        "result": None,  # bytes 或 (x,y,w,h)
        "cancelled": False,
        "return_image": return_image,
    }

    topmost = tk.Toplevel(root)
    topmost.overrideredirect(True)
    topmost.geometry(f"{width}x{height}+{left}+{top}")
    topmost.attributes("-topmost", True)
    try:
        topmost.attributes("-alpha", 0.32)
    except Exception:
        pass
    topmost.configure(bg="#000000")
    topmost.config(cursor="cross")

    canvas = tk.Canvas(
        topmost, width=width, height=height, bg="#000000", highlightthickness=0, bd=0
    )
    canvas.pack(fill=tk.BOTH, expand=True)

    def _draw_hint() -> None:
        canvas.create_text(
            width // 2,
            28,
            text="按住鼠标拖拽框选 · ESC 取消",
            fill="#ffffff",
            font=("Microsoft YaHei UI", 14, "bold"),
        )

    def _on_press(event: tk.Event) -> None:
        state["x0"] = event.x_root
        state["y0"] = event.y_root
        state["x1"] = event.x_root
        state["y1"] = event.y_root
        if state["rect"] is not None:
            canvas.delete(state["rect"])
            state["rect"] = None
        _redraw()

    def _on_drag(event: tk.Event) -> None:
        state["x1"] = event.x_root
        state["y1"] = event.y_root
        _redraw()

    def _redraw() -> None:
        if state["rect"] is not None:
            canvas.delete(state["rect"])
        x0 = state["x0"] - left
        y0 = state["y0"] - top
        x1 = state["x1"] - left
        y1 = state["y1"] - top
        rx0, ry0 = min(x0, x1), min(y0, y1)
        rx1, ry1 = max(x0, x1), max(y0, y1)
        state["rect"] = canvas.create_rectangle(
            rx0, ry0, rx1, ry1, outline="#22c55e", width=2, fill=""
        )
        w = int(rx1 - rx0)
        h = int(ry1 - ry0)
        canvas.create_text(
            rx1 + 6, ry1 + 6, text=f"{w}×{h}",
            fill="#22c55e", anchor="nw", font=("Consolas", 11, "bold")
        )

    def _on_release(event: tk.Event) -> None:
        state["x1"] = event.x_root
        state["y1"] = event.y_root
        x0, y0 = int(min(state["x0"], state["x1"])), int(min(state["y0"], state["y1"]))
        x1, y1 = int(max(state["x0"], state["x1"])), int(max(state["y0"], state["y1"]))
        if x1 - x0 < 4 or y1 - y0 < 4:
            if state["rect"] is not None:
                canvas.delete(state["rect"])
                state["rect"] = None
            return
        if state["return_image"]:
            try:
                topmost.withdraw()
                topmost.update_idletasks()
                time.sleep(0.05)
                img = ImageGrab.grab(bbox=(x0, y0, x1, y1), all_screens=True)
                buf = io.BytesIO()
                img.save(buf, format="PNG")
                state["result"] = buf.getvalue()
            except Exception as e:
                LOG.exception("截图失败")
                state["error"] = str(e)  # type: ignore[assignment]
        else:
            state["result"] = (x0, y0, x1 - x0, y1 - y0)
        topmost.destroy()

    def _on_escape(event: tk.Event) -> None:
        state["cancelled"] = True
        state["result"] = None
        topmost.destroy()

    canvas.bind("<ButtonPress-1>", _on_press)
    canvas.bind("<B1-Motion>", _on_drag)
    canvas.bind("<ButtonRelease-1>", _on_release)
    topmost.bind("<Escape>", _on_escape)
    topmost.focus_force()
    _draw_hint()

    topmost.wait_window()
    try:
        root.destroy()
    except Exception:
        pass
    if state.get("error"):  # type: ignore[attr-defined]
        raise RuntimeError(state["error"])  # type: ignore[attr-defined]
    return state["result"]


# ============================================================
# Live 模式：反复选区，ESC 退出
# ============================================================

class LiveSession:
    """Live 模式会话：通过 stop() 停止。"""

    def __init__(self) -> None:
        self._stopped = False
        self._thread: Optional[threading.Thread] = None
        self._on_select: Optional[Callable[[bytes], None]] = None
        self._on_cancel: Optional[Callable[[], None]] = None

    @property
    def running(self) -> bool:
        return self._thread is not None and self._thread.is_alive()

    def start(
        self,
        on_select: Callable[[bytes], None],
        on_cancel: Optional[Callable[[], None]] = None,
    ) -> None:
        if self.running:
            return
        self._stopped = False
        self._on_select = on_select
        self._on_cancel = on_cancel
        self._thread = threading.Thread(
            target=self._run, daemon=True, name="live-snipping"
        )
        self._thread.start()

    def stop(self) -> None:
        self._stopped = True
        # 中断正在运行的 wait_window（如果有）
        try:
            from . import translate_result_window
            tk_root = translate_result_window._ensure_tk_thread()
            tk_root.after(0, tk_root.quit)
        except Exception:
            pass
        if self._thread is not None:
            self._thread.join(timeout=2.0)
            self._thread = None

    def _run(self) -> None:
        try:
            while not self._stopped:
                png = capture_region()
                if self._stopped:
                    break
                if png is None:
                    # 用户按 ESC：退出 live
                    if self._on_cancel:
                        try:
                            self._on_cancel()
                        except Exception:
                            LOG.exception("on_cancel 异常")
                    break
                if self._on_select:
                    try:
                        self._on_select(png)
                    except Exception:
                        LOG.exception("on_select 回调异常")
        except Exception:
            LOG.exception("Live 模式循环异常")


def start_live_mode(
    on_select: Callable[[bytes], None],
    on_cancel: Optional[Callable[[], None]] = None,
) -> LiveSession:
    sess = LiveSession()
    sess.start(on_select, on_cancel)
    return sess


# ============================================================
# 连续模式：定一个区域，每隔 N 秒自动截图回调
# ============================================================

class ContinuousCapture:
    """对固定区域定时截图的 worker。"""

    def __init__(
        self,
        region: tuple[int, int, int, int],
        on_update: Callable[[bytes], None],
        interval_s: float = 2.0,
    ) -> None:
        self._region = region
        self._on_update = on_update
        self._interval_s = max(0.3, float(interval_s))
        self._stopped = False
        self._thread: Optional[threading.Thread] = None
        self._paused = False

    @property
    def region(self) -> tuple[int, int, int, int]:
        return self._region

    @property
    def running(self) -> bool:
        return self._thread is not None and self._thread.is_alive()

    def start(self) -> None:
        if self.running:
            return
        self._stopped = False
        self._thread = threading.Thread(
            target=self._run, daemon=True, name="continuous-capture"
        )
        self._thread.start()

    def stop(self) -> None:
        self._stopped = True
        if self._thread is not None:
            self._thread.join(timeout=3.0)
            self._thread = None

    def pause(self) -> None:
        self._paused = True

    def resume(self) -> None:
        self._paused = False

    def set_region(self, region: tuple[int, int, int, int]) -> None:
        self._region = region

    def _capture_once(self) -> Optional[bytes]:
        x, y, w, h = self._region
        if w < 4 or h < 4:
            return None
        try:
            img = ImageGrab.grab(bbox=(x, y, x + w, y + h), all_screens=True)
            buf = io.BytesIO()
            img.save(buf, format="PNG")
            return buf.getvalue()
        except Exception as e:
            LOG.warning("连续截图失败: %s", e)
            return None

    def _run(self) -> None:
        # 立即先来一发
        png = self._capture_once()
        if png is not None and not self._stopped:
            try:
                self._on_update(png)
            except Exception:
                LOG.exception("on_update 异常")
        while not self._stopped:
            if not self._paused:
                png = self._capture_once()
                if png is not None and not self._stopped:
                    try:
                        self._on_update(png)
                    except Exception:
                        LOG.exception("on_update 异常")
            # 分段 sleep 便于快速响应 stop
            for _ in range(int(self._interval_s * 10)):
                if self._stopped:
                    return
                time.sleep(0.1)


def start_continuous_capture(
    region: tuple[int, int, int, int],
    on_update: Callable[[bytes], None],
    interval_s: float = 2.0,
) -> ContinuousCapture:
    cap = ContinuousCapture(region, on_update, interval_s)
    cap.start()
    return cap
