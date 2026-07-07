"""
FunASR Adapter 端到端测试脚本：
1. 用 pyttsx3 离线合成若干段中文测试音频（无网络依赖）
2. 调用 Node FunAsrAdapter → 转 base64 → 调 Python 服务 /api/asr
3. 直接调用 Python 服务端做对比

跑法：
    cd server
    npx tsx scripts/funasr_test.ts
"""
import os
import sys
import wave
import struct
import time
import math
import http.client
from pathlib import Path

# 简易离线合成：用 Windows SAPI
import win32com.client


def synth_wav(text: str, out_path: Path):
    speaker = win32com.client.Dispatch("SAPI.SpVoice")
    stream = win32com.client.Dispatch("SAPI.SpFileStream")
    fmt = win32com.client.Dispatch("SAPI.SpAudioFormat")
    fmt.Type = 22  # SAFT22kHz16BitMono
    stream.Format = fmt
    stream.Open(str(out_path), 3, False)  # SSFMCreateForWrite = 3
    speaker.AudioOutputStream = stream
    speaker.Rate = 0
    speaker.Speak(text, 3)  # SVSFDefault = 0 | SVSFPurgeBeforeSpeak = 2 → 3 SVSFlagsAsync = 1
    stream.Close()


def synth_fallback_tone(out_path: Path, duration_s: float = 2.0):
    """无 SAPI 时生成纯音 wav，无法做真实 ASR，仅用于上传测试。"""
    sample_rate = 16000
    n = int(sample_rate * duration_s)
    with wave.open(str(out_path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sample_rate)
        for i in range(n):
            v = int(32767 * 0.3 * math.sin(2 * math.pi * 440 * i / sample_rate))
            w.writeframesraw(struct.pack("<h", v))


def call_asr(wav_path: Path, language: str = "zh", enable_punctuation: bool = True) -> dict:
    """multipart 上传 wav 到 http://127.0.0.1:8001/api/asr"""
    boundary = "----funasr_test_boundary"
    body = b""
    body += f"--{boundary}\r\n".encode()
    body += (
        f'Content-Disposition: form-data; name="file"; filename="{wav_path.name}"\r\n'
        "Content-Type: audio/wav\r\n\r\n"
    ).encode()
    body += wav_path.read_bytes()
    body += b"\r\n"
    body += f"--{boundary}\r\n".encode()
    body += b'Content-Disposition: form-data; name="language"\r\n\r\n'
    body += f"{language}\r\n".encode()
    body += f"--{boundary}\r\n".encode()
    body += b'Content-Disposition: form-data; name="enable_punctuation"\r\n\r\n'
    body += f"{'true' if enable_punctuation else 'false'}\r\n".encode()
    body += f"--{boundary}--\r\n".encode()

    conn = http.client.HTTPConnection("127.0.0.1", 8001, timeout=120)
    conn.request(
        "POST",
        "/api/asr",
        body=body,
        headers={
            "Content-Type": f"multipart/form-data; boundary={boundary}",
            "Content-Length": str(len(body)),
        },
    )
    resp = conn.getresponse()
    data = resp.read().decode("utf-8")
    conn.close()
    return {
        "status": resp.status,
        "body": data,
    }


def main():
    """用预先生成好的 case_*.wav 测试 ASR 服务。"""
    tmp_dir = Path("data/funasr_test_audio")
    test_cases = [
        (0, "你好，今天天气怎么样", "短句-日常问候"),
        (1, "我要预约明天下午三点的会议室", "中句-日程预约"),
        (2, "帮我搜索一下北京到上海的高铁票，明天早上的车次", "长句-复杂查询"),
        (3, "1加2等于3，10乘以20等于200", "数字识别"),
        (4, "I love programming in TypeScript and Python", "中英混合"),
    ]

    print("========== FunASR 测试 ==========")
    for idx, text, label in test_cases:
        wav_path = tmp_dir / f"case_{idx}.wav"
        if not wav_path.exists():
            print(f"[{label}] 跳过：{wav_path} 不存在")
            continue
        size_kb = wav_path.stat().st_size / 1024
        t0 = time.time()
        try:
            result = call_asr(wav_path, "zh", True)
            elapsed = time.time() - t0
            print(f"[{label}]")
            print(f"  原文：{text}")
            print(f"  识别：{result['body']}")
            print(f"  耗时：{elapsed*1000:.0f}ms | 文件：{size_kb:.1f}KB")
        except Exception as e:
            print(f"[{label}] 调用失败：{e}")
        print()


if __name__ == "__main__":
    main()
