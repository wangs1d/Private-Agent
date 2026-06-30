"""
桌面外文区域智能检测：鼠标悬停即译。

工作方式：
  - 一个轻量后台线程以 ~120ms 间隔轮询鼠标位置（Win32 GetCursorPos，降级 pynput）
  - 当鼠标在 move_threshold 像素内停留 >= dwell_ms，且距上次触发 >= cooldown_ms，
    且当前没有在飞的翻译请求时，截取鼠标周围 box_w x box_h 区域 → 回调 on_detect(png)
  - 用图像签名去重：与上次相同则跳过，避免同一画面重复翻译
  - 仅当 set_enabled(True) 时才触发；关闭后线程空转（开销极低）

不依赖 mss，复用 PIL.ImageGrab（与 translate_snipping 一致）。
线程模型：worker 线程自带轮询；on_detect 回调在临时 shot 线程里执行，
        截图 + HTTP 都在 shot 线程，不阻塞 Tk 线程。
"""
from __future__ import annotations

import io
import logging
import threading
import time
from typing import Callable, Optional

LOG = logging.getLogger("smart_detect")


class SmartDetectController:
    """鼠标悬停智能检测控制器。"""

    def __init__(
        self,
        on_detect: Callable[[bytes], None],
        dwell_ms: int = 1000,
        cooldown_ms: int = 1500,
        move_threshold: int = 8,
        box_w: int = 520,
        box_h: int = 300,
    ) -> None:
        self._on_detect = on_detect
        self.dwell_ms = dwell_ms
        self.cooldown_ms = cooldown_ms
        self.move_threshold = move_threshold
        self.box_w = box_w
        self.box_h = box_h

        self._enabled = False
        self._thread: Optional[threading.Thread] = None
        self._stop = threading.Event()

        self._lock = threading.Lock()
        self._last_pos: Optional[tuple[int, int]] = None
        self._last_move_ts: float = 0.0
        self._last_trigger_ts: float = 0.0
        self._last_sig: str = ""
        self._inflight: bool = False

    # ---- 公有 API ----

    @property
    def enabled(self) -> bool:
        return self._enabled

    def set_enabled(self, on: bool) -> None:
        """开启/关闭智能检测。开启时确保 worker 线程在跑。"""
        self._enabled = bool(on)
        with self._lock:
            self._last_pos = None
            self._last_move_ts = time.time()
            self._last_sig = ""
            self._inflight = False
        if on:
            self._ensure_running()
            LOG.info("智能检测已开启（悬停 %dms 触发，区域 %dx%d）",
                     self.dwell_ms, self.box_w, self.box_h)
        else:
            LOG.info("智能检测已关闭")

    def stop(self) -> None:
        """彻底停止（托盘退出时调）。"""
        self._enabled = False
        self._stop.set()
        t = self._thread
        if t is not None and t.is_alive():
            t.join(timeout=1.0)
        self._thread = None

    # ---- 内部 ----

    def _ensure_running(self) -> None:
        if self._thread is not None and self._thread.is_alive():
            return
        self._stop.clear()
        self._thread = threading.Thread(target=self._run, daemon=True, name="smart-detect")
        self._thread.start()

    @staticmethod
    def _get_mouse() -> Optional[tuple[int, int]]:
        try:
            import ctypes
            import ctypes.wintypes
            pt = ctypes.wintypes.POINT()
            ctypes.windll.user32.GetCursorPos(ctypes.byref(pt))
            return (pt.x, pt.y)
        except Exception:
            try:
                from pynput import mouse
                return mouse.Controller().position  # type: ignore[no-any-return]
            except Exception:
                return None

    @staticmethod
    def _virtual_screen_size() -> tuple[int, int]:
        try:
            import ctypes
            # SM_CXVIRTUALSCREEN=78, SM_CYVIRTUALSCREEN=79
            w = ctypes.windll.user32.GetSystemMetrics(78)
            h = ctypes.windll.user32.GetSystemMetrics(79)
            if w > 0 and h > 0:
                return w, h
        except Exception:
            pass
        return 1920, 1080

    def _capture_around(self, pos: tuple[int, int]) -> Optional[bytes]:
        try:
            from PIL import ImageGrab
        except Exception:
            LOG.exception("PIL 不可用，无法截图")
            return None
        sw, sh = self._virtual_screen_size()
        hw = self.box_w // 2
        hh = self.box_h // 2
        x, y = pos
        x0 = max(0, x - hw)
        y0 = max(0, y - hh)
        x1 = min(sw, x + hw)
        y1 = min(sh, y + hh)
        if x1 - x0 < 16 or y1 - y0 < 16:
            return None
        try:
            img = ImageGrab.grab(bbox=(x0, y0, x1, y1), all_screens=True)
            buf = io.BytesIO()
            img.save(buf, format="PNG")
            return buf.getvalue()
        except Exception:
            LOG.exception("智能检测截图失败")
            return None

    @staticmethod
    def _signature(png: bytes) -> str:
        """快速图像签名（灰度 32x32 像素和 + 低位哈希）。"""
        try:
            from PIL import Image
            img = Image.open(io.BytesIO(png)).convert("L").resize((32, 32))
            data = list(img.getdata())
            avg = sum(data) / len(data)
            bits = "".join("1" if p > avg else "0" for p in data)
            return f"{sum(data)}-{bits[:16]}"
        except Exception:
            return str(len(png))

    def _trigger(self, pos: tuple[int, int]) -> None:
        self._last_trigger_ts = time.time()
        with self._lock:
            self._inflight = True

        def _shot() -> None:
            try:
                png = self._capture_around(pos)
                if png is None:
                    return
                sig = self._signature(png)
                with self._lock:
                    if sig == self._last_sig:
                        return  # 同一画面，跳过
                    self._last_sig = sig
                try:
                    self._on_detect(png)
                except Exception:
                    LOG.exception("on_detect 回调失败")
            except Exception:
                LOG.exception("智能检测触发失败")
            finally:
                with self._lock:
                    self._inflight = False

        threading.Thread(target=_shot, daemon=True, name="smart-detect-shot").start()

    def _run(self) -> None:
        while not self._stop.is_set():
            try:
                if self._enabled:
                    with self._lock:
                        inflight = self._inflight
                    if not inflight:
                        pos = self._get_mouse()
                        now = time.time()
                        if pos is not None:
                            with self._lock:
                                lp = self._last_pos
                                lmt = self._last_move_ts
                            if (
                                lp is None
                                or abs(pos[0] - lp[0]) > self.move_threshold
                                or abs(pos[1] - lp[1]) > self.move_threshold
                            ):
                                # 移动了 —— 重置停留计时
                                with self._lock:
                                    self._last_pos = pos
                                    self._last_move_ts = now
                            else:
                                dwell_ms = (now - lmt) * 1000.0
                                cd_ms = (now - self._last_trigger_ts) * 1000.0
                                if dwell_ms >= self.dwell_ms and cd_ms >= self.cooldown_ms:
                                    self._trigger(pos)
            except Exception:
                LOG.exception("智能检测轮询异常")
            self._stop.wait(0.12)
