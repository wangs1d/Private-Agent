"""Sphere Overlay — PySide6 替代 Tauri 外壳。

职责：
  1. 无边框透明置顶主窗口，QWebEngineView 加载 agent-sphere-avatar/dist/overlay.html
  2. 通过 QWebChannel 注入 window.sphereOverlay API（兼容 Tauri preload）
  3. 与 PAI server WebSocket 连接，接收 agent.embodiment.command 等事件
  4. 日程悬浮窗（独立窗口，加载 schedule-floating.html）
  5. 系统托盘 + 单实例锁
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import tempfile
import threading
import time
import urllib.parse
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

import websockets
from PySide6.QtCore import (
    QBuffer,
    QByteArray,
    QEasingCurve,
    QPoint,
    QPropertyAnimation,
    QRect,
    Qt,
    QThread,
    QTimer,
    QUrl,
    Signal,
)
from PySide6.QtGui import QAction, QIcon, QMouseEvent, QPainter, QRegion
from PySide6.QtNetwork import QLocalServer, QLocalSocket
from PySide6.QtWebChannel import QWebChannel
from PySide6.QtWebEngineWidgets import QWebEngineView
from PySide6.QtWidgets import (
    QApplication,
    QMainWindow,
    QMenu,
    QSystemTrayIcon,
    QWidget,
)

from .bridge import SphereOverlayBridge
from .win32_utils import (
    apply_desk_pet_shell,
    get_work_area,
    hwnd_from_window,
    set_click_through,
    set_window_pos,
)


# ===== 常量 =====
PET_WIDTH = 186
PET_HEIGHT = 232
MENU_WIDTH = 204

SCHEDULE_WIDTH = 280
SCHEDULE_HEIGHT_COLLAPSED = 48
SCHEDULE_HEIGHT_EXPANDED = 340
SCHEDULE_WIDTH_COLLAPSED = 200


@dataclass
class SphereConfig:
    ws_url: str = "ws://127.0.0.1:3000/ws"
    http_base: str = "http://127.0.0.1:3000"
    session_id: str = ""
    actor_id: str = "default"
    user_id: str = ""
    dev_url: Optional[str] = None  # 开发模式前端 dev server URL
    avatar_dist: str = "../agent-sphere-avatar/dist"


# 注入前端 WebChannel 初始化脚本 + window.sphereOverlay 包装
WEBCHANNEL_INIT = r"""
(function () {
    function setup() {
        if (typeof qt === 'undefined' || !qt.webChannelTransport) {
            setTimeout(setup, 30);
            return;
        }
        new QWebChannel(qt.webChannelTransport, function(channel) {
            var bridge = channel.objects.sphereOverlay;
            if (!bridge) {
                console.warn('[sphereOverlay] bridge not found');
                return;
            }
            window.sphereOverlay = {
                getWorkArea: function () {
                    return Promise.resolve(bridge.getWorkArea());
                },
                moveTo: function (x, y, animateMs) {
                    bridge.moveTo(x, y, animateMs || 0);
                },
                moveBy: function (dx, dy) {
                    bridge.moveBy(dx, dy);
                },
                setPosition: function (x, y) {
                    bridge.setPosition(x, y);
                },
                getPosition: function () {
                    return Promise.resolve(bridge.getPosition());
                },
                setIgnoreMouseEvents: function (ignore, forward) {
                    bridge.setIgnoreMouseEvents(!!ignore, forward !== false);
                },
                setMenuExpanded: function (expanded) {
                    bridge.setMenuExpanded(!!expanded);
                },
                setScheduleCollapsed: function (collapsed) {
                    bridge.setScheduleCollapsed(!!collapsed);
                },
                onPatch: function (cb) {
                    bridge.patch_event.connect(cb);
                    return function () {
                        try { bridge.patch_event.disconnect(cb); } catch (e) {}
                    };
                },
                onRoam: function (cb) {
                    bridge.roam_event.connect(cb);
                    return function () {
                        try { bridge.roam_event.disconnect(cb); } catch (e) {}
                    };
                }
            };
            window.sphereOverlayBridge = bridge;
            console.log('[sphereOverlay] ready (PySide6)');
            // 触发就绪事件，兼容前端检测逻辑
            window.dispatchEvent(new CustomEvent('sphere-overlay:ready'));
        });
    }
    setup();
})();
"""


class WsClient(QThread):
    """与 PAI server 保持 WebSocket 连接，接收 embodiment 命令 / patch。"""

    connected = Signal()
    disconnected = Signal(str)
    patch = Signal(dict)
    command = Signal(dict)
    error = Signal(str)

    def __init__(self, cfg: SphereConfig, parent: Optional[QObject] = None) -> None:
        super().__init__(parent)
        self.cfg = cfg
        self._send_queue: list[dict] = []
        self._queue_lock = threading.Lock()
        self._ws: Optional[websockets.WebSocketClientProtocol] = None
        self._stop_event = threading.Event()

    def send(self, envelope: dict) -> None:
        with self._queue_lock:
            self._send_queue.append(envelope)

    def send_state(self, x: int, y: int, width: int, height: int) -> None:
        self.send({
            "type": "agent.embodiment.state",
            "payload": {
                "x": x, "y": y, "width": width, "height": height,
                "actorId": self.cfg.actor_id,
                "sessionId": self.cfg.session_id or None,
            },
        })

    def stop(self) -> None:
        self._stop_event.set()
        if self._ws:
            try:
                import asyncio
                asyncio.run_coroutine_threadsafe(self._ws.close(), self._loop)
            except Exception:  # noqa: BLE001
                pass

    def run(self) -> None:
        import asyncio
        self._loop = asyncio.new_event_loop()
        asyncio.set_event_loop(self._loop)
        self._loop.run_until_complete(self._loop_body())

    async def _loop_body(self) -> None:
        import asyncio
        try:
            async with websockets.connect(self.cfg.ws_url) as ws:
                self._ws = ws
                self.connected.emit()
                await ws.send(json.dumps({
                    "type": "session.init",
                    "payload": {
                        "actorId": self.cfg.actor_id,
                        "sessionId": self.cfg.session_id or None,
                        "userId": self.cfg.user_id or None,
                        "client": "sphere-overlay-py",
                    },
                }))
                consumer = asyncio.create_task(self._consume(ws))
                sender = asyncio.create_task(self._sender(ws))
                done, pending = await asyncio.wait(
                    [consumer, sender], return_when=asyncio.FIRST_COMPLETED,
                )
                for task in pending:
                    task.cancel()
        except websockets.exceptions.ConnectionClosed as exc:
            self.disconnected.emit(f"WS 关闭：{exc}")
        except Exception as exc:  # noqa: BLE001
            self.disconnected.emit(f"WS 异常：{exc}")

    async def _consume(self, ws: websockets.WebSocketClientProtocol) -> None:
        async for raw in ws:
            try:
                msg = json.loads(raw)
                typ = msg.get("type")
                payload = msg.get("payload", {})
                if typ == "agent.embodiment.command":
                    self.command.emit(payload)
                elif typ in ("agent.embodiment.patch", "agent.embodiment.command"):
                    # patch 事件直接透传
                    self.patch.emit(payload)
                elif typ == "agent.embodiment.interact":
                    self.patch.emit(payload)
            except Exception as exc:  # noqa: BLE001
                self.error.emit(f"解析失败：{exc}")

    async def _sender(self, ws: websockets.WebSocketClientProtocol) -> None:
        import asyncio
        while not self._stop_event.is_set():
            to_send = []
            with self._queue_lock:
                to_send, self._send_queue = self._send_queue, []
            for envelope in to_send:
                await ws.send(json.dumps(envelope))
            await asyncio.sleep(0.05)


class SphereMainWindow(QMainWindow):
    """3D 桌宠主窗口。"""

    schedule_toggle_requested = Signal(bool)  # collapsed

    def __init__(self, cfg: SphereConfig) -> None:
        super().__init__()
        self.cfg = cfg
        self._menu_expanded = False
        self._move_anim: Optional[QPropertyAnimation] = None
        self._bridge = SphereOverlayBridge(self)
        self._setup_window()
        self._setup_webview()
        self._setup_position()

    def _setup_window(self) -> None:
        self.setWindowFlags(
            Qt.WindowType.FramelessWindowHint
            | Qt.WindowType.WindowStaysOnTopHint
            | Qt.WindowType.Tool
            | Qt.WindowType.WindowDoesNotAcceptFocus
        )
        self.setAttribute(Qt.WidgetAttribute.WA_TranslucentBackground)
        self.setAttribute(Qt.WidgetAttribute.WA_NoSystemBackground)
        self.resize(PET_WIDTH, PET_HEIGHT)

    def _setup_webview(self) -> None:
        self._view = QWebEngineView(self)
        self._view.setAttribute(Qt.WidgetAttribute.WA_TranslucentBackground)
        self.setCentralWidget(self._view)

        # 透明背景
        page = self._view.page()
        page.setBackgroundColor(Qt.GlobalColor.transparent)

        # WebChannel
        self._channel = QWebChannel(self)
        self._channel.registerObject("sphereOverlay", self._bridge)
        page.setWebChannel(self._channel)

        # 注入初始化脚本
        script = WEBCHANNEL_INIT.replace("\n", " ")
        page.runJavaScript(script)

        # 加载页面
        url = self._build_overlay_url()
        self._view.load(QUrl(url))

    def _build_overlay_url(self) -> str:
        base = self.cfg.dev_url
        if base:
            url = QUrl(base)
            if not url.path().endswith("/overlay.html"):
                url.setPath("/overlay.html")
        else:
            dist = Path(self.cfg.avatar_dist).resolve()
            url = QUrl.fromLocalFile(str(dist / "overlay.html"))
        query = urllib.parse.urlencode({
            "ws": self.cfg.ws_url,
            "sessionId": self.cfg.session_id,
            "petW": str(PET_WIDTH),
            "petH": str(PET_HEIGHT),
        })
        url.setQuery(query)
        return url.toString()

    def _setup_position(self) -> None:
        area = self.work_area()
        x = area["x"] + area["width"] - PET_WIDTH - 24
        y = area["y"] + area["height"] - PET_HEIGHT - 24
        self.move(x, y)

    def showEvent(self, event) -> None:
        super().showEvent(event)
        apply_desk_pet_shell(self)
        set_click_through(self, True)

    # ---- bridge API ----
    def work_area(self) -> dict:
        return get_work_area(self)

    def set_click_through(self, enable: bool) -> None:
        set_click_through(self, enable)

    def move_window_to(self, x: int, y: int, animate_ms: int = 0) -> None:
        if animate_ms <= 0:
            self.move(x, y)
            return
        if self._move_anim is not None:
            self._move_anim.stop()
        self._move_anim = QPropertyAnimation(self, b"pos")
        self._move_anim.setDuration(animate_ms)
        self._move_anim.setStartValue(self.pos())
        self._move_anim.setEndValue(QPoint(x, y))
        self._move_anim.setEasingCurve(QEasingCurve.Type.InOutCubic)
        self._move_anim.start()

    def move_window_by(self, dx: int, dy: int) -> None:
        self.move(self.x() + dx, self.y() + dy)

    def set_window_position(self, x: int, y: int) -> None:
        self.move(x, y)

    def set_menu_expanded(self, expanded: bool) -> None:
        self._menu_expanded = expanded
        width = PET_WIDTH + (MENU_WIDTH if expanded else 0)
        self.resize(width, PET_HEIGHT)

    def set_schedule_collapsed(self, collapsed: bool) -> None:
        self.schedule_toggle_requested.emit(collapsed)

    def emit_patch(self, payload: dict) -> None:
        self._bridge.emit_patch(payload)

    def emit_roam(self) -> None:
        self._bridge.emit_roam()


class ScheduleWindow(QMainWindow):
    """日程悬浮窗。"""

    def __init__(self, cfg: SphereConfig) -> None:
        super().__init__()
        self.cfg = cfg
        self._collapsed = True
        self._setup_window()
        self._setup_webview()
        self._setup_position()

    def _setup_window(self) -> None:
        self.setWindowFlags(
            Qt.WindowType.FramelessWindowHint
            | Qt.WindowType.WindowStaysOnTopHint
            | Qt.WindowType.Tool
        )
        self.setAttribute(Qt.WidgetAttribute.WA_TranslucentBackground)
        self.resize(SCHEDULE_WIDTH, SCHEDULE_HEIGHT_EXPANDED)

    def _setup_webview(self) -> None:
        self._view = QWebEngineView(self)
        self._view.setAttribute(Qt.WidgetAttribute.WA_TranslucentBackground)
        self._view.page().setBackgroundColor(Qt.GlobalColor.transparent)
        self.setCentralWidget(self._view)
        url = self._build_schedule_url()
        self._view.load(QUrl(url))

    def _build_schedule_url(self) -> str:
        base = self.cfg.dev_url
        if base:
            url = QUrl(base)
            url.setPath("/schedule-floating.html")
        else:
            dist = Path(self.cfg.avatar_dist).resolve()
            url = QUrl.fromLocalFile(str(dist / "schedule-floating.html"))
        query = urllib.parse.urlencode({
            "ws": self.cfg.ws_url,
            "httpBase": self.cfg.http_base,
            "sessionId": self.cfg.session_id,
        })
        url.setQuery(query)
        return url.toString()

    def _setup_position(self) -> None:
        area = get_work_area(self) or {"x": 0, "y": 0, "width": 1920, "height": 1080}
        x = area["x"] + area["width"] - SCHEDULE_WIDTH - 24
        y = area["y"] + 24
        self.move(x, y)

    def showEvent(self, event) -> None:
        super().showEvent(event)
        apply_desk_pet_shell(self)

    def set_collapsed(self, collapsed: bool) -> None:
        self._collapsed = collapsed
        if collapsed:
            self.resize(SCHEDULE_WIDTH_COLLAPSED, SCHEDULE_HEIGHT_COLLAPSED)
        else:
            self.resize(SCHEDULE_WIDTH, SCHEDULE_HEIGHT_EXPANDED)


class SphereOverlayApp(QApplication):
    def __init__(self, argv: list[str]) -> None:
        super().__init__(argv)
        self.setQuitOnLastWindowClosed(False)
        self.cfg = self._parse_args(argv)
        self._main_win: Optional[SphereMainWindow] = None
        self._schedule_win: Optional[ScheduleWindow] = None
        self._ws = WsClient(self.cfg)
        self._tray: Optional[QSystemTrayIcon] = None
        self._single_server: Optional[QLocalServer] = None

    def _parse_args(self, argv: list[str]) -> SphereConfig:
        parser = argparse.ArgumentParser(description="Sphere Overlay (PySide6)")
        parser.add_argument("--ws", default=os.environ.get("PAI_WS_URL", "ws://127.0.0.1:3000/ws"))
        parser.add_argument("--http-base", default=os.environ.get("PAI_HTTP_BASE", "http://127.0.0.1:3000"))
        parser.add_argument("--session-id", default=os.environ.get("PAI_SESSION_ID", ""))
        parser.add_argument("--actor-id", default=os.environ.get("PAI_ACTOR_ID", "default"))
        parser.add_argument("--user-id", default=os.environ.get("PAI_USER_ID", ""))
        parser.add_argument("--dev-url", default=os.environ.get("PAI_OVERLAY_DEV_URL"))
        parser.add_argument("--avatar-dist", default=os.environ.get("PAI_AVATAR_DIST", "../agent-sphere-avatar/dist"))
        parser.add_argument("--single-instance", action="store_true", default=True)
        args = parser.parse_args(argv[1:])
        return SphereConfig(
            ws_url=args.ws,
            http_base=args.http_base,
            session_id=args.session_id,
            actor_id=args.actor_id,
            user_id=args.user_id,
            dev_url=args.dev_url,
            avatar_dist=args.avatar_dist,
        )

    def ensure_single_instance(self) -> bool:
        """尝试建立本地 server 实现单实例；若已存在则发送激活信号。"""
        name = "com.private-agent.sphere-overlay-py"
        socket = QLocalSocket()
        socket.connectToServer(name)
        if socket.waitForConnected(500):
            socket.write(b"show")
            socket.flush()
            socket.waitForBytesWritten(500)
            return False
        self._single_server = QLocalServer()
        self._single_server.listen(name)
        self._single_server.newConnection.connect(self._on_single_instance_activate)
        return True

    def _on_single_instance_activate(self) -> None:
        conn = self._single_server.nextPendingConnection()
        if conn:
            conn.readAll()
            conn.close()
        if self._main_win:
            self._main_win.show()
            self._main_win.raise_()

    def build(self) -> bool:
        if not self.ensure_single_instance():
            print("Another sphere-overlay instance is already running.")
            return False

        self._main_win = SphereMainWindow(self.cfg)
        self._schedule_win = ScheduleWindow(self.cfg)
        self._schedule_win.hide()

        self._main_win.schedule_toggle_requested.connect(self._schedule_win.set_collapsed)
        self._main_win.schedule_toggle_requested.connect(self._schedule_win.show)

        self._setup_tray()
        self._connect_ws()
        self._ws.start()

        self._main_win.show()
        return True

    def _setup_tray(self) -> None:
        if not QSystemTrayIcon.isSystemTrayAvailable():
            return
        menu = QMenu()
        show_action = QAction("显示", self)
        show_action.triggered.connect(lambda: self._main_win.show())
        hide_action = QAction("隐藏", self)
        hide_action.triggered.connect(lambda: self._main_win.hide())
        quit_action = QAction("退出", self)
        quit_action.triggered.connect(self.quit)
        menu.addAction(show_action)
        menu.addAction(hide_action)
        menu.addSeparator()
        menu.addAction(quit_action)

        self._tray = QSystemTrayIcon(self)
        self._tray.setContextMenu(menu)
        self._tray.setToolTip("Sphere Overlay")
        self._tray.activated.connect(self._on_tray_activated)
        self._tray.show()

    def _on_tray_activated(self, reason: QSystemTrayIcon.ActivationReason) -> None:
        if reason == QSystemTrayIcon.ActivationReason.DoubleClick:
            self._main_win.show()

    def _connect_ws(self) -> None:
        self._ws.patch.connect(self._main_win.emit_patch)
        self._ws.command.connect(self._main_win.emit_patch)
        self._ws.connected.connect(lambda: None)
        self._ws.disconnected.connect(lambda msg: print(f"WS disconnected: {msg}"))

        # 定期上报窗口位置
        self._state_timer = QTimer(self)
        self._state_timer.timeout.connect(self._report_state)
        self._state_timer.start(2000)

    def _report_state(self) -> None:
        if self._main_win and self._main_win.isVisible():
            self._ws.send_state(
                self._main_win.x(), self._main_win.y(),
                self._main_win.width(), self._main_win.height(),
            )

    def exec(self) -> int:
        return super().exec()


def main() -> int:
    app = SphereOverlayApp(sys.argv)
    if not app.build():
        return 0
    return app.exec()


if __name__ == "__main__":
    sys.exit(main())
