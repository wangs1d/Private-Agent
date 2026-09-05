# Agent 纯语音对话模式 —— 常驻竖波悬浮件（桌面唯一可见形态）
#
# 形态：语音模式下桌面上没有任何画面，只有一个**常驻的竖波悬浮件**——
# 一枚细长的竖向波纹胶囊（无框/透明/置顶/不抢焦点），波纹随对话状态起伏，
# 即语音模式的"化身"。悬浮件是模式切换的唯一入口：
#   - 鼠标悬停 → 右侧滑出「界面模式」选择组件，点击切回完整界面模式
#   - 左键点击（未拖动）→ 直接开始聆听（免唤醒词说话）
#   - 拖动 → 换位置；右键菜单 → 静音 / 打开主界面
#
# 对话直达所有能力（Surface-on-Demand）：悬浮件左侧浮现**临时浮层卡**
# （自动淡出、可关闭、悬停暂停淡出）：
#   - 今日安排：surface.show(today_schedule) → GET /api/schedule/today 自取数据
#   - 图片/视频：chat.media_ready / chat.assistant_done(mediaCards) → 缩略图墙，
#     点击用系统浏览器打开
#
# 职责清单：
#   1. VerticalWaveOrb：竖向波纹胶囊（待机/聆听/思考/播报/提示五态）+ 悬停模式选择
#   2. ToastCard / CardStack：浮层卡片（日程/媒体/文本），TTL 自动淡出
#   3. WakeListener：语音唤醒（滑窗 ASR 匹配唤醒词；Phase 2 计划换本地热词模型）
#   4. ListeningRecorder：VAD 端点检测录音（静默 700ms 自动说完，免按键连续对话）
#   5. MicMonitor：TTS 播放期间的人声监视（barge-in lite：用户开口即停播）
#   6. 语音链路：录音 → ASR /brain/sensory/listen → WS chat.user_message →
#      chat.assistant_done → TTS /brain/sensory/speak → QMediaPlayer 播放
#   7. 语音退出：识别到"打开界面/退出语音…" 或点击「界面模式」→
#      PAGE_MODE_REQUESTED → 进程退出，父进程（Flutter）恢复主窗口
#
# 线程约定：QThread / QMediaPlayer / QWidget 只能在主线程操作。工作线程
# （ASR、TTS、日程/缩略图 HTTP 请求）一律通过 Signal 回主线程，
# 不得直接触碰 UI / 播放器 / QTimer。
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
from datetime import datetime
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
    QPointF,
    Signal,
)
from PySide6.QtGui import (
    QBrush,
    QColor,
    QDesktopServices,
    QFont,
    QFontMetrics,
    QPainter,
    QPainterPath,
    QPen,
    QPixmap,
)
from PySide6.QtMultimedia import QAudioOutput, QMediaPlayer
from PySide6.QtWidgets import (
    QApplication,
    QGridLayout,
    QHBoxLayout,
    QLabel,
    QMenu,
    QPushButton,
    QVBoxLayout,
    QWidget,
)


class OrbState(Enum):
    """竖波悬浮件状态机。语音模式下悬浮件常驻可见，IDLE = 待机呼吸。"""

    IDLE = auto()        # 待机：呼吸波纹（悬浮件常驻的唯一"安静"形态）
    LISTENING = auto()   # 聆听：波纹随麦克风实时响度起伏
    THINKING = auto()    # 思考：波纹缓慢行进（识别 / LLM 生成中）
    SPEAKING = auto()    # 播报：波纹随音节包络起伏（TTS 播放中）
    NOTE = auto()        # 提示：短暂显示一句提示后回到待机（如"没听清"）


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
# 悬浮件的 hover「界面模式」按钮是图形入口，这里是语音入口，二者等价。
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


def resolve_media_url(http_base: str, url: str) -> str:
    """把服务端相对路径（如 /agent/images/x.png）拼成完整 URL。"""
    u = (url or "").strip()
    if not u:
        return ""
    if u.startswith("http://") or u.startswith("https://"):
        return u
    return http_base.rstrip("/") + (u if u.startswith("/") else "/" + u)


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
        用于追问窗口（"继续说，或等我待机"）；
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
    """WebSocket 客户端：负责 session.init + 收发聊天事件。

    语音模式下用户消息由 orb 自己的连接发出，因此 assistant_chunk/done、
    chat.media_ready（边说边出图）都会回到本连接；surface.show 由服务端按
    actor 广播（registry fan-out），orb 与 Flutter 主进程都会收到。
    """

    connected = Signal()
    disconnected = Signal(str)
    assistant_chunk = Signal(str, str)   # message_id, text
    assistant_done = Signal(dict)        # chat.assistant_done 完整 payload
    turn_started = Signal(str)
    surface_show = Signal(dict)          # surface.show payload（对话召唤浮层卡）
    media_ready = Signal(dict)           # chat.media_ready payload（边说边出图）
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
                    self.assistant_done.emit(payload if isinstance(payload, dict) else {})
                elif typ == "chat.turn_started":
                    self.turn_started.emit(payload.get("messageId", ""))
                elif typ == "surface.show":
                    self.surface_show.emit(payload if isinstance(payload, dict) else {})
                elif typ == "chat.media_ready":
                    self.media_ready.emit(payload if isinstance(payload, dict) else {})
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


# ─────────────────────────────────────────────────────────────────────────────
# 竖波悬浮件 + 模式选择 + 状态提示
# ─────────────────────────────────────────────────────────────────────────────


def _float_flags(widget: QWidget) -> None:
    """浮层通用窗口旗标：无框 / 置顶 / 工具窗 / 不抢焦点 + 透明背景。"""
    widget.setWindowFlags(
        Qt.WindowType.FramelessWindowHint
        | Qt.WindowType.WindowStaysOnTopHint
        | Qt.WindowType.Tool
        | Qt.WindowType.WindowDoesNotAcceptFocus
    )
    widget.setAttribute(Qt.WidgetAttribute.WA_TranslucentBackground)
    widget.setAttribute(Qt.WidgetAttribute.WA_NoSystemBackground)


class ModeSelector(QWidget):
    """模式选择组件：悬停竖波悬浮件时从其右侧滑出。

    当前只有一个切换项「界面模式」→ 点击发出 page_mode_requested，
    由 VoiceSession 上报父进程恢复 Flutter 主窗口（等价于语音说"打开界面"）。
    """

    page_mode_requested = Signal()

    WIDTH = 150
    HEIGHT = 48
    HOVER_HIDE_DELAY_MS = 280

    def __init__(self) -> None:
        super().__init__()
        _float_flags(self)
        self.setFixedSize(self.WIDTH, self.HEIGHT)
        self._hovered = False
        self._hide_timer = QTimer(self)
        self._hide_timer.setSingleShot(True)
        self._hide_timer.timeout.connect(self._maybe_hide)
        self._fade = QPropertyAnimation(self, b"windowOpacity")
        self._fade.setDuration(160)
        self.setCursor(Qt.CursorShape.PointingHandCursor)

    # ---- 展示 / 隐藏（主线程） ----

    def popup_near(self, orb: "VerticalWaveOrb") -> None:
        """出现在 orb 右侧；右侧放不下（贴边拖动过）则翻到左侧。"""
        self._hide_timer.stop()
        screen = QApplication.primaryScreen()
        geo = screen.availableGeometry() if screen else None
        gap = 10
        x = orb.x() + orb.width() + gap
        if geo is not None and x + self.WIDTH > geo.right() - 8:
            x = orb.x() - gap - self.WIDTH
        y = orb.y() + (orb.height() - self.HEIGHT) // 2
        if geo is not None:
            y = max(geo.top() + 8, min(y, geo.bottom() - self.HEIGHT - 8))
        self.move(x, y)
        if not self.isVisible():
            self.setWindowOpacity(0.0)
            self.show()
        self._fade.stop()
        self._fade.setStartValue(self.windowOpacity())
        self._fade.setEndValue(1.0)
        self._fade.start()
        self.raise_()

    def request_hide(self) -> None:
        """离开悬浮件/本组件后延迟隐藏（给鼠标移入本组件留时间）。"""
        self._hide_timer.start(self.HOVER_HIDE_DELAY_MS)

    def _maybe_hide(self) -> None:
        if self.isVisible() and not self.underMouse():
            self._fade.stop()
            self._fade.setStartValue(self.windowOpacity())
            self._fade.setEndValue(0.0)
            self._fade.start()
            QTimer.singleShot(170, self._hide_if_faded)

    def _hide_if_faded(self) -> None:
        if self.isVisible() and self.windowOpacity() <= 0.02 and not self.underMouse():
            self.hide()

    # ---- 交互 ----

    def enterEvent(self, event) -> None:  # noqa: N802
        self._hovered = True
        self._hide_timer.stop()
        self.update()
        super().enterEvent(event)

    def leaveEvent(self, event) -> None:  # noqa: N802
        self._hovered = False
        self.update()
        self.request_hide()
        super().leaveEvent(event)

    def mouseReleaseEvent(self, event) -> None:  # noqa: N802
        if event.button() == Qt.MouseButton.LeftButton:
            self.page_mode_requested.emit()
            event.accept()

    # ---- 绘制 ----

    def paintEvent(self, event) -> None:  # noqa: N802
        try:
            painter = QPainter(self)
            painter.setRenderHint(QPainter.RenderHint.Antialiasing)
            w, h = self.WIDTH, self.HEIGHT
            radius = 14.0
            bg = QColor(15, 17, 26, 225) if not self._hovered else QColor(30, 34, 50, 235)
            painter.setPen(Qt.PenStyle.NoPen)
            painter.setBrush(QBrush(bg))
            painter.drawRoundedRect(0, 0, w, h, radius, radius)
            border = QColor(96, 165, 250, 90) if self._hovered else QColor(255, 255, 255, 30)
            painter.setPen(QPen(border, 1.2))
            painter.setBrush(Qt.BrushStyle.NoBrush)
            painter.drawRoundedRect(0.5, 0.5, w - 1, h - 1, radius, radius)

            # 左侧小"窗口"图标：圆角外框 + 底部任务条
            icon = QColor(96, 165, 250, 230)
            painter.setPen(QPen(icon, 1.6))
            painter.drawRoundedRect(16, 14, 20, 15, 3.5, 3.5)
            painter.setPen(Qt.PenStyle.NoPen)
            painter.setBrush(QBrush(icon))
            painter.drawRoundedRect(16, 24, 20, 5, 2.0, 2.0)

            painter.setPen(QPen(QColor(230, 233, 240, 235)))
            painter.setFont(QFont("Microsoft YaHei", 11))
            painter.drawText(
                44, 0, w - 52, h,
                Qt.AlignmentFlag.AlignVCenter | Qt.AlignmentFlag.AlignLeft,
                "界面模式",
            )
        except Exception:  # noqa: BLE001
            traceback.print_exc()


class StatusPill(QLabel):
    """悬浮件上方的状态提示小药丸（"我在听，请说" / 识别预览 / 错误提示）。"""

    def __init__(self) -> None:
        super().__init__()
        _float_flags(self)
        self.setStyleSheet(
            "background-color: rgba(15,17,26,215);"
            "color: #E6E9F0;"
            "border: 1px solid rgba(255,255,255,28);"
            "border-radius: 14px;"
            "padding: 7px 14px;"
            "font-size: 12px;"
        )
        self._fade = QPropertyAnimation(self, b"windowOpacity")
        self._fade.setDuration(180)

    def show_text(self, text: str) -> None:
        if not text:
            self.fade_out()
            return
        self.setText(text)
        self.adjustSize()
        if not self.isVisible():
            self.setWindowOpacity(0.0)
            self.show()
        self._fade.stop()
        self._fade.setStartValue(self.windowOpacity())
        self._fade.setEndValue(1.0)
        self._fade.start()
        self.raise_()

    def fade_out(self) -> None:
        if not self.isVisible():
            return
        self._fade.stop()
        self._fade.setStartValue(self.windowOpacity())
        self._fade.setEndValue(0.0)
        self._fade.start()
        QTimer.singleShot(200, self._hide_if_faded)

    def _hide_if_faded(self) -> None:
        if self.isVisible() and self.windowOpacity() <= 0.02:
            self.hide()

    def position_near(self, orb: "VerticalWaveOrb") -> None:
        """居中悬浮件上方；顶部放不下则翻到下方。"""
        if not self.isVisible():
            return
        screen = QApplication.primaryScreen()
        geo = screen.availableGeometry() if screen else None
        x = orb.x() + (orb.width() - self.width()) // 2
        y = orb.y() - self.height() - 10
        if geo is not None:
            x = max(geo.left() + 8, min(x, geo.right() - self.width() - 8))
            if y < geo.top() + 8:
                y = orb.y() + orb.height() + 10
        self.move(x, y)


class VerticalWaveOrb(QWidget):
    """常驻竖波悬浮件：语音模式在桌面上的全部"存在"。

    - 细长竖向胶囊，内部三条竖向行进的波纹曲线（"竖波纹路"），
      颜色与振幅随 OrbState 变化：待机呼吸 / 聆听随麦 / 思考行进 / 播报包络
    - 常驻可见（IDLE 呼吸），不再对话结束即消失
    - 左键点击（未拖动）→ 点击说话；拖动 → 换位置
    - 悬停 → 右侧滑出 ModeSelector（模式选择组件）
    - 右键菜单：打开主界面 / 静音
    """

    open_page_requested = Signal()
    mute_toggled = Signal(bool)
    talk_toggled = Signal()
    moved = Signal()

    WIDTH = 72
    HEIGHT = 340

    # 停靠默认位：屏幕右缘留出模式选择组件的滑出空间（右侧出现）
    SELECTOR_GAP = 10
    SCREEN_EDGE = 16
    DOCK_RIGHT_MARGIN = ModeSelector.WIDTH + SELECTOR_GAP + SCREEN_EDGE

    STATE_COLOR = {
        OrbState.IDLE: "#7C8394",
        OrbState.LISTENING: "#60A5FA",
        OrbState.THINKING: "#FBBF24",
        OrbState.SPEAKING: "#34D399",
        OrbState.NOTE: "#9CA3AF",
    }
    STATE_TEXT = {
        OrbState.LISTENING: "我在听，请说",
        OrbState.THINKING: "想一下…",
        OrbState.SPEAKING: "",
        OrbState.IDLE: "",
        OrbState.NOTE: "",
    }

    _DRAG_THRESHOLD = 6  # px

    def __init__(self) -> None:
        super().__init__()
        _float_flags(self)
        self.setFixedSize(self.WIDTH, self.HEIGHT)

        self.state = OrbState.IDLE
        self.caption = ""
        self.volume = 0.0          # 聆听态实时响度（0~1，EMA 平滑后）
        self._raw_volume = 0.0
        self._t = 0.0
        self._speak_env = 0.3      # 播报态音节包络（向随机目标缓动）
        self._speak_target = 0.3
        self._target_tick = 0
        self._muted = False

        self._selector = ModeSelector()
        self._selector.page_mode_requested.connect(self.open_page_requested)
        self._pill = StatusPill()

        self._timer = QTimer(self)
        self._timer.timeout.connect(self._on_tick)
        self._timer.start(33)

    # ---- 状态切换 ----

    def show_state(self, state: OrbState, caption: str = "") -> None:
        """切入指定状态（常驻可见，只换波形与提示）。主线程调用。"""
        self.state = state
        self.caption = caption if caption else self.STATE_TEXT.get(state, "")
        if not self.isVisible():
            self._position()
            self.show()
        self._pill.show_text(self.caption)
        self._pill.position_near(self)
        self.update()

    def set_volume(self, value: float) -> None:
        self._raw_volume = value

    def _position(self) -> None:
        """默认停靠：屏幕右缘、竖直居中，右侧给模式选择组件留出滑出空间。"""
        screen = QApplication.primaryScreen()
        if screen is None:
            return
        geo = screen.availableGeometry()  # 已排除任务栏
        x = geo.right() - self.WIDTH - self.DOCK_RIGHT_MARGIN
        y = geo.y() + (geo.height() - self.HEIGHT) // 2
        self.move(x, y)

    def _on_tick(self) -> None:
        self._t += 0.033
        # 聆听响度 EMA 平滑，波纹不至于抖成噪声
        self.volume += (self._raw_volume - self.volume) * 0.25
        # 播报态：每 ~130ms 换一个随机目标（模拟音节包络），向目标缓动
        self._target_tick += 1
        if self._target_tick >= 4:
            self._target_tick = 0
            self._speak_target = 0.25 + 0.75 * random.random()
        self._speak_env += (self._speak_target - self._speak_env) * 0.35
        self.update()

    # ---- 交互 ----

    def enterEvent(self, event) -> None:  # noqa: N802
        self._selector.popup_near(self)
        super().enterEvent(event)

    def leaveEvent(self, event) -> None:  # noqa: N802
        self._selector.request_hide()
        super().leaveEvent(event)

    def moveEvent(self, event) -> None:  # noqa: N802
        self.moved.emit()
        self._pill.position_near(self)
        super().moveEvent(event)

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
        was_drag = getattr(self, "_drag_started", False)
        self._press_global = None
        self._drag_started = False
        # 点击（未拖动）= 点击说话开关
        if event.button() == Qt.MouseButton.LeftButton and not was_drag:
            self.talk_toggled.emit()
            event.accept()

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
            color = QColor(self.STATE_COLOR.get(self.state, "#7C8394"))
            w, h = self.WIDTH, self.HEIGHT
            inset = 6.0
            radius = (w - inset * 2) / 2

            # 胶囊底：深色毛玻璃 + 状态色描边微光
            painter.setPen(Qt.PenStyle.NoPen)
            painter.setBrush(QBrush(QColor(12, 14, 22, 185)))
            painter.drawRoundedRect(inset, inset, w - inset * 2, h - inset * 2, radius, radius)
            border = QColor(color)
            border.setAlpha(80)
            painter.setPen(QPen(border, 1.2))
            painter.setBrush(Qt.BrushStyle.NoBrush)
            painter.drawRoundedRect(
                inset + 0.5, inset + 0.5, w - inset * 2 - 1, h - inset * 2 - 1,
                radius, radius,
            )

            # 竖向波纹：三条竖向行进的波纹曲线（层叠淡出，形成"纹路"质感）
            pad_top, pad_bottom = 34.0, 22.0
            usable = (h - inset * 2) - pad_top - pad_bottom
            cx = w / 2
            max_amp = w / 2 - 14
            env = self._envelope()
            speed = self._wave_speed()
            freq = self._wave_freq()
            steps = 56
            for layer in range(3):
                phase = self._t * speed + layer * 2.1
                alpha = (210, 125, 60)[layer]
                c = QColor(color)
                c.setAlpha(alpha)
                painter.setPen(QPen(c, 2.6 - layer * 0.6))
                path = QPainterPath()
                for i in range(steps + 1):
                    ratio = i / steps
                    yy = inset + pad_top + usable * ratio
                    taper = math.sin(math.pi * ratio)  # 两端收敛，贴合胶囊
                    amp = max_amp * env * (1.0 - layer * 0.22) * taper
                    xx = cx + amp * math.sin(yy * freq + phase)
                    if i == 0:
                        path.moveTo(xx, yy)
                    else:
                        path.lineTo(xx, yy)
                painter.drawPath(path)

            # 顶部状态呼吸点
            dot = QColor(color)
            dot.setAlpha(235)
            painter.setPen(Qt.PenStyle.NoPen)
            painter.setBrush(QBrush(dot))
            pulse = 3.2 + 1.1 * (0.5 + 0.5 * math.sin(self._t * 2.4))
            painter.drawEllipse(QPointF(w / 2, inset + 14), pulse, pulse)
        except Exception:  # noqa: BLE001
            # 绘制异常不允许逃逸出事件循环，否则可能导致进程被 Qt 终止
            traceback.print_exc()

    def _envelope(self) -> float:
        """当前状态的整体振幅包络（0~1）。"""
        if self.state == OrbState.LISTENING:
            jitter = 0.85 + 0.15 * (1 + math.sin(self._t * 7.0)) / 2
            return max(0.18, min(1.0, (0.20 + self.volume * 2.2) * jitter))
        if self.state == OrbState.THINKING:
            return 0.32 + 0.10 * (0.5 + 0.5 * math.sin(self._t * 2.2))
        if self.state == OrbState.SPEAKING:
            return max(0.15, min(1.0, self._speak_env))
        if self.state == OrbState.NOTE:
            return 0.20
        # IDLE：慢呼吸
        return 0.15 + 0.08 * (0.5 + 0.5 * math.sin(self._t * 1.4))

    def _wave_speed(self) -> float:
        """波纹沿竖向行进的相位速度（rad/s）。"""
        if self.state == OrbState.THINKING:
            return 3.6
        if self.state == OrbState.LISTENING:
            return 2.2
        if self.state == OrbState.SPEAKING:
            return 2.8
        return 1.1

    def _wave_freq(self) -> float:
        """波纹的空间频率（rad/px），决定竖向"纹路"的疏密。"""
        return 0.055


# ─────────────────────────────────────────────────────────────────────────────
# 浮层卡片（临时呈现，自动淡出、可关闭、悬停暂停）
# ─────────────────────────────────────────────────────────────────────────────

CARD_WIDTH = 304
CARD_MAX_H = 440
CARD_TTL_MEDIA_S = 20


class ToastCard(QWidget):
    """浮层卡片基类：深色圆角卡 + 标题行（含关闭按钮）+ 内容区。

    生命周期：show → TTL 计时（鼠标悬停暂停）→ 淡出 → closed(card) → 销毁。
    """

    closed = Signal(object)

    def __init__(self, title: str, ttl_seconds: float) -> None:
        super().__init__()
        _float_flags(self)
        self.setFixedWidth(CARD_WIDTH)
        self._dead = False
        self._ttl_ms = max(3.0, float(ttl_seconds)) * 1000.0

        self._fade = QPropertyAnimation(self, b"windowOpacity")
        self._fade.setDuration(320)
        self._after_fade = ""

        outer = QVBoxLayout(self)
        outer.setContentsMargins(14, 12, 10, 12)
        outer.setSpacing(8)

        header = QHBoxLayout()
        header.setSpacing(6)
        title_label = QLabel(title)
        title_label.setStyleSheet(
            "color: #E6E9F0; font-size: 13px; font-weight: 600; background: transparent;"
        )
        close_btn = QPushButton("✕")
        close_btn.setFixedSize(24, 24)
        close_btn.setCursor(Qt.CursorShape.PointingHandCursor)
        close_btn.setStyleSheet(
            "QPushButton { color: rgba(230,233,240,150); background: transparent;"
            "  border: none; font-size: 13px; }"
            "QPushButton:hover { color: #F87171; background: rgba(255,255,255,18);"
            "  border-radius: 12px; }"
        )
        close_btn.clicked.connect(self.dismiss)
        header.addWidget(title_label)
        header.addStretch(1)
        header.addWidget(close_btn)
        outer.addLayout(header)

        self._body = QVBoxLayout()
        self._body.setSpacing(6)
        outer.addLayout(self._body)

        self._ttl = QTimer(self)
        self._ttl.setSingleShot(True)
        self._ttl.timeout.connect(self.dismiss)

    def finish_build(self) -> None:
        """内容装完后调用：按内容定高并显示（从悬浮件侧滑入）。"""
        self.setFixedHeight(min(CARD_MAX_H, self.sizeHint().height()))
        self._ttl.start(int(self._ttl_ms))
        self.setWindowOpacity(0.0)
        self.show()
        self._fade.stop()
        self._fade.setStartValue(0.0)
        self._fade.setEndValue(1.0)
        self._fade.start()
        self.raise_()

    def add_body(self, widget: QWidget) -> None:
        self._body.addWidget(widget)

    def dismiss(self) -> None:
        """淡出后关闭（关闭按钮 / TTL 到期共用）。"""
        if self._dead or not self.isVisible():
            return
        self._dead = True
        self._ttl.stop()
        self._fade.stop()
        self._fade.setStartValue(self.windowOpacity())
        self._fade.setEndValue(0.0)
        try:
            self._fade.finished.disconnect()
        except (RuntimeError, TypeError):
            pass
        self._fade.finished.connect(self._close_after_fade)
        self._fade.start()

    def _close_after_fade(self) -> None:
        self.hide()
        self.closed.emit(self)
        self.deleteLater()

    def enterEvent(self, event) -> None:  # noqa: N802
        # 悬停阅读时暂停自动淡出，离开后重新计满
        if not self._dead:
            self._ttl.stop()
        super().enterEvent(event)

    def leaveEvent(self, event) -> None:  # noqa: N802
        if not self._dead and self.isVisible():
            self._ttl.start(int(self._ttl_ms))
        super().leaveEvent(event)

    def paintEvent(self, event) -> None:  # noqa: N802
        try:
            painter = QPainter(self)
            painter.setRenderHint(QPainter.RenderHint.Antialiasing)
            painter.setPen(Qt.PenStyle.NoPen)
            painter.setBrush(QBrush(QColor(16, 18, 27, 236)))
            painter.drawRoundedRect(0, 0, self.width(), self.height(), 16, 16)
            painter.setPen(QPen(QColor(255, 255, 255, 26), 1.0))
            painter.setBrush(Qt.BrushStyle.NoBrush)
            painter.drawRoundedRect(0.5, 0.5, self.width() - 1, self.height() - 1, 16, 16)
        except Exception:  # noqa: BLE001
            traceback.print_exc()


def _elide(text: str, width_px: int, font=None) -> str:
    metrics = QFontMetrics(font or QFont("Microsoft YaHei", 11))
    return metrics.elidedText(text, Qt.TextElideMode.ElideRight, width_px)


class ScheduleCard(ToastCard):
    """今日安排浮层卡：时间 + 标题 + 完成态。数据来自 /api/schedule/today。"""

    MAX_ROWS = 8

    def __init__(self, items: list[dict]) -> None:
        super().__init__("今日安排", ttl_seconds=30)
        if not items:
            empty = QLabel("今天没有安排，好好休息 🌿")
            empty.setStyleSheet(
                "color: rgba(215,219,228,190); font-size: 12px; background: transparent;"
            )
            self.add_body(empty)
            self.finish_build()
            return

        accent_more = len(items) - self.MAX_ROWS
        for item in items[: self.MAX_ROWS]:
            time_text, title = self._parse_item(item)
            completed = item.get("completed") is True
            if completed:
                html = (
                    f"<span style='color:#6B7280;'>✓ {time_text}</span>&nbsp;&nbsp;"
                    f"<span style='color:#6B7280;'>{_elide(title, 220)}</span>"
                )
            else:
                html = (
                    f"<span style='color:#60A5FA;font-weight:600;'>{time_text}</span>"
                    f"&nbsp;&nbsp;<span style='color:#D7DBE4;'>{_elide(title, 220)}</span>"
                )
            row = QLabel(html)
            row.setStyleSheet("background: transparent; font-size: 12px;")
            note = str(item.get("notes") or "").strip()
            if note:
                row.setToolTip(note)
            self.add_body(row)
        if accent_more > 0:
            more = QLabel(f"… 还有 {accent_more} 项")
            more.setStyleSheet(
                "color: rgba(139,147,167,180); font-size: 11px; background: transparent;"
            )
            self.add_body(more)
        self.finish_build()

    @staticmethod
    def _parse_item(item: dict) -> tuple[str, str]:
        title = str(item.get("title") or "未命名").strip() or "未命名"
        raw = str(item.get("startAt") or "")
        try:
            dt = datetime.fromisoformat(raw.replace("Z", "+00:00"))
            time_text = dt.astimezone().strftime("%H:%M")
        except ValueError:
            time_text = "--:--"
        return time_text, title


class _MediaTile(QLabel):
    """媒体缩略图块：加载占位 → 圆角图（视频加 ▶ 角标），点击用浏览器打开。"""

    TILE_W, TILE_H = 136, 92

    def __init__(self, open_url: str, is_video: bool = False) -> None:
        super().__init__()
        self._open_url = open_url
        self._is_video = is_video
        self.setFixedSize(self.TILE_W, self.TILE_H)
        self.setCursor(Qt.CursorShape.PointingHandCursor)
        self.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self.setStyleSheet(
            "background-color: rgba(255,255,255,14);"
            "border: 1px solid rgba(255,255,255,18);"
            "border-radius: 8px;"
        )

    def set_pixmap(self, pixmap: QPixmap) -> None:
        if pixmap.isNull():
            return
        scaled = pixmap.scaled(
            self.TILE_W - 2, self.TILE_H - 2,
            Qt.AspectRatioMode.KeepAspectRatioByExpanding,
            Qt.TransformationMode.SmoothTransformation,
        )
        x = max(0, (scaled.width() - (self.TILE_W - 2)) // 2)
        y = max(0, (scaled.height() - (self.TILE_H - 2)) // 2)
        cropped = scaled.copy(x, y, self.TILE_W - 2, self.TILE_H - 2)

        out = QPixmap(self.TILE_W - 2, self.TILE_H - 2)
        out.fill(Qt.GlobalColor.transparent)
        painter = QPainter(out)
        painter.setRenderHint(QPainter.RenderHint.Antialiasing)
        path = QPainterPath()
        path.addRoundedRect(0, 0, out.width(), out.height(), 8, 8)
        painter.setClipPath(path)
        painter.drawPixmap(0, 0, cropped)
        if self._is_video:
            badge = QColor(0, 0, 0, 140)
            painter.setPen(Qt.PenStyle.NoPen)
            painter.setBrush(QBrush(badge))
            cx, cy, r = out.width() / 2, out.height() / 2, 16
            painter.drawEllipse(QPointF(cx, cy), r, r)
            painter.setBrush(QBrush(QColor(255, 255, 255, 235)))
            tri = QPainterPath()
            tri.moveTo(cx - 5, cy - 8)
            tri.lineTo(cx - 5, cy + 8)
            tri.lineTo(cx + 9, cy)
            tri.closeSubpath()
            painter.drawPath(tri)
        painter.end()
        self.setPixmap(out)

    def mouseReleaseEvent(self, event) -> None:  # noqa: N802
        if event.button() == Qt.MouseButton.LeftButton and self._open_url:
            QDesktopServices.openUrl(QUrl(self._open_url))
            event.accept()


class MediaCard(ToastCard):
    """图片/视频浮层卡：2 列缩略图墙（最多 6 块），点击系统浏览器打开。

    缩略图在工作线程下载，经 Signal 回主线程解码圆角后上墙；
    卡片可能先于下载完成被关闭（_dead / 已销毁），回调里全部兜住。
    """

    MAX_TILES = 6
    _thumb_ready = Signal(int, bytes)

    def __init__(self, cards: list[dict], http_base: str) -> None:
        super().__init__(self._title_of(cards), ttl_seconds=CARD_TTL_MEDIA_S)
        self._http_base = http_base
        self._thumb_ready.connect(self._on_thumb_ready)

        grid_holder = QWidget()
        grid_holder.setStyleSheet("background: transparent;")
        grid = QGridLayout(grid_holder)
        grid.setContentsMargins(0, 0, 0, 0)
        grid.setSpacing(8)
        self._tiles: list[_MediaTile] = []
        for idx, card in enumerate(cards[: self.MAX_TILES]):
            tile_spec = self._tile_spec(card)
            tile = _MediaTile(tile_spec["open_url"], tile_spec["is_video"])
            row, col = divmod(idx, 2)
            grid.addWidget(tile, row, col)
            self._tiles.append(tile)
            self._load_thumb_async(idx, tile_spec["thumb_url"])
        self.add_body(grid_holder)
        if len(cards) > self.MAX_TILES:
            more = QLabel(f"… 共 {len(cards)} 条，切换回界面模式可查看全部")
            more.setStyleSheet(
                "color: rgba(139,147,167,180); font-size: 11px; background: transparent;"
            )
            self.add_body(more)
        self.finish_build()

    @staticmethod
    def _title_of(cards: list[dict]) -> str:
        types = {str(c.get("type") or "").lower() for c in cards}
        if types == {"image"}:
            return f"图片 · {len(cards)}"
        if types == {"video"}:
            return f"视频 · {len(cards)}"
        return f"媒体 · {len(cards)}"

    @staticmethod
    def _tile_spec(card: dict) -> dict:
        is_video = str(card.get("type") or "").lower() == "video"
        thumb = str(card.get("thumbnailUrl") or card.get("mediaUrl") or "")
        media = str(card.get("mediaUrl") or "")
        page = str(card.get("pageUrl") or "")
        # 视频 ▶ 打开播放页；图片优先打开原图（mediaUrl），缺了退来源页/缩略图
        open_url = (page if is_video else (media or page)) or thumb
        return {"is_video": is_video, "thumb_url": thumb, "open_url": open_url}

    def _load_thumb_async(self, idx: int, url: str) -> None:
        full = resolve_media_url(self._http_base, url)
        if not full:
            return

        def work(index: int = idx, target: str = full) -> None:
            try:
                resp = requests.get(target, timeout=12)
                resp.raise_for_status()
                data = resp.content
            except Exception:  # noqa: BLE001
                return
            try:
                self._thumb_ready.emit(index, data)
            except RuntimeError:
                # 卡片已销毁（TTL 到期/手动关闭），丢弃迟到的缩略图
                pass

        threading.Thread(target=work, daemon=True).start()

    def _on_thumb_ready(self, idx: int, data: bytes) -> None:
        try:
            if self._dead or idx >= len(self._tiles):
                return
            pixmap = QPixmap()
            pixmap.loadFromData(data)
            self._tiles[idx].set_pixmap(pixmap)
        except Exception:  # noqa: BLE001
            traceback.print_exc()


class TextCard(ToastCard):
    """通用文本浮层卡（预留：搜索摘要等未来 surface 的轻量呈现）。"""

    def __init__(self, title: str, body: str, ttl_seconds: float = 12) -> None:
        super().__init__(title, ttl_seconds=ttl_seconds)
        label = QLabel(str(body))
        label.setWordWrap(True)
        label.setStyleSheet(
            "color: rgba(215,219,228,225); font-size: 12px; background: transparent;"
        )
        self.add_body(label)
        self.finish_build()


class CardStack(QObject):
    """悬浮件左侧的浮层卡片栈：右对齐悬浮件、底部对齐、最新在上。

    最多同时 3 张，超出立即挤掉最旧一张；悬浮件拖动时整体跟随。
    """

    MAX_CARDS = 3
    GAP = 10
    ORB_GAP = 12

    def __init__(self, orb: VerticalWaveOrb) -> None:
        super().__init__(orb)
        self._orb = orb
        self._cards: list[ToastCard] = []
        orb.moved.connect(self._relayout)

    # ---- 呈现入口 ----

    def show_schedule(self, items: list[dict]) -> None:
        card = ScheduleCard(items)
        self._attach(card)

    def show_media(self, cards: list[dict], http_base: str) -> None:
        card = MediaCard(cards, http_base)
        self._attach(card)

    def show_text(self, title: str, body: str) -> None:
        self._attach(TextCard(title, body))

    # ---- 栈管理 ----

    def _attach(self, card: ToastCard) -> None:
        if len(self._cards) >= self.MAX_CARDS:
            oldest = self._cards[-1]
            oldest.dismiss()
            self._cards.remove(oldest)
        card.closed.connect(self._on_card_closed)
        self._cards.insert(0, card)
        self._relayout()

    def _on_card_closed(self, card: object) -> None:
        if isinstance(card, ToastCard) and card in self._cards:
            self._cards.remove(card)
        self._relayout()

    def _relayout(self) -> None:
        if not self._cards:
            return
        screen = QApplication.primaryScreen()
        geo = screen.availableGeometry() if screen else None
        orb = self._orb
        x = orb.x() - self.ORB_GAP - CARD_WIDTH
        heights = [c.height() for c in self._cards]
        total_h = sum(heights) + self.GAP * (len(self._cards) - 1)
        orb_bottom = orb.y() + orb.height()
        y = orb_bottom - total_h
        if geo is not None:
            y = max(geo.top() + 12, y)
        for card, h in zip(self._cards, heights):
            card.move(x, y)
            card.raise_()
            y += h + self.GAP


# ─────────────────────────────────────────────────────────────────────────────
# 语音会话编排
# ─────────────────────────────────────────────────────────────────────────────


class VoiceSession(QObject):
    """语音模式编排器：唤醒/点击 → 聆听 → 识别 → 对话 → 播报 → 追问 → 待机。

    麦克风互斥编排（同一时刻只允许一个采集流）：
      唤醒监听 ──命中──▶ 停唤醒 ──▶ 录音(VAD) ──说完──▶ ASR ──▶ 播报
        ▲                                                        │
        └──追问窗口超时 ◀──播报结束（或 barge-in 直接回录音）◀──────┘

    悬浮件交互：点击说话开关 / hover 右侧「界面模式」/ 右键静音。
    浮层卡片：surface.show(today_schedule) 与 chat.media_ready /
    assistant_done.mediaCards → CardStack（自动淡出、可关闭）。

    线程约定：ASR/TTS/日程 HTTP 在 daemon 线程里跑，结果一律经 Signal 回主线程；
    overlay / player / recorder / monitor / cards 都只在主线程创建与驱动。
    """

    # 跨线程信号（worker → 主线程）
    _show_state = Signal(str, str)     # (OrbState 名, caption)
    _play_requested = Signal(str)      # 播放本地音频文件
    _turn_failed = Signal(str)         # 本轮失败（识别/播报异常）
    _schedule_ready = Signal(list, int)  # 今日安排列表, TTL 秒

    FOLLOWUP_WINDOW_S = 10.0           # 播报结束后保持追问聆听的时长
    NOTE_DISPLAY_MS = 2600             # 提示文案显示多久后回待机

    def __init__(self, cfg: VoiceOrbConfig, overlay: VerticalWaveOrb) -> None:
        super().__init__()
        self.cfg = cfg
        self.overlay = overlay
        self._muted = False

        self._recorder: Optional[ListeningRecorder] = None
        self._monitor: Optional[MicMonitor] = None
        self._wake: Optional[WakeListener] = None
        self._turn_active = False
        self._pending_text = ""
        # 媒体去重：media_ready 先推、assistant_done 再带全量，按 (traceId, 图) 去重
        self._seen_media: set[tuple[str, str]] = set()

        self._cards = CardStack(overlay)

        self._ws = WsClient(cfg)
        self._ws.assistant_chunk.connect(self._on_assistant_chunk)
        self._ws.assistant_done.connect(self._on_assistant_done)
        self._ws.turn_started.connect(self._on_turn_started)
        self._ws.surface_show.connect(self._on_surface_show)
        self._ws.media_ready.connect(self._on_media_ready)
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
        self._schedule_ready.connect(self._on_schedule_ready)
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
        overlay.talk_toggled.connect(self._on_talk_toggled)

    def start(self) -> None:
        # 常驻形态：启动即待机呼吸 + 唤醒监听（不再隐身）
        self._show_state.emit("IDLE", "")
        self._resume_wake()

    # ---- 状态/提示（主线程槽） ----

    def _on_show_state(self, state_name: str, caption: str) -> None:
        try:
            self.overlay.show_state(OrbState[state_name], caption)
        except Exception:  # noqa: BLE001
            traceback.print_exc()

    def _show_note(self, msg: str, display_ms: int = NOTE_DISPLAY_MS) -> None:
        try:
            self.overlay.show_state(OrbState.NOTE, msg)
            self._note_timer.start(display_ms)
        except Exception:  # noqa: BLE001
            traceback.print_exc()

    def _on_note_timeout(self) -> None:
        try:
            if self.overlay.state == OrbState.NOTE:
                self._show_state.emit("IDLE", "")
                QTimer.singleShot(250, self._resume_wake)
        except Exception:  # noqa: BLE001
            traceback.print_exc()

    # ---- 唤醒 / 点击说话 ----

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
            self.overlay.show_state(OrbState.LISTENING, "我在听，请说")
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
            self._show_note(msg)
        except Exception:  # noqa: BLE001
            traceback.print_exc()

    def _on_talk_toggled(self) -> None:
        """点击悬浮件（未拖动）：待机/提示态开录音；聆听中取消；播报中打断。"""
        try:
            if self.overlay.state == OrbState.SPEAKING:
                self._on_barge_in()
                return
            if self._recorder is not None and self._recorder.isRunning():
                # 正在聆听 → 再点一次取消本次录音，回待机
                self._recorder.stop()
                self._recorder = None
                self._show_state.emit("IDLE", "")
                QTimer.singleShot(250, self._resume_wake)
                return
            if self._turn_active:
                return
            self.overlay.show_state(OrbState.LISTENING, "我在听，请说")
            QTimer.singleShot(120, lambda: self._start_listening(
                followup_window_s=8.0, caption="我在听，请说",
            ))
        except Exception:  # noqa: BLE001
            traceback.print_exc()

    # ---- 录音（VAD 端点） ----

    def _start_listening(self, followup_window_s: float = 0.0,
                         caption: str = "我在听，请说") -> None:
        try:
            if self._recorder is not None and self._recorder.isRunning():
                return
            self._pause_wake()
            self.overlay.show_state(OrbState.LISTENING, caption)
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
            # 追问窗口没人说话（或空录音）→ 回待机呼吸，继续唤醒监听
            self._show_state.emit("IDLE", "")
            QTimer.singleShot(250, self._resume_wake)
        except Exception:  # noqa: BLE001
            traceback.print_exc()

    def _on_recording_error(self, msg: str) -> None:
        self._turn_failed.emit(msg)

    # ---- 识别 → 对话（worker 线程，只经信号回主线程） ----

    def _on_recording_finished(self, path: str) -> None:
        try:
            if self._recorder is not self.sender():
                # 已被取消的旧录音迟到的 finished：丢弃，不进识别
                try:
                    os.remove(path)
                except OSError:
                    pass
                return
            self.overlay.show_state(OrbState.THINKING, "识别中…")
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
        self.overlay.show_state(OrbState.THINKING, "想一下…")

    def _on_assistant_chunk(self, _message_id: str, text: str) -> None:
        self._pending_text += text

    def _on_assistant_done(self, payload: dict) -> None:
        # 边说边出图兜底：done 里的全量 mediaCards（media_ready 的去重补发）
        cards = payload.get("mediaCards")
        if isinstance(cards, list) and cards:
            self._handle_media_cards(cards, str(payload.get("traceId") or ""))
        full = str(payload.get("finalText") or "").strip() or self._pending_text
        self._pending_text = ""
        if full.strip():
            self.overlay.show_state(OrbState.THINKING, "想一下…")
            threading.Thread(target=self._speak, args=(full,), daemon=True).start()
        else:
            self._end_turn()

    def _on_surface_show(self, payload: dict) -> None:
        """对话召唤浮层卡：today_schedule 由 orb 自取数据渲染。

        语音模式下 Flutter 主窗口隐藏且让位（main.dart 同名守卫），
        悬浮卡统一在竖波悬浮件旁呈现。不改波形状态——surface.show
        多在对话进行中到达，状态由对话链路（思考/播报）自己驱动。
        """
        try:
            surface = str(payload.get("surface") or "").strip()
            if surface != "today_schedule":
                return
            ttl_raw = payload.get("ttlSeconds")
            try:
                ttl = int(ttl_raw)
            except (TypeError, ValueError):
                ttl = 30
            threading.Thread(
                target=self._fetch_schedule, args=(ttl,), daemon=True,
            ).start()
        except Exception:  # noqa: BLE001
            traceback.print_exc()

    def _fetch_schedule(self, ttl: int) -> None:
        """worker 线程：GET /api/schedule/today（服务端只存提醒任务侧数据）。"""
        try:
            resp = requests.get(
                f"{self.cfg.http_base}/api/schedule/today",
                params={"sessionId": self.cfg.actor_id or self.cfg.session_id},
                timeout=8,
            )
            resp.raise_for_status()
            data = resp.json()
            items = data if isinstance(data, list) else []
        except Exception as exc:  # noqa: BLE001
            self._turn_failed.emit(f"日程获取失败：{exc}")
            return
        self._schedule_ready.emit(items, ttl)

    def _on_schedule_ready(self, items: list, ttl: int) -> None:
        try:
            self._cards.show_schedule(list(items))
        except Exception:  # noqa: BLE001
            traceback.print_exc()

    def _on_media_ready(self, payload: dict) -> None:
        try:
            cards = payload.get("cards")
            if isinstance(cards, list) and cards:
                self._handle_media_cards(cards, str(payload.get("traceId") or ""))
        except Exception:  # noqa: BLE001
            traceback.print_exc()

    def _handle_media_cards(self, cards: list, trace_id: str) -> None:
        """媒体卡片上墙（media_ready 先推、done 补全量，按 trace+图去重）。"""
        try:
            fresh: list[dict] = []
            for card in cards:
                if not isinstance(card, dict):
                    continue
                key = (
                    trace_id,
                    str(card.get("thumbnailUrl") or card.get("mediaUrl") or ""),
                )
                if not key[1] or key in self._seen_media:
                    continue
                self._seen_media.add(key)
                fresh.append(card)
            if len(self._seen_media) > 200:
                self._seen_media.clear()
            if fresh:
                self._cards.show_media(fresh, self.cfg.http_base)
        except Exception:  # noqa: BLE001
            traceback.print_exc()

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
            self.overlay.show_state(OrbState.SPEAKING)
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
        """用户在播报中开口（或点击悬浮件）：停播 → 直接回聆听（不等播完）。"""
        try:
            self._stop_monitor()
            self._player.stop()
            # 用追问窗口兜底：若"开口"是扬声器噪声误触发，10s 无声自动回待机
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
            # 追问窗口：保持聆听 10s，开口即继续（免唤醒词）；没人说话则回待机
            QTimer.singleShot(250, lambda: self._start_listening(
                followup_window_s=self.FOLLOWUP_WINDOW_S,
                caption="继续说，或点一下悬浮件",
            ))
        except Exception:  # noqa: BLE001
            traceback.print_exc()

    def _on_turn_failed(self, msg: str) -> None:
        try:
            self._turn_active = False
            self._stop_monitor()
            self._show_note(msg)
        except Exception:  # noqa: BLE001
            traceback.print_exc()

    def _on_ws_disconnected(self, msg: str) -> None:
        try:
            if self._turn_active:
                self._show_note(f"连接断开：{msg[:40]}")
        except Exception:  # noqa: BLE001
            traceback.print_exc()

    # ---- 静音 / 退出 ----

    def _set_muted(self, muted: bool) -> None:
        self._muted = muted
        if muted:
            self._pause_wake()
            self._show_note("已静音（右键取消）", display_ms=self.NOTE_DISPLAY_MS * 2)
        else:
            self._show_note("已取消静音")
            QTimer.singleShot(300, self._resume_wake)

    def _request_open_page(self) -> None:
        """请求父进程恢复页面模式（hover「界面模式」/ 右键菜单 / 语音口令）。"""
        try:
            _print_event("PAGE_MODE_REQUESTED")
            self._pause_wake()
            self._stop_monitor()
            self._ws.stop()
            self._ws.wait(2000)
        except Exception:  # noqa: BLE001
            traceback.print_exc()
        app = QApplication.instance()
        if app is not None:
            app.quit()

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
        overlay = VerticalWaveOrb()
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
