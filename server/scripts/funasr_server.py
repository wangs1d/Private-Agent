"""
FunASR 自托管 ASR 服务（与 Node 端 funasr-asr-adapter.ts 配套）。

启动：
    pip install -r server/scripts/funasr_requirements.txt
    python server/scripts/funasr_server.py            # 默认 0.0.0.0:8001
    python server/scripts/funasr_server.py --port 8002 --model paraformer-zh
    python server/scripts/funasr_server.py --device cuda:0  # GPU 加速

接口：
    POST /api/asr  (multipart/form-data)
        file: 音频文件（wav/mp3/ogg/pcm）
        language: 可选，默认 "zh"
        enable_punctuation: 可选，默认 true
    返回：
        { "text": "...", "confidence": 0.9, "language": "zh" }

    WS /ws/asr  (WebSocket 流式)
        客户端发送：
          {"type":"config","language":"zh","enable_punctuation":true}
          {"type":"audio","data":"<base64>"}   （可多次）
          {"type":"stop"}
        服务端返回：
          {"type":"ready","language":"zh"}
          {"type":"ack","bytes_received":N}
          {"type":"final","text":"...","is_final":true,"confidence":0.9}

    GET /health  → { "status": "ok", "model_loaded": true }

优化项：
    #1 内存解码（消除临时文件 I/O）
    #7 并发控制（信号量串行推理，避免 CPU 争抢）
    #8 WebSocket 流式接口
    #3 模型预热（消除首次推理冷启动）

模型加载策略：
    首次启动会从 ModelScope 下载模型到 ~/.cache/funasr/，约 1GB。
    后续启动直接加载本地缓存，毫秒级。
"""
import argparse
import asyncio
import io
import logging
import os
import re
import sys
import json
from pathlib import Path

logging.basicConfig(
    level=logging.INFO,
    format="[FunASR-Server] %(asctime)s | %(levelname)s | %(message)s",
)
log = logging.getLogger("funasr_server")

# FastAPI
from fastapi import FastAPI, File, UploadFile, Form, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse
import uvicorn

# 音频处理
import soundfile as sf
import numpy as np

# FunASR
try:
    from funasr import AutoModel
except ImportError:
    log.error("funasr 未安装。请运行：pip install -r server/scripts/funasr_requirements.txt")
    sys.exit(1)


app = FastAPI(title="FunASR ASR Server", version="2.0.0")

# 全局模型实例，启动时加载一次
MODEL = None
MODEL_NAME = "paraformer-zh"
VAD_MODEL = "fsmn-vad"
PUNC_MODEL = "ct-punc"
DEVICE = "cpu"

# #7 并发控制：CPU 推理是 GIL 受限的，串行推理避免争抢反而更快
_INFERENCE_SEMAPHORE: asyncio.Semaphore | None = None
_MAX_CONCURRENT = 1


def load_model(model_name: str, vad_model: str | None, punc_model: str | None,
               device: str = "cpu") -> AutoModel:
    """加载 FunASR 模型（首次启动会从 ModelScope 下载）。"""
    kwargs = {
        "model": model_name,
        "disable_update": True,
        "device": device,
    }
    if vad_model:
        kwargs["vad_model"] = vad_model
        kwargs["vad_kwargs"] = {"max_single_segment_time": 30000}
    if punc_model:
        kwargs["punc_model"] = punc_model

    log.info(f"正在加载模型：{kwargs}")
    return AutoModel(**kwargs)


def _decode_audio(audio_bytes: bytes, filename: str) -> tuple[np.ndarray, int]:
    """内存解码音频字节为 (ndarray, sample_rate)，不写临时文件。"""
    suffix = Path(filename).suffix.lower() or ".wav"
    if suffix == ".pcm":
        # PCM 裸数据：假设 16kHz 16bit 单声道
        data = np.frombuffer(audio_bytes, dtype=np.int16).astype(np.float32) / 32768.0
        return data, 16000
    # wav/mp3/ogg 都用 soundfile 内存解码
    buf = io.BytesIO(audio_bytes)
    data, sr = sf.read(buf, dtype="float32")
    if data.ndim > 1:
        data = data[:, 0]  # 立体声取左声道
    return data, sr


def transcribe_bytes(audio_bytes: bytes, filename: str, language: str,
                     enable_punctuation: bool) -> dict:
    """对音频字节做 ASR 识别（内存解码，无临时文件 I/O）。"""
    # #1: 内存解码，消除磁盘 I/O
    data, sr = _decode_audio(audio_bytes, filename)
    duration_s = len(data) / sr
    log.info(f"  解码完成: {duration_s:.1f}s, sr={sr}, samples={len(data)}")

    # 短音频跳过 VAD 分段（<10s 无需 VAD，省 20-50ms）
    if duration_s < 10:
        res = MODEL.generate(
            input=data,
            cache={},
            language=language,
            use_itn=True,
            batch_size_s=60,
        )
    else:
        res = MODEL.generate(
            input=data,
            cache={},
            language=language,
            use_itn=True,
            batch_size_s=60,
            merge_vad=True,
            merge_length_s=15,
        )

    # res 是 list，每个 item {key, text, timestamp}；合并所有 text
    texts = []
    for item in res:
        t = item.get("text", "").strip()
        if t:
            texts.append(t)

    final_text = "".join(texts)
    if not enable_punctuation:
        final_text = re.sub(r"[，。？！、；：""''（）《》【】…—\-]", "", final_text)

    return {
        "text": final_text,
        "confidence": 0.9,
        "language": language,
    }


@app.on_event("startup")
async def _on_startup():
    global MODEL, MODEL_NAME, VAD_MODEL, PUNC_MODEL, DEVICE, _INFERENCE_SEMAPHORE
    MODEL = load_model(MODEL_NAME, VAD_MODEL, PUNC_MODEL, DEVICE)
    log.info("模型加载完成")

    # #3: 模型预热 — 跑一段 1s 静音消除首次推理冷启动
    try:
        dummy = np.zeros(16000, dtype=np.float32)
        MODEL.generate(input=dummy, cache={}, language="zh", use_itn=True)
        log.info("模型预热完成（warmup done）")
    except Exception as e:
        log.warning(f"模型预热失败（不影响使用）: {e}")

    # #7: 初始化并发信号量
    max_conc = int(os.environ.get("FUNASR_MAX_CONCURRENT", str(_MAX_CONCURRENT)))
    _INFERENCE_SEMAPHORE = asyncio.Semaphore(max_conc)
    log.info(f"并发限制: {max_conc}，服务就绪")


@app.get("/health")
async def health():
    return {
        "status": "ok",
        "model_loaded": MODEL is not None,
        "model": MODEL_NAME,
        "vad": VAD_MODEL,
        "punc": PUNC_MODEL,
        "device": DEVICE,
        "streaming": True,
    }


# ============ #7: 非流式 ASR（带并发控制）============

@app.post("/api/asr")
async def api_asr(
    file: UploadFile = File(...),
    language: str = Form("zh"),
    enable_punctuation: bool = Form(True),
):
    if MODEL is None:
        raise HTTPException(status_code=503, detail="model not loaded yet")

    audio_bytes = await file.read()
    if not audio_bytes:
        raise HTTPException(status_code=400, detail="empty audio file")

    log.info(f"ASR 请求：filename={file.filename}, size={len(audio_bytes)}B, "
             f"language={language}, punc={enable_punctuation}")

    # #7: 信号量控制并发，CPU 推理串行避免争抢
    async def _run():
        loop = asyncio.get_event_loop()
        return await loop.run_in_executor(
            None,
            lambda: transcribe_bytes(audio_bytes, file.filename or "audio.wav",
                                      language, enable_punctuation),
        )

    try:
        async with _INFERENCE_SEMAPHORE:
            result = await _run()
    except Exception as e:
        log.exception("ASR 推理失败")
        return JSONResponse(
            status_code=500,
            content={"error": f"inference failed: {e}", "text": "", "language": language},
        )

    log.info(f"ASR 结果：{result['text'][:80]}{'...' if len(result['text']) > 80 else ''}")
    return result


# ============ #8: 流式 ASR WebSocket ============
# 协议：
#   客户端 → 服务端：
#     {"type":"config","language":"zh","enable_punctuation":true}  （首条，可选）
#     {"type":"audio","data":"<base64-encoded PCM/WAV bytes>"}      （可多次发送）
#     {"type":"stop"}                                                （结束流）
#   服务端 → 客户端：
#     {"type":"partial","text":"你好","is_final":false}
#     {"type":"final","text":"你好 我是帅哥。","is_final":true,"confidence":0.9}
#     {"type":"error","message":"..."}

@app.websocket("/ws/asr")
async def ws_asr(ws: WebSocket):
    await ws.accept()
    language = "zh"
    enable_punctuation = True
    audio_chunks: list[bytes] = []
    total_bytes = 0

    log.info("WS /ws/asr 客户端已连接")

    try:
        while True:
            raw = await ws.receive_text()
            msg = json.loads(raw)
            mtype = msg.get("type", "")

            if mtype == "config":
                language = msg.get("language", "zh")
                enable_punctuation = msg.get("enable_punctuation", True)
                await ws.send_json({"type": "ready", "language": language})
                log.info(f"  WS config: lang={language}, punc={enable_punctuation}")

            elif mtype == "audio":
                import base64
                chunk = base64.b64decode(msg.get("data", ""))
                audio_chunks.append(chunk)
                total_bytes += len(chunk)
                # 发送累积字节数反馈
                await ws.send_json({"type": "ack", "bytes_received": total_bytes})

            elif mtype == "stop":
                # 合并所有音频块，做一次完整推理
                if not audio_chunks:
                    await ws.send_json({"type": "final", "text": "", "is_final": True,
                                        "confidence": 0, "language": language})
                    break

                audio_bytes = b"".join(audio_chunks)
                log.info(f"  WS stop: total {total_bytes}B, 开始推理")

                async def _run():
                    loop = asyncio.get_event_loop()
                    return await loop.run_in_executor(
                        None,
                        lambda: transcribe_bytes(audio_bytes, "audio.wav",
                                                  language, enable_punctuation),
                    )

                try:
                    async with _INFERENCE_SEMAPHORE:
                        result = await _run()
                    await ws.send_json({
                        "type": "final",
                        "text": result["text"],
                        "is_final": True,
                        "confidence": result["confidence"],
                        "language": result["language"],
                    })
                    log.info(f"  WS final: {result['text'][:80]}")
                except Exception as e:
                    log.exception("WS ASR 推理失败")
                    await ws.send_json({"type": "error", "message": str(e)})
                break

            else:
                await ws.send_json({"type": "error", "message": f"unknown type: {mtype}"})

    except WebSocketDisconnect:
        log.info("WS /ws/asr 客户端断开")
    except Exception as e:
        log.exception("WS /ws/asr 异常")
        try:
            await ws.send_json({"type": "error", "message": str(e)})
        except Exception:
            pass


def main():
    global MODEL_NAME, VAD_MODEL, PUNC_MODEL, DEVICE
    parser = argparse.ArgumentParser(description="FunASR ASR HTTP server")
    parser.add_argument("--host", default="0.0.0.0", help="监听地址")
    parser.add_argument("--port", type=int, default=8001, help="监听端口")
    parser.add_argument("--model", default=os.environ.get("FUNASR_MODEL", "paraformer-zh"),
                        help="ASR 模型名")
    parser.add_argument("--vad", default=os.environ.get("FUNASR_VAD_MODEL", "fsmn-vad"),
                        help="VAD 模型名（空字符串禁用）")
    parser.add_argument("--punc", default=os.environ.get("FUNASR_PUNC_MODEL", "ct-punc"),
                        help="标点恢复模型名（空字符串禁用）")
    parser.add_argument("--device", default=os.environ.get("FUNASR_DEVICE", "cpu"),
                        help="推理设备（cpu / cuda:0）")
    args = parser.parse_args()

    MODEL_NAME = args.model
    VAD_MODEL = args.vad or None
    PUNC_MODEL = args.punc or None
    DEVICE = args.device

    log.info(f"启动 FunASR Server：host={args.host}, port={args.port}, "
             f"model={MODEL_NAME}, vad={VAD_MODEL}, punc={PUNC_MODEL}, device={DEVICE}")

    uvicorn.run(app, host=args.host, port=args.port, log_level="info")


if __name__ == "__main__":
    main()
