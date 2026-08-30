# Agent 纯语音对话模式 —— PySide6 声纹波形（无常驻悬浮球）
#
# 形态：待机时桌面上"什么都没有"——orb 进程隐身运行，只跑唤醒监听；
# 唤醒命中或对话进行时，屏幕下方浮现一块声纹波形（无框/透明/置顶/不抢焦点），
# 对话结束自动淡出。设计详见 docs/voice-mode-architecture.md。
#
# 职责：
#   1. WaveformOverlay：四态声纹浮窗（聆听/思考/播报/提示），淡入淡出、可拖动、右键菜单
#   2. WakeListener：语音唤醒（滑窗 ASR 匹配唤醒词；Phase 2 计划换本地热词模型）
#   3. ListeningRecorder：VAD 端点检测录音（静默 700ms 自动说完，免按键连续对话）
#   4. MicMonitor：TTS 播放期间的人声监视（barge-in lite：用户开口即停播）
#   5. 语音链路：录音 → ASR /brain/sensory/listen → WS chat.user_message →
#      chat.assistant_done → TTS /brain/sensory/speak → QMediaPlayer 播放
#   6. 语音退出：识别到"打开界面/退出语音…" → PAGE_MODE_REQUESTED → 进程退出，
#      父进程（Flutter）恢复主窗口
#
# 线程约定：QThread / QMediaPlayer / QWidget 只能在主线程操作。工作线程
# （ASR、TTS 请求）一律通过 Signal 回主线程，不得直接触碰 UI / 播放器 / QTimer。
from __future__ import annotations

import asyncio
import base64
import json
import math
import os
import queue
import random
import re
import struct
import sys
import tempfile
import threading
import time
import traceback
import wave
from collections import deque
from dataclasses import dataclass
from enum import Enum, auto
from typing import Optional

import pyaudio
import requests
import websockets
from PySide6.QtCore import (
    QObject,
    QPropertyAnimation,
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
    QPainter,
    QPen,
    QRadialGradient,
)
from PySide6.QtMultimedia import QAudioOutput, QMediaPlayer
from PySide6.QtWidgets import QApplication, QMenu, QWidget


class WaveState(Enum):
    """声纹浮窗状态机。HIDDEN = 隐身（仅唤醒监听）。"""

    HIDDEN = auto()
    LISTENING = auto()   # 聆听：波形随麦克风实时响度起伏
    THINKING = auto()    # 思考：波形缓慢行进（LLM 生成中）
    SPEAKING = auto()    # 播报：波形随音节包络起伏（TTS 播放中）
    NOTE = auto()        # 提示：短暂显示一句提示后淡出（如"没听清"）


@dataclass
class VoiceOrbConfig:
    ws_url: str = "ws://127.0.0.1:3000/ws"
    http_base: str = "http://127.0.0.1:3000"
    session_id: str = ""
    actor_id: str = "default"
    user_id: str = ""
    # 父进程（Flutter 客户端）PID；>0 时启动父进程存活监控，
    # 父进程退出后自动结束 orb，避免残留进程。
    parent_pid: int = 0
    # 录音参数（与 server funasr 默认保持一致）
    sample_rate: int = 16000
    channels: int = 1
    chunk_size: int = 1024
    format: str = "wav"

    @property
    def chunk_ms(self) -> float:
        """单个采集块的时长（毫秒）。chunk_size=1024 @16kHz ≈ 64ms。"""
        return self.chunk_size / self.sample_rate * 1000.0


# 语音退出口令：识别文本命中任意一条 → 请求父进程恢复页面并退出 orb。
# 语音模式没有可见 UI，这是用户不说话时也能找回窗口的兜底之一
#（另一个是波形右键菜单）。
EXIT_PHRASES = (
    "打开界面", "回到界面", "显示界面", "打开主界面", "显示主界面",
    "回到页面", "打开页面", "显示页面", "回到主页",
    "退出语音", "退出语音模式", "关闭语音", "关闭语音模式", "结束语音",
)


def _print_event(event: str) -> None:
    """向父进程（Flutter）输出协议事件，stdout 单行 flush。"""
    print(f"__VOICE_ORB_EVENT__:{event}", flush=True)


def rms_of(data: bytes) -> float:
    """16kHz int16 PCM 块的 RMS 响度（0~32768）。"""
    count = len(data) // 2
    if count == 0:
        return 0.0
    shorts = struct.unpack(f"{count}h", data)
    sum_squares = sum((s / 32768.0) ** 2 for s in shorts)
    return (sum_squares / count) ** 0.5 * 32768.0


def transcribe_wav(cfg: VoiceOrbConfig, wav_path: str, timeout: float = 30) -> str:
    """把 wav 文件 POST 到 /brain/sensory/listen 做 ASR，返回文本（失败空串）。"""
    with open(wav_path, "rb") as f:
        audio_b64 = base64.b64encode(f.read()).decode("ascii")
    resp = requests.post(
        f"{cfg.http_base}/brain/sensory/listen",
        json={
            "audio": {
                "data": audio_b64,
                "format": cfg.format,
                "sampleRate": cfg.sample_rate,
                "channels": cfg.channels,
            }
        },
        timeout=timeout,
    )
    resp.raise_for_status()
    data = resp.json()
    return str(data.get("result", {}).get("text", "") or "").strip()


class MicStreamBase(QThread):
    """共用基类：打开一个独占的麦克风采集流并循环读块。

    子类通过 _on_chunk(data, rms) 消费音频块；stop() 请求尽快退出并释放麦克风。
    注意：整个 orb 里同一时刻只允许一个采集流（唤醒监听 / 录音 / 播放监视互斥），
    由 VoiceSession 负责编排先后。
    """

    error = Signal(str)

    def __init__(self, cfg: VoiceOrbConfig, parent: Optional[QObject] = None) -> None:
        super().__init__(parent)
        self.cfg = cfg
        self._stop_event = threading.Event()

    def stop(self) -> None:
        self._stop_event.set()

    def _open_stream(self):
        audio = pyaudio.PyAudio()
        try:
            stream = audio.open(
                format=pyaudio.paInt16,
                channels=self.cfg.channels,
                rate=self.cfg.sample_rate,
                input=True,
                frames_per_buffer=self.cfg.chunk_size,
            )
        except Exception:
            audio.terminate()
            raise
        return audio, stream

    def run(self) -> None:
        try:
            audio, stream = self._open_stream()
        except Exception as exc:  # noqa: BLE001
            self.error.emit(f"麦克风启动失败：{exc}")
            return
        try:
            while not self._stop_event.is_set():
                try:
                    data = stream.read(self.cfg.chunk_size, exception_on_overflow=False)
                except Exception as exc:  # noqa: BLE001
                    self.error.emit(f"录音读取失败：{exc}")
                    break
                self._on_chunk(data, rms_of(data))
        finally:
            try:
                stream.stop_stream()
                stream.close()
            except Exception:  # noqa: BLE001
                pass
            try:
                audio.terminate()
            except Exception:  # noqa: BLE001
                pass

    def _on_chunk(self, data: bytes, level: float) -> None:  # pragma: no cover
        raise NotImplementedError


class ListeningRecorder(MicStreamBase):
    """带 VAD 端点检测的录音线程（免按键连续对话的核心）。

    行为：
      - 响度连续 `SPEECH_START_CHUNKS` 块超阈值 → 判定开始说话；
      - 开始说话后，静默持续 `SILENCE_MS` → 判定说完，发出 finished(wav 路径)；
      - 未开始说话时等待超过 `pre_speech_timeout_s`（>0 时）→ aborted("no_speech")，
        用于追问窗口（"继续说，或等我隐身"）；
      - 无论是否说完，开口后总时长超过 `MAX_DURATION_S` → 强制收尾。
    为避免吞字，wav 里包含说话前 0.5s 的预缓冲。
    """

    level_changed = Signal(float)
    finished = Signal(str)     # 录制的 wav 文件路径
    aborted = Signal(str)      # 放弃原因（no_speech / stopped）

    SPEECH_START_RMS = 900     # 判定"开口"的响度阈值
    SPEECH_START_CHUNKS = 2    # 连续多少块超阈值判定开口
    SILENCE_MS = 700           # 说完后静默多久收尾
    MAX_DURATION_S = 20.0      # 单次录音上限（自开口起算）
    PREBUFFER_SECONDS = 0.5    # 预缓冲时长（回补开口前的音频）

    def __init__(self, cfg: VoiceOrbConfig, parent: Optional[QObject] = None,
                 pre_speech_timeout_s: float = 0.0) -> None:
        super().__init__(cfg, parent)
        self._pre_speech_timeout_s = pre_speech_timeout_s

    def _reset(self) -> None:
        prebuf_chunks = max(1, int(self.PREBUFFER_SECONDS * 1000 / self.cfg.chunk_ms))
        self._frames: list[bytes] = []
        self._prebuf: deque = deque(maxlen=prebuf_chunks)
        self._loud_streak = 0
        self._silence_ms = 0.0
        self._started = False
        self._started_at = 0.0
        self._begin_at = time.monotonic()

    def _on_chunk(self, data: bytes, level: float) -> None:
        if not hasattr(self, "_frames"):
            self._reset()
        self._prebuf.append(data)
        self.level_changed.emit(min(1.0, level / 32768.0 * 8.0))

        now = time.monotonic()
        if not self._started:
            if level >= self.SPEECH_START_RMS:
                self._loud_streak += 1
                if self._loud_streak >= self.SPEECH_START_CHUNKS:
                    self._started = True
                    self._started_at = now
                    self._frames.extend(self._prebuf)  # 回补开口前的音频
                    self._silence_ms = 0.0
                    return
            else:
                self._loud_streak = 0
            if (
                self._pre_speech_timeout_s > 0
                and now - self._begin_at >= self._pre_speech_timeout_s
            ):
                self.aborted.emit("no_speech")
                self.stop()
            return

        # 已开口：积累 / 判停
        self._frames.append(data)
        if level < self.SPEECH_START_RMS:
            self._silence_ms += self.cfg.chunk_ms
            if self._silence_ms >= self.SILENCE_MS:
                self._emit_finished()
                return
        else:
            self._silence_ms = 0.0
        if now - self._started_at >= self.MAX_DURATION_S:
            self._emit_finished()

    def _emit_finished(self) -> None:
        self.stop()
        frames = list(self._frames)
        if not frames:
            self.aborted.emit("no_speech")
            return
        try:
            fd, path = tempfile.mkstemp(suffix=".wav")
            os.close(fd)
            with wave.open(path, "wb") as wf:
                wf.setnchannels(self.cfg.channels)
                wf.setsampwidth(2)
                wf.setframerate(self.cfg.sample_rate)
                wf.writeframes(b"".join(frames))
        except Exception as exc:  # noqa: BLE001
            self.error.emit(f"录音文件写入失败：{exc}")
            return
        self.finished.emit(path)


class MicMonitor(MicStreamBase):
    """播放期间的人声监视（barge-in lite）。

    TTS 播放时不做 ASR（省成本、也避免自听回环），只盯响度：
    连续约 0.5s 超阈值 → 发出 barge_in，由 VoiceSession 停播回聆听。
    """

    level_changed = Signal(float)
    barge_in = Signal()

    BARGE_RMS = 1200           # 播放环境下人声阈值略抬高
    BARGE_WINDOW_MS = 500      # 持续人声多久触发（防偶发噪声）

    def _on_chunk(self, data: bytes, level: float) -> None:
        if not hasattr(self, "_streak_ms"):
            self._streak_ms = 0.0
        self.level_changed.emit(min(1.0, level / 32768.0 * 8.0))
        if level >= self.BARGE_RMS:
            self._streak_ms += self.cfg.chunk_ms
            if self._streak_ms >= self.BARGE_WINDOW_MS:
                self._streak_ms = 0.0
                self.barge_in.emit()
        else:
            self._streak_ms = 0.0


class WakeListener(QThread):
    """语音唤醒 — 持续监听唤醒词，命中后触发回调。

    采集线程持续读麦克风（16kHz 单声道 int16），把字节块放入队列；
    本线程每间隔取最近 1.5s 滑动窗口 POST /brain/sensory/listen 做 ASR，
    匹配到唤醒词后发出 woke 信号并退出（释放麦克风）。
    响度过低时跳过识别，避免持续请求服务端。
    （Phase 2 计划替换为 sherpa-onnx 本地热词模型，消除持续 ASR 成本。）
    """

    woke = Signal(str)    # 命中的唤醒词文本
    error = Signal(str)   # 麦克风不可用等错误

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
                if rms_of(snap) < self.MIN_RMS:
                    continue
                text = self._asr(snap)
                if text and self._match_wake(text):
                    self.woke.emit(text)
                    break
        except Exception as exc:  # noqa: BLE001
            self.error.emit(f"唤醒异常：{exc}")
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
            # 设备不可用（如当前会话没有默认输入设备）属环境问题，上报即可
            if not self._stop_event.is_set():
                self.error.emit(f"唤醒麦克风不可用：{exc}")
        except Exception as exc:  # noqa: BLE001
            if not self._stop_event.is_set():
                self.error.emit(f"唤醒麦克风失败：{exc}")
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


class WsClient(QThread):
    """WebSocket 客户端：负责 session.init + 收发聊天事件。"""

    connected = Signal()
    disconnected = Signal(str)
    assistant_chunk = Signal(str, str)   # message_id, text
    assistant_done = Signal(str)         # message_id
    turn_started = Signal(str)
    error = Signal(str)

    def __init__(self, cfg: VoiceOrbConfig, parent: Optional[QObject] = None) -> None:
        super().__init__(parent)
        self.cfg = cfg
        self._send_queue: list[dict] = []
        self._queue_lock = threading.Lock()
        self._ws = None
        self._loop = None
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
        if self._ws and self._loop:
            try:
                asyncio.run_coroutine_threadsafe(self._ws.close(), self._loop)
            except Exception:  # noqa: BLE001
                pass

    def run(self) -> None:
        self._loop = asyncio.new_event_loop()
        asyncio.set_event_loop(self._loop)
        self._loop.run_until_complete(self._loop_body())

    async def _loop_body(self) -> None:
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
                    # 收回取消/异常的协程结果，避免 "Task exception was never retrieved" 告警
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
            # 自动重连（指数退避），保证 server 中途重启/宕机后 orb 仍可用
            delay = min(2.0 * (2 ** retry), 15.0)
            retry += 1
            self.disconnected.emit(f"连接断开，{int(delay)} 秒后重连…")
            try:
                await asyncio.sleep(delay)
            except asyncio.CancelledError:
                break

    async def _consume(self, ws) -> None:
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
            except Exception as exc:  # noqa: BLE001
                self.error.emit(f"解析消息失败：{exc}")

    async def _sender(self, ws) -> None:
        while not self._stop_event.is_set():
            to_send = []
            with self._queue_lock:
                to_send, self._send_queue = self._send_queue, []
            for envelope in to_send:
                await ws.send(json.dumps(envelope))
            await asyncio.sleep(0.05)


class WaveformOverlay(QWidget):
    """声纹波形浮窗：语音模式在桌面上的全部"存在"。

    - 无框 / 透明 / 置顶 / 不接受焦点（不抢键盘，不进任务栏）
    - 显示/隐藏由 VoiceSession 控制：淡入 → 对话 → 淡出 → 隐身
    - 左键拖动换位置；右键菜单：打开主界面 / 静音
    """

    open_page_requested = Signal()
    mute_toggled = Signal(bool)

    WIDTH = 460
    HEIGHT = 170
    BAR_COUNT = 32
    BAR_W = 6
    BAR_GAP = 5

    STATE_COLOR = {
        WaveState.LISTENING: "#60A5FA",
        WaveState.THINKING: "#FBBF24",
        WaveState.SPEAKING: "#34D399",
        WaveState.NOTE: "#9CA3AF",
    }
    STATE_TEXT = {
        WaveState.LISTENING: "我在听",
        WaveState.THINKING: "想一下…",
        WaveState.SPEAKING: "",
        WaveState.NOTE: "",
    }

    def __init__(self) -> None:
        super().__init__()
        self.setWindowFlags(
            Qt.WindowType.FramelessWindowHint
            | Qt.WindowType.WindowStaysOnTopHint
            | Qt.WindowType.Tool
            | Qt.WindowType.WindowDoesNotAcceptFocus
        )
        self.setAttribute(Qt.WidgetAttribute.WA_TranslucentBackground)
        self.setAttribute(Qt.WidgetAttribute.WA_NoSystemBackground)
        self.setFixedSize(self.WIDTH, self.HEIGHT)

        self.state = WaveState.HIDDEN
        self.caption = ""
        self.volume = 0.0          # 聆听态实时响度（0~1，EMA 平滑后）
        self._raw_volume = 0.0
        self._t = 0.0
        self._speak_levels = [0.3] * self.BAR_COUNT
        self._speak_targets = [0.3] * self.BAR_COUNT
        self._target_tick = 0
        self._muted = False

        self._timer = QTimer(self)
        self._timer.timeout.connect(self._on_tick)
        self._timer.start(33)

        self._fade = QPropertyAnimation(self, b"windowOpacity")
        self._fade.setDuration(200)
        self._after_fade: Optional[str] = None  # "hide"：淡出结束后隐身

    # ---- 状态切换 ----

    def show_state(self, state: WaveState, caption: str = "") -> None:
        """淡入并进入指定状态（已可见则平滑切换）。主线程调用。"""
        self.state = state
        self.caption = caption or self.STATE_TEXT.get(state, "")
        if not self.isVisible():
            self._position()
            self.setWindowOpacity(0.0)
            self.show()
            self._start_fade(1.0, None)
        self.update()

    def fade_out(self) -> None:
        """淡出后隐身（回到唤醒待命）。主线程调用。"""
        if not self.isVisible():
            return
        self.state = WaveState.HIDDEN
        self._start_fade(0.0, "hide")

    def set_volume(self, value: float) -> None:
        self._raw_volume = value

    # ---- 内部 ----

    def _position(self) -> None:
        screen = QApplication.primaryScreen()
        if screen is None:
            return
        geo = screen.availableGeometry()  # 已排除任务栏
        x = geo.x() + (geo.width() - self.WIDTH) // 2
        y = geo.y() + geo.height() - self.HEIGHT - 24
        self.move(x, y)

    def _start_fade(self, to: float, after: Optional[str]) -> None:
        self._fade.stop()
        self._after_fade = after
        self._fade.setStartValue(self.windowOpacity())
        self._fade.setEndValue(to)
        self._fade.start()

    def _on_tick(self) -> None:
        self._t += 0.033
        # 聆听响度 EMA 平滑，波形不至于抖成噪声
        self.volume += (self._raw_volume - self.volume) * 0.25
        # 播报态：每 ~130ms 换一包随机目标（模拟音节包络），向目标缓动
        self._target_tick += 1
        if self._target_tick >= 4:
            self._target_tick = 0
            peak = 0.55 + 0.4 * random.random()
            self._speak_targets = [
                peak * (0.25 + 0.75 * random.random()) for _ in range(self.BAR_COUNT)
            ]
        for i in range(self.BAR_COUNT):
            cur = self._speak_levels[i]
            self._speak_levels[i] = cur + (self._speak_targets[i] - cur) * 0.35
        if self._after_fade == "hide" and self.windowOpacity() <= 0.02:
            self._after_fade = None
            self.hide()
        self.update()

    # ---- 交互 ----

    _DRAG_THRESHOLD = 6  # px

    def mousePressEvent(self, event) -> None:
        if event.button() == Qt.MouseButton.LeftButton:
            self._press_global = event.globalPosition().toPoint()
            self._press_pos = self.pos()
            self._drag_started = False
            event.accept()

    def mouseMoveEvent(self, event) -> None:
        try:
            if (
                event.buttons() & Qt.MouseButton.LeftButton
                and hasattr(self, "_press_global")
                and self._press_global is not None
            ):
                delta = event.globalPosition().toPoint() - self._press_global
                if not self._drag_started and delta.manhattanLength() > self._DRAG_THRESHOLD:
                    self._drag_started = True
                if self._drag_started:
                    self.move(self._press_pos + delta)
                    event.accept()
        except Exception:  # noqa: BLE001
            traceback.print_exc()

    def mouseReleaseEvent(self, event) -> None:
        self._press_global = None
        self._drag_started = False

    def contextMenuEvent(self, event) -> None:
        try:
            menu = QMenu(self)
            open_action = menu.addAction("打开主界面")
            mute_action = menu.addAction("取消静音" if self._muted else "静音")
            chosen = menu.exec(event.globalPos())
            if chosen is open_action:
                self.open_page_requested.emit()
            elif chosen is mute_action:
                self._muted = not self._muted
                self.mute_toggled.emit(self._muted)
        except Exception:  # noqa: BLE001
            traceback.print_exc()

    # ---- 绘制 ----

    def paintEvent(self, event) -> None:
        try:
            painter = QPainter(self)
            painter.setRenderHint(QPainter.RenderHint.Antialiasing)
            color = QColor(self.STATE_COLOR.get(self.state, "#60A5FA"))

            # 中央柔光
            glow = QRadialGradient(self.WIDTH / 2, self.HEIGHT * 0.42, self.WIDTH * 0.42)
            glow.setColorAt(0, QColor(color.red(), color.green(), color.blue(), 46))
            glow.setColorAt(1, QColor(color.red(), color.green(), color.blue(), 0))
            painter.setBrush(QBrush(glow))
            painter.setPen(Qt.PenStyle.NoPen)
            painter.drawEllipse(0, 0, self.WIDTH, self.HEIGHT)

            # 声纹条
            painter.setPen(Qt.PenStyle.NoPen)
            total_w = self.BAR_COUNT * (self.BAR_W + self.BAR_GAP) - self.BAR_GAP
            x0 = (self.WIDTH - total_w) / 2
            cy = self.HEIGHT * 0.42
            max_h = 74.0
            for i in range(self.BAR_COUNT):
                amp = self._bar_amplitude(i)
                h = max(3.0, max_h * amp)
                phase = self._t * 1.6 + i * 0.55
                alpha = 150 + int(70 * (0.5 + 0.5 * math.sin(phase)))
                c = QColor(color)
                c.setAlpha(alpha)
                painter.setBrush(QBrush(c))
                rect_x = x0 + i * (self.BAR_W + self.BAR_GAP)
                painter.drawRoundedRect(
                    int(rect_x), int(cy - h / 2), self.BAR_W, int(h),
                    self.BAR_W // 2, self.BAR_W // 2,
                )

            # 状态字幕
            if self.caption:
                painter.setPen(QPen(QColor(230, 233, 240, 210)))
                painter.setFont(QFont("Microsoft YaHei", 10))
                painter.drawText(
                    0, int(self.HEIGHT * 0.72), self.WIDTH, 34,
                    Qt.AlignmentFlag.AlignHCenter | Qt.AlignmentFlag.AlignVCenter,
                    self.caption,
                )
        except Exception:  # noqa: BLE001
            # 绘制异常不允许逃逸出事件循环，否则可能导致进程被 Qt 终止
            traceback.print_exc()

    def _bar_amplitude(self, index: int) -> float:
        """各状态下第 index 根声纹条的振幅（0~1）。"""
        if self.state == WaveState.LISTENING:
            jitter = 0.75 + 0.25 * (1 + math.sin(self._t * 3 + index * 0.9)) / 2
            return max(0.06, min(1.0, self.volume * 2.2 * jitter))
        if self.state == WaveState.THINKING:
            wave_phase = math.sin(self._t * 2.2 - index * 0.45)
            return 0.18 + 0.30 * (0.5 + 0.5 * wave_phase)
        if self.state == WaveState.SPEAKING:
            return max(0.08, min(1.0, self._speak_levels[index]))
        # NOTE / HIDDEN：轻呼吸
        return 0.12 + 0.10 * (1 + math.sin(self._t * 1.8)) / 2


class VoiceSession(QObject):
    """语音模式编排器：唤醒 → 聆听 → 识别 → 对话 → 播报 → 追问 → 隐身。

    麦克风互斥编排（同一时刻只允许一个采集流）：
      唤醒监听 ──命中──▶ 停唤醒 ──▶ 录音(VAD) ──说完──▶ ASR ──▶ 播报
        ▲                                                        │
        └──追问窗口超时/淡出 ◀──播报结束（或 barge-in 直接回录音）◀──┘

    线程约定：ASR/TTS 在 daemon 线程里跑，结果一律经 Signal 回主线程；
    overlay / player / recorder / monitor 都只在主线程创建与驱动。
    """

    # 跨线程信号（worker → 主线程）
    _show_state = Signal(str, str)     # (WaveState 名, caption)
    _play_requested = Signal(str)      # 播放本地音频文件
    _turn_failed = Signal(str)         # 本轮失败（识别/播报异常）

    FOLLOWUP_WINDOW_S = 10.0           # 播报结束后保持追问聆听的时长
    NOTE_DISPLAY_MS = 2600             # 提示文案显示多久后淡出

    def __init__(self, cfg: VoiceOrbConfig, overlay: WaveformOverlay) -> None:
        super().__init__()
        self.cfg = cfg
        self.overlay = overlay
        self._muted = False

        self._recorder: Optional[ListeningRecorder] = None
        self._monitor: Optional[MicMonitor] = None
        self._wake: Optional[WakeListener] = None
        self._turn_active = False
        self._pending_text = ""

        self._ws = WsClient(cfg)
        self._ws.assistant_chunk.connect(self._on_assistant_chunk)
        self._ws.assistant_done.connect(self._on_assistant_done)
        self._ws.turn_started.connect(self._on_turn_started)
        self._ws.disconnected.connect(self._on_ws_disconnected)
        self._ws.error.connect(lambda _m: None)
        self._ws.start()

        self._player = QMediaPlayer(self)
        self._audio_output = QAudioOutput(self)
        self._player.setAudioOutput(self._audio_output)
        self._player.mediaStatusChanged.connect(self._on_media_status)

        self._show_state.connect(self._on_show_state)
        self._play_requested.connect(self._play_audio)
        self._turn_failed.connect(self._on_turn_failed)
        self._note_timer = QTimer(self)
        self._note_timer.setSingleShot(True)
        self._note_timer.timeout.connect(self._on_note_timeout)

        self._parent_pid = cfg.parent_pid
        self._parent_watchdog: Optional[QTimer] = None
        if self._parent_pid > 0:
            self._parent_watchdog = QTimer(self)
            self._parent_watchdog.timeout.connect(self._check_parent_alive)
            self._parent_watchdog.start(2000)

        overlay.mute_toggled.connect(self._set_muted)
        overlay.open_page_requested.connect(self._request_open_page)

    def start(self) -> None:
        self._resume_wake()

    # ---- 状态/提示（主线程槽） ----

    def _on_show_state(self, state_name: str, caption: str) -> None:
        try:
            self.overlay.show_state(WaveState[state_name], caption)
        except Exception:  # noqa: BLE001
            traceback.print_exc()

    def _show_note_and_fade(self, msg: str, display_ms: int = NOTE_DISPLAY_MS) -> None:
        try:
            self.overlay.show_state(WaveState.NOTE, msg)
            self._note_timer.start(display_ms)
        except Exception:  # noqa: BLE001
            traceback.print_exc()

    def _on_note_timeout(self) -> None:
        try:
            if self.overlay.state == WaveState.NOTE:
                self.overlay.fade_out()
                QTimer.singleShot(250, self._resume_wake)
        except Exception:  # noqa: BLE001
            traceback.print_exc()

    # ---- 唤醒 ----

    def _resume_wake(self) -> None:
        if self._muted:
            return
        if self._wake is not None and self._wake.isRunning():
            return
        self._wake = WakeListener(self.cfg, self)
        self._wake.woke.connect(self._on_wake)
        self._wake.error.connect(self._on_wake_error)
        self._wake.start()

    def _pause_wake(self) -> None:
        try:
            if self._wake is not None:
                self._wake.stop()
        except Exception:  # noqa: BLE001
            traceback.print_exc()

    def _on_wake(self, _text: str) -> None:
        try:
            if self._turn_active or (self._recorder and self._recorder.isRunning()):
                return
            self.overlay.show_state(WaveState.LISTENING, "我在听，请说")
            # 唤醒线程自行退出释放麦克风；稍等再开录音，避免设备占用冲突
            QTimer.singleShot(350, self._start_listening)
        except Exception:  # noqa: BLE001
            traceback.print_exc()

    def _on_wake_error(self, msg: str) -> None:
        try:
            if "不可用" in msg or "失败" in msg:
                # 麦克风彻底不可用：通知父进程恢复窗口后退出，避免用户"失联"
                _print_event("MIC_UNAVAILABLE")
                QTimer.singleShot(300, self._quit)
                return
            self._show_note_and_fade(msg)
        except Exception:  # noqa: BLE001
            traceback.print_exc()

    # ---- 录音（VAD 端点） ----

    def _start_listening(self, followup_window_s: float = 0.0,
                         caption: str = "我在听，请说") -> None:
        try:
            if self._recorder is not None and self._recorder.isRunning():
                return
            self._pause_wake()
            self.overlay.show_state(WaveState.LISTENING, caption)
            self._recorder = ListeningRecorder(
                self.cfg, self, pre_speech_timeout_s=followup_window_s,
            )
            self._recorder.level_changed.connect(self.overlay.set_volume)
            self._recorder.finished.connect(self._on_recording_finished)
            self._recorder.aborted.connect(self._on_recording_aborted)
            self._recorder.error.connect(self._on_recording_error)
            self._recorder.start()
        except Exception:  # noqa: BLE001
            traceback.print_exc()

    def _on_recording_aborted(self, _reason: str) -> None:
        try:
            # 追问窗口没人说话（或空录音）→ 淡出回到隐身唤醒
            self.overlay.fade_out()
            QTimer.singleShot(250, self._resume_wake)
        except Exception:  # noqa: BLE001
            traceback.print_exc()

    def _on_recording_error(self, msg: str) -> None:
        self._turn_failed.emit(msg)

    # ---- 识别 → 对话（worker 线程，只经信号回主线程） ----

    def _on_recording_finished(self, path: str) -> None:
        try:
            self.overlay.show_state(WaveState.THINKING, "识别中…")
            threading.Thread(
                target=self._transcribe_and_chat, args=(path,), daemon=True,
            ).start()
        except Exception:  # noqa: BLE001
            traceback.print_exc()

    def _transcribe_and_chat(self, wav_path: str) -> None:
        try:
            text = transcribe_wav(self.cfg, wav_path)
            if not text:
                self._turn_failed.emit("没听清，请再喊我")
                return
            if any(p in re.sub(r"\s+", "", text) for p in EXIT_PHRASES):
                print(f"[voice-orb] exit phrase: {text}", flush=True)
                self._request_open_page()
                return
            self._turn_active = True
            self._pending_text = ""
            self._show_state.emit("THINKING", text[:24])
            self._ws.send_user_message(text)
        except Exception as exc:  # noqa: BLE001
            self._turn_failed.emit(f"识别失败：{exc}")
        finally:
            try:
                os.remove(wav_path)
            except OSError:
                pass

    # ---- WS 回调（主线程） ----

    def _on_turn_started(self, _message_id: str) -> None:
        self.overlay.show_state(WaveState.THINKING, "想一下…")

    def _on_assistant_chunk(self, _message_id: str, text: str) -> None:
        self._pending_text += text

    def _on_assistant_done(self, _message_id: str) -> None:
        full = self._pending_text
        self._pending_text = ""
        if full.strip():
            self.overlay.show_state(WaveState.THINKING, "想一下…")
            threading.Thread(target=self._speak, args=(full,), daemon=True).start()
        else:
            self._end_turn()

    def _speak(self, text: str) -> None:
        """worker 线程：TTS 合成；成功后经 _play_requested 回主线程播放。"""
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
                self._turn_failed.emit("（本轮没有可播报的内容）")
                return
            raw = (
                base64.b64decode(audio_data)
                if isinstance(audio_data, str)
                else bytes(audio_data)
            )
            fmt = result.get("format", "mp3")
            fd, path = tempfile.mkstemp(suffix=f".{fmt}")
            os.close(fd)
            with open(path, "wb") as f:
                f.write(raw)
            self._play_requested.emit(path)
        except Exception as exc:  # noqa: BLE001
            self._turn_failed.emit(f"播报失败：{exc}")

    def _play_audio(self, path: str) -> None:
        """主线程槽：启动人声监视（barge-in lite）后播放。"""
        try:
            self._start_monitor()
            self.overlay.show_state(WaveState.SPEAKING)
            self._player.setSource(QUrl.fromLocalFile(path))
            self._player.play()
        except Exception:  # noqa: BLE001
            traceback.print_exc()

    def _start_monitor(self) -> None:
        try:
            if self._monitor is not None and self._monitor.isRunning():
                return
            self._monitor = MicMonitor(self.cfg, self)
            self._monitor.barge_in.connect(self._on_barge_in)
            self._monitor.error.connect(lambda _m: None)
            self._monitor.start()
        except Exception:  # noqa: BLE001
            traceback.print_exc()

    def _stop_monitor(self) -> None:
        try:
            if self._monitor is not None:
                self._monitor.stop()
        except Exception:  # noqa: BLE001
            traceback.print_exc()

    def _on_barge_in(self) -> None:
        """用户在播报中开口：停播 → 直接回聆听（不等播完）。"""
        try:
            self._stop_monitor()
            self._player.stop()
            # 用追问窗口兜底：若"开口"是扬声器噪声误触发，10s 无声自动隐身
            QTimer.singleShot(250, lambda: self._start_listening(
                followup_window_s=self.FOLLOWUP_WINDOW_S, caption="请讲",
            ))
        except Exception:  # noqa: BLE001
            traceback.print_exc()

    def _on_media_status(self, status) -> None:
        try:
            if status == QMediaPlayer.MediaStatus.EndOfMedia:
                self._stop_monitor()
                self._end_turn()
        except Exception:  # noqa: BLE001
            traceback.print_exc()

    # ---- 一轮收尾 / 追问 ----

    def _end_turn(self) -> None:
        try:
            self._turn_active = False
            # 追问窗口：保持聆听 10s，开口即继续（免唤醒词）；没人说话则隐身
            QTimer.singleShot(250, lambda: self._start_listening(
                followup_window_s=self.FOLLOWUP_WINDOW_S,
                caption="继续说，或等我隐身",
            ))
        except Exception:  # noqa: BLE001
            traceback.print_exc()

    def _on_turn_failed(self, msg: str) -> None:
        try:
            self._turn_active = False
            self._stop_monitor()
            self._show_note_and_fade(msg)
        except Exception:  # noqa: BLE001
            traceback.print_exc()

    def _on_ws_disconnected(self, msg: str) -> None:
        try:
            if self._turn_active:
                self._show_note_and_fade(f"连接断开：{msg[:40]}")
        except Exception:  # noqa: BLE001
            traceback.print_exc()

    # ---- 静音 / 退出 ----

    def _set_muted(self, muted: bool) -> None:
        self._muted = muted
        if muted:
            self._pause_wake()
            self._show_note_and_fade("已静音（右键取消）", display_ms=self.NOTE_DISPLAY_MS * 2)
        else:
            self._show_note_and_fade("已取消静音")
            QTimer.singleShot(300, self._resume_wake)

    def _request_open_page(self) -> None:
        """请求父进程恢复页面模式，orb 淡出后退出。"""
        try:
            _print_event("PAGE_MODE_REQUESTED")
            self.overlay.fade_out()
            QTimer.singleShot(400, self._quit)
        except Exception:  # noqa: BLE001
            traceback.print_exc()

    def _quit(self) -> None:
        try:
            self._pause_wake()
            self._stop_monitor()
            self._ws.stop()
            self._ws.wait(2000)
        except Exception:  # noqa: BLE001
            traceback.print_exc()
        app = QApplication.instance()
        if app is not None:
            app.quit()

    # ---- 父进程存活监控 ----

    def _check_parent_alive(self) -> None:
        try:
            if not self._is_process_alive(self._parent_pid):
                _print_event("PARENT_EXITED")
                self._quit()
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
        overlay = WaveformOverlay()
        session = VoiceSession(cfg, overlay)
        session.start()
    except Exception:  # noqa: BLE001
        # 启动失败也要把原因打出来，供 Flutter 侧 stderr 日志定位
        traceback.print_exc()
        _print_event("STARTUP_FAILED")
        return 1
    _print_event("ORB_READY")
    return app.exec()


if __name__ == "__main__":
    sys.exit(main())
