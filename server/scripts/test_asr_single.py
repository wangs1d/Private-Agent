"""
端到端 ASR 测试（v2）：
1. 用 Windows SAPI5 合成 "你好 我是帅哥" 的 WAV 音频
2. 检查 FunASR 服务健康状态
3. 非流式 HTTP 测试（验证 #1 内存解码 + #7 并发控制）
4. 流式 WebSocket 测试（验证 #8 流式 ASR）
"""
import sys
import os
import time
import tempfile
import http.client
import json
import base64
import threading
from pathlib import Path

# ============ 1. 合成 WAV ============
def synth_wav(text: str, out_path: Path):
    import win32com.client
    speaker = win32com.client.Dispatch("SAPI.SpVoice")
    voices = speaker.GetVoices()
    zh_voice = None
    for i in range(voices.Count):
        v = voices.Item(i)
        desc = v.GetDescription()
        if "Chinese" in desc or "zh" in desc.lower() or "中文" in desc:
            zh_voice = v
            break
    if zh_voice:
        speaker.Voice = zh_voice
        print(f"  使用 voice: {zh_voice.GetDescription()}")
    else:
        print(f"  [WARN] 未找到中文 voice，使用默认: {voices.Item(0).GetDescription()}")
    stream = win32com.client.Dispatch("SAPI.SpFileStream")
    fmt = win32com.client.Dispatch("SAPI.SpAudioFormat")
    fmt.Type = 22  # SAFT22kHz16BitMono
    stream.Format = fmt
    stream.Open(str(out_path), 3, False)
    speaker.AudioOutputStream = stream
    speaker.Rate = 0
    speaker.Speak(text, 0)
    stream.Close()

# ============ 2. 检查健康 ============
def check_health(host: str, port: int) -> dict:
    conn = http.client.HTTPConnection(host, port, timeout=10)
    conn.request("GET", "/health")
    resp = conn.getresponse()
    data = resp.read().decode("utf-8")
    conn.close()
    return {"status": resp.status, "body": data}

# ============ 3. 非流式 ASR ============
def call_asr_http(wav_path: Path, host: str, port: int, language: str = "zh") -> dict:
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
    body += f"--{boundary}--\r\n".encode()

    conn = http.client.HTTPConnection(host, port, timeout=120)
    conn.request(
        "POST", "/api/asr", body=body,
        headers={
            "Content-Type": f"multipart/form-data; boundary={boundary}",
            "Content-Length": str(len(body)),
        },
    )
    resp = conn.getresponse()
    data = resp.read().decode("utf-8")
    conn.close()
    return {"status": resp.status, "body": data}

# ============ 4. 流式 ASR (WebSocket) ============
def call_asr_ws(wav_path: Path, host: str, port: int, language: str = "zh") -> dict:
    """通过 WebSocket /ws/asr 分块发送音频，返回最终识别结果。"""
    import asyncio
    import websockets

    async def _run():
        ws_url = f"ws://{host}:{port}/ws/asr"
        async with websockets.connect(ws_url) as ws:
            # 1. 发送配置
            await ws.send(json.dumps({"type": "config", "language": language, "enable_punctuation": True}))
            resp = await ws.recv()
            print(f"  WS config 响应: {resp}")

            # 2. 分块发送音频（每块 8KB）
            audio_bytes = wav_path.read_bytes()
            chunk_size = 8192
            chunks_sent = 0
            for i in range(0, len(audio_bytes), chunk_size):
                chunk = audio_bytes[i:i + chunk_size]
                await ws.send(json.dumps({"type": "audio", "data": base64.b64encode(chunk).decode()}))
                await ws.recv()  # 等待 ack
                chunks_sent += 1
            print(f"  WS 已发送 {chunks_sent} 块, 共 {len(audio_bytes)} bytes")

            # 3. 发送 stop
            await ws.send(json.dumps({"type": "stop"}))

            # 4. 等待 final 结果
            final_result = None
            while True:
                raw = await ws.recv()
                msg = json.loads(raw)
                print(f"  WS 消息: {raw[:200]}")
                if msg.get("type") == "final":
                    final_result = msg
                    break
                elif msg.get("type") == "error":
                    final_result = msg
                    break

            return final_result or {"type": "error", "message": "no final result"}

    return asyncio.run(_run())

# ============ 主流程 ============
def main():
    text = "你好 我是帅哥"
    host = "127.0.0.1"
    port = 8001

    print(f"========== ASR 端到端测试 v2 ==========")
    print(f"[Step 1] 合成音频: \"{text}\"")
    tmp_dir = Path(tempfile.gettempdir()) / "asr_test"
    tmp_dir.mkdir(parents=True, exist_ok=True)
    wav_path = tmp_dir / "test_asr.wav"
    try:
        synth_wav(text, wav_path)
        size = wav_path.stat().st_size
        print(f"  → {wav_path} ({size} bytes)")
        if size < 100:
            print("  [ERROR] 文件过小，合成可能失败")
            return
    except Exception as e:
        print(f"  [ERROR] 合成失败: {e}")
        return

    # 检查服务
    print(f"\n[Step 2] 检查 FunASR 服务 ({host}:{port})")
    try:
        health = check_health(host, port)
        print(f"  HTTP {health['status']}: {health['body']}")
        if health["status"] != 200:
            print("  [ERROR] 服务不健康，终止测试")
            return
    except Exception as e:
        print(f"  [ERROR] 无法连接 FunASR 服务: {e}")
        print("  请先启动: python server/scripts/funasr_server.py")
        return

    # 非流式 HTTP 测试
    print(f"\n[Step 3] 非流式 HTTP ASR (#1 内存解码 + #7 并发控制)")
    t0 = time.time()
    try:
        result = call_asr_http(wav_path, host, port, "zh")
        elapsed = time.time() - t0
        print(f"  HTTP {result['status']}")
        print(f"  响应: {result['body']}")
        print(f"  耗时: {elapsed*1000:.0f}ms")
    except Exception as e:
        print(f"  [ERROR] 调用失败: {e}")

    # 流式 WebSocket 测试
    print(f"\n[Step 4] 流式 WebSocket ASR (#8 WebSocket)")
    t0 = time.time()
    try:
        result = call_asr_ws(wav_path, host, port, "zh")
        elapsed = time.time() - t0
        print(f"  最终结果: {json.dumps(result, ensure_ascii=False)}")
        print(f"  耗时: {elapsed*1000:.0f}ms")
    except ImportError:
        print("  [SKIP] websockets 未安装，跳过 WS 测试")
        print("  安装: pip install websockets")
    except Exception as e:
        print(f"  [ERROR] WS 调用失败: {e}")

    # 清理
    try:
        wav_path.unlink()
    except OSError:
        pass

    print(f"\n========== 测试完成 ==========")

if __name__ == "__main__":
    main()
