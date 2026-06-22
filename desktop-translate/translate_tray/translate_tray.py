r"""
屏幕翻译托盘应用（独立模块，已与 desktop-visual 解耦）：
  - 系统托盘图标 + 菜单
  - 全局热键
      Ctrl+Shift+T   Live 模式：反复框选并翻译（每选一次就出一张新卡片）
      Ctrl+Shift+R   Continuous 模式：定一个区域，每隔 N 秒自动 OCR + 翻译
      Ctrl+Shift+C   清空悬浮窗
      Esc            退出当前模式
  - 截屏 → 主服务 `/api/translate/screen-region`（OCR + 翻译）→ 悬浮结果窗
  - 所有结果合并到**一个独立的悬浮窗**内（不依赖 desktop-visual / Flutter 应用）

启动：
  python -m translate_tray
  # 或者在仓库根目录：powershell -ExecutionPolicy Bypass -File .\start-translate.ps1
"""
from __future__ import annotations

import argparse
import logging
import os
import signal
import threading
import time
import uuid
from typing import Optional

LOG = logging.getLogger("translate_tray")


def _build_tray_icon_image():
    """生成一个简单的托盘图标：蓝底圆形 + 文字 译。"""
    from PIL import Image, ImageDraw, ImageFont

    size = 64
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    draw.ellipse((2, 2, size - 2, size - 2), fill=(56, 189, 248, 255))
    try:
        font = ImageFont.truetype("arial.ttf", 36)
    except Exception:
        try:
            font = ImageFont.truetype("msyh.ttc", 36)
        except Exception:
            font = ImageFont.load_default()
    text = "译"
    try:
        bbox = draw.textbbox((0, 0), text, font=font)
        tw = bbox[2] - bbox[0]
        th = bbox[3] - bbox[1]
    except Exception:
        tw, th = 24, 30
    draw.text(
        ((size - tw) / 2 - 2, (size - th) / 2 - 6),
        text,
        fill=(15, 23, 42, 255),
        font=font,
    )
    return img


def _parse_hotkey(raw: str) -> str:
    """把 'Ctrl+Shift+T' 转成 pynput 期望的 '<ctrl>+<shift>+t' 形式。"""
    s = (raw or "").strip()
    if not s:
        return "<ctrl>+<shift>+t"
    if "<" in s and ">" in s:
        return s.lower()
    parts = [p.strip() for p in s.replace(" ", "").split("+") if p.strip()]
    mapped: list[str] = []
    for p in parts:
        pl = p.lower()
        if pl in ("ctrl", "control"):
            mapped.append("<ctrl>")
        elif pl == "shift":
            mapped.append("<shift>")
        elif pl == "alt":
            mapped.append("<alt>")
        elif pl in ("win", "meta", "cmd", "super"):
            mapped.append("<cmd>")
        else:
            mapped.append(pl)
    return "+".join(mapped)


class TranslateTrayApp:
    def __init__(
        self,
        hotkey: str = "<ctrl>+<shift>+t",
        continuous_hotkey: str = "<ctrl>+<shift>+r",
        clear_hotkey: str = "<ctrl>+<shift>+c",
        target_lang: str = "zh",
        source_lang: str = "en",
        base_url: Optional[str] = None,
        continuous_interval_s: float = 2.0,
    ) -> None:
        self.hotkey = hotkey
        self.continuous_hotkey = continuous_hotkey
        self.clear_hotkey = clear_hotkey
        self.target_lang = target_lang
        self.source_lang = source_lang
        self.base_url = base_url
        self.continuous_interval_s = continuous_interval_s

        self._tray_icon = None
        self._keyboard_listener = None
        self._stop_event = threading.Event()

        # 状态：live 模式 / continuous 模式
        self._live_session = None
        self._continuous_capture = None
        self._continuous_card_id: Optional[str] = None
        self._continuous_lock = threading.Lock()
        self._last_continuous_signature: str = ""  # 用于去重相同内容
        self._inflight_continuous = False

        # 幂等：避免翻译请求并发
        self._inflight_lock = threading.Lock()
        self._inflight: set[str] = set()

    # ---------- 主流程 ----------

    def start(self, once: bool = False) -> None:
        from .translate_api_client import TranslateApiClient
        from . import translate_result_window

        self.api_client = TranslateApiClient(base_url=self.base_url)
        # 提前启动 Tk 事件循环
        translate_result_window._ensure_tk_thread()

        if once:
            self._trigger_live_once()
            return

        self._start_keyboard_listener()
        self._run_tray()

    def stop(self) -> None:
        self._stop_event.set()
        try:
            if self._live_session is not None and self._live_session.running:
                self._live_session.stop()
        except Exception:
            pass
        try:
            if self._continuous_capture is not None and self._continuous_capture.running:
                self._continuous_capture.stop()
        except Exception:
            pass
        try:
            if self._keyboard_listener is not None:
                self._keyboard_listener.stop()
        except Exception:
            pass
        try:
            if self._tray_icon is not None:
                self._tray_icon.stop()
        except Exception:
            pass

    # ---------- Live 模式（反复拖选） ----------

    def _trigger_live_once(self) -> None:
        """单次模式：截一次后退出（调试用）。"""
        from .translate_result_window import (
            show_error,
            show_loading,
            show_translation,
        )
        from .translate_snipping import capture_region

        def _worker() -> None:
            png = capture_region()
            if png is None:
                return
            show_loading("正在识别并翻译...")
            self._translate_and_show(png, card_id=f"live-{uuid.uuid4().hex[:8]}")

        threading.Thread(target=_worker, daemon=True, name="live-once").start()

    def _enter_live_mode(self) -> None:
        """进入 Live 模式：持续显示选区蒙版，每次选完回调翻译。"""
        from .translate_snipping import LiveSession
        from .translate_result_window import set_status

        if self._live_session is not None and self._live_session.running:
            LOG.info("已在 Live 模式")
            return
        # 同时只能跑一个模式
        self._exit_continuous_mode()

        set_status("Live 模式：拖选翻译 · Esc 退出", color="#22c55e")

        def _on_select(png: bytes) -> None:
            from .translate_result_window import show_loading
            card_id = f"live-{uuid.uuid4().hex[:8]}"
            show_loading("正在识别并翻译...", card_id=card_id)
            self._translate_and_show(png, card_id=card_id)

        def _on_cancel() -> None:
            from .translate_result_window import set_status
            set_status("Live 模式已退出", color="#94a3b8")
            self._live_session = None

        self._live_session = LiveSession()
        self._live_session.start(_on_select, _on_cancel)

    def _exit_live_mode(self) -> None:
        if self._live_session is not None and self._live_session.running:
            self._live_session.stop()
        self._live_session = None
        from .translate_result_window import set_status
        set_status("Live 模式已退出", color="#94a3b8")

    # ---------- Continuous 模式（连续 OCR） ----------

    def _enter_continuous_mode(self) -> None:
        """进入 Continuous 模式：先让用户定一个区域，然后每 N 秒自动 OCR + 翻译。"""
        from .translate_snipping import define_region
        from .translate_result_window import set_status, show_error

        if self._continuous_capture is not None and self._continuous_capture.running:
            LOG.info("已在 Continuous 模式")
            return
        # 同时只能跑一个模式
        self._exit_live_mode()

        # 让用户先定一个区域
        region = define_region()
        if region is None:
            return
        x, y, w, h = region
        if w < 8 or h < 8:
            show_error("所选区域太小，请重新选择")
            return

        set_status(f"Continuous 模式：每 {self.continuous_interval_s:.1f}s 自动翻译 · Esc 退出", color="#a78bfa")
        self._continuous_card_id = f"continuous-{uuid.uuid4().hex[:8]}"
        self._last_continuous_signature = ""

        from .translate_result_window import show_loading
        show_loading("正在初始化连续模式...", card_id=self._continuous_card_id)

        # 启 worker
        from .translate_snipping import start_continuous_capture
        with self._continuous_lock:
            self._continuous_capture = start_continuous_capture(
                region=region,
                on_update=self._on_continuous_update,
                interval_s=self.continuous_interval_s,
            )

    def _exit_continuous_mode(self) -> None:
        with self._continuous_lock:
            if self._continuous_capture is not None and self._continuous_capture.running:
                self._continuous_capture.stop()
            self._continuous_capture = None
        from .translate_result_window import set_status
        set_status("Continuous 模式已退出", color="#94a3b8")

    def _on_continuous_update(self, png: bytes) -> None:
        # 用图像 hash 简单去重（连续两次内容相同就不重复请求翻译）
        sig = self._quick_image_signature(png)
        if sig == self._last_continuous_signature:
            return
        self._last_continuous_signature = sig

        from .translate_result_window import show_loading
        if self._continuous_card_id:
            show_loading("正在识别并翻译...", card_id=self._continuous_card_id)
        self._translate_and_show(png, card_id=self._continuous_card_id, mode="continuous")

    @staticmethod
    def _quick_image_signature(png: bytes) -> str:
        """基于像素和的快速签名（避免连续模式下 OCR 重复）。"""
        try:
            from PIL import Image
            import io
            img = Image.open(io.BytesIO(png)).convert("L").resize((32, 32))
            data = list(img.getdata())
            avg = sum(data) / len(data)
            bits = "".join("1" if p > avg else "0" for p in data)
            # 16 chars
            return f"{sum(data)}-{bits[:16]}"
        except Exception:
            return str(len(png))

    # ---------- 翻译核心 ----------

    def _translate_and_show(
        self,
        png: bytes,
        card_id: Optional[str] = None,
        mode: str = "live",
    ) -> None:
        from .translate_result_window import (
            show_error,
            show_translation,
        )

        if not card_id:
            card_id = f"live-{uuid.uuid4().hex[:8]}"

        # 用 card_id 简单去重（同一张卡片的并发请求只跑一次）
        with self._inflight_lock:
            if card_id in self._inflight:
                return
            self._inflight.add(card_id)

        def _worker() -> None:
            try:
                result = self.api_client.translate_image(
                    image_bytes=png,
                    mime_type="image/png",
                    target_lang=self.target_lang,
                    source_lang=self.source_lang,
                )
                if not result.ok:
                    show_error(result.error or "翻译失败")
                    return
                show_translation(
                    source_text=result.source_text,
                    translated_text=result.translated_text,
                    target_lang_label=self._lang_label(self.target_lang),
                    translated_by=result.translated_by,
                    card_id=card_id,
                    mode=mode,
                )
                LOG.info(
                    "翻译完成[%s] %d 行 → %d 字 (by %s)",
                    mode, result.line_count, len(result.translated_text), result.translated_by,
                )
            except Exception as e:
                LOG.exception("翻译异常")
                show_error(f"翻译异常: {e}")
            finally:
                with self._inflight_lock:
                    self._inflight.discard(card_id)

        threading.Thread(target=_worker, daemon=True, name=f"translate-{card_id}").start()

    def _lang_label(self, code: str) -> str:
        table = {
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
        return table.get(code, code)

    # ---------- 托盘 ----------

    def _run_tray(self) -> None:
        try:
            import pystray
        except ImportError as e:
            LOG.error("pystray 缺失：%s（请 pip install pystray）", e)
            raise

        icon_image = _build_tray_icon_image()

        def _on_live(icon, item) -> None:
            self._enter_live_mode()

        def _on_continuous(icon, item) -> None:
            self._enter_continuous_mode()

        def _on_clear(icon, item) -> None:
            from .translate_result_window import clear_all
            clear_all()

        def _on_change_lang(icon, item) -> None:
            cycle = ["zh", "en", "ja", "ko", "fr", "de"]
            try:
                idx = cycle.index(self.target_lang)
            except ValueError:
                idx = 0
            self.target_lang = cycle[(idx + 1) % len(cycle)]
            LOG.info("目标语言已切换为 %s", self.target_lang)
            try:
                icon.notify(f"目标语言：{self._lang_label(self.target_lang)}", title="屏幕翻译")
            except Exception:
                pass

        def _on_exit(icon, item) -> None:
            LOG.info("退出托盘")
            self.stop()

        menu = pystray.Menu(
            pystray.MenuItem(f"开始 Live 模式（{self._short_hk(self.hotkey)}）", _on_live, default=True),
            pystray.MenuItem(
                f"开始 Continuous 模式（{self._short_hk(self.continuous_hotkey)}）", _on_continuous
            ),
            pystray.MenuItem(f"清空结果（{self._short_hk(self.clear_hotkey)}）", _on_clear),
            pystray.MenuItem("切换目标语言", _on_change_lang),
            pystray.Menu.SEPARATOR,
            pystray.MenuItem("退出", _on_exit),
        )

        self._tray_icon = pystray.Icon(
            "translate-tray",
            icon_image,
            "屏幕翻译",
            menu,
        )

        def _on_signal(signum, frame):
            self.stop()

        try:
            signal.signal(signal.SIGINT, _on_signal)
        except Exception:
            pass
        try:
            signal.signal(signal.SIGTERM, _on_signal)
        except Exception:
            pass

        LOG.info(
            "托盘启动 · Live=%s  Continuous=%s  Clear=%s",
            self.hotkey, self.continuous_hotkey, self.clear_hotkey,
        )
        self._tray_icon.run()

    @staticmethod
    def _short_hk(hk: str) -> str:
        """把 '<ctrl>+<shift>+t' 简化成 'Ctrl+Shift+T'。"""
        out = hk.replace("<", "").replace(">", "+")
        return out.rstrip("+").upper()

    # ---------- 全局热键 ----------

    def _start_keyboard_listener(self) -> None:
        try:
            from pynput import keyboard
        except ImportError as e:
            LOG.error("pynput 缺失：%s", e)
            return

        def _on_live() -> None:
            self._enter_live_mode()

        def _on_continuous() -> None:
            self._enter_continuous_mode()

        def _on_clear() -> None:
            from .translate_result_window import clear_all
            clear_all()

        def _on_esc() -> None:
            # 任何模式下按 Esc 都先退出当前模式
            if self._live_session is not None and self._live_session.running:
                self._exit_live_mode()
            elif self._continuous_capture is not None and self._continuous_capture.running:
                self._exit_continuous_mode()

        hotkeys = {
            self.hotkey: _on_live,
            self.continuous_hotkey: _on_continuous,
            self.clear_hotkey: _on_clear,
            "<esc>": _on_esc,
        }
        # 把 esc 之外的 key 都换成小写
        hotkeys = {k: v for k, v in hotkeys.items()}
        try:
            self._keyboard_listener = keyboard.GlobalHotKeys(hotkeys)
            self._keyboard_listener.daemon = True
            self._keyboard_listener.start()
            LOG.info(
                "全局热键已注册：live=%s continuous=%s clear=%s esc=退出模式",
                self.hotkey, self.continuous_hotkey, self.clear_hotkey,
            )
        except Exception as e:
            LOG.error("注册全局热键失败：%s（可改用菜单触发）", e)


def main() -> None:
    parser = argparse.ArgumentParser(description="屏幕翻译托盘")
    parser.add_argument("--hotkey", default=os.environ.get("TRANSLATE_HOTKEY", "Ctrl+Shift+T"))
    parser.add_argument(
        "--continuous-hotkey",
        default=os.environ.get("TRANSLATE_CONTINUOUS_HOTKEY", "Ctrl+Shift+R"),
    )
    parser.add_argument(
        "--clear-hotkey",
        default=os.environ.get("TRANSLATE_CLEAR_HOTKEY", "Ctrl+Shift+C"),
    )
    parser.add_argument("--target-lang", default=os.environ.get("TRANSLATE_TARGET_LANG", "zh"))
    parser.add_argument(
        "--source-lang",
        default=os.environ.get("TRANSLATE_SOURCE_LANG", "en"),
        help="源语言代码（默认 en，传给 MyMemory 时必填）",
    )
    parser.add_argument(
        "--continuous-interval",
        type=float,
        default=float(os.environ.get("TRANSLATE_CONTINUOUS_INTERVAL", "2.0")),
        help="连续模式刷新间隔（秒）",
    )
    parser.add_argument(
        "--base-url",
        default=os.environ.get("PRIVATE_AI_AGENT_BASE_URL", "http://127.0.0.1:8787"),
    )
    parser.add_argument("--once", action="store_true", help="截一次后退出（调试用）")
    parser.add_argument("--log-level", default=os.environ.get("LOG_LEVEL", "INFO"))
    args = parser.parse_args()

    logging.basicConfig(
        level=getattr(logging, args.log_level.upper(), logging.INFO),
        format="%(asctime)s %(levelname)s %(name)s - %(message)s",
    )

    app = TranslateTrayApp(
        hotkey=_parse_hotkey(args.hotkey),
        continuous_hotkey=_parse_hotkey(args.continuous_hotkey),
        clear_hotkey=_parse_hotkey(args.clear_hotkey),
        target_lang=args.target_lang,
        source_lang=args.source_lang,
        base_url=args.base_url,
        continuous_interval_s=args.continuous_interval,
    )
    try:
        app.start(once=args.once)
    except KeyboardInterrupt:
        app.stop()


if __name__ == "__main__":
    main()
