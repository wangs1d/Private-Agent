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
#   - 图片/视频：chat.media_ready / chat.assistant_done(mediaCards) → CenterStage
#     屏幕中央大图展示，不自动消失（用户 ✕ 或对话 surface.dismiss 关闭），
#     点击用系统浏览器打开
#
# 职责清单：
#   1. VerticalWaveOrb：竖向波纹胶囊（待机/聆听/思考/播报/提示五态）+ 悬停模式选择
#   2. ToastCard / CardStack：浮层卡片（日程/文本），TTL 自动淡出
#   3. CenterStage：媒体中央展示页，大图短暂呈现
#   3. WakeListener：语音唤醒（滑窗 ASR 匹配唤醒词；Phase 2 计划换本地热词模型）
#   4. ListeningRecorder：VAD 端点检测录音（静默 700ms 自动说完，免按键连续对话）
#   5. MicMonitor：TTS 播放期间的人声监视（barge-in lite：用户开口即停播）
#   6. 语音链路：录音 → ASR /brain/sensory/listen → WS chat.user_message →
#      chat.assistant_chunk（分句流式）→ TTS /brain/sensory/speak 逐句合成、
#      边合成边播（首句不等全文）→ QMediaPlayer 顺序播放；done 只补残句收尾
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
    QPoint,
    QPointF,
    QRect,
    QRectF,
    Signal,
)
from PySide6.QtGui import (
    QBrush,
    QColor,
    QDesktopServices,
    QFont,
    QFontMetrics,
    QLinearGradient,
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


# ── 分句流式 TTS：文本清洗与分句 ─────────────────────────────────────────────
# LLM 回复是面向屏幕的 Markdown；直接整段念会有「星号井号网址」混在语音里。
# 清洗规则只删「念出来是噪音」的标记，不改变正文语义。

_MD_CODE_FENCE_RE = re.compile(r"```.*?```", re.S)
_MD_INLINE_CODE_RE = re.compile(r"`([^`]*)`")
_MD_LINK_RE = re.compile(r"!?\[([^\]]*)\]\([^)]*\)")
_URL_RE = re.compile(r"https?://\S+")
_MD_HEADING_RE = re.compile(r"^\s{0,3}#{1,6}\s*", re.M)
_MD_EMPHASIS_RE = re.compile(r"(\*\*|__|\*|~~|`)")
_MD_LIST_MARK_RE = re.compile(r"^\s*[-*•]\s+", re.M)
_MD_QUOTE_RE = re.compile(r"^\s{0,3}>\s?", re.M)
_MD_HR_RE = re.compile(r"^\s*[-=*]{3,}\s*$", re.M)
_TABLE_PIPE_RE = re.compile(r"\s*\|\s*")
_TIMESTAMP_FRAME_RE = re.compile(r"\[ts:[^\]]*\]\s*")

# 分句边界：与 server StreamSegmenter 一致的句末标点 + 换行；
# 逗号软边界：句子超过 SOFT_SPLIT_CHARS 后遇到逗号即切，避免长句一次合成太久。
_SENTENCE_BOUNDARY_CHARS = "。！？!?；;\n"
_SOFT_SPLIT_CHARS = 56


def clean_text_for_speech(text: str) -> str:
    """把面向屏幕的 Markdown 回复清洗成适合朗读的纯文本。"""
    t = text or ""
    t = _MD_CODE_FENCE_RE.sub(" ", t)
    t = _MD_INLINE_CODE_RE.sub(r"\1", t)
    t = _MD_LINK_RE.sub(r"\1", t)
    t = _URL_RE.sub(" ", t)
    t = _TIMESTAMP_FRAME_RE.sub("", t)
    t = _MD_HEADING_RE.sub("", t)
    t = _MD_EMPHASIS_RE.sub("", t)
    t = _MD_LIST_MARK_RE.sub("", t)
    t = _MD_QUOTE_RE.sub("", t)
    t = _MD_HR_RE.sub("", t)
    t = _TABLE_PIPE_RE.sub("，", t)
    return t.strip()


def split_speech_units(text: str) -> list[str]:
    """把一段文本切成适合逐条合成的短句单元（句末硬边界 + 逗号软边界）。

    返回的单元都是完整句（最后一个不带句末标点的残句留在调用方缓冲里，
    由 flush 语义决定何时作为末句发出）。
    """
    units: list[str] = []
    buf = ""
    for ch in text:
        buf += ch
        if ch in _SENTENCE_BOUNDARY_CHARS:
            units.append(buf)
            buf = ""
        elif ch in "，," and len(buf) >= _SOFT_SPLIT_CHARS:
            units.append(buf)
            buf = ""
    if buf.strip():
        units.append(buf)
    # 纯标点/空白碎片并入前一条，避免合成出无意义的短音频
    merged: list[str] = []
    for u in units:
        if u.strip() and merged and not re.search(r"[\w\u4e00-\u9fa5]", u):
            merged[-1] += u
        else:
            merged.append(u)
    return [u.strip() for u in merged if u.strip()]


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
    surface_dismiss = Signal(dict)       # surface.dismiss payload（对话移除展示页）
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
                    # 服务端 chat-user-message 处理器字段名为 chunk（phase 标注
                    # interim/stream）；历史代码误读 "text" 导致 _pending_text
                    # 恒为空，只能等 done。两个键都兼容。
                    self.assistant_chunk.emit(
                        payload.get("messageId", ""),
                        payload.get("chunk") or payload.get("text") or "",
                    )
                elif typ == "chat.assistant_done":
                    self.assistant_done.emit(payload if isinstance(payload, dict) else {})
                elif typ == "chat.turn_started":
                    self.turn_started.emit(payload.get("messageId", ""))
                elif typ == "surface.show":
                    self.surface_show.emit(payload if isinstance(payload, dict) else {})
                elif typ == "surface.dismiss":
                    self.surface_dismiss.emit(payload if isinstance(payload, dict) else {})
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
    """模式选择组件：悬停声纹胶囊时从其右侧滑出。

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
        """出现在 orb 右侧（垂直居中）；右边放不下则翻到左边。"""
        self._hide_timer.stop()
        screen = QApplication.primaryScreen()
        geo = screen.availableGeometry() if screen else None
        gap = 10
        x = orb.x() + orb.width() + gap  # 胶囊右侧
        y = orb.y() + (orb.HEIGHT - self.HEIGHT) // 2  # 垂直居中对齐胶囊
        if geo is not None and x + self.WIDTH > geo.right() - 8:
            x = orb.x() - gap - self.WIDTH  # 右边放不下：翻到左侧
        if geo is not None:
            x = max(geo.left() + 8, min(x, geo.right() - self.WIDTH - 8))
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
        """居中悬浮件下方（卡片堆叠在上方，避免重叠）；底部放不下则翻到上方。"""
        if not self.isVisible():
            return
        screen = QApplication.primaryScreen()
        geo = screen.availableGeometry() if screen else None
        x = orb.x() + (orb.width() - self.width()) // 2
        y = orb.y() + orb.HEIGHT + 10
        if geo is not None:
            x = max(geo.left() + 8, min(x, geo.right() - self.width() - 8))
            if y + self.height() > geo.bottom() - 8:
                y = orb.y() - self.height() - 10
        self.move(x, y)


class VerticalWaveOrb(QWidget):
    """常驻声纹胶囊（横向玻璃形态）：语音模式在桌面上的全部"存在"。

    - 横向白色毛玻璃胶囊：左侧状态呼吸点（状态色）+ 中部横向声纹条
      （随麦响度/音节包络起伏）+ 右侧状态文字（聆听中/思考中/播报中）
    - 常驻可见（IDLE 慢呼吸），不自动消失
    - 左键点击（未拖动）→ 点击说话；拖动 → 换位置
    - 悬停 → 右侧滑出 ModeSelector（模式选择组件）
    - 右键菜单：打开主界面 / 静音
    """

    open_page_requested = Signal()
    mute_toggled = Signal(bool)
    talk_toggled = Signal()
    moved = Signal()

    WIDTH = 680
    HEIGHT = 92

    # 停靠默认位：屏幕底部居中（任务栏上方）
    DOCK_BOTTOM_MARGIN = 56

    STATE_COLOR = {
        OrbState.IDLE: "#9CA3AF",
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
    # 胶囊内的状态文字（右侧）；NOTE 的具体提示走 StatusPill
    STATE_LABEL = {
        OrbState.IDLE: "",
        OrbState.LISTENING: "聆听中",
        OrbState.THINKING: "思考中",
        OrbState.SPEAKING: "播报中",
        OrbState.NOTE: "请再说一遍",
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
        """默认停靠：屏幕底部居中（任务栏上方）。"""
        screen = QApplication.primaryScreen()
        if screen is None:
            return
        geo = screen.availableGeometry()  # 已排除任务栏
        x = geo.x() + (geo.width() - self.WIDTH) // 2
        y = geo.bottom() - self.HEIGHT - self.DOCK_BOTTOM_MARGIN
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
            w, h = self.WIDTH, self.HEIGHT
            radius = h / 2 - 2
            body = QRectF(3.0, 3.0, w - 6.0, h - 6.0)

            # 玻璃胶囊：偏黑烟雾色、近实心铺满（不透出背景），顶部高光描边
            grad = QLinearGradient(0, body.top(), 0, body.bottom())
            grad.setColorAt(0.0, QColor(58, 64, 78, 244))
            grad.setColorAt(0.5, QColor(30, 34, 43, 248))
            grad.setColorAt(1.0, QColor(13, 15, 21, 252))
            # 必须显式 NoPen：默认画笔会被画成 1px 亮白描边，在胶囊外圈露出白边
            painter.setPen(Qt.PenStyle.NoPen)
            painter.setBrush(QBrush(grad))
            painter.drawRoundedRect(body, radius, radius)
            painter.setPen(QPen(QColor(255, 255, 255, 90), 1.2))
            painter.setBrush(Qt.BrushStyle.NoBrush)
            painter.drawRoundedRect(body.adjusted(0.5, 0.5, -0.5, -0.5), radius, radius)

            # 左侧状态呼吸点：白色呼吸灯（核心常亮 + 白色柔光呼吸）
            cx, cy = 44.0, h / 2
            pulse = 0.5 + 0.5 * math.sin(self._t * 2.4)
            glow = QColor(255, 255, 255, int(55 + 55 * pulse))
            painter.setPen(Qt.PenStyle.NoPen)
            painter.setBrush(QBrush(glow))
            painter.drawEllipse(QPointF(cx, cy), 13 + 3.0 * pulse, 13 + 3.0 * pulse)
            painter.setBrush(QBrush(QColor(255, 255, 255, 235)))
            painter.drawEllipse(QPointF(cx, cy), 7.2, 7.2)
            painter.setBrush(QBrush(QColor(255, 255, 255, 255)))
            painter.drawEllipse(QPointF(cx, cy), 5.6, 5.6)

            # 中部横向声纹条：一组以中线对称的圆角竖条
            self._draw_wave_bars(painter, w, h)

            # 右侧状态文字（深色玻璃上用浅色）
            label = "已静音" if self._muted else self.STATE_LABEL.get(self.state, "")
            if label:
                painter.setPen(QPen(QColor(233, 238, 246, 225)))
                painter.setFont(QFont("Microsoft YaHei", 12))
                painter.drawText(
                    QRectF(w - 104, body.top(), 84, body.height()),
                    Qt.AlignmentFlag.AlignVCenter | Qt.AlignmentFlag.AlignRight,
                    label,
                )
        except Exception:  # noqa: BLE001
            # 绘制异常不允许逃逸出事件循环，否则可能导致进程被 Qt 终止
            traceback.print_exc()

    def _draw_wave_bars(self, painter: QPainter, w: int, h: int) -> None:
        """横向声纹条：中间高两端低的包络，各状态用不同的时域动画。"""
        left, right = 74.0, w - 116.0
        zone_w = right - left
        bar_w = 3.0
        n = max(30, int(zone_w / 7.5))  # 加长后自适应加密声纹条
        step = zone_w / (n - 1)
        max_amp = h / 2 - 22.0
        mid = h / 2

        if self.state == OrbState.LISTENING:
            env = max(0.16, min(1.0, 0.20 + self.volume * 2.2))
        elif self.state == OrbState.THINKING:
            env = 0.55
        elif self.state == OrbState.SPEAKING:
            env = max(0.22, min(1.0, self._speak_env))
        elif self.state == OrbState.NOTE:
            env = 0.30
        else:  # IDLE：慢呼吸
            env = 0.22 + 0.10 * (0.5 + 0.5 * math.sin(self._t * 1.4))

        painter.setPen(Qt.PenStyle.NoPen)
        for i in range(n):
            x = left + i * step
            taper = math.sin(math.pi * (i + 0.5) / n) ** 0.9  # 中间高两端低
            if self.state == OrbState.LISTENING:
                # 响度驱动 + 相位抖动，像真实采样的频谱
                ph = math.sin(self._t * 6.0 + i * 0.9) * 0.5 + 0.5
                amp = (0.25 + 0.75 * ph) * env * taper
            elif self.state == OrbState.THINKING:
                # 行进波：能量从左向右推移
                ph = 0.5 + 0.5 * math.sin(self._t * 3.4 + i * 0.65)
                amp = (0.20 + 0.80 * ph) * env * taper
            elif self.state == OrbState.SPEAKING:
                # 音节包络：随机缓动目标 + 高频纹理
                ph = math.sin(self._t * 8.0 + i * 1.1) * 0.5 + 0.5
                amp = (0.35 + 0.65 * ph) * env * taper
            elif self.state == OrbState.NOTE:
                amp = (0.5 + 0.5 * math.sin(self._t * 2.0 + i * 0.5)) * env * taper
            else:
                amp = (0.5 + 0.5 * math.sin(self._t * 1.4 + i * 0.35)) * env * taper

            bar_h = max(3.0, max_amp * 2.0 * amp)
            # 白色声纹条：幅度越大越亮（呼吸灯质感）
            c = QColor(248, 250, 253)
            c.setAlpha(int(85 + 160 * min(1.0, amp * 1.6)))
            painter.setBrush(QBrush(c))
            painter.drawRoundedRect(
                QRectF(x - bar_w / 2, mid - bar_h / 2, bar_w, bar_h),
                bar_w / 2, bar_w / 2,
            )


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

    def __init__(
        self, title: str, ttl_seconds: Optional[float], width: int = CARD_WIDTH,
    ) -> None:
        super().__init__()
        _float_flags(self)
        self.setFixedWidth(width)
        self._dead = False
        # ttl_seconds=None 表示不自动消失（用户 ✕ / 对话指令关闭），如中央媒体展示页
        self._ttl_ms: Optional[float] = (
            max(3.0, float(ttl_seconds)) * 1000.0 if ttl_seconds else None
        )

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

    def finish_build(self, pos: Optional[QPoint] = None) -> None:
        """内容装完后调用：按内容定高并显示（pos 给定则先定位再显示）。"""
        self.setFixedHeight(min(CARD_MAX_H, self.sizeHint().height()))
        if pos is not None:
            self.move(pos)
        if self._ttl_ms:
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
        if self._ttl_ms and not self._dead and self.isVisible():
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

    def __init__(
        self, open_url: str, is_video: bool = False,
        tile_w: int = 136, tile_h: int = 92,
    ) -> None:
        super().__init__()
        self._open_url = open_url
        self._is_video = is_video
        # 实例级尺寸（类常量只是默认值），中央展示页可用更大的块
        self.TILE_W, self.TILE_H = tile_w, tile_h
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

    def __init__(
        self, cards: list[dict], http_base: str,
        width: int = CARD_WIDTH,
        tile_size: tuple[int, int] = (136, 92),
        cols: int = 2,
        ttl_seconds: Optional[float] = CARD_TTL_MEDIA_S,
    ) -> None:
        super().__init__(
            self._title_of(cards), ttl_seconds=ttl_seconds, width=width,
        )
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
            tile_widget = _MediaTile(
                tile_spec["open_url"], tile_spec["is_video"],
                tile_size[0], tile_size[1],
            )
            row, col = divmod(idx, cols)
            grid.addWidget(tile_widget, row, col)
            self._tiles.append(tile_widget)
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
        # 叠在胶囊上方，右对齐悬浮件（下方留给状态提示药丸）
        x = orb.x() + orb.width() - CARD_WIDTH
        heights = [c.height() for c in self._cards]
        total_h = sum(heights) + self.GAP * (len(self._cards) - 1)
        y = orb.y() - self.ORB_GAP - total_h
        if geo is not None and y < geo.top() + 12:
            # 上方放不下：翻到胶囊下方（会短暂遮挡状态提示药丸，可接受）
            y = orb.y() + orb.height() + self.ORB_GAP
            for card, h in zip(self._cards, heights):
                card.move(x, y)
                card.raise_()
                y += h + self.GAP
            return
        for card, h in zip(self._cards, heights):
            card.move(x, y)
            card.raise_()
            y += h + self.GAP


# ─────────────────────────────────────────────────────────────────────────────
# 中央展示页（媒体等"看内容"的信息在屏幕中央短暂呈现）
# ─────────────────────────────────────────────────────────────────────────────

STAGE_MEDIA_WIDTH = 720
STAGE_MEDIA_TILE = (224, 148)
STAGE_MEDIA_COLS = 3
STAGE_MEDIA_TTL_S = 20


class CenterStage(QObject):
    """屏幕中央的短暂展示页：照片/视频等需要"看"的内容在此大图呈现。

    与悬浮件旁的小浮层卡互补——媒体走中央大页，**不会自动消失**：
    用户点 ✕ 关闭，或对话里说"把图片收了"→ LLM 调 surface.dismiss 移除。
    轻量状态（日程/提示）仍走 CardStack 侧卡（带 TTL 自动淡出）。
    """

    def __init__(self) -> None:
        super().__init__()
        self._card: Optional[MediaCard] = None

    def show_media(self, cards: list[dict], http_base: str) -> None:
        # 新一轮内容替换上一轮，避免中央叠页
        if self._card is not None:
            self._card.dismiss()
        card = MediaCard(
            cards, http_base,
            width=STAGE_MEDIA_WIDTH,
            tile_size=STAGE_MEDIA_TILE,
            cols=STAGE_MEDIA_COLS,
            ttl_seconds=None,  # 不自动消失：✕ / surface.dismiss 关闭
        )
        card.closed.connect(self._on_card_closed)
        self._card = card
        card.finish_build(pos=self._centered_pos(card))

    def dismiss(self) -> None:
        """对话移除入口（surface.dismiss 事件触发）。"""
        if self._card is not None:
            self._card.dismiss()

    def _centered_pos(self, card: QWidget) -> QPoint:
        screen = QApplication.primaryScreen()
        geo: QRect = (
            screen.availableGeometry() if screen else QRect(0, 0, 1920, 1040)
        )
        return QPoint(
            geo.x() + (geo.width() - card.width()) // 2,
            geo.y() + (geo.height() - card.height()) // 2,
        )

    def _on_card_closed(self, card: object) -> None:
        if self._card is card:
            self._card = None


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
    浮层卡片：surface.show(today_schedule) → CardStack（悬浮件旁侧卡）；
    媒体 chat.media_ready / assistant_done.mediaCards → CenterStage
    （屏幕中央短暂大图展示，TTL 自动淡出、可关闭）。

    线程约定：ASR/TTS/日程 HTTP 在 daemon 线程里跑，结果一律经 Signal 回主线程；
    overlay / player / recorder / monitor / cards 都只在主线程创建与驱动。
    """

    # 跨线程信号（worker → 主线程）
    _show_state = Signal(str, str)     # (OrbState 名, caption)
    _play_requested = Signal(str)      # 播放本地音频文件
    _synth_settled = Signal()          # TTS 工作线程处理完一条（成功或失败），主线程复核收尾
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

        # ── 分句流式 TTS 管线 ──
        # chunk 一到就分句入队合成，边合成边播，首句播报不等全文。
        # _speech_queue：待合成句（worker 线程消费）→ 逐条 POST /brain/sensory/speak
        # → _play_requested 回主线程 → 播放中则排 _playback_queue，EndOfMedia 接续播。
        # _speech_buffer：末尾不带句末标点的半句，等下一个 chunk 或 done 冲队。
        # _speech_done：done 已收到（文本到齐），播放队列耗尽后即可收尾。
        self._speech_cond = threading.Condition()
        self._speech_queue: list[str] = []
        self._speech_buffer = ""
        self._speech_done = False
        self._speech_exit = False
        self._synth_inflight = False
        self._speech_gen = 0            # 代次：打断/新轮次递增，作废在途合成
        self._queued_any = False        # 本轮是否已有任何句子入队（done 兜底判据）
        self._played_any = False        # 本轮是否成功播出过音频（判断全部合成失败）
        self._synth_failed_any = False  # 本轮是否出现过合成失败
        self._playback_queue: list[str] = []
        self._current_audio_path: Optional[str] = None
        self._tts_thread = threading.Thread(
            target=self._tts_worker, name="tts-worker", daemon=True,
        )
        self._tts_thread.start()

        self._cards = CardStack(overlay)
        self._stage = CenterStage()

        self._ws = WsClient(cfg)
        self._ws.assistant_chunk.connect(self._on_assistant_chunk)
        self._ws.assistant_done.connect(self._on_assistant_done)
        self._ws.turn_started.connect(self._on_turn_started)
        self._ws.surface_show.connect(self._on_surface_show)
        self._ws.surface_dismiss.connect(self._on_surface_dismiss)
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
        self._synth_settled.connect(self._maybe_finish_playback)
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
            # 先清上一轮残留的合成/播放状态，再开启新轮次，避免竞态丢句
            self._drain_speech_pipeline()
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
        # 分句流式 TTS：chunk 一到就清洗、分句、入队合成，首句播报不等全文
        self._feed_speech(text)

    def _feed_speech(self, text: str, final: bool = False) -> None:
        """把新到的回复文本并入缓冲，清洗分句后逐句送合成队列。

        末尾不带句末标点的半句留在缓冲，等后续 chunk 或 done（final=True
        时作为末句冲出）。
        """
        cleaned = clean_text_for_speech(text)
        src = (self._speech_buffer + cleaned).strip()
        self._speech_buffer = ""
        if not src:
            if final:
                self._mark_speech_done()
            return
        units = split_speech_units(src)
        if units and not final:
            tail = units[-1]
            if not re.search(r"[。！？!?；;\n]\s*$", tail):
                self._speech_buffer = units.pop()
        for unit in units:
            self._enqueue_speech(unit)
        if final:
            if self._speech_buffer.strip():
                self._enqueue_speech(self._speech_buffer.strip())
                self._speech_buffer = ""
            self._mark_speech_done()

    def _on_assistant_done(self, payload: dict) -> None:
        # 边说边出图兜底：done 里的全量 mediaCards（media_ready 的去重补发）
        cards = payload.get("mediaCards")
        if isinstance(cards, list) and cards:
            self._handle_media_cards(cards, str(payload.get("traceId") or ""))
        full = str(payload.get("finalText") or "").strip() or self._pending_text
        self._pending_text = ""
        if not full.strip():
            self._speech_buffer = ""
            self._mark_speech_done()
            return
        if self._queued_any:
            # 流式分句已覆盖正文：只把残句缓冲冲出。不整段重播 finalText——
            # 分段去重丢掉的重复句已经念过，整段重播会复读。
            self._feed_speech("", final=True)
        else:
            # chunk 全程没产出可念内容（字段缺失/被剥光/纯媒体轮）→ 整段兜底合成
            self.overlay.show_state(OrbState.THINKING, "想一下…")
            self._feed_speech(full, final=True)

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

    def _on_surface_dismiss(self, payload: dict) -> None:
        """对话移除中央展示页：LLM 调 surface.dismiss（surface=media/all）。"""
        try:
            surface = str(payload.get("surface") or "").strip().lower()
            if surface in ("", "media", "all"):
                self._stage.dismiss()
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
                self._stage.show_media(fresh, self.cfg.http_base)
        except Exception:  # noqa: BLE001
            traceback.print_exc()

    # ---- 分句流式 TTS 管线（合成 worker + 主线程播放队列） ----

    def _enqueue_speech(self, unit: str) -> None:
        if not unit:
            return
        self._queued_any = True
        with self._speech_cond:
            self._speech_queue.append((self._speech_gen, unit))
            self._speech_cond.notify()

    def _mark_speech_done(self) -> None:
        """回复文本已到齐：合成/播放全部耗尽后即可收尾。"""
        self._speech_done = True
        self._maybe_finish_playback()

    def _tts_worker(self) -> None:
        """常驻工作线程：串行消费合成队列，逐句合成后回主线程播放。

        播放与合成流水线并行：当前句播放期间下一句已在合成，句间零空档。
        每条处理完（无论成败）都发 _synth_settled 让主线程复核收尾条件。
        """
        while True:
            with self._speech_cond:
                while not self._speech_queue and not self._speech_exit:
                    self._speech_cond.wait(timeout=1.0)
                if self._speech_exit:
                    return
                gen, text = self._speech_queue.pop(0)
                self._synth_inflight = True
            path: Optional[str] = None
            try:
                path = self._synthesize_to_file(text)
            except Exception:  # noqa: BLE001
                traceback.print_exc()
            with self._speech_cond:
                self._synth_inflight = False
                stale = self._speech_exit or gen != self._speech_gen
                if path is None and not stale:
                    self._synth_failed_any = True
            if path is not None:
                if stale:
                    self._delete_audio_file(path)
                else:
                    self._play_requested.emit(path)
            self._synth_settled.emit()

    def _synthesize_to_file(self, text: str) -> Optional[str]:
        """一句文本 → POST /brain/sensory/speak 合成 → 落地临时音频文件。"""
        try:
            resp = requests.post(
                f"{self.cfg.http_base}/brain/sensory/speak",
                json={"text": text},
                timeout=60,
            )
            resp.raise_for_status()
            result = resp.json().get("result", {})
            audio_data = result.get("data")
            if not audio_data:
                return None
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
            return path
        except Exception as exc:  # noqa: BLE001
            print(f"[voice-orb] TTS 合成失败: {exc}", flush=True)
            return None

    @staticmethod
    def _delete_audio_file(path: Optional[str]) -> None:
        if not path:
            return
        try:
            os.remove(path)
        except OSError:
            pass

    def _drain_speech_pipeline(self) -> None:
        """打断/新轮次：清空合成与播放队列，删除未播放的临时音频。

        递增 _speech_gen 使工作线程中正在合成的上一轮句子作废（合成结果
        直接丢弃，不回主线程播放）。
        """
        with self._speech_cond:
            self._speech_queue.clear()
            self._speech_buffer = ""
            self._speech_done = False
            self._speech_gen += 1
            self._queued_any = False
            self._synth_failed_any = False
        for stale_path in self._playback_queue:
            self._delete_audio_file(stale_path)
        self._playback_queue.clear()
        self._delete_audio_file(self._current_audio_path)
        self._current_audio_path = None

    def _shutdown_speech_worker(self) -> None:
        with self._speech_cond:
            self._speech_exit = True
            self._speech_cond.notify_all()

    def _play_audio(self, path: str) -> None:
        """主线程槽：播放器空闲即播；播放中则排队，EndOfMedia 接续。"""
        try:
            if self._player.playbackState() == QMediaPlayer.PlaybackState.PlayingState:
                self._playback_queue.append(path)
                return
            self._played_any = True
            self._start_monitor()
            self.overlay.show_state(OrbState.SPEAKING)
            self._current_audio_path = path
            self._player.setSource(QUrl.fromLocalFile(path))
            self._player.play()
        except Exception:  # noqa: BLE001
            traceback.print_exc()

    def _maybe_finish_playback(self) -> None:
        """文本到齐且合成/播放全部耗尽 → 本轮收尾（进追问聆听窗口）。"""
        try:
            if not self._speech_done or not self._turn_active:
                return
            if self._player.playbackState() == QMediaPlayer.PlaybackState.PlayingState:
                return
            if self._playback_queue:
                return
            with self._speech_cond:
                if self._speech_queue or self._synth_inflight or self._speech_buffer:
                    return
                all_failed = self._queued_any and not self._played_any and self._synth_failed_any
            self._speech_done = False
            if all_failed:
                self._turn_failed.emit("播报失败：语音合成服务无响应")
                return
            self._end_turn()
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
        """用户在播报中开口（或点击悬浮件）：停播清队 → 直接回聆听（不等播完）。"""
        try:
            self._stop_monitor()
            self._player.stop()
            self._drain_speech_pipeline()
            # 复位轮次：追问聆听窗口与 _end_turn 路径同状态，避免打断后
            # 无人说话时 _turn_active 残留卡住点击说话/唤醒入口
            self._turn_active = False
            # 用追问窗口兜底：若"开口"是扬声器噪声误触发，10s 无声自动回待机
            QTimer.singleShot(250, lambda: self._start_listening(
                followup_window_s=self.FOLLOWUP_WINDOW_S, caption="请讲",
            ))
        except Exception:  # noqa: BLE001
            traceback.print_exc()

    def _on_media_status(self, status) -> None:
        try:
            if status != QMediaPlayer.MediaStatus.EndOfMedia:
                return
            self._delete_audio_file(self._current_audio_path)
            self._current_audio_path = None
            if self._playback_queue:
                nxt = self._playback_queue.pop(0)
                self._current_audio_path = nxt
                self._player.setSource(QUrl.fromLocalFile(nxt))
                self._player.play()
                return
            self._stop_monitor()
            self._maybe_finish_playback()
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
            self._drain_speech_pipeline()
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
            self._shutdown_speech_worker()
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
            self._shutdown_speech_worker()
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
