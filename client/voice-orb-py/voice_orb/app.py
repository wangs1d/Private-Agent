# Agent 纯语音对话模式 —— PySide6 独立悬浮球
# 职责：
#   1. 提供无边框、透明、置顶、可拖拽的悬浮球窗口
#   2. 管理四态 UI：小球态 / 唤醒展开态 / 聆听对话态 / 播报态
#   3. 录音（PyAudio）→ ASR HTTP /brain/sensory/listen
#   4. WebSocket 对话：chat.user_message → 接收 chat.assistant_chunk / done
#   5. TTS：/brain/sensory/speak 合成 + QMediaPlayer / pygame 播放
#   6. 提供切换按钮，通知父进程/外部回到页面模式
from __future__ import annotations

import asyncio
import base64
import json
import os
import queue
import re
import struct
import sys
import tempfile
import threading
import time
import traceback
import wave
from dataclasses import dataclass
from enum import Enum, auto
from typing import Optional

import pyaudio
import requests
import websockets
from PySide6.QtCore import (
    QBuffer,
    QByteArray,
    QObject,
    QEasingCurve,
    QPoint,
    QPropertyAnimation,
    QRect,
    QSize,
    Qt,
    QThread,
    QTimer,
    QUrl,
    Signal,
)
from PySide6.QtGui import (
    QBrush,
    QColor,
    QFont,
    QFontMetrics,
    QLinearGradient,
    QMouseEvent,
    QPainter,
    QPaintEvent,
    QPen,
    QPixmap,
    QRadialGradient,
)
from PySide6.QtMultimedia import QAudioOutput, QMediaPlayer
from PySide6.QtWidgets import (
    QApplication,
    QFileDialog,
    QHBoxLayout,
    QLabel,
    QMainWindow,
    QPushButton,
    QSizePolicy,
    QSpacerItem,
    QVBoxLayout,
    QWidget,
)


class OrbPhase(Enum):
    """悬浮球状态机。"""

    IDLE = auto()        # 小球态：右下角 48px
    EXPANDED = auto()    # 唤醒展开态：280x56 胶囊条
    LISTENING = auto()   # 聆听/对话态：320x140 面板
    SPEAKING = auto()    # 播报态：320x140 面板


@dataclass
class VoiceOrbConfig:
    ws_url: str = "ws://127.0.0.1:3000/ws"
    http_base: str = "http://127.0.0.1:3000"
    session_id: str = ""
    actor_id: str = "default"
    user_id: str = ""
    # 父进程（Flutter 客户端）PID；>0 时启动父进程存活监控，
    # 父进程退出后自动结束悬浮球，避免残留悬浮窗。
    parent_pid: int = 0
    # 录音参数（与 server funasr 默认保持一致）
    sample_rate: int = 16000
    channels: int = 1
    chunk_size: int = 1024
    format: str = "wav"


class AudioRecorder(QThread):
    """在独立线程中录制麦克风音频，完成后发出 finished 信号。"""

    volume_changed = Signal(float)
    finished = Signal(str)   # 返回录制的 wav 文件路径
    error = Signal(str)

    def __init__(self, cfg: VoiceOrbConfig, parent: Optional[QObject] = None) -> None:
        super().__init__(parent)
        self.cfg = cfg
        self._stop_event = threading.Event()
        self._path: Optional[str] = None

    def stop(self) -> None:
        self._stop_event.set()

    def run(self) -> None:
        try:
            audio = pyaudio.PyAudio()
            fmt = pyaudio.paInt16
            stream = audio.open(
                format=fmt,
                channels=self.cfg.channels,
                rate=self.cfg.sample_rate,
                input=True,
                frames_per_buffer=self.cfg.chunk_size,
            )
        except Exception as exc:  # noqa: BLE001
            self.error.emit(f"麦克风启动失败：{exc}")
            return

        frames: list[bytes] = []
        self._stop_event.clear()
        while not self._stop_event.is_set():
            try:
                data = stream.read(self.cfg.chunk_size, exception_on_overflow=False)
            except Exception as exc:  # noqa: BLE001
                self.error.emit(f"录音读取失败：{exc}")
                break
            frames.append(data)
            # 简单音量 RMS
            rms = self._rms(data)
            self.volume_changed.emit(min(1.0, rms / 32768.0 * 8.0))

        stream.stop_stream()
        stream.close()

        try:
            fd, path = tempfile.mkstemp(suffix=".wav")
            os.close(fd)
            with wave.open(path, "wb") as wf:
                wf.setnchannels(self.cfg.channels)
                wf.setsampwidth(audio.get_sample_size(fmt))
                wf.setframerate(self.cfg.sample_rate)
                wf.writeframes(b"".join(frames))
        except Exception as exc:  # noqa: BLE001
            self.error.emit(f"录音文件写入失败：{exc}")
        else:
            self._path = path
            self.finished.emit(path)
        finally:
            try:
                audio.terminate()
            except Exception:  # noqa: BLE001
                pass

    @staticmethod
    def _rms(data: bytes) -> float:
        count = len(data) // 2
        if count == 0:
            return 0.0
        shorts = struct.unpack(f"{count}h", data)
        sum_squares = sum((s / 32768.0) ** 2 for s in shorts)
        return (sum_squares / count) ** 0.5 * 32768.0


class WsClient(QThread):
    """WebSocket 客户端：负责 session.init + 收发聊天事件。"""

    connected = Signal()
    disconnected = Signal(str)
    assistant_chunk = Signal(str, str)   # message_id, text
    assistant_done = Signal(str)         # message_id
    turn_started = Signal(str)
    intent_detected = Signal(dict)
    execution_event = Signal(dict)
    error = Signal(str)

    def __init__(self, cfg: VoiceOrbConfig, parent: Optional[QObject] = None) -> None:
        super().__init__(parent)
        self.cfg = cfg
        self._send_queue: list[dict] = []
        self._queue_lock = threading.Lock()
        self._ws: Optional[websockets.WebSocketClientProtocol] = None
        self._stop_event = threading.Event()

    def send(self, envelope: dict) -> None:
        with self._queue_lock:
            self._send_queue.append(envelope)

    def send_user_message(self, text: str, reply_to_message_id: Optional[str] = None) -> None:
        payload: dict = {
            "type": "chat.user_message",
            "payload": {
                "text": text,
                "mode": "voice",
                "actorId": self.cfg.actor_id,
            },
        }
        if reply_to_message_id:
            payload["payload"]["replyToMessageId"] = reply_to_message_id
        if self.cfg.session_id:
            payload["payload"]["sessionId"] = self.cfg.session_id
        self.send(payload)

    def stop(self) -> None:
        self._stop_event.set()
        if self._ws:
            try:
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

        retry = 0
        while not self._stop_event.is_set():
            try:
                async with websockets.connect(self.cfg.ws_url, ping_interval=None) as ws:
                    retry = 0
                    self._ws = ws
                    self.connected.emit()
                    # session init
                    await ws.send(json.dumps({
                        "type": "session.init",
                        "payload": {
                            "actorId": self.cfg.actor_id,
                            "sessionId": self.cfg.session_id or None,
                            "userId": self.cfg.user_id or None,
                            "client": "voice-orb-py",
                        },
                    }))
                    consumer_task = asyncio.create_task(self._consume(ws))
                    sender_task = asyncio.create_task(self._sender(ws))
                    done, pending = await asyncio.wait(
                        [consumer_task, sender_task],
                        return_when=asyncio.FIRST_COMPLETED,
                    )
                    for task in pending:
                        task.cancel()
                    # 收回取消/异常的协程结果，避免 "Task exception was never retrieved" 告警与资源泄漏
                    await asyncio.gather(*pending, return_exceptions=True)
                    if consumer_task in done:
                        exc = consumer_task.exception()
                        if exc:
                            raise exc
                    if sender_task in done:
                        exc = sender_task.exception()
                        if exc:
                            raise exc
            except websockets.exceptions.ConnectionClosed as exc:
                self.disconnected.emit(f"WS 连接已关闭：{exc}")
            except Exception as exc:  # noqa: BLE001
                self.disconnected.emit(f"WS 异常：{exc}")

            if self._stop_event.is_set():
                break
            # 自动重连（指数退避），保证 server 中途重启/宕机后悬浮球仍可用
            delay = min(2.0 * (2 ** retry), 15.0)
            retry += 1
            self.disconnected.emit(f"连接断开，{int(delay)} 秒后重连…")
            try:
                await asyncio.sleep(delay)
            except asyncio.CancelledError:
                break

    async def _consume(self, ws: websockets.WebSocketClientProtocol) -> None:
        async for raw in ws:
            try:
                msg = json.loads(raw)
                typ = msg.get("type")
                payload = msg.get("payload", {})
                if typ == "chat.assistant_chunk":
                    self.assistant_chunk.emit(
                        payload.get("messageId", ""),
                        payload.get("text", ""),
                    )
                elif typ == "chat.assistant_done":
                    self.assistant_done.emit(payload.get("messageId", ""))
                elif typ == "chat.turn_started":
                    self.turn_started.emit(payload.get("messageId", ""))
                elif typ == "chat.intent_detected":
                    self.intent_detected.emit(payload)
                elif typ == "chat.execution_event":
                    self.execution_event.emit(payload)
            except Exception as exc:  # noqa: BLE001
                self.error.emit(f"解析消息失败：{exc}")

    async def _sender(self, ws: websockets.WebSocketClientProtocol) -> None:
        while not self._stop_event.is_set():
            to_send = []
            with self._queue_lock:
                to_send, self._send_queue = self._send_queue, []
            for envelope in to_send:
                await ws.send(json.dumps(envelope))
            await asyncio.sleep(0.05)


class WakeListener(QThread):
    """语音唤醒 — 持续监听唤醒词，命中后触发回调。

    采集线程持续读麦克风（16kHz 单声道 int16），把字节块放入队列；
    本线程每间隔取最近 1.5s 滑动窗口 POST /brain/sensory/listen 做 ASR，
    匹配到唤醒词后发出 woke 信号并退出（释放麦克风）。
    响度过低时跳过识别，避免持续请求服务端。
    """

    woke = Signal(str)    # 命中的唤醒词文本
    status = Signal(str)  # 状态提示（错误等，用于悬浮球字幕）

    SAMPLE_RATE = 16000
    CHUNK_SECONDS = 0.1            # 采集块时长（100ms）
    WINDOW_SECONDS = 1.5           # 滑动窗口长度
    SUBMIT_INTERVAL = 0.8          # 两次识别最小间隔（s）
    MIN_RMS = 300                  # 低于该响度不提交识别
    ASR_TIMEOUT = 6                # 单次识别超时（s）

    # 默认唤醒词（与 Flutter 端 VoiceWakeService 保持一致）
    WAKE_PHRASES = (
        "小助手", "嘿助手", "你好助手", "助手你好",
        "嘿agent", "hi agent",
    )

    def __init__(self, cfg: VoiceOrbConfig, parent: Optional[QObject] = None) -> None:
        super().__init__(parent)
        self.cfg = cfg
        self._audio_queue: "queue.Queue[bytes]" = queue.Queue()
        self._stop_event = threading.Event()
        self._capture: Optional[threading.Thread] = None

    def stop(self) -> None:
        """请求停止：采集线程会尽快退出并释放麦克风。"""
        self._stop_event.set()

    def run(self) -> None:
        self._stop_event.clear()
        self._capture = threading.Thread(target=self._capture_loop, daemon=True)
        self._capture.start()

        keep = int(self.SAMPLE_RATE * self.WINDOW_SECONDS * 2)  # 字节数
        buf = bytearray()
        last_submit = 0.0
        try:
            while not self._stop_event.is_set():
                try:
                    data = self._audio_queue.get(timeout=0.2)
                except queue.Empty:
                    data = b""
                if data:
                    buf += data
                    if len(buf) > keep * 2:
                        del buf[: len(buf) - keep * 2]
                # 采集线程已退出（如麦克风不可用）且队列已空 → 结束监听
                if (
                    not data
                    and self._capture is not None
                    and not self._capture.is_alive()
                    and self._audio_queue.empty()
                ):
                    break
                now = time.monotonic()
                if (
                    now - last_submit < self.SUBMIT_INTERVAL
                    or len(buf) < keep
                    or self._stop_event.is_set()
                ):
                    continue
                last_submit = now
                snap = bytes(buf[-keep:])
                if self._rms(snap) < self.MIN_RMS:
                    continue
                text = self._asr(snap)
                if text and self._match_wake(text):
                    self.woke.emit(text)
                    break
        except Exception as exc:  # noqa: BLE001
            self.status.emit(f"唤醒异常：{exc}")
            traceback.print_exc()
        finally:
            self._stop_event.set()  # 通知采集线程退出，释放麦克风
            if self._capture is not None:
                self._capture.join(timeout=2)

    def _capture_loop(self) -> None:
        audio = None
        stream = None
        try:
            audio = pyaudio.PyAudio()
            stream = audio.open(
                format=pyaudio.paInt16,
                channels=1,
                rate=self.SAMPLE_RATE,
                input=True,
                frames_per_buffer=int(self.SAMPLE_RATE * self.CHUNK_SECONDS),
            )
            block = int(self.SAMPLE_RATE * self.CHUNK_SECONDS)
            while not self._stop_event.is_set():
                data = stream.read(block, exception_on_overflow=False)
                self._audio_queue.put(data)
        except OSError as exc:  # noqa: BLE001
            # 设备不可用（如当前会话没有默认输入设备）属环境问题，提示即可
            if not self._stop_event.is_set():
                self.status.emit(f"唤醒麦克风不可用：{exc}")
        except Exception as exc:  # noqa: BLE001
            if not self._stop_event.is_set():
                self.status.emit(f"唤醒麦克风失败：{exc}")
            traceback.print_exc()
        finally:
            if stream is not None:
                try:
                    stream.stop_stream()
                    stream.close()
                except Exception:  # noqa: BLE001
                    pass
            if audio is not None:
                try:
                    audio.terminate()
                except Exception:  # noqa: BLE001
                    pass

    @staticmethod
    def _rms(data: bytes) -> float:
        count = len(data) // 2
        if count == 0:
            return 0.0
        shorts = struct.unpack(f"{count}h", data)
        sum_squares = sum((s / 32768.0) ** 2 for s in shorts)
        return (sum_squares / count) ** 0.5 * 32768.0

    @classmethod
    def _match_wake(cls, text: str) -> bool:
        normalized = re.sub(r"\s+", "", text).lower()
        return any(p in normalized for p in cls.WAKE_PHRASES if p)

    def _asr(self, wav_bytes: bytes) -> str:
        """一次性识别一段 wav 字节，返回文本（失败返回空串）。"""
        try:
            fd, path = tempfile.mkstemp(suffix=".wav")
            os.close(fd)
            with wave.open(path, "wb") as wf:
                wf.setnchannels(1)
                wf.setsampwidth(2)
                wf.setframerate(self.SAMPLE_RATE)
                wf.writeframes(wav_bytes)
            try:
                with open(path, "rb") as f:
                    audio_b64 = base64.b64encode(f.read()).decode("ascii")
            finally:
                try:
                    os.remove(path)
                except OSError:
                    pass
            resp = requests.post(
                f"{self.cfg.http_base}/brain/sensory/listen",
                json={
                    "audio": {
                        "data": audio_b64,
                        "format": "wav",
                        "sampleRate": self.SAMPLE_RATE,
                        "channels": 1,
                    }
                },
                timeout=self.ASR_TIMEOUT,
            )
            resp.raise_for_status()
            data = resp.json()
            return str(data.get("result", {}).get("text", "") or "").strip()
        except Exception:  # noqa: BLE001
            return ""


class VoiceOrb(QWidget):
    """悬浮球主控件，负责绘制与状态切换。"""

    start_listening_requested = Signal()
    stop_listening_requested = Signal()
    back_to_page_requested = Signal()
    volume_changed = Signal(float)

    def __init__(self, cfg: VoiceOrbConfig, parent: Optional[QWidget] = None) -> None:
        super().__init__(parent)
        self.cfg = cfg
        self.phase = OrbPhase.IDLE
        self.subtitle = ""
        self.volume = 0.0
        self._reply_text = ""
        self._reply_message_id = ""
        self._press_global: Optional[QPoint] = None
        self._drag_started = False
        self._expanded_geometry = QRect()
        self._setup_window()
        self._setup_ui()
        self._setup_animations()
        self._setup_timers()
        self.volume_changed.connect(self._on_volume_changed)

    def _setup_window(self) -> None:
        self.setWindowFlags(
            Qt.WindowType.FramelessWindowHint
            | Qt.WindowType.WindowStaysOnTopHint
            | Qt.WindowType.Tool
            | Qt.WindowType.WindowDoesNotAcceptFocus
        )
        self.setAttribute(Qt.WidgetAttribute.WA_TranslucentBackground)
        self.setAttribute(Qt.WidgetAttribute.WA_NoSystemBackground)
        self.setMinimumSize(48, 48)
        self.resize(48, 48)

    def _setup_ui(self) -> None:
        self.setLayout(QVBoxLayout())
        self.layout().setContentsMargins(0, 0, 0, 0)
        self.layout().setSpacing(0)

    def _setup_animations(self) -> None:
        self._size_anim = QPropertyAnimation(self, b"geometry")
        self._size_anim.setDuration(240)
        self._size_anim.setEasingCurve(QEasingCurve.Type.OutCubic)

        self._breath_timer = QTimer(self)
        self._breath_timer.timeout.connect(self._on_breath_tick)
        self._breath_timer.start(40)
        self._breath_t = 0.0

    def _setup_timers(self) -> None:
        # 自动收起：idle 5s 后回到小球态
        self._collapse_timer = QTimer(self)
        self._collapse_timer.setSingleShot(True)
        self._collapse_timer.timeout.connect(lambda: self.set_phase(OrbPhase.IDLE))

    def _on_breath_tick(self) -> None:
        self._breath_t += 0.04
        self.update()

    def _on_volume_changed(self, value: float) -> None:
        self.volume = value
        self.update()

    def set_phase(self, phase: OrbPhase, subtitle: str = "") -> None:
        self.phase = phase
        if subtitle:
            self.subtitle = subtitle
        if phase in (OrbPhase.IDLE, OrbPhase.EXPANDED):
            self._collapse_timer.start(5000)
        else:
            self._collapse_timer.stop()
        self._animate_to_phase_size()
        self.update()

    def _animate_to_phase_size(self) -> None:
        screen = QApplication.primaryScreen()
        if screen is None:
            return
        screen = screen.availableGeometry()
        # 默认右下角
        target = self._target_size_for(self.phase)
        x = self.x()
        y = self.y()
        # 保持右下角对齐优先
        if self._expanded_geometry.isValid():
            x = self._expanded_geometry.x()
            y = self._expanded_geometry.y()
        else:
            x = screen.width() - target.width() - 24
            y = screen.height() - target.height() - 24
            self._expanded_geometry = QRect(x, y, target.width(), target.height())

        # 确保不超出屏幕
        x = max(8, min(screen.width() - target.width() - 8, x))
        y = max(8, min(screen.height() - target.height() - 8, y))

        geo = QRect(x, y, target.width(), target.height())
        self._size_anim.stop()
        self._size_anim.setStartValue(self.geometry())
        self._size_anim.setEndValue(geo)
        self._size_anim.start()

    def _target_size_for(self, phase: OrbPhase) -> QSize:
        if phase == OrbPhase.IDLE:
            return QSize(48, 48)
        if phase == OrbPhase.EXPANDED:
            return QSize(280, 56)
        return QSize(320, 140)

    # ---- 鼠标交互 ----
    # 交互约定：
    #   - 按下左键后移动超过阈值 → 拖拽移动悬浮球（不做点击动作）
    #   - 按下后没有移动 → 松开时执行点击动作（展开 / 开始录音 / 结束录音）
    _DRAG_THRESHOLD = 6  # px

    def mousePressEvent(self, event: QMouseEvent) -> None:
        try:
            if event.button() == Qt.MouseButton.LeftButton:
                self._press_global = event.globalPosition().toPoint()
                self._drag_started = False
                event.accept()
        except Exception:  # noqa: BLE001
            traceback.print_exc()

    def mouseMoveEvent(self, event: QMouseEvent) -> None:
        try:
            if (
                event.buttons() & Qt.MouseButton.LeftButton
                and self._press_global is not None
            ):
                delta = event.globalPosition().toPoint() - self._press_global
                if not self._drag_started and delta.manhattanLength() > self._DRAG_THRESHOLD:
                    self._drag_started = True
                if self._drag_started:
                    # 拖动：保持按下位置与窗口左上角的相对偏移
                    self.move(event.globalPosition().toPoint() - self._press_global + self.pos())
                    self._expanded_geometry.moveTo(self.pos())
                    event.accept()
        except Exception:  # noqa: BLE001
            traceback.print_exc()

    def mouseReleaseEvent(self, event: QMouseEvent) -> None:
        try:
            was_drag = self._drag_started
            self._press_global = None
            self._drag_started = False
            if was_drag or event.button() != Qt.MouseButton.LeftButton:
                return
            # 视为点击，执行状态机动作
            if self.phase == OrbPhase.IDLE:
                self.set_phase(OrbPhase.EXPANDED, "你好，我在")
            elif self.phase == OrbPhase.EXPANDED:
                # 点击胶囊条主体触发录音
                self._collapse_timer.stop()
                self.start_listening_requested.emit()
            elif self.phase == OrbPhase.LISTENING:
                # 聆听态点击结束录音
                self.stop_listening_requested.emit()
            event.accept()
        except Exception:  # noqa: BLE001
            traceback.print_exc()

    # ---- 绘制 ----
    def paintEvent(self, event: QPaintEvent) -> None:
        try:
            painter = QPainter(self)
            painter.setRenderHint(QPainter.RenderHint.Antialiasing)

            if self.phase == OrbPhase.IDLE:
                self._draw_idle(painter)
            elif self.phase == OrbPhase.EXPANDED:
                self._draw_expanded(painter)
            else:
                self._draw_panel(painter)
        except Exception:  # noqa: BLE001
            # 绘制异常不允许逃逸出事件循环，否则可能导致进程被 Qt 终止
            traceback.print_exc()

    def _phase_color(self) -> QColor:
        if self.phase == OrbPhase.IDLE:
            return QColor("#3B82F6")
        if self.phase == OrbPhase.EXPANDED:
            return QColor("#60A5FA")
        if self.phase == OrbPhase.LISTENING:
            return QColor("#3B82F6")
        return QColor("#22C55E")

    def _draw_idle(self, painter: QPainter) -> None:
        w, h = self.width(), self.height()
        cx, cy, r = w // 2, h // 2, min(w, h) // 2 - 2
        pulse = 1.0 + 0.08 * (1 + __import__("math").sin(self._breath_t)) / 2
        color = self._phase_color()

        # 外发光
        glow = QRadialGradient(cx, cy, r * pulse * 1.6)
        glow.setColorAt(0, QColor(color.red(), color.green(), color.blue(), 90))
        glow.setColorAt(1, QColor(color.red(), color.green(), color.blue(), 0))
        painter.setBrush(QBrush(glow))
        painter.setPen(Qt.PenStyle.NoPen)
        painter.drawEllipse(cx - r * pulse * 1.6, cy - r * pulse * 1.6,
                            r * pulse * 3.2, r * pulse * 3.2)

        # 球体
        grad = QRadialGradient(cx - r * 0.3, cy - r * 0.3, r * 1.5)
        grad.setColorAt(0, QColor("#93C5FD"))
        grad.setColorAt(1, color)
        painter.setBrush(QBrush(grad))
        painter.drawEllipse(cx - r, cy - r, r * 2, r * 2)

        # 内圈环
        ring_pen = QPen(QColor("rgba(255,255,255,0.6)"))
        ring_pen.setWidth(2)
        painter.setPen(ring_pen)
        painter.setBrush(Qt.BrushStyle.NoBrush)
        painter.drawEllipse(cx - r * 0.45, cy - r * 0.45, r * 0.9, r * 0.9)

    def _draw_expanded(self, painter: QPainter) -> None:
        self._draw_rounded_card(painter)
        color = self._phase_color()

        # 左侧小球
        self._draw_orb_icon(painter, 28, self.height() // 2, 18, color)

        # 中间文字
        painter.setPen(QPen(QColor("#F9FAFB")))
        font = QFont("Microsoft YaHei", 12)
        font.setWeight(QFont.Weight.Medium)
        painter.setFont(font)
        text = self.subtitle or "你好，我在"
        painter.drawText(56, 0, self.width() - 110, self.height(),
                         Qt.AlignmentFlag.AlignVCenter | Qt.AlignmentFlag.AlignLeft, text)

        # 右侧声波
        self._draw_waveform(painter, self.width() - 42, self.height() // 2, 20, 16)

        # 切换按钮（回到页面模式）放在最右
        # 这里仅绘制一个小图标区域，真实点击由 _back_button 子控件处理

    def _draw_panel(self, painter: QPainter) -> None:
        self._draw_rounded_card(painter)
        color = self._phase_color()

        # 顶部状态行
        self._draw_orb_icon(painter, 24, 24, 12, color)
        painter.setPen(QPen(color))
        font = QFont("Microsoft YaHei", 11)
        font.setWeight(QFont.Weight.Bold)
        painter.setFont(font)
        status_text = "正在聆听" if self.phase == OrbPhase.LISTENING else "正在回复"
        painter.drawText(44, 8, 120, 32,
                         Qt.AlignmentFlag.AlignVCenter | Qt.AlignmentFlag.AlignLeft, status_text)

        # 内容区
        painter.setPen(QPen(QColor("#E5E7EB")))
        font = QFont("Microsoft YaHei", 12)
        painter.setFont(font)
        content = self.subtitle if self.phase == OrbPhase.LISTENING else self._reply_text
        rect = QRect(20, 48, self.width() - 40, self.height() - 64)
        painter.drawText(rect, Qt.TextFlag.TextWordWrap, content)

        # 底部声波
        if self.phase == OrbPhase.LISTENING:
            self._draw_waveform(painter, self.width() // 2, self.height() - 18,
                                self.width() - 48, 12)

    def _draw_rounded_card(self, painter: QPainter) -> None:
        rect = self.rect().adjusted(2, 2, -2, -2)
        radius = min(rect.height(), 40) // 2
        # 背景
        bg = QColor("#111827")
        bg.setAlpha(225)
        painter.setBrush(QBrush(bg))
        pen = QPen(QColor("rgba(255,255,255,0.12)"))
        pen.setWidth(1)
        painter.setPen(pen)
        painter.drawRoundedRect(rect, radius, radius)
        # 微弱外发光
        glow = QColor(self._phase_color())
        glow.setAlpha(40)
        pen = QPen(glow)
        pen.setWidth(2)
        painter.setPen(pen)
        painter.setBrush(Qt.BrushStyle.NoBrush)
        painter.drawRoundedRect(rect.adjusted(-1, -1, 1, 1), radius, radius)

    def _draw_orb_icon(self, painter: QPainter, x: int, y: int, r: int, color: QColor) -> None:
        grad = QRadialGradient(x - r * 0.3, y - r * 0.3, r * 1.5)
        grad.setColorAt(0, QColor("#93C5FD"))
        grad.setColorAt(1, color)
        painter.setBrush(QBrush(grad))
        painter.setPen(Qt.PenStyle.NoPen)
        painter.drawEllipse(x - r, y - r, r * 2, r * 2)

    def _draw_waveform(self, painter: QPainter, cx: int, cy: int, w: int, bar_h: int) -> None:
        painter.setPen(Qt.PenStyle.NoPen)
        color = self._phase_color()
        bars = 5
        gap = 3
        bar_w = (w - gap * (bars - 1)) // bars
        for i in range(bars):
            phase = self._breath_t + i * 0.8
            amp = self.volume if self.phase == OrbPhase.LISTENING else 0.5
            h = max(3, bar_h * (0.3 + 0.7 * amp) *
                    (0.6 + 0.4 * (1 + __import__("math").sin(phase)) / 2))
            rect = QRect(
                cx - w // 2 + i * (bar_w + gap),
                int(cy - h / 2),
                bar_w,
                int(h),
            )
            c = QColor(color)
            c.setAlpha(200)
            painter.setBrush(QBrush(c))
            painter.drawRoundedRect(rect, bar_w // 2, bar_w // 2)


class VoiceOrbWindow(QMainWindow):
    """应用主窗口，承载 VoiceOrb 控件并编排录音/ASR/TTS/WS 流程。"""

    # 工作线程（ASR / TTS）不得直接触碰 Qt 控件；统一通过跨线程信号
    # 回到主线程更新 UI，避免 Qt 对象跨线程访问导致进程崩溃。
    phase_changed = Signal(str, str)   # phase_name(OrbPhase 名), subtitle
    reply_text_changed = Signal(str)   # 追加回复文本；空串表示重置上一轮回复
    turn_finished = Signal()           # 一轮对话结束（播报完/无内容），回到空闲并恢复唤醒

    def __init__(self, cfg: VoiceOrbConfig) -> None:
        super().__init__()
        self.cfg = cfg
        self.orb = VoiceOrb(cfg)
        self.setCentralWidget(self.orb)
        self.setWindowFlags(
            Qt.WindowType.FramelessWindowHint
            | Qt.WindowType.WindowStaysOnTopHint
            | Qt.WindowType.Tool
        )
        self.setAttribute(Qt.WidgetAttribute.WA_TranslucentBackground)
        self.resize(48, 48)
        self._position_to_bottom_right()

        self._build_back_button()
        self._connect_orb_signals()
        # 跨线程 UI 更新通道
        self.phase_changed.connect(self._on_phase_changed)
        self.reply_text_changed.connect(self._on_reply_text_changed)

        # 父进程存活监控：Flutter 客户端退出/重启后自动结束悬浮球，避免残留
        self._parent_pid = cfg.parent_pid
        self._parent_watchdog: Optional[QTimer] = None
        if self._parent_pid > 0:
            self._parent_watchdog = QTimer(self)
            self._parent_watchdog.timeout.connect(self._check_parent_alive)
            self._parent_watchdog.start(2000)

        # 录音 / 播放 / 网络组件
        self._recorder: Optional[AudioRecorder] = None
        self._ws = WsClient(cfg)
        self._connect_ws_signals()
        self._ws.start()

        self._player = QMediaPlayer(self)
        self._audio_output = QAudioOutput(self)
        self._player.setAudioOutput(self._audio_output)

        self._pending_text = ""
        self._last_message_id = ""

        # 语音唤醒：默认开启，作为置顶悬浮球时持续监听唤醒词
        self._wake_enabled = True
        self._wake: Optional[WakeListener] = None
        self.turn_finished.connect(self._on_turn_finished)
        self._player.mediaStatusChanged.connect(self._on_media_status)
        self._resume_wake()

    def _position_to_bottom_right(self) -> None:
        """初始位置：屏幕右下角，距边缘 24px。"""
        screen = QApplication.primaryScreen()
        if screen is None:
            return
        screen = screen.availableGeometry()
        self.move(
            screen.width() - self.width() - 24,
            screen.height() - self.height() - 24,
        )

    def _build_back_button(self) -> None:
        """展开态/面板态右上角显示"回到页面"切换 + 语音唤醒开关按钮。"""
        self._back_btn = QPushButton("↩ 页面模式", self.orb)
        self._back_btn.setStyleSheet("""
            QPushButton {
                background-color: rgba(31, 41, 55, 0.85);
                color: #E5E7EB;
                border: 1px solid rgba(255,255,255,0.12);
                border-radius: 10px;
                padding: 2px 8px;
                font-size: 11px;
            }
            QPushButton:hover { background-color: rgba(55, 65, 81, 0.95); }
        """)
        self._back_btn.setCursor(Qt.CursorShape.PointingHandCursor)
        self._back_btn.clicked.connect(self._on_back_to_page)
        self._back_btn.hide()

        self._wake_btn = QPushButton("唤醒：开", self.orb)
        self._wake_btn.setStyleSheet("""
            QPushButton {
                background-color: rgba(31, 41, 55, 0.85);
                color: #6EE7B7;
                border: 1px solid rgba(110, 231, 183, 0.35);
                border-radius: 10px;
                padding: 2px 8px;
                font-size: 11px;
            }
            QPushButton:hover { background-color: rgba(55, 65, 81, 0.95); }
        """)
        self._wake_btn.setCursor(Qt.CursorShape.PointingHandCursor)
        self._wake_btn.clicked.connect(self._toggle_wake)
        self._wake_btn.hide()

    def _connect_orb_signals(self) -> None:
        self.orb.start_listening_requested.connect(self._start_listening)
        self.orb.stop_listening_requested.connect(self.stop_listening)

    def _connect_ws_signals(self) -> None:
        self._ws.assistant_chunk.connect(self._on_assistant_chunk)
        self._ws.assistant_done.connect(self._on_assistant_done)
        self._ws.turn_started.connect(self._on_turn_started)
        self._ws.connected.connect(self._on_ws_connected)
        self._ws.disconnected.connect(self._on_ws_disconnected)
        self._ws.error.connect(self._on_ws_error)

    def _on_ws_connected(self) -> None:
        pass

    def _on_ws_disconnected(self, msg: str) -> None:
        try:
            self.orb.set_phase(OrbPhase.EXPANDED, f"连接断开：{msg}")
            self._layout_back_button()
        except Exception:  # noqa: BLE001
            traceback.print_exc()

    def _on_ws_error(self, msg: str) -> None:
        try:
            self.orb.set_phase(OrbPhase.EXPANDED, f"WS 错误：{msg}")
            self._layout_back_button()
        except Exception:  # noqa: BLE001
            traceback.print_exc()

    # ---- 跨线程 UI 更新（由工作线程通过信号触发，这里在主线程执行）----
    def _on_phase_changed(self, phase_name: str, subtitle: str) -> None:
        try:
            self.orb.set_phase(OrbPhase[phase_name], subtitle)
            self._layout_back_button()
        except Exception:  # noqa: BLE001
            traceback.print_exc()

    def _on_reply_text_changed(self, text: str) -> None:
        try:
            if text:
                self.orb._reply_text += text
                self.orb.subtitle = self.orb._reply_text
            else:
                # 空串 = 开始新一轮回复前重置
                self.orb._reply_text = ""
                self._pending_text = ""
            self.orb.set_phase(OrbPhase.SPEAKING, "")
            self.orb.update()
        except Exception:  # noqa: BLE001
            traceback.print_exc()

    def resizeEvent(self, event) -> None:
        super().resizeEvent(event)
        self._layout_back_button()

    def _layout_back_button(self) -> None:
        if self.orb.phase == OrbPhase.IDLE:
            self._back_btn.hide()
            self._wake_btn.hide()
            return
        # 唤醒开关在右，回到页面在左
        wbtn = self._wake_btn
        wbtn.adjustSize()
        x = self.orb.width() - wbtn.width() - 10
        y = 8
        if self.orb.phase in (OrbPhase.LISTENING, OrbPhase.SPEAKING):
            x = self.orb.width() - wbtn.width() - 14
            y = 12
        wbtn.move(x, y)
        wbtn.show()
        wbtn.raise_()

        btn = self._back_btn
        btn.adjustSize()
        x = x - btn.width() - 6
        btn.move(x, y)
        btn.show()
        btn.raise_()

    def _on_back_to_page(self) -> None:
        try:
            self.orb.back_to_page_requested.emit()
            # 通知父进程（Flutter 客户端）恢复页面模式
            print("__VOICE_ORB_EVENT__:PAGE_MODE_REQUESTED", flush=True)
            # 最小化隐藏悬浮球
            self.orb.set_phase(OrbPhase.IDLE)
            self.hide()
        except Exception:  # noqa: BLE001
            traceback.print_exc()

    # ---- 录音流程 ----
    def _start_listening(self) -> None:
        try:
            if self._recorder is not None and self._recorder.isRunning():
                return
            # 先停掉唤醒监听释放麦克风，稍等采集线程退出后再开录音
            self._pause_wake()
            self.orb.set_phase(OrbPhase.LISTENING, "正在聆听…")
            self._layout_back_button()
            QTimer.singleShot(300, self._do_start_listening)
        except Exception:  # noqa: BLE001
            traceback.print_exc()

    def _do_start_listening(self) -> None:
        try:
            if self._recorder is not None and self._recorder.isRunning():
                return
            self.orb.set_phase(OrbPhase.LISTENING, "正在聆听…")
            self._layout_back_button()
            self._recorder = AudioRecorder(self.cfg, self.orb)
            self._recorder.volume_changed.connect(self.orb._on_volume_changed)
            self._recorder.finished.connect(self._on_recording_finished)
            self._recorder.error.connect(self._on_recording_error)
            self._recorder.start()
        except Exception:  # noqa: BLE001
            traceback.print_exc()

    def stop_listening(self) -> None:
        try:
            if self._recorder:
                self._recorder.stop()
        except Exception:  # noqa: BLE001
            traceback.print_exc()

    def _on_recording_finished(self, path: str) -> None:
        try:
            self.orb.set_phase(OrbPhase.EXPANDED, "识别中…")
            threading.Thread(target=self._transcribe_and_chat, args=(path,), daemon=True).start()
        except Exception:  # noqa: BLE001
            traceback.print_exc()

    def _on_recording_error(self, msg: str) -> None:
        try:
            self.orb.set_phase(OrbPhase.EXPANDED, msg)
            # 录音失败也结束本轮，回到空闲并恢复唤醒
            self.turn_finished.emit()
        except Exception:  # noqa: BLE001
            traceback.print_exc()

    def _transcribe_and_chat(self, wav_path: str) -> None:
        try:
            with open(wav_path, "rb") as f:
                audio_b64 = base64.b64encode(f.read()).decode("ascii")
            resp = requests.post(
                f"{self.cfg.http_base}/brain/sensory/listen",
                json={
                    "audio": {
                        "data": audio_b64,
                        "format": self.cfg.format,
                        "sampleRate": self.cfg.sample_rate,
                        "channels": self.cfg.channels,
                    }
                },
                timeout=30,
            )
            resp.raise_for_status()
            data = resp.json()
            text = data.get("result", {}).get("text", "")
            if not text:
                # 工作线程不得直接操作 Qt 控件，通过信号回主线程
                self.phase_changed.emit("EXPANDED", "没听清，请再说一次")
                self.turn_finished.emit()
                return
            self.phase_changed.emit("SPEAKING", "")
            self.reply_text_changed.emit("")  # 重置上一轮回复
            self._ws.send_user_message(text)
        except Exception as exc:  # noqa: BLE001
            self.phase_changed.emit("EXPANDED", f"识别失败：{exc}")
            self.turn_finished.emit()
        finally:
            try:
                os.remove(wav_path)
            except OSError:
                pass

    # ---- WS 回调（主线程）----
    def _on_turn_started(self, message_id: str) -> None:
        try:
            self._last_message_id = message_id
            self.orb.set_phase(OrbPhase.SPEAKING, "")
        except Exception:  # noqa: BLE001
            traceback.print_exc()

    def _on_assistant_chunk(self, message_id: str, text: str) -> None:
        try:
            self._last_message_id = message_id
            self.orb.set_phase(OrbPhase.SPEAKING, "")
            self.orb._reply_text += text
            self.orb.subtitle = self.orb._reply_text
            self._pending_text += text
            self.orb.update()
        except Exception:  # noqa: BLE001
            traceback.print_exc()

    def _on_assistant_done(self, message_id: str) -> None:
        full = self._pending_text
        self._pending_text = ""
        if full:
            threading.Thread(target=self._speak, args=(full,), daemon=True).start()
        else:
            # 没有任何回复内容也结束本轮（恢复唤醒）
            self.turn_finished.emit()

    def _speak(self, text: str) -> None:
        try:
            resp = requests.post(
                f"{self.cfg.http_base}/brain/sensory/speak",
                json={"text": text},
                timeout=60,
            )
            resp.raise_for_status()
            data = resp.json()
            result = data.get("result", {})
            audio_data = result.get("data")
            if not audio_data:
                self.turn_finished.emit()
                return
            if isinstance(audio_data, str):
                raw = base64.b64decode(audio_data)
            else:
                raw = bytes(audio_data)
            fmt = result.get("format", "mp3")
            fd, path = tempfile.mkstemp(suffix=f".{fmt}")
            os.close(fd)
            with open(path, "wb") as f:
                f.write(raw)
            self._play_audio(path)
        except Exception as exc:  # noqa: BLE001
            self.phase_changed.emit("EXPANDED", f"播报失败：{exc}")
            self.turn_finished.emit()

    def _play_audio(self, path: str) -> None:
        try:
            url = QUrl.fromLocalFile(path)
            self._player.setSource(url)
            self._player.play()
        except Exception:  # noqa: BLE001
            traceback.print_exc()

    # ---- 语音唤醒 ----
    def _toggle_wake(self) -> None:
        try:
            self._set_wake_enabled(not self._wake_enabled)
        except Exception:  # noqa: BLE001
            traceback.print_exc()

    def _set_wake_enabled(self, enabled: bool) -> None:
        self._wake_enabled = enabled
        self._wake_btn.setText("唤醒：开" if enabled else "唤醒：关")
        if enabled:
            self._resume_wake()
        else:
            self._pause_wake()

    def _pause_wake(self) -> None:
        """停掉唤醒监听（采集线程尽快退出并释放麦克风），不阻塞等待。"""
        try:
            if self._wake is not None:
                self._wake.stop()
        except Exception:  # noqa: BLE001
            traceback.print_exc()

    def _resume_wake(self) -> None:
        try:
            if not self._wake_enabled:
                return
            if self._wake is not None and self._wake.isRunning():
                return
            # QThread 结束后不能复用，重建监听器
            self._wake = WakeListener(self.cfg, self)
            self._wake.woke.connect(self._on_wake)
            self._wake.status.connect(self._on_wake_status)
            self._wake.start()
        except Exception:  # noqa: BLE001
            traceback.print_exc()

    def _on_wake(self, text: str) -> None:
        """命中唤醒词：进入聆听态并开始录音。"""
        try:
            self.orb.set_phase(OrbPhase.LISTENING, "我在，请说")
            self._layout_back_button()
            # 唤醒线程已自行退出，再显式停一下确保采集线程释放麦克风
            self._pause_wake()
            QTimer.singleShot(350, self._do_start_listening)
        except Exception:  # noqa: BLE001
            traceback.print_exc()

    def _on_wake_status(self, msg: str) -> None:
        try:
            # 仅提示，不强制改变形态（避免启动时因麦克风问题突然展开）
            if self.orb.phase == OrbPhase.IDLE:
                self.orb.subtitle = msg
                self.orb.update()
            else:
                self.orb.set_phase(OrbPhase.EXPANDED, msg)
                self._layout_back_button()
        except Exception:  # noqa: BLE001
            traceback.print_exc()

    # ---- 一轮对话结束 ----
    def _on_media_status(self, status) -> None:
        try:
            if status == QMediaPlayer.MediaStatus.EndOfMedia:
                self.turn_finished.emit()
        except Exception:  # noqa: BLE001
            traceback.print_exc()

    def _on_turn_finished(self) -> None:
        try:
            self._resume_wake()
            # 从聆听/播报态回到空闲小球态；若已在提示态（如"没听清"）则保持，5s 后自动收起
            if self.orb.phase in (OrbPhase.LISTENING, OrbPhase.SPEAKING):
                self.orb.set_phase(OrbPhase.IDLE, "")
                self._layout_back_button()
        except Exception:  # noqa: BLE001
            traceback.print_exc()

    def closeEvent(self, event) -> None:
        try:
            self._pause_wake()
            self._ws.stop()
            self._ws.wait(2000)
        except Exception:  # noqa: BLE001
            traceback.print_exc()
        super().closeEvent(event)

    # ---- 父进程存活监控 ----
    def _check_parent_alive(self) -> None:
        try:
            if not self._is_process_alive(self._parent_pid):
                print("__VOICE_ORB_EVENT__:PARENT_EXITED", flush=True)
                self.close()
                app = QApplication.instance()
                if app is not None:
                    app.quit()
        except Exception:  # noqa: BLE001
            traceback.print_exc()

    @staticmethod
    def _is_process_alive(pid_: int) -> bool:
        """通过进程句柄探测 PID 是否仍存活（Windows）。"""
        try:
            import ctypes
        except ImportError:
            return True
        PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
        STILL_ACTIVE = 259
        handle = ctypes.windll.kernel32.OpenProcess(
            PROCESS_QUERY_LIMITED_INFORMATION, False, int(pid_)
        )
        if not handle:
            # 进程不存在（或无权访问），视为已退出
            return False
        try:
            exit_code = ctypes.c_ulong()
            if ctypes.windll.kernel32.GetExitCodeProcess(
                handle, ctypes.byref(exit_code)
            ):
                return exit_code.value == STILL_ACTIVE
            return True
        finally:
            ctypes.windll.kernel32.CloseHandle(handle)


def build_config_from_env() -> VoiceOrbConfig:
    env = os.environ
    return VoiceOrbConfig(
        ws_url=env.get("PAI_WS_URL", "ws://127.0.0.1:3000/ws"),
        http_base=env.get("PAI_HTTP_BASE", "http://127.0.0.1:3000"),
        session_id=env.get("PAI_SESSION_ID", ""),
        actor_id=env.get("PAI_ACTOR_ID", "default"),
        user_id=env.get("PAI_USER_ID", ""),
        parent_pid=int(env.get("PAI_ORB_PARENT_PID", "0") or 0),
    )


def main() -> int:
    app = QApplication(sys.argv)
    app.setQuitOnLastWindowClosed(False)
    cfg = build_config_from_env()
    try:
        window = VoiceOrbWindow(cfg)
        window.show()
    except Exception:  # noqa: BLE001
        # 启动失败也要把原因打出来，供 Flutter 侧 stderr 日志定位
        traceback.print_exc()
        print("__VOICE_ORB_EVENT__:STARTUP_FAILED", flush=True)
        return 1
    print("__VOICE_ORB_EVENT__:ORB_READY", flush=True)
    return app.exec()


if __name__ == "__main__":
    sys.exit(main())
