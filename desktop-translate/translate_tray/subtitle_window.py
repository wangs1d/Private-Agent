"""
字幕窗口：屏幕底部居中的半透明大字号悬浮窗，显示最新翻译结果。

特性：
  - 独立 Toplevel，无边框，置顶，半透明
  - 显示最新一张卡片的译文（可选显示原文）
  - 不抢焦点，不阻塞主面板
  - 单例，随 PinPanel 的 toggle_subtitle 切换显示/隐藏

线程模型：所有 UI 操作通过 _dispatch 派发到 Tk 线程。
"""
from __future__ import annotations

import logging
import threading
import tkinter as tk
from typing import Optional

LOG = logging.getLogger("subtitle_window")

# 配色（与 pin_panel 一致）
BG = "#0f172a"
BG_SOFT = "#1e293b"
FG = "#f8fafc"
FG_MUTED = "#94a3b8"
ACCENT = "#38bdf8"

# 字号
FONT_SIZE = 22
SOURCE_FONT_SIZE = 13

# 窗口尺寸
WIN_WIDTH = 720
WIN_HEIGHT = 96

# 半透明
ALPHA = 0.88


def _ensure_tk_thread() -> Optional[tk.Tk]:
    """获取全局 Tk root（由 translate_result_window 创建）。"""
    try:
        from . import translate_result_window
        return translate_result_window._ensure_tk_thread()
    except Exception:
        LOG.exception("获取 Tk root 失败")
        return None


class SubtitleWindow:
    """字幕窗口单例。"""

    _instance: "Optional[SubtitleWindow]" = None
    _instance_lock = threading.Lock()

    def __init__(self) -> None:
        self._root: Optional[tk.Toplevel] = None
        self._target_label: Optional[tk.Label] = None
        self._source_label: Optional[tk.Label] = None
        self._visible = False
        self._show_source = True
        self._last_target = ""
        self._last_source = ""

    @classmethod
    def get(cls) -> "SubtitleWindow":
        with cls._instance_lock:
            if cls._instance is None:
                cls._instance = SubtitleWindow()
            return cls._instance

    # ---- Tk 线程桥 ----

    def _dispatch(self, fn) -> None:
        root = _ensure_tk_thread()
        if root is None:
            return
        try:
            root.after(0, fn)
        except Exception:
            LOG.exception("派发到 Tk 失败")

    def _build(self) -> None:
        """在 Tk 线程内构建 Toplevel（默认隐藏）。"""
        if self._root is not None:
            return
        root = _ensure_tk_thread()
        if root is None:
            return
        try:
            self._root = tk.Toplevel(root)
            self._root.overrideredirect(True)  # 无边框
            self._root.attributes("-topmost", True)
            try:
                self._root.attributes("-alpha", ALPHA)
            except Exception:
                pass
            self._root.configure(bg=BG)

            # 译文（大字号）
            self._target_label = tk.Label(
                self._root,
                text="",
                bg=BG,
                fg=FG,
                font=("Microsoft YaHei", FONT_SIZE, "bold"),
                wraplength=WIN_WIDTH - 48,
                justify="center",
                padx=24,
                pady=14,
            )
            self._target_label.pack(fill=tk.X)

            # 原文（小字号，灰）
            self._source_label = tk.Label(
                self._root,
                text="",
                bg=BG,
                fg=FG_MUTED,
                font=("Microsoft YaHei", SOURCE_FONT_SIZE),
                wraplength=WIN_WIDTH - 48,
                justify="center",
                padx=24,
                pady=10,
            )
            # 默认隐藏原文，set_text 时按需显示

            self._place_at_bottom()
            self._root.withdraw()  # 默认隐藏
        except Exception:
            LOG.exception("构建字幕窗口失败")
            self._root = None

    def _place_at_bottom(self) -> None:
        """把窗口放到屏幕底部居中。"""
        if self._root is None:
            return
        try:
            sw = self._root.winfo_screenwidth()
            sh = self._root.winfo_screenheight()
            x = max(0, (sw - WIN_WIDTH) // 2)
            y = max(0, sh - WIN_HEIGHT - 80)  # 距底部 80px
            self._root.geometry(f"{WIN_WIDTH}x{WIN_HEIGHT}+{x}+{y}")
        except Exception:
            LOG.exception("定位字幕窗口失败")

    # ---- 公有 API ----

    def show(self) -> None:
        self._dispatch(self._show_impl)

    def _show_impl(self) -> None:
        if self._root is None:
            self._build()
        if self._root is None:
            return
        try:
            self._place_at_bottom()
            self._root.deiconify()
            self._root.lift()
            self._visible = True
        except Exception:
            LOG.exception("显示字幕窗口失败")

    def hide(self) -> None:
        self._dispatch(self._hide_impl)

    def _hide_impl(self) -> None:
        if self._root is None:
            return
        try:
            self._root.withdraw()
        except Exception:
            pass
        self._visible = False

    def toggle(self) -> bool:
        """切换显示/隐藏，返回切换后是否可见。"""
        if self._visible:
            self.hide()
        else:
            self.show()
        return self._visible

    def set_text(self, target: str, source: str = "", lang_label: str = "") -> None:
        """更新字幕内容。若窗口当前隐藏，也会先显示。"""
        self._last_target = target or ""
        self._last_source = source or ""
        self._dispatch(self._set_text_impl)

    def _set_text_impl(self) -> None:
        if self._root is None:
            self._build()
        if self._root is None:
            return
        if self._target_label is not None:
            try:
                self._target_label.configure(text=self._last_target or "…")
            except Exception:
                pass
        # 原文按需显示
        if self._source_label is not None:
            try:
                if self._show_source and self._last_source.strip():
                    self._source_label.configure(text=self._last_source)
                    self._source_label.pack(fill=tk.X)
                else:
                    self._source_label.pack_forget()
            except Exception:
                pass
        # 自适应高度（根据译文长度）
        try:
            self._root.update_idletasks()
            req_h = self._root.winfo_reqheight()
            h = max(WIN_HEIGHT, min(req_h, 280))
            sw = self._root.winfo_screenwidth()
            sh = self._root.winfo_screenheight()
            x = max(0, (sw - WIN_WIDTH) // 2)
            y = max(0, sh - h - 80)
            self._root.geometry(f"{WIN_WIDTH}x{h}+{x}+{y}")
        except Exception:
            LOG.exception("subtitle _set_text: geometry 失败")

    def set_show_source(self, show: bool) -> None:
        self._show_source = show
        if self._visible:
            self._dispatch(self._set_text_impl)

    def is_visible(self) -> bool:
        return self._visible


# ---- 模块级便利函数 ----

def show_subtitle() -> None:
    SubtitleWindow.get().show()


def hide_subtitle() -> None:
    SubtitleWindow.get().hide()


def toggle_subtitle() -> bool:
    return SubtitleWindow.get().toggle()


def set_subtitle_text(target: str, source: str = "", lang_label: str = "") -> None:
    SubtitleWindow.get().set_text(target, source, lang_label)
