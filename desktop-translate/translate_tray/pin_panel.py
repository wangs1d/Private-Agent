"""
独立翻译主面板（pin_panel）：
  - 工具栏（36px）：[✚ 框选] [🌐 中文 ▼] [👁 原文] [Aa 中 ▼] [📺 字幕] [─] [✕]
  - 结果区：可滚动，最新结果在顶部，每条可独立关闭
  - 通过共享 translate_result_window._ensure_tk_thread() 的 Tk 线程跑 Toplevel，
    避免跨线程 Tcl / apartment 错配
  - 所有 UI 构建严格在 Tk 线程内完成；跨线程调用统一走 _dispatch(root.after)

对外动作方法（9 个，对应 IPC 端点）：
  show() / enter_select() / add_result(...) / clear()
  set_language(code) / set_show_source(show) / set_font_size(size)
  toggle_subtitle() / collapse() / close()

便捷别名（供 translate_tray 替换原 translate_result_window 的调用）：
  set_status(text, color)
  show_loading(card_id, hint)
  show_error(error)
  show_translation(card_id, source, target, lang_label, mode)
"""
from __future__ import annotations

import logging
import threading
import time
import tkinter as tk
from typing import Any, Callable, Optional

from .translate_result_window import _ensure_tk_thread

LOG = logging.getLogger("translate_tray.pin_panel")

# ---- 配色（与 translate_result_window 保持一致） ----
BG = "#0f172a"
BG_PANEL = "#1e293b"
BG_CARD = "#1e293b"
BORDER = "#334155"
FG = "#f1f5f9"
FG_MUTED = "#94a3b8"
ACCENT = "#38bdf8"
SUCCESS = "#22c55e"
ERROR = "#f87171"
WARN = "#fbbf24"
SOURCE_FG = "#cbd5e1"

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

FONT_SIZE_OPTIONS: list[tuple[str, int]] = [
    ("小", 10),
    ("中", 13),
    ("大", 16),
]

PANEL_GEOMETRY: tuple[int, int] = (420, 560)


def _label_for_lang(code: str) -> str:
    return LANG_LABELS.get(code, code or "?")


# ============================================================
# 单卡片
# ============================================================

class _Card(tk.Frame):
    """单条翻译结果卡片。"""

    def __init__(
        self,
        master: tk.Misc,
        card_id: str,
        source_text: str,
        target_text: str,
        lang_label: str,
        mode: str,
        show_source: bool,
        font_size: int,
        on_close: Callable[[str], None],
    ) -> None:
        super().__init__(master, bg=BG_CARD, bd=0, highlightthickness=1,
                         highlightbackground=BORDER, highlightcolor=BORDER)
        self._card_id = card_id
        self._show_source = show_source
        self._font_size = font_size
        self._on_close = on_close
        self._source_text = source_text or ""
        self._target_text = target_text or ""
        self._lang_label = lang_label or "—"
        self._mode = mode or "live"

        self._src_text: Optional[tk.Text] = None
        self._tgt_text: Optional[tk.Text] = None
        self._mode_label: Optional[tk.Label] = None

        self._build()

    # ---- 构建 ----
    def _build(self) -> None:
        # 顶部小行：语言 / 模式 / 关闭
        head = tk.Frame(self, bg=BG_CARD)
        head.pack(fill=tk.X, padx=10, pady=6)

        mode_text = self._mode_text()
        self._mode_label = tk.Label(
            head, text=f"{self._lang_label} · {mode_text}",
            bg=BG_CARD, fg=FG_MUTED, font=("Microsoft YaHei UI", 8),
        )
        self._mode_label.pack(side=tk.LEFT)

        close_btn = tk.Label(
            head, text="✕", bg=BG_CARD, fg=FG_MUTED,
            font=("Microsoft YaHei UI", 9), cursor="hand2",
        )
        close_btn.pack(side=tk.RIGHT)
        close_btn.bind("<Button-1>", lambda _e: self._on_close(self._card_id))

        # 译文（主区）
        self._tgt_text = tk.Text(
            self, wrap=tk.WORD, bd=0, bg=BG_CARD, fg=FG,
            font=("Microsoft YaHei UI", self._font_size),
            highlightthickness=0, padx=10, pady=4,
            height=max(2, self._estimate_height(self._target_text_for_display())),
        )
        self._tgt_text.pack(fill=tk.X, padx=0, pady=2)
        self._tgt_text.insert("1.0", self._target_text_for_display())
        self._tgt_text.configure(state=tk.DISABLED)

        # 原文（可隐藏）
        if self._show_source and self._source_text:
            self._src_text = tk.Text(
                self, wrap=tk.WORD, bd=0, bg=BG_CARD, fg=SOURCE_FG,
                font=("Microsoft YaHei UI", max(8, self._font_size - 2)),
                highlightthickness=0, padx=10, pady=4, height=2,
            )
            self._src_text.pack(fill=tk.X, padx=0, pady=(0, 6))
            self._src_text.insert("1.0", self._source_text)
            self._src_text.configure(state=tk.DISABLED)

    def _target_text_for_display(self) -> str:
        return self._target_text or ""

    @staticmethod
    def _estimate_height(text: str) -> int:
        if not text:
            return 2
        lines = text.count("\n") + 1
        return max(2, min(lines + 1, 12))

    def _mode_text(self) -> str:
        if self._mode == "continuous":
            return "连续"
        if self._mode == "smart":
            return "智能"
        if self._mode == "text":
            return "文本"
        if self._mode == "loading":
            return "识别中"
        if self._mode == "error":
            return "错误"
        return "实时"

    # ---- 外部 API ----
    def set_font_size(self, size: int) -> None:
        self._font_size = size
        if self._tgt_text is not None:
            try:
                self._tgt_text.configure(font=("Microsoft YaHei UI", size))
            except Exception:
                pass
        if self._src_text is not None:
            try:
                self._src_text.configure(font=("Microsoft YaHei UI", max(8, size - 2)))
            except Exception:
                pass

    def set_show_source(self, show: bool) -> None:
        if show == self._show_source:
            return
        self._show_source = show
        if show and self._source_text and self._src_text is None:
            # 重新构建整个卡片，最简单可靠
            self._rebuild()
        elif not show and self._src_text is not None:
            try:
                self._src_text.destroy()
            except Exception:
                pass
            self._src_text = None

    def update_content(
        self,
        source_text: Optional[str] = None,
        target_text: Optional[str] = None,
        lang_label: Optional[str] = None,
        mode: Optional[str] = None,
    ) -> None:
        if source_text is not None:
            self._source_text = source_text
        if target_text is not None:
            self._target_text = target_text
            if self._tgt_text is not None:
                try:
                    self._tgt_text.configure(state=tk.NORMAL)
                    self._tgt_text.delete("1.0", tk.END)
                    self._tgt_text.insert("1.0", target_text)
                    self._tgt_text.configure(state=tk.DISABLED)
                except Exception:
                    LOG.exception("更新译文失败")
        if lang_label is not None:
            self._lang_label = lang_label
        if mode is not None:
            self._mode = mode
        if self._mode_label is not None:
            try:
                self._mode_label.configure(text=f"{self._lang_label} · {self._mode_text()}")
            except Exception:
                pass

    def _rebuild(self) -> None:
        for child in self.winfo_children():
            try:
                child.destroy()
            except Exception:
                pass
        self._src_text = None
        self._tgt_text = None
        self._mode_label = None
        self._build()


# ============================================================
# 主面板
# ============================================================

class PinPanel:
    """翻译主面板（单例）。所有 UI 操作都在 Tk worker 线程里执行。"""

    _instance: Optional["PinPanel"] = None
    _instance_lock = threading.Lock()

    def __init__(
        self,
        on_select_request: Optional[Callable[[], None]] = None,
        on_language_change: Optional[Callable[[str], None]] = None,
        on_show_source_change: Optional[Callable[[bool], None]] = None,
        on_font_size_change: Optional[Callable[[int], None]] = None,
        on_subtitle_toggle: Optional[Callable[[], None]] = None,
        on_smart_detect_toggle: Optional[Callable[[bool], None]] = None,
        on_close_request: Optional[Callable[[], None]] = None,
    ) -> None:
        self._on_select_request = on_select_request
        self._on_language_change = on_language_change
        self._on_show_source_change = on_show_source_change
        self._on_font_size_change = on_font_size_change
        self._on_subtitle_toggle = on_subtitle_toggle
        self._on_smart_detect_toggle = on_smart_detect_toggle
        self._on_close_request = on_close_request

        # 状态
        self._target_lang: str = "zh"
        self._show_source: bool = False
        self._font_size: int = FONT_SIZE_OPTIONS[1][1]
        self._subtitle_visible: bool = False
        self._smart_detect_on: bool = False

        # Tk 控件
        self._root: Optional[tk.Toplevel] = None
        self._canvas: Optional[tk.Canvas] = None
        self._inner: Optional[tk.Frame] = None
        self._empty_label: Optional[tk.Label] = None
        self._status_label: Optional[tk.Label] = None
        self._lang_mb: Optional[tk.Menubutton] = None
        self._font_mb: Optional[tk.Menubutton] = None
        self._src_btn: Optional[tk.Label] = None
        self._subtitle_btn: Optional[tk.Label] = None
        self._smart_detect_btn: Optional[tk.Label] = None

        self._cards: dict[str, _Card] = {}

    # ---- 单例 ----
    @classmethod
    def get(cls) -> "PinPanel":
        with cls._instance_lock:
            if cls._instance is None:
                cls._instance = PinPanel()
                cls._instance._build()
            return cls._instance

    @classmethod
    def configure(
        cls,
        on_select_request: Optional[Callable[[], None]] = None,
        on_language_change: Optional[Callable[[str], None]] = None,
        on_show_source_change: Optional[Callable[[bool], None]] = None,
        on_font_size_change: Optional[Callable[[int], None]] = None,
        on_subtitle_toggle: Optional[Callable[[], None]] = None,
        on_smart_detect_toggle: Optional[Callable[[bool], None]] = None,
        on_close_request: Optional[Callable[[], None]] = None,
    ) -> "PinPanel":
        # 注意：不能在这里调 cls.get()，因为 get() 也会 acquire _instance_lock，
        # 而 threading.Lock 不可重入，会死锁。直接在锁内内联单例创建逻辑。
        with cls._instance_lock:
            if cls._instance is None:
                cls._instance = PinPanel()
                cls._instance._build()
            inst = cls._instance
            if on_select_request is not None:
                inst._on_select_request = on_select_request
            if on_language_change is not None:
                inst._on_language_change = on_language_change
            if on_show_source_change is not None:
                inst._on_show_source_change = on_show_source_change
            if on_font_size_change is not None:
                inst._on_font_size_change = on_font_size_change
            if on_subtitle_toggle is not None:
                inst._on_subtitle_toggle = on_subtitle_toggle
            if on_smart_detect_toggle is not None:
                inst._on_smart_detect_toggle = on_smart_detect_toggle
            if on_close_request is not None:
                inst._on_close_request = on_close_request
            return inst

    # ---- Tk 线程桥 ----
    def _dispatch(self, fn: Callable[[], None]) -> None:
        try:
            root = _ensure_tk_thread()
            root.after(0, fn)
        except Exception:
            LOG.exception("派发到 Tk 失败")

    def _alive(self) -> bool:
        try:
            return bool(self._root) and bool(self._root.winfo_exists())
        except Exception:
            return False

    def _ensure_visible_impl(self) -> None:
        if self._root is None:
            return
        try:
            self._root.deiconify()
            self._root.lift()
        except Exception:
            pass

    def _withdraw_impl(self) -> None:
        if self._root is not None and self._alive():
            try:
                self._root.withdraw()
            except Exception:
                pass

    def _ensure_visible(self) -> None:
        self._dispatch(self._ensure_visible_impl)

    # ---- 构建 ----
    def _build(self) -> None:
        root = _ensure_tk_thread()
        done = threading.Event()
        err: list[BaseException] = []

        def _build_impl() -> None:
            try:
                if self._root is not None and self._alive():
                    return
                self._root = tk.Toplevel(root)
                self._build_ui()
                # 默认隐藏：仅在 show() / add_result() / IPC 唤起时才显示
                try:
                    self._root.withdraw()
                except Exception:
                    pass
            except BaseException as e:
                err.append(e)
            finally:
                done.set()

        root.after(0, _build_impl)
        if not done.wait(timeout=10):
            raise RuntimeError("构建 PinPanel 超时")
        if err:
            raise err[0]

    def _build_ui(self) -> None:
        root = self._root
        assert root is not None
        root.title("屏幕翻译")
        try:
            root.attributes("-topmost", True)
        except Exception:
            pass
        try:
            root.attributes("-toolwindow", True)
        except Exception:
            pass
        root.configure(bg=BG)
        root.resizable(True, True)
        root.minsize(320, 200)
        root.protocol("WM_DELETE_WINDOW", self._on_window_close_clicked)

        w, h = PANEL_GEOMETRY
        try:
            sw = root.winfo_screenwidth()
            sh = root.winfo_screenheight()
            x = max(20, sw - w - 24)
            y = max(20, (sh - h) // 2)
            root.geometry(f"{w}x{h}+{x}+{y}")
        except Exception:
            root.geometry(f"{w}x{h}")

        # 工具栏
        toolbar = tk.Frame(root, bg=BG_PANEL, height=36)
        toolbar.pack(fill=tk.X, side=tk.TOP)
        toolbar.pack_propagate(False)

        # 拖动
        def _start_move(e: tk.Event) -> None:
            root._drag_x = e.x_root - root.winfo_x()  # type: ignore[attr-defined]
            root._drag_y = e.y_root - root.winfo_y()  # type: ignore[attr-defined]

        def _do_move(e: tk.Event) -> None:
            try:
                root.geometry(f"+{e.x_root - root._drag_x}+{e.y_root - root._drag_y}")  # type: ignore[attr-defined]
            except Exception:
                pass

        toolbar.bind("<ButtonPress-1>", _start_move)
        toolbar.bind("<B1-Motion>", _do_move)

        # ✚ 框选
        select_btn = tk.Label(
            toolbar, text="✚ 框选", bg=BG_PANEL, fg=ACCENT,
            font=("Microsoft YaHei UI", 10, "bold"), padx=10, pady=4, cursor="hand2",
        )
        select_btn.pack(side=tk.LEFT, padx=(6, 2))
        select_btn.bind("<Button-1>", lambda _e: self.enter_select())

        # 🌐 翻译为 ▼
        lang_menu = tk.Menu(root, tearoff=0)
        for code, label in LANG_LABELS.items():
            lang_menu.add_command(
                label=label,
                command=lambda c=code: self._on_lang_picked(c),
            )
        self._lang_mb = tk.Menubutton(
            toolbar,
            text=f"🌐 {_label_for_lang(self._target_lang)} ▼",
            fg=FG, bg=BG_PANEL, activebackground=BORDER, activeforeground=FG,
            relief="flat", bd=0, padx=8, pady=4,
            font=("Microsoft YaHei UI", 9), cursor="hand2",
            menu=lang_menu,
        )
        self._lang_mb.pack(side=tk.LEFT, padx=2)

        # 👁 原文
        self._src_btn = tk.Label(
            toolbar, text="👁 原文", bg=BG_PANEL, fg=FG_MUTED,
            font=("Microsoft YaHei UI", 9), padx=8, pady=4, cursor="hand2",
        )
        self._src_btn.pack(side=tk.LEFT, padx=2)
        self._src_btn.bind("<Button-1>", lambda _e: self._toggle_show_source_from_btn())

        # Aa 字号 ▼
        font_menu = tk.Menu(root, tearoff=0)
        for label, size in FONT_SIZE_OPTIONS:
            font_menu.add_command(
                label=label,
                command=lambda s=size, l=label: self._on_font_picked(s, l),
            )
        self._font_mb = tk.Menubutton(
            toolbar, text=f"Aa {_font_label_for_size(self._font_size)} ▼",
            fg=FG, bg=BG_PANEL, activebackground=BORDER, activeforeground=FG,
            relief="flat", bd=0, padx=8, pady=4,
            font=("Microsoft YaHei UI", 9), cursor="hand2",
            menu=font_menu,
        )
        self._font_mb.pack(side=tk.LEFT, padx=2)

        # 📺 字幕
        self._subtitle_btn = tk.Label(
            toolbar, text="📺 字幕", bg=BG_PANEL, fg=FG_MUTED,
            font=("Microsoft YaHei UI", 9), padx=8, pady=4, cursor="hand2",
        )
        self._subtitle_btn.pack(side=tk.LEFT, padx=2)
        self._subtitle_btn.bind("<Button-1>", lambda _e: self.toggle_subtitle())

        # 🔍 智能检测（鼠标悬停即译）
        self._smart_detect_btn = tk.Label(
            toolbar, text="🔍 检测", bg=BG_PANEL, fg=FG_MUTED,
            font=("Microsoft YaHei UI", 9), padx=8, pady=4, cursor="hand2",
        )
        self._smart_detect_btn.pack(side=tk.LEFT, padx=2)
        self._smart_detect_btn.bind("<Button-1>", lambda _e: self.toggle_smart_detect())

        # 间隔
        sep = tk.Frame(toolbar, bg=BORDER, width=1)
        sep.pack(side=tk.LEFT, padx=6, pady=8, fill=tk.Y)

        # ✕
        close_btn = tk.Label(
            toolbar, text="✕", bg=BG_PANEL, fg=FG_MUTED,
            font=("Microsoft YaHei UI", 10), padx=10, pady=4, cursor="hand2",
        )
        close_btn.pack(side=tk.RIGHT)
        close_btn.bind("<Button-1>", lambda _e: self._on_window_close_clicked())

        # 状态提示行
        self._status_label = tk.Label(
            root, text="", bg=BG, fg=FG_MUTED, anchor="w",
            font=("Microsoft YaHei UI", 8), padx=10, pady=2,
        )
        self._status_label.pack(fill=tk.X, side=tk.TOP)

        # 结果区：Canvas + 内 Frame + 滚动
        body = tk.Frame(root, bg=BG)
        body.pack(fill=tk.BOTH, expand=True)

        self._canvas = tk.Canvas(body, bg=BG, bd=0, highlightthickness=0)
        scroll = tk.Scrollbar(body, orient=tk.VERTICAL, command=self._canvas.yview)
        self._canvas.configure(yscrollcommand=scroll.set)
        scroll.pack(side=tk.RIGHT, fill=tk.Y)
        self._canvas.pack(side=tk.LEFT, fill=tk.BOTH, expand=True)

        self._inner = tk.Frame(self._canvas, bg=BG)
        self._inner.bind(
            "<Configure>",
            lambda e: self._canvas.configure(scrollregion=self._canvas.bbox("all")),
        )
        self._canvas.create_window((0, 0), window=self._inner, anchor="nw")

        # 鼠标滚轮
        def _on_wheel(e: tk.Event) -> None:
            try:
                self._canvas.yview_scroll(int(-1 * (e.delta / 120)), "units")
            except Exception:
                pass
        self._canvas.bind("<Enter>", lambda _e: self._canvas.bind_all("<MouseWheel>", _on_wheel))
        self._canvas.bind("<Leave>", lambda _e: self._canvas.unbind_all("<MouseWheel>"))

        # 空态
        self._empty_label = tk.Label(
            self._inner, text="点击 ✚ 框选 开始翻译\n或按 Ctrl+Shift+T",
            bg=BG, fg=FG_MUTED, font=("Microsoft YaHei UI", 10), pady=40,
        )
        self._empty_label.pack(fill=tk.X)

    # ---- 工具栏回调 ----
    def _on_lang_picked(self, code: str) -> None:
        self.set_language(code)

    def _on_font_picked(self, size: int, label: str) -> None:
        self.set_font_size(size)

    def _toggle_show_source_from_btn(self) -> None:
        self.set_show_source(not self._show_source)

    def _on_window_close_clicked(self) -> None:
        self.close()

    # ---- 公共动作（对应 9 个 IPC 端点） ----

    def show(self) -> None:
        """唤起面板（首次会构建）。"""
        try:
            # 不跨线程调 _alive()/winfo_exists()（会与 Tcl 死锁）；
            # _build_impl 在 Tk 线程内会再用 _alive() 兜底判重
            if self._root is None:
                self._build()
        except Exception:
            LOG.exception("PinPanel.show 构建 UI 失败")
            return
        self._ensure_visible()

    def enter_select(self) -> None:
        """触发框选翻译：先隐藏面板 → 调 on_select_request → 主面板在结果回来时重现。"""
        # withdraw 必须在 Tk 线程内执行，跨线程调用会与 Tcl 解释器死锁
        self._dispatch(self._withdraw_impl)
        if self._on_select_request is not None:
            try:
                self._on_select_request()
            except Exception:
                LOG.exception("on_select_request 回调失败")
        else:
            # 没注册回调，2s 后自动恢复显示
            self._dispatch(lambda: self._root.after(2000, self._ensure_visible_impl) if self._root else None)

    def add_result(
        self,
        card_id: str,
        source_text: str,
        target_text: str,
        lang_label: Optional[str] = None,
        mode: str = "live",
    ) -> None:
        """添加或更新一张卡片；最新在顶部。"""
        if not card_id:
            card_id = f"r-{int(time.time() * 1000)}"
        label = lang_label or _label_for_lang(self._target_lang)
        # 调用方可能在任意线程，UI 操作派发到 Tk 线程
        self._dispatch(lambda: self._add_result_impl(card_id, source_text, target_text, label, mode))
        # 顺便让面板可见
        self._ensure_visible()

    def _add_result_impl(
        self,
        card_id: str,
        source_text: str,
        target_text: str,
        lang_label: str,
        mode: str,
    ) -> None:
        if self._inner is None:
            return
        # 隐藏空态
        if self._empty_label is not None:
            try:
                self._empty_label.pack_forget()
            except Exception:
                pass

        if card_id in self._cards:
            card = self._cards[card_id]
            try:
                card.update_content(
                    source_text=source_text,
                    target_text=target_text,
                    lang_label=lang_label,
                    mode=mode,
                )
            except Exception:
                LOG.exception("更新卡片失败")
            self._sync_subtitle(source_text, target_text)
            return

        card = _Card(
            self._inner,
            card_id=card_id,
            source_text=source_text,
            target_text=target_text,
            lang_label=lang_label,
            mode=mode,
            show_source=self._show_source,
            font_size=self._font_size,
            on_close=self._remove_card_impl,
        )
        # 新卡片插到顶部（空态之后、其他卡片之前）
        first = self._inner.winfo_children()[0] if self._inner.winfo_children() else None
        # 跳过 empty_label
        if first is self._empty_label and len(self._inner.winfo_children()) > 1:
            first = self._inner.winfo_children()[1]
        try:
            if first is None or first is self._empty_label:
                card.pack(fill=tk.X, padx=8, pady=8)
            else:
                card.pack(fill=tk.X, padx=8, pady=8, before=first)
        except Exception:
            card.pack(fill=tk.X, padx=8, pady=8)
        self._cards[card_id] = card
        self._sync_subtitle(source_text, target_text)

    def _sync_subtitle(self, source_text: str, target_text: str) -> None:
        """字幕窗口可见时，同步最新译文。在 Tk 线程内被调。"""
        if not self._subtitle_visible:
            return
        try:
            from . import subtitle_window
            subtitle_window.set_subtitle_text(target=target_text, source=source_text)
        except Exception:
            LOG.exception("同步字幕窗口失败")

    def _remove_card_impl(self, card_id: str) -> None:
        card = self._cards.pop(card_id, None)
        if card is None:
            return
        try:
            card.destroy()
        except Exception:
            pass
        if not self._cards and self._empty_label is not None:
            try:
                self._empty_label.pack(fill=tk.X)
            except Exception:
                pass

    def clear(self) -> None:
        self._dispatch(self._clear_impl)

    def _clear_impl(self) -> None:
        for card in list(self._cards.values()):
            try:
                card.destroy()
            except Exception:
                pass
        self._cards.clear()
        if self._empty_label is not None and self._inner is not None:
            try:
                self._empty_label.pack(fill=tk.X)
            except Exception:
                pass

    def set_language(self, code: str) -> None:
        code = (code or "zh").strip() or "zh"
        if code == self._target_lang:
            return
        self._target_lang = code
        self._dispatch(self._refresh_lang_label)
        if self._on_language_change is not None:
            try:
                self._on_language_change(code)
            except Exception:
                LOG.exception("on_language_change 回调失败")

    def _refresh_lang_label(self) -> None:
        if self._lang_mb is not None:
            try:
                self._lang_mb.configure(text=f"🌐 {_label_for_lang(self._target_lang)} ▼")
            except Exception:
                pass

    def set_show_source(self, show: bool) -> None:
        show = bool(show)
        if show == self._show_source:
            return
        self._show_source = show
        self._dispatch(self._apply_show_source)
        if self._on_show_source_change is not None:
            try:
                self._on_show_source_change(show)
            except Exception:
                LOG.exception("on_show_source_change 回调失败")

    def _apply_show_source(self) -> None:
        if self._src_btn is not None:
            try:
                self._src_btn.configure(fg=ACCENT if self._show_source else FG_MUTED)
            except Exception:
                pass
        for card in self._cards.values():
            try:
                card.set_show_source(self._show_source)
            except Exception:
                pass

    def set_font_size(self, size: int) -> None:
        # 找最近档位
        for _, v in FONT_SIZE_OPTIONS:
            if v == size:
                self._font_size = size
                break
        else:
            self._font_size = FONT_SIZE_OPTIONS[1][1]
        self._dispatch(self._apply_font_size)
        if self._on_font_size_change is not None:
            try:
                self._on_font_size_change(self._font_size)
            except Exception:
                LOG.exception("on_font_size_change 回调失败")

    def _apply_font_size(self) -> None:
        if self._font_mb is not None:
            try:
                self._font_mb.configure(text=f"Aa {_font_label_for_size(self._font_size)} ▼")
            except Exception:
                pass
        for card in self._cards.values():
            try:
                card.set_font_size(self._font_size)
            except Exception:
                pass

    def toggle_subtitle(self) -> None:
        self._subtitle_visible = not self._subtitle_visible
        self._dispatch(self._apply_subtitle_btn)
        # 真正显示/隐藏字幕窗口
        try:
            from . import subtitle_window
            if self._subtitle_visible:
                subtitle_window.show_subtitle()
            else:
                subtitle_window.hide_subtitle()
        except Exception:
            LOG.exception("切换字幕窗口失败")
        if self._on_subtitle_toggle is not None:
            try:
                self._on_subtitle_toggle()
            except Exception:
                LOG.exception("on_subtitle_toggle 回调失败")

    def _apply_subtitle_btn(self) -> None:
        if self._subtitle_btn is not None:
            try:
                self._subtitle_btn.configure(
                    fg=ACCENT if self._subtitle_visible else FG_MUTED
                )
            except Exception:
                pass

    def toggle_smart_detect(self) -> None:
        """切换智能检测（鼠标悬停即译）。"""
        self._smart_detect_on = not self._smart_detect_on
        self._dispatch(self._apply_smart_detect_btn)
        if self._on_smart_detect_toggle is not None:
            try:
                self._on_smart_detect_toggle(self._smart_detect_on)
            except Exception:
                LOG.exception("on_smart_detect_toggle 回调失败")

    def _apply_smart_detect_btn(self) -> None:
        if self._smart_detect_btn is not None:
            try:
                self._smart_detect_btn.configure(
                    fg=ACCENT if self._smart_detect_on else FG_MUTED
                )
            except Exception:
                pass

    def collapse(self) -> None:
        """折叠：缩到很小的尺寸，保留工具栏可用。再次 show() 恢复。"""
        if self._root is None or not self._alive():
            return
        try:
            self._root.geometry(f"{PANEL_GEOMETRY[0]}x48")
        except Exception:
            pass

    def close(self) -> None:
        """关闭并销毁面板（不退出整个托盘）。"""
        with PinPanel._instance_lock:
            if self._root is not None:
                try:
                    self._root.destroy()
                except Exception:
                    pass
            self._root = None
            self._cards.clear()
            self._canvas = None
            self._inner = None
            self._empty_label = None
            self._status_label = None
            self._lang_mb = None
            self._font_mb = None
            self._src_btn = None
            self._subtitle_btn = None
            self._smart_detect_btn = None
            if PinPanel._instance is self:
                PinPanel._instance = None
        if self._on_close_request is not None:
            try:
                self._on_close_request()
            except Exception:
                LOG.exception("on_close_request 回调失败")

    # ---- 状态行 ----
    def set_status(self, text: str, color: str = FG_MUTED) -> None:
        self._dispatch(lambda: self._set_status_impl(text, color))

    def _set_status_impl(self, text: str, color: str) -> None:
        if self._status_label is not None:
            try:
                self._status_label.configure(text=text or "", fg=color)
            except Exception:
                pass

    # ---- 便捷别名（供 translate_tray 直接替换 translate_result_window 调用） ----
    def show_loading(self, hint: str = "正在识别并翻译...", card_id: str = "__loading__") -> None:
        self.add_result(
            card_id=card_id,
            source_text="正在识别...",
            target_text=hint or "正在翻译...",
            lang_label="—",
            mode="loading",
        )

    def show_error(self, error: str) -> None:
        self.add_result(
            card_id=f"err-{int(time.time() * 1000)}",
            source_text="—",
            target_text=f"❌ {error}",
            lang_label="—",
            mode="error",
        )

    def show_translation(
        self,
        source_text: str,
        translated_text: str,
        target_lang_label: str = "中文",
        translated_by: str = "llm",
        card_id: Optional[str] = None,
        mode: str = "live",
    ) -> None:
        cid = card_id or f"r-{int(time.time() * 1000)}"
        self.add_result(
            card_id=cid,
            source_text=source_text,
            target_text=translated_text,
            lang_label=target_lang_label,
            mode=mode,
        )

    # ---- 给外部读状态用 ----
    def get_target_lang(self) -> str:
        return self._target_lang

    def get_font_size(self) -> int:
        return self._font_size

    def get_show_source(self) -> bool:
        return self._show_source

    def get_subtitle_visible(self) -> bool:
        return self._subtitle_visible


# ============================================================
# 模块级便捷函数（保持与 translate_result_window 类似的调用风格）
# ============================================================

def _font_label_for_size(size: int) -> str:
    for label, v in FONT_SIZE_OPTIONS:
        if v == size:
            return label
    return "中"


def get_panel() -> PinPanel:
    return PinPanel.get()


def set_status(text: str, color: str = FG_MUTED) -> None:
    PinPanel.get().set_status(text, color)


def show_loading(hint: str = "正在识别并翻译...", card_id: str = "__loading__") -> None:
    PinPanel.get().show_loading(hint, card_id)


def show_error(error: str) -> None:
    PinPanel.get().show_error(error)


def show_translation(
    source_text: str,
    translated_text: str,
    target_lang_label: str = "中文",
    translated_by: str = "llm",
    card_id: Optional[str] = None,
    mode: str = "live",
) -> None:
    PinPanel.get().show_translation(
        source_text=source_text,
        translated_text=translated_text,
        target_lang_label=target_lang_label,
        translated_by=translated_by,
        card_id=card_id,
        mode=mode,
    )


def clear_all() -> None:
    PinPanel.get().clear()
