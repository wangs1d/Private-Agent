"""
独立悬浮翻译结果窗（多卡片合并版）：
  - 单个 always-on-top Tk 悬浮窗，所有选区结果叠加显示在窗口内
  - 顶部工具栏：翻译为 ▼ / ➕ 新建 / 字号 ▼ / 展开字幕 / ✕
  - 每次新的翻译结果作为一张新卡片插入到顶部
  - 卡片可独立关闭、可复制译文
  - 窗口可拖动、可滚动、可隐藏到托盘

不依赖 desktop-visual / Flutter 应用。
"""
from __future__ import annotations

import logging
import threading
import time
import tkinter as tk
from typing import Callable, Optional

LOG = logging.getLogger("translate_result_window")

# 颜色
BG = "#0f172a"           # 深色背景
BG_PANEL = "#1e293b"     # 面板
BG_CARD = "#1e293b"
BORDER = "#334155"
FG = "#f1f5f9"           # 主文字
FG_MUTED = "#94a3b8"     # 辅助文字
ACCENT = "#38bdf8"       # 强调
SUCCESS = "#22c55e"
ERROR = "#f87171"
WARN = "#fbbf24"
CONTINUOUS_ACCENT = "#a78bfa"  # 连续模式卡片用紫色区分

# 字号档位（小 / 中 / 大）—— 应用到卡片译文
FONT_SIZE_OPTIONS: list[tuple[str, int]] = [
    ("小号字体", 10),
    ("中号字体", 13),
    ("大号字体", 16),
]

# 窗口尺寸
NORMAL_GEOMETRY: tuple[int, int] = (460, 600)     # 收起态
EXPANDED_GEOMETRY: tuple[int, int] = (860, 260)   # 展开字幕态（宽而矮，靠底）

# 语言下拉
LANG_LABELS: dict[str, str] = {
    "zh": "中文",
    "zh-CN": "中文",
    "zh-TW": "繁體",
    "en": "English",
    "ja": "日本語",
    "ko": "한국어",
    "fr": "Français",
    "de": "Deutsch",
    "es": "Español",
    "ru": "Русский",
}


def _label_for_lang(code: str) -> str:
    return LANG_LABELS.get(code, code)


class ConsolidatedTranslateWindow:
    """单例悬浮窗，所有翻译结果合并在此窗口内。"""

    _instance: Optional["ConsolidatedTranslateWindow"] = None
    _instance_lock = threading.Lock()

    def __init__(
        self,
        width: int = NORMAL_GEOMETRY[0],
        new_callback: Optional[Callable[[], None]] = None,
        language_callback: Optional[Callable[[str], None]] = None,
    ) -> None:
        self.width = width
        self._new_callback = new_callback
        self._language_callback = language_callback

        self._target_lang: str = "zh"
        self._font_size: int = FONT_SIZE_OPTIONS[1][1]  # 默认中号
        self._expanded: bool = False

        self._root: Optional[tk.Tk] = None
        self._cards_frame: Optional[tk.Frame] = None
        self._canvas: Optional[tk.Canvas] = None
        self._empty_label: Optional[tk.Label] = None
        self._status_label: Optional[tk.Label] = None
        self._cards: dict[str, _CardWidget] = {}
        self._hide_when_empty = True
        self._auto_close_ms: int = 0  # 0 = 不自动关闭
        self._close_job: Optional[str] = None

        # 工具栏控件引用
        self._lang_menubutton: Optional[tk.Menubutton] = None
        self._font_menubutton: Optional[tk.Menubutton] = None
        self._expand_button: Optional[tk.Button] = None

    # ---------- 单例管理 ----------

    @classmethod
    def get(cls) -> "ConsolidatedTranslateWindow":
        with cls._instance_lock:
            if cls._instance is None:
                cls._instance = ConsolidatedTranslateWindow()
                cls._instance._build()
            return cls._instance

    @classmethod
    def configure(
        cls,
        new_callback: Optional[Callable[[], None]] = None,
        language_callback: Optional[Callable[[str], None]] = None,
    ) -> "ConsolidatedTranslateWindow":
        """注册工具栏回调。首次调用前用于注入；之后用于热更新。"""
        with cls._instance_lock:
            if cls._instance is None:
                cls._instance = ConsolidatedTranslateWindow(
                    new_callback=new_callback,
                    language_callback=language_callback,
                )
                cls._instance._build()
                return cls._instance
            if new_callback is not None:
                cls._instance._new_callback = new_callback
            if language_callback is not None:
                cls._instance._language_callback = language_callback
            return cls._instance

    # ---------- 公开配置接口（供 tray app 同步状态） ----------

    def set_target_lang(self, code: str) -> None:
        self._target_lang = code or "zh"
        self._dispatch(self._refresh_lang_label)

    def set_font_size(self, size: int) -> None:
        for _, v in FONT_SIZE_OPTIONS:
            if v == size:
                self._font_size = size
                self._dispatch(self._apply_font_size)
                return
        # 兜底取最近
        self._font_size = FONT_SIZE_OPTIONS[1][1]
        self._dispatch(self._apply_font_size)

    def get_target_lang(self) -> str:
        return self._target_lang

    def get_font_size(self) -> int:
        return self._font_size

    # ---------- 公开 API ----------

    def add_or_update_card(
        self,
        card_id: str,
        source_text: str,
        translated_text: str,
        target_lang_label: str = "中文",
        translated_by: str = "llm",
        error: Optional[str] = None,
        mode: str = "live",  # "live" | "continuous"
        auto_close_ms: int = 0,
    ) -> None:
        """添加或更新一张卡片。card_id 相同则更新；不同则新增到顶部。"""
        win = self.get()
        win._dispatch(
            lambda: win._add_or_update_card_impl(
                card_id, source_text, translated_text, target_lang_label, translated_by, error, mode
            )
        )
        if auto_close_ms > 0:
            self._schedule_auto_close(auto_close_ms)

    def show_loading(self, hint: str, card_id: str = "__loading__") -> None:
        win = self.get()
        win._dispatch(lambda: win._add_or_update_card_impl(
            card_id, "正在识别...", "正在翻译...", "—", "loading", None, "live"
        ))
        if win._status_label is not None:
            win._dispatch(lambda: win._status_label.configure(text=hint, fg=ACCENT))

    def show_error(self, error: str) -> None:
        win = self.get()
        win._dispatch(lambda: win._add_or_update_card_impl(
            "__error__", "—", f"❌ {error}", "—", "error", None, "live"
        ))

    def clear(self) -> None:
        win = self.get()
        win._dispatch(lambda: win._clear_impl())

    def set_status(self, text: str, color: str = FG_MUTED) -> None:
        win = self.get()
        win._dispatch(lambda: win._status_label.configure(text=text, fg=color) if win._status_label else None)

    def remove_card(self, card_id: str) -> None:
        win = self.get()
        win._dispatch(lambda: win._remove_card_impl(card_id))

    def close(self) -> None:
        with ConsolidatedTranslateWindow._instance_lock:
            if self._close_job is not None:
                try:
                    if self._root is not None:
                        self._root.after_cancel(self._close_job)
                except Exception:
                    pass
                self._close_job = None
            if self._root is not None:
                try:
                    self._root.destroy()
                except Exception:
                    pass
            self._root = None
            self._cards.clear()
            if ConsolidatedTranslateWindow._instance is self:
                ConsolidatedTranslateWindow._instance = None

    # ---------- Tk 内部 ----------

    def _alive(self) -> bool:
        try:
            return bool(self._root) and bool(self._root.winfo_exists())
        except Exception:
            return False

    def _dispatch(self, fn: Callable[[], None]) -> None:
        try:
            root = _ensure_tk_thread()
            root.after(0, fn)
        except Exception:
            LOG.exception("派发到 Tk 失败")

    def _ensure_visible(self) -> None:
        if self._root is None:
            return
        try:
            self._root.deiconify()
            self._root.lift()
        except Exception:
            pass

    def _schedule_auto_close(self, ms: int) -> None:
        if self._root is None:
            return
        if self._close_job is not None:
            try:
                self._root.after_cancel(self._close_job)
            except Exception:
                pass
        self._close_job = self._root.after(ms, self.close)

    def _position(self) -> None:
        if self._root is None:
            return
        try:
            self._root.update_idletasks()
            sw = self._root.winfo_screenwidth()
            sh = self._root.winfo_screenheight()
            w, h = EXPANDED_GEOMETRY if self._expanded else NORMAL_GEOMETRY
            x = max(20, sw - w - 24)
            y = max(20, (sh - h) // 2)
            self._root.geometry(f"{w}x{h}+{x}+{y}")
        except Exception:
            pass

    # ---------- 工具栏回调 ----------

    def _on_new_clicked(self) -> None:
        LOG.info("工具栏 ➕ 新建：触发框选翻译")
        cb = self._new_callback
        if cb is None:
            return
        try:
            cb()
        except Exception:
            LOG.exception("新建回调失败")

    def _on_lang_change(self, code: str) -> None:
        self._target_lang = code
        self._refresh_lang_label()
        if self._language_callback is not None:
            try:
                self._language_callback(code)
            except Exception:
                LOG.exception("语言切换回调失败")

    def _on_font_change(self, label: str, size: int) -> None:
        self._font_size = size
        if self._font_menubutton is not None:
            try:
                self._font_menubutton.configure(text=f"Aa {label} ▼")
            except Exception:
                pass
        self._apply_font_size()

    def _on_expand_toggle(self) -> None:
        self._expanded = not self._expanded
        if self._expand_button is not None:
            try:
                self._expand_button.configure(
                    text="🗗 收起字幕" if self._expanded else "⛶ 展开字幕"
                )
            except Exception:
                pass
        self._position()

    def _refresh_lang_label(self) -> None:
        if self._lang_menubutton is None:
            return
        try:
            self._lang_menubutton.configure(
                text=f"🌐 翻译为: {_label_for_lang(self._target_lang)} ▼"
            )
        except Exception:
            pass

    def _apply_font_size(self) -> None:
        # 让所有卡片同步字号
        for card in self._cards.values():
            try:
                card.set_font_size(self._font_size)
            except Exception:
                pass

    # ---------- 构建 UI ----------

    def _build(self) -> None:
        self._root = tk.Tk()
        self._root.title("屏幕翻译")
        try:
            self._root.attributes("-topmost", True)
        except Exception:
            pass
        try:
            self._root.attributes("-toolwindow", True)
        except Exception:
            pass
        self._root.configure(bg=BG)
        self._root.resizable(True, True)
        self._root.minsize(360, 180)
        self._root.protocol("WM_DELETE_WINDOW", self.close)

        # ─── 顶部工具栏（参照截图：翻译为/新建/字号/展开字幕/关闭）───
        toolbar = tk.Frame(self._root, bg=BG_PANEL, height=36)
        toolbar.pack(fill=tk.X, side=tk.TOP)
        toolbar.pack_propagate(False)

        # 拖动支持（仅在工具栏空白处生效，避免和按钮冲突）
        def _start_move(e: tk.Event) -> None:
            self._root._drag_x = e.x  # type: ignore[attr-defined]
            self._root._drag_y = e.y  # type: ignore[attr-defined]

        def _do_move(e: tk.Event) -> None:
            try:
                x = self._root.winfo_pointerx() - self._root._drag_x  # type: ignore[attr-defined]
                y = self._root.winfo_pointery() - self._root._drag_y  # type: ignore[attr-defined]
                self._root.geometry(f"+{x}+{y}")
            except Exception:
                pass

        toolbar.bind("<ButtonPress-1>", _start_move)
        toolbar.bind("<B1-Motion>", _do_move)

        # 翻译为 ▼
        lang_menu = tk.Menu(self._root, tearoff=0)
        for code, label in LANG_LABELS.items():
            lang_menu.add_command(
                label=label,
                command=lambda c=code: self._on_lang_change(c),
            )
        self._lang_menubutton = tk.Menubutton(
            toolbar,
            text=f"🌐 翻译为: {_label_for_lang(self._target_lang)} ▼",
            fg=FG,
            bg=BG_PANEL,
            activebackground=BORDER,
            activeforeground=FG,
            relief="flat",
            bd=0,
            padx=10,
            pady=4,
            font=("Microsoft YaHei UI", 9),
            cursor="hand2",
            menu=lang_menu,
        )
        self._lang_menubutton.pack(side=tk.LEFT, padx=(8, 2))

        # ➕ 新建（关键交互：触发 Live 框选）
        tk.Button(
            toolbar,
            text="➕ 新建",
            fg=FG,
            bg=BG_PANEL,
            activebackground=BORDER,
            activeforeground=FG,
            relief="flat",
            bd=0,
            padx=10,
            pady=4,
            font=("Microsoft YaHei UI", 9),
            cursor="hand2",
            command=self._on_new_clicked,
        ).pack(side=tk.LEFT, padx=4)

        # Aa 中号字体 ▼
        font_menu = tk.Menu(self._root, tearoff=0)
        for label, size in FONT_SIZE_OPTIONS:
            font_menu.add_command(
                label=label,
                command=lambda l=label, s=size: self._on_font_change(l, s),
            )
        current_font_label = next(
            (lab for lab, sz in FONT_SIZE_OPTIONS if sz == self._font_size),
            FONT_SIZE_OPTIONS[1][0],
        )
        self._font_menubutton = tk.Menubutton(
            toolbar,
            text=f"Aa {current_font_label} ▼",
            fg=FG,
            bg=BG_PANEL,
            activebackground=BORDER,
            activeforeground=FG,
            relief="flat",
            bd=0,
            padx=10,
            pady=4,
            font=("Microsoft YaHei UI", 9),
            cursor="hand2",
            menu=font_menu,
        )
        self._font_menubutton.pack(side=tk.LEFT, padx=4)

        # 弹性空间
        tk.Frame(toolbar, bg=BG_PANEL).pack(side=tk.LEFT, fill=tk.X, expand=True)

        # ⛶ 展开字幕
        self._expand_button = tk.Button(
            toolbar,
            text="⛶ 展开字幕",
            fg=FG,
            bg=BG_PANEL,
            activebackground=BORDER,
            activeforeground=FG,
            relief="flat",
            bd=0,
            padx=10,
            pady=4,
            font=("Microsoft YaHei UI", 9),
            cursor="hand2",
            command=self._on_expand_toggle,
        )
        self._expand_button.pack(side=tk.RIGHT, padx=2)

        # ✕ 关闭
        tk.Button(
            toolbar,
            text="✕",
            fg=FG_MUTED,
            bg=BG_PANEL,
            activebackground=BORDER,
            activeforeground=FG,
            relief="flat",
            bd=0,
            padx=10,
            pady=4,
            font=("Microsoft YaHei UI", 10),
            cursor="hand2",
            command=self.close,
        ).pack(side=tk.RIGHT, padx=(2, 8))

        # ─── 状态行（保留，原有 API 仍可写入） ───
        self._status_label = tk.Label(
            self._root,
            text="",
            fg=FG_MUTED,
            bg=BG,
            font=("Microsoft YaHei UI", 8),
            anchor="w",
            padx=12,
        )
        self._status_label.pack(fill=tk.X, pady=(2, 0))

        # ─── 滚动区域（卡片列表） ───
        body = tk.Frame(self._root, bg=BG)
        body.pack(fill=tk.BOTH, expand=True)

        self._canvas = tk.Canvas(body, bg=BG, highlightthickness=0, bd=0)
        scrollbar = tk.Scrollbar(body, orient="vertical", command=self._canvas.yview)
        self._canvas.configure(yscrollcommand=scrollbar.set)
        scrollbar.pack(side=tk.RIGHT, fill=tk.Y)
        self._canvas.pack(side=tk.LEFT, fill=tk.BOTH, expand=True)

        self._cards_frame = tk.Frame(self._canvas, bg=BG)
        self._cards_frame_id = self._canvas.create_window(
            (0, 0), window=self._cards_frame, anchor="nw"
        )

        def _on_frame_config(_e):
            self._canvas.configure(scrollregion=self._canvas.bbox("all"))
        self._cards_frame.bind("<Configure>", _on_frame_config)

        def _on_canvas_config(e):
            self._canvas.itemconfigure(self._cards_frame_id, width=e.width)
        self._canvas.bind("<Configure>", _on_canvas_config)

        # 鼠标滚轮
        def _on_mousewheel(e: tk.Event) -> None:
            try:
                self._canvas.yview_scroll(int(-1 * (e.delta / 120)), "units")
            except Exception:
                pass
        self._canvas.bind_all("<MouseWheel>", _on_mousewheel)

        # 空状态提示
        self._empty_label = tk.Label(
            self._cards_frame,
            text="（还没有翻译结果）\n\n点 ➕ 新建 或按 Ctrl+Shift+T 框选并翻译\nCtrl+Shift+R 选区域持续翻译",
            fg=FG_MUTED,
            bg=BG,
            font=("Microsoft YaHei UI", 9),
            justify="center",
            pady=30,
        )
        self._empty_label.pack(fill=tk.X)

        self._position()
        self._root.lift()

    def _clear_impl(self) -> None:
        for cid, card in list(self._cards.items()):
            try:
                card.destroy()
            except Exception:
                pass
        self._cards.clear()
        if self._empty_label is not None:
            try:
                self._empty_label.pack(fill=tk.X)
            except Exception:
                pass

    def _remove_card_impl(self, card_id: str) -> None:
        card = self._cards.pop(card_id, None)
        if card is not None:
            try:
                card.destroy()
            except Exception:
                pass
        if not self._cards and self._empty_label is not None:
            try:
                self._empty_label.pack(fill=tk.X)
            except Exception:
                pass

    def _add_or_update_card_impl(
        self,
        card_id: str,
        source_text: str,
        translated_text: str,
        target_lang_label: str,
        translated_by: str,
        error: Optional[str],
        mode: str,
    ) -> None:
        if self._empty_label is not None:
            try:
                self._empty_label.pack_forget()
            except Exception:
                pass

        existing = self._cards.get(card_id)
        if existing is not None:
            existing.update(source_text, translated_text, target_lang_label, translated_by, error, mode)
        else:
            card = _CardWidget(
                self._cards_frame,
                card_id=card_id,
                on_close=lambda cid=card_id: self._remove_card_impl(cid),
                font_size=self._font_size,
            )
            card.pack(fill=tk.X, padx=10, pady=6, anchor="n")
            card.update(source_text, translated_text, target_lang_label, translated_by, error, mode)
            self._cards[card_id] = card

        # 自动滚到顶部
        try:
            self._canvas.yview_moveto(0)
        except Exception:
            pass

        self._ensure_visible()


class _CardWidget(tk.Frame):
    """单张翻译结果卡片：原文（折叠显示）+ 译文（主）+ ✕。"""

    def __init__(
        self,
        parent,
        card_id: str,
        on_close: Callable[[], None],
        font_size: int = 13,
    ) -> None:
        super().__init__(parent, bg=BG_CARD, bd=1, relief="solid", highlightthickness=0)
        try:
            self.configure(highlightbackground=BORDER, highlightcolor=BORDER)
        except Exception:
            pass
        self._card_id = card_id
        self._on_close = on_close
        self._font_size = font_size
        self._tgt_text: Optional[tk.Text] = None
        self._mode_indicator: Optional[tk.Label] = None
        self._tgt_border_color = ACCENT
        self._build()

    def _build(self) -> None:
        # 译文（主显示）
        self._tgt_text = tk.Text(
            self,
            height=2,
            bg=BG,
            fg=self._tgt_border_color,
            insertbackground=self._tgt_border_color,
            relief="flat",
            bd=0,
            wrap="word",
            font=("Microsoft YaHei UI", self._font_size, "bold"),
            padx=12,
            pady=(10, 4),
        )
        self._tgt_text.pack(fill=tk.X)
        self._tgt_text.configure(state="disabled")

        # 按钮栏：左侧模式指示，右侧 ✕（已去掉"关闭原文"）
        btn_bar = tk.Frame(self, bg=BG_CARD)
        btn_bar.pack(fill=tk.X, padx=10, pady=(0, 6))

        self._mode_indicator = tk.Frame(btn_bar, bg=BG_CARD, width=4, height=16)
        self._mode_indicator.pack(side=tk.LEFT, padx=(2, 6), pady=2)
        self._mode_indicator.pack_propagate(False)

        tk.Button(
            btn_bar,
            text="✕",
            fg=FG_MUTED,
            bg=BG_CARD,
            activebackground=BG_PANEL,
            activeforeground=FG,
            relief="flat",
            bd=0,
            padx=8,
            pady=2,
            cursor="hand2",
            command=self._on_close,
        ).pack(side=tk.RIGHT, padx=2)

    def set_font_size(self, size: int) -> None:
        self._font_size = size
        if self._tgt_text is not None:
            try:
                self._tgt_text.configure(font=("Microsoft YaHei UI", size, "bold"))
            except Exception:
                pass

    def update(
        self,
        source_text: str,
        translated_text: str,
        target_lang_label: str,
        translated_by: str,
        error: Optional[str],
        mode: str,
    ) -> None:
        if error:
            color = ERROR
            self._tgt_border_color = ERROR
            indicator_color = ERROR
        elif mode == "continuous":
            color = CONTINUOUS_ACCENT
            self._tgt_border_color = CONTINUOUS_ACCENT
            indicator_color = CONTINUOUS_ACCENT
        else:
            color = ACCENT
            self._tgt_border_color = ACCENT
            indicator_color = ACCENT

        try:
            self._tgt_text.configure(fg=color, insertbackground=color)
        except Exception:
            pass
        if self._mode_indicator is not None:
            try:
                self._mode_indicator.configure(bg=indicator_color)
            except Exception:
                pass

        # 仅显示译文；原文供接口内部保留，但不在卡片上展开
        if error:
            self._set_text(self._tgt_text, f"❌ {error}")
        else:
            self._set_text(self._tgt_text, translated_text or "（空）")

    def _set_text(self, widget: Optional[tk.Text], text: str) -> None:
        if widget is None:
            return
        try:
            widget.configure(state="normal")
            widget.delete("1.0", tk.END)
            widget.insert("1.0", text)
            widget.configure(state="disabled")
        except Exception:
            pass


# ---- Tk 事件循环桥接 ----

_TK_THREAD: Optional[tk.Tk] = None
_TK_THREAD_LOCK = threading.Lock()


def _ensure_tk_thread() -> tk.Tk:
    """确保有一个 Tk 主循环在后台运行；返回 dummy root。"""
    global _TK_THREAD
    with _TK_THREAD_LOCK:
        if _TK_THREAD is not None:
            try:
                if _TK_THREAD.winfo_exists():
                    return _TK_THREAD
            except Exception:
                pass
        root = tk.Tk()
        root.withdraw()  # 隐藏主 root
        _TK_THREAD = root

        def _loop() -> None:
            try:
                root.mainloop()
            except Exception:
                LOG.exception("Tk 主循环异常")

        t = threading.Thread(target=_loop, daemon=True, name="translate-tk-loop")
        t.start()
        return root


# 顶层便捷函数（保持向后兼容）

def get_window() -> ConsolidatedTranslateWindow:
    return ConsolidatedTranslateWindow.get()


def show_loading(hint: str, card_id: str = "__loading__") -> None:
    ConsolidatedTranslateWindow.get().show_loading(hint, card_id)


def show_error(error: str) -> None:
    ConsolidatedTranslateWindow.get().show_error(error)


def show_translation(
    source_text: str,
    translated_text: str,
    target_lang_label: str = "中文",
    translated_by: str = "llm",
    card_id: Optional[str] = None,
    mode: str = "live",
) -> None:
    """添加一张翻译结果卡片。card_id 相同则覆盖。"""
    cid = card_id or f"live-{int(time.time() * 1000)}"
    ConsolidatedTranslateWindow.get().add_or_update_card(
        card_id=cid,
        source_text=source_text,
        translated_text=translated_text,
        target_lang_label=target_lang_label,
        translated_by=translated_by,
        mode=mode,
    )


def clear_all() -> None:
    ConsolidatedTranslateWindow.get().clear()
