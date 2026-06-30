"""
选中文字翻译监听器。

工作流程：
  1. 监听全局 Ctrl+C（用户选中文字后复制）
  2. 复制后 200ms 读取剪贴板，若为新文本，在鼠标位置上方显示"译"悬浮按钮
  3. 用户点击"译" → 调 on_translate(text) 回调（由 tray app 翻译并显示到主面板）
  4. 按钮 4 秒后自动消失；不抢焦点；不破坏剪贴板

设计原则：
  - 零剪贴板破坏（用户本来就复制了，不模拟按键）
  - 零新依赖（pynput + tkinter，venv 已有）
  - 小巧（单文件，约 200 行）
"""
from __future__ import annotations

import logging
import threading
import tkinter as tk
from typing import Callable, Optional

LOG = logging.getLogger("selection_watcher")

# 按钮自动消失时间（秒）
BUTTON_TTL_S = 4.0
# 复制后延迟读剪贴板（毫秒，让应用完成复制动作）
READ_CLIPBOARD_DELAY_MS = 200
# 文本最大长度（超过不处理，避免误复制大文件）
MAX_TEXT_LEN = 5000


def _get_tk_root() -> Optional[tk.Tk]:
    """获取全局 Tk root（由 translate_result_window._ensure_tk_thread 创建）。"""
    try:
        from . import translate_result_window
        return translate_result_window._ensure_tk_thread()
    except Exception:
        LOG.exception("获取 Tk root 失败")
        return None


def _get_mouse_position() -> tuple[int, int]:
    """获取鼠标位置（优先 Win32 API，降级 pynput）。"""
    try:
        import ctypes

        class POINT(ctypes.Structure):
            _fields_ = [("x", ctypes.c_long), ("y", ctypes.c_long)]

        pt = POINT()
        ctypes.windll.user32.GetCursorPos(ctypes.byref(pt))
        return (int(pt.x), int(pt.y))
    except Exception:
        try:
            from pynput import mouse
            pos = mouse.Controller().position
            return (int(pos[0]), int(pos[1]))
        except Exception:
            return (0, 0)


class SelectionWatcher:
    """监听 Ctrl+C 复制，在鼠标附近弹出"译"悬浮按钮。

    线程模型：
      - pynput keyboard.Listener 在自己的线程跑
      - 剪贴板读取、UI 创建必须派发到 Tk 线程（root.after）
    """

    def __init__(self, on_translate: Callable[[str], None]) -> None:
        self._on_translate = on_translate
        self._listener = None
        self._ctrl_pressed = False
        self._last_text = ""
        self._enabled = False
        self._read_lock = threading.Lock()
        self._pending_read = False
        self._button_windows: list[tk.Toplevel] = []

    def start(self) -> None:
        if self._listener is not None:
            return
        try:
            from pynput import keyboard
        except ImportError:
            LOG.warning("pynput 缺失，选中文字翻译不可用")
            return
        self._enabled = True
        self._listener = keyboard.Listener(
            on_press=self._on_press,
            on_release=self._on_release,
        )
        self._listener.daemon = True
        self._listener.start()
        LOG.info("选中文字翻译监听已启动（Ctrl+C 触发）")

    def stop(self) -> None:
        self._enabled = False
        if self._listener is not None:
            try:
                self._listener.stop()
            except Exception:
                pass
            self._listener = None
        self._ctrl_pressed = False
        self._close_all_buttons()

    def set_enabled(self, enabled: bool) -> None:
        """运行时开关。"""
        if enabled and not self._enabled:
            self.start()
        elif not enabled and self._enabled:
            self.stop()

    # ---- pynput 回调（在 listener 线程） ----

    def _on_press(self, key) -> None:
        try:
            from pynput import keyboard as kb
            if key in (kb.Key.ctrl, kb.Key.ctrl_l, kb.Key.ctrl_r):
                self._ctrl_pressed = True
                return
            if self._ctrl_pressed and isinstance(key, kb.KeyCode):
                ch = key.char
                if ch and ch.lower() == "c":
                    self._schedule_read_clipboard()
        except Exception:
            LOG.exception("on_press 处理失败")

    def _on_release(self, key) -> None:
        try:
            from pynput import keyboard as kb
            if key in (kb.Key.ctrl, kb.Key.ctrl_l, kb.Key.ctrl_r):
                self._ctrl_pressed = False
        except Exception:
            LOG.exception("on_release 处理失败")

    # ---- 剪贴板读取（派发到 Tk 线程） ----

    def _schedule_read_clipboard(self) -> None:
        with self._read_lock:
            if self._pending_read:
                return
            self._pending_read = True
        root = _get_tk_root()
        if root is None:
            with self._read_lock:
                self._pending_read = False
            return
        try:
            root.after(READ_CLIPBOARD_DELAY_MS, self._read_clipboard_on_tk)
        except Exception:
            with self._read_lock:
                self._pending_read = False

    def _read_clipboard_on_tk(self) -> None:
        with self._read_lock:
            self._pending_read = False
        if not self._enabled:
            return
        root = _get_tk_root()
        if root is None:
            return
        try:
            text = root.clipboard_get()
        except Exception:
            # 剪贴板为空或非文本内容
            return
        text = (text or "").strip()
        if not text or text == self._last_text:
            return
        if len(text) > MAX_TEXT_LEN:
            LOG.debug("剪贴板文本过长（%d 字），跳过", len(text))
            return
        self._last_text = text
        LOG.info("检测到选中文字（%d 字），显示翻译按钮", len(text))
        self._show_translate_button(text)

    # ---- "译" 悬浮按钮 ----

    def _show_translate_button(self, text: str) -> None:
        root = _get_tk_root()
        if root is None:
            return
        # 先关掉旧按钮，避免堆积
        self._close_all_buttons()

        mx, my = _get_mouse_position()
        # 按钮位置：鼠标右上方
        btn_x = mx + 14
        btn_y = my - 44

        try:
            win = tk.Toplevel(root)
            win.overrideredirect(True)  # 无边框
            win.attributes("-topmost", True)
            win.geometry(f"+{btn_x}+{btn_y}")

            def _on_click():
                try:
                    self._on_translate(text)
                except Exception:
                    LOG.exception("on_translate 回调失败")
                self._close_button(win)

            btn = tk.Button(
                win,
                text="译",
                command=_on_click,
                width=3,
                height=1,
                bg="#38bdf8",
                fg="white",
                activebackground="#0ea5e9",
                activeforeground="white",
                font=("Microsoft YaHei", 12, "bold"),
                relief="flat",
                cursor="hand2",
                bd=0,
                padx=8,
                pady=4,
            )
            btn.pack()

            # 4 秒后自动消失
            win.after(int(BUTTON_TTL_S * 1000), lambda: self._close_button(win))

            self._button_windows.append(win)
        except Exception:
            LOG.exception("显示翻译按钮失败")

    def _close_button(self, win: tk.Toplevel) -> None:
        try:
            win.destroy()
        except Exception:
            pass
        try:
            self._button_windows.remove(win)
        except ValueError:
            pass

    def _close_all_buttons(self) -> None:
        for w in list(self._button_windows):
            self._close_button(w)
