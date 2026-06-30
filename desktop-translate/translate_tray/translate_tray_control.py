"""
翻译托盘本地 IPC HTTP 服务（仅监听 127.0.0.1）。

让主服务（Node server）能远程驱动翻译主面板。
端点：
  GET  /health            探活：返回 {ok, pid, version, hotkeys}
  POST /show-window       唤起主面板（首次会构建）
  POST /enter-live        （兼容旧名）等价于 /enter-select
  POST /enter-select      触发框选翻译（隐藏面板 → 进入 Live 蒙版）
  POST /add-result        添加/更新一张翻译结果卡片
  POST /clear             清空所有卡片
  POST /set-language      切换目标语言
  POST /set-show-source   切换原文显示
  POST /set-font-size     切换字号
  POST /toggle-subtitle   切换字幕窗口
  POST /collapse          折叠主面板
  POST /close             关闭主面板（不退出托盘）

监听：TRANSLATE_TRAY_CONTROL_PORT（默认 8766），仅绑 127.0.0.1。
"""
from __future__ import annotations

import json
import logging
import os
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Callable, Optional

LOG = logging.getLogger("translate_tray.control")

DEFAULT_CONTROL_PORT = 8766
SERVICE_VERSION = "1.1"


class TrayControlServer:
    """
    托盘控制 HTTP 服务（单进程内、单例）。

    由 TranslateTrayApp.start() 时实例化并 start()。
    关闭时调 stop() 释放端口。

    通过回调与托盘主体通信（每个回调对应一个端点；未注册则返回 ok=False）：
      - on_show_window(body)        : /show-window
      - on_enter_select()           : /enter-select (以及 /enter-live 兼容)
      - on_add_result(body)         : /add-result
      - on_clear()                  : /clear
      - on_set_language(code)       : /set-language
      - on_set_show_source(show)    : /set-show-source
      - on_set_font_size(size)      : /set-font-size
      - on_toggle_subtitle()        : /toggle-subtitle
      - on_collapse()               : /collapse
      - on_close_panel()            : /close
      - hotkeys_info                : 字典，供 /health 返回
    """

    def __init__(
        self,
        host: str = "127.0.0.1",
        port: int = DEFAULT_CONTROL_PORT,
        on_show_window: Optional[Callable[[dict[str, Any]], None]] = None,
        on_enter_live: Optional[Callable[[], None]] = None,
        on_enter_select: Optional[Callable[[], None]] = None,
        on_add_result: Optional[Callable[[dict[str, Any]], None]] = None,
        on_clear: Optional[Callable[[], None]] = None,
        on_set_language: Optional[Callable[[str], None]] = None,
        on_set_show_source: Optional[Callable[[bool], None]] = None,
        on_set_font_size: Optional[Callable[[int], None]] = None,
        on_toggle_subtitle: Optional[Callable[[], None]] = None,
        on_toggle_smart_detect: Optional[Callable[[], None]] = None,
        on_collapse: Optional[Callable[[], None]] = None,
        on_close_panel: Optional[Callable[[], None]] = None,
        hotkeys_info: Optional[dict[str, str]] = None,
    ) -> None:
        self.host = host
        self.port = port
        # 向后兼容：on_enter_live 与 on_enter_select 等价；优先用 on_enter_select
        self._on_show_window = on_show_window
        self._on_enter_select = on_enter_select or on_enter_live
        self._on_add_result = on_add_result
        self._on_clear = on_clear
        self._on_set_language = on_set_language
        self._on_set_show_source = on_set_show_source
        self._on_set_font_size = on_set_font_size
        self._on_toggle_subtitle = on_toggle_subtitle
        self._on_toggle_smart_detect = on_toggle_smart_detect
        self._on_collapse = on_collapse
        self._on_close_panel = on_close_panel
        self._hotkeys_info = hotkeys_info or {}
        self._server: Optional[ThreadingHTTPServer] = None
        self._thread: Optional[threading.Thread] = None
        self._lock = threading.Lock()
        self._started = False

    @property
    def started(self) -> bool:
        return self._started

    def start(self) -> None:
        with self._lock:
            if self._started:
                return
            try:
                self._server = ThreadingHTTPServer((self.host, self.port), _make_handler(self))
            except OSError as e:
                # 端口占用：常见于上一个托盘没死干净。仅警告，不抛。
                LOG.warning(
                    "控制端口 %d 绑定失败（%s），托盘控制 API 不可用，主服务点翻译会回退到提示文案",
                    self.port,
                    e,
                )
                self._server = None
                return
            self._thread = threading.Thread(
                target=self._server.serve_forever,
                daemon=True,
                name="translate-tray-control",
            )
            self._thread.start()
            self._started = True
            LOG.info("托盘控制 HTTP 已启动：http://%s:%d", self.host, self.port)

    def stop(self) -> None:
        with self._lock:
            if not self._started or self._server is None:
                return
            try:
                self._server.shutdown()
                self._server.server_close()
            except Exception:
                LOG.exception("关闭控制 HTTP 失败")
            self._server = None
            self._thread = None
            self._started = False
            LOG.info("托盘控制 HTTP 已停止")

    # ---- 给 handler 用的内部接口 ----

    def _handle_show_window(self, body: dict[str, Any]) -> dict[str, Any]:
        return self._invoke("on_show_window", self._on_show_window, body or {})

    def _handle_enter_select(self) -> dict[str, Any]:
        return self._invoke("on_enter_select", self._on_enter_select)

    def _handle_add_result(self, body: dict[str, Any]) -> dict[str, Any]:
        return self._invoke("on_add_result", self._on_add_result, body or {})

    def _handle_clear(self) -> dict[str, Any]:
        return self._invoke("on_clear", self._on_clear)

    def _handle_set_language(self, body: dict[str, Any]) -> dict[str, Any]:
        code = str((body or {}).get("lang") or (body or {}).get("code") or "").strip()
        if not code:
            return {"ok": False, "error": "missing 'lang' in body"}
        return self._invoke("on_set_language", self._on_set_language, code)

    def _handle_set_show_source(self, body: dict[str, Any]) -> dict[str, Any]:
        show = bool((body or {}).get("show"))
        return self._invoke("on_set_show_source", self._on_set_show_source, show)

    def _handle_set_font_size(self, body: dict[str, Any]) -> dict[str, Any]:
        raw = (body or {}).get("size")
        try:
            size = int(raw)
        except (TypeError, ValueError):
            return {"ok": False, "error": f"invalid 'size': {raw!r}"}
        if size < 6 or size > 72:
            return {"ok": False, "error": f"'size' out of range: {size}"}
        return self._invoke("on_set_font_size", self._on_set_font_size, size)

    def _handle_toggle_subtitle(self) -> dict[str, Any]:
        return self._invoke("on_toggle_subtitle", self._on_toggle_subtitle)

    def _handle_toggle_smart_detect(self) -> dict[str, Any]:
        return self._invoke("on_toggle_smart_detect", self._on_toggle_smart_detect)

    def _handle_collapse(self) -> dict[str, Any]:
        return self._invoke("on_collapse", self._on_collapse)

    def _handle_close_panel(self) -> dict[str, Any]:
        return self._invoke("on_close_panel", self._on_close_panel)

    def _handle_health(self) -> dict[str, Any]:
        return {
            "ok": True,
            "service": "translate-tray",
            "version": SERVICE_VERSION,
            "pid": os.getpid(),
            "port": self.port,
            "hotkeys": self._hotkeys_info,
            "endpoints": [
                "GET /health",
                "POST /show-window",
                "POST /enter-live",
                "POST /enter-select",
                "POST /add-result",
                "POST /clear",
                "POST /set-language",
                "POST /set-show-source",
                "POST /set-font-size",
                "POST /toggle-subtitle",
                "POST /toggle-smart-detect",
                "POST /collapse",
                "POST /close",
            ],
        }

    # ---- 通用回调调度 ----

    def _invoke(
        self,
        name: str,
        cb: Optional[Callable[..., Any]],
        *args: Any,
    ) -> dict[str, Any]:
        if cb is None:
            return {"ok": False, "error": f"{name} 未注册（托盘未初始化）"}
        try:
            cb(*args)
            return {"ok": True}
        except Exception as e:  # noqa: BLE001
            LOG.exception("%s 回调失败", name)
            return {"ok": False, "error": f"{type(e).__name__}: {e}"}


def _make_handler(ctrl: "TrayControlServer"):
    """工厂：为指定 ctrl 实例生成 handler 类。"""

    class Handler(BaseHTTPRequestHandler):
        # 静默默认 access log（我们用自己的 logger）
        def log_message(self, format: str, *args: Any) -> None:  # noqa: A002
            return

        def _write_json(self, status: int, payload: dict[str, Any]) -> None:
            try:
                body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
            except (TypeError, ValueError):
                body = json.dumps({"ok": False, "error": "response encode failed"}, ensure_ascii=False).encode("utf-8")
                status = 500
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            try:
                self.wfile.write(body)
            except Exception:
                LOG.exception("写响应失败")

        def _read_json(self) -> dict[str, Any]:
            try:
                length = int(self.headers.get("Content-Length") or 0)
            except ValueError:
                length = 0
            if length <= 0:
                return {}
            if length > 32 * 1024:
                # 32KB 上限，避免被人灌爆
                raise ValueError(f"payload too large: {length} bytes")
            raw = self.rfile.read(length) if length > 0 else b""
            if not raw:
                return {}
            try:
                data = json.loads(raw.decode("utf-8"))
            except (UnicodeDecodeError, json.JSONDecodeError) as e:
                raise ValueError(f"invalid JSON body: {e}") from e
            if not isinstance(data, dict):
                raise ValueError("body must be a JSON object")
            return data

        def do_GET(self) -> None:  # noqa: N802
            if self.path.split("?", 1)[0] == "/health":
                self._write_json(200, ctrl._handle_health())
                return
            self._write_json(404, {"ok": False, "error": "not found", "path": self.path})

        def do_POST(self) -> None:  # noqa: N802
            path = self.path.split("?", 1)[0]
            # 兼容旧版：不带 body 的端点
            no_body_routes = {
                "/enter-live": ctrl._handle_enter_select,
                "/enter-select": ctrl._handle_enter_select,
                "/clear": ctrl._handle_clear,
                "/toggle-subtitle": ctrl._handle_toggle_subtitle,
                "/toggle-smart-detect": ctrl._handle_toggle_smart_detect,
                "/collapse": ctrl._handle_collapse,
                "/close": ctrl._handle_close_panel,
            }
            body_routes = {
                "/show-window": ctrl._handle_show_window,
                "/add-result": ctrl._handle_add_result,
                "/set-language": ctrl._handle_set_language,
                "/set-show-source": ctrl._handle_set_show_source,
                "/set-font-size": ctrl._handle_set_font_size,
            }
            if path in body_routes:
                try:
                    body = self._read_json()
                except ValueError as e:
                    self._write_json(400, {"ok": False, "error": str(e)})
                    return
                self._write_json(200, body_routes[path](body))
                return
            if path in no_body_routes:
                # 这些端点允许空 body；如果有 body 也忽略
                try:
                    self._read_json()
                except ValueError:
                    pass
                self._write_json(200, no_body_routes[path]())
                return
            self._write_json(404, {"ok": False, "error": "not found", "path": self.path})

    return Handler


def resolve_control_port(env: Optional[dict[str, str]] = None) -> int:
    """从环境变量读控制端口，无效则用默认。"""
    src = env if env is not None else os.environ
    raw = (src.get("TRANSLATE_TRAY_CONTROL_PORT") or "").strip()
    if not raw:
        return DEFAULT_CONTROL_PORT
    try:
        n = int(raw)
    except ValueError:
        return DEFAULT_CONTROL_PORT
    if n <= 0 or n > 65535:
        return DEFAULT_CONTROL_PORT
    return n
