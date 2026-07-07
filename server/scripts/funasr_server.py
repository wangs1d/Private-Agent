"""
FunASR 自托管 ASR HTTP 服务（与 Node 端 funasr-asr-adapter.ts 配套）。

启动：
    pip install -r server/scripts/funasr_requirements.txt
    python server/scripts/funasr_server.py            # 默认 0.0.0.0:8001
    python server/scripts/funasr_server.py --port 8002 --model paraformer-zh

接口：
    POST /api/asr  (multipart/form-data)
        file: 音频文件（wav/mp3/ogg/pcm）
        language: 可选，默认 "zh"
        enable_punctuation: 可选，默认 true
    返回：
        { "text": "...", "confidence": 0.9, "language": "zh" }

    GET /health  → { "status": "ok", "model_loaded": true }

模型加载策略：
    首次启动会从 ModelScope 下载模型到 ~/.cache/funasr/，约 1GB。
    后续启动直接加载本地缓存，毫秒级。
"""
import argparse
import asyncio
import io
import logging
import os
import sys
import tempfile
from pathlib import Path

logging.basicConfig(
    level=logging.INFO,
    format="[FunASR-Server] %(asctime)s | %(levelname)s | %(message)s",
)
log = logging.getLogger("funasr_server")

# FastAPI
from fastapi import FastAPI, File, UploadFile, Form, HTTPException
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


app = FastAPI(title="FunASR ASR Server", version="1.0.0")

# 全局模型实例，启动时加载一次
MODEL = None
MODEL_NAME = "paraformer-zh"
VAD_MODEL = "fsmn-vad"
PUNC_MODEL = "ct-punc"


def load_model(model_name: str, vad_model: str | None, punc_model: str | None) -> AutoModel:
    """加载 FunASR 模型（首次启动会从 ModelScope 下载）。"""
    kwargs = {
        "model": model_name,
        "disable_update": True,
        "device": "cpu",  # 兼容无 GPU 环境；有 CUDA 可改 "cuda:0"
    }
    if vad_model:
        kwargs["vad_model"] = vad_model
        kwargs["vad_kwargs"] = {"max_single_segment_time": 30000}
    if punc_model:
        kwargs["punc_model"] = punc_model

    log.info(f"正在加载模型：{kwargs}")
    return AutoModel(**kwargs)


def transcribe_bytes(audio_bytes: bytes, filename: str, language: str,
                     enable_punctuation: bool) -> dict:
    """对音频字节做 ASR 识别。"""
    # FunASR 接受本地文件路径或 ndarray；优先写临时文件确保 soundfile 能解码
    suffix = Path(filename).suffix or ".wav"
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
        tmp.write(audio_bytes)
        tmp_path = tmp.name

    try:
        res = MODEL.generate(
            input=tmp_path,
            cache={},
            language=language,
            use_itn=True,
            batch_size_s=60,
            merge_vad=True,
            merge_length_s=15,
        )
    finally:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass

    # res 是 list，每个 item {key, text, timestamp}；合并所有 text
    texts = []
    for item in res:
        t = item.get("text", "").strip()
        if t:
            texts.append(t)

    final_text = "".join(texts)
    if not enable_punctuation:
        # 简易去标点（FunASR punc 模型会加中文标点）
        import re
        final_text = re.sub(r"[，。？！、；：""''（）《》【】…—\-]", "", final_text)

    return {
        "text": final_text,
        "confidence": 0.9,  # FunASR 不直接返回 confidence，用固定值表示成功
        "language": language,
    }


@app.on_event("startup")
async def _on_startup():
    global MODEL, MODEL_NAME, VAD_MODEL, PUNC_MODEL
    MODEL = load_model(MODEL_NAME, VAD_MODEL, PUNC_MODEL)
    log.info("模型加载完成，服务就绪")


@app.get("/health")
async def health():
    return {
        "status": "ok",
        "model_loaded": MODEL is not None,
        "model": MODEL_NAME,
        "vad": VAD_MODEL,
        "punc": PUNC_MODEL,
    }


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

    # 同步推理放线程池避免阻塞 event loop
    try:
        loop = asyncio.get_event_loop()
        result = await loop.run_in_executor(
            None,
            lambda: transcribe_bytes(audio_bytes, file.filename or "audio.wav",
                                      language, enable_punctuation),
        )
    except Exception as e:
        log.exception("ASR 推理失败")
        return JSONResponse(
            status_code=500,
            content={"error": f"inference failed: {e}", "text": "", "language": language},
        )

    log.info(f"ASR 结果：{result['text'][:80]}{'...' if len(result['text']) > 80 else ''}")
    return result


def main():
    global MODEL_NAME, VAD_MODEL, PUNC_MODEL
    parser = argparse.ArgumentParser(description="FunASR ASR HTTP server")
    parser.add_argument("--host", default="0.0.0.0", help="监听地址")
    parser.add_argument("--port", type=int, default=8001, help="监听端口")
    parser.add_argument("--model", default=os.environ.get("FUNASR_MODEL", "paraformer-zh"),
                        help="ASR 模型名")
    parser.add_argument("--vad", default=os.environ.get("FUNASR_VAD_MODEL", "fsmn-vad"),
                        help="VAD 模型名（空字符串禁用）")
    parser.add_argument("--punc", default=os.environ.get("FUNASR_PUNC_MODEL", "ct-punc"),
                        help="标点恢复模型名（空字符串禁用）")
    parser.add_argument("--device", default="cpu", help="推理设备（cpu / cuda:0）")
    args = parser.parse_args()

    MODEL_NAME = args.model
    VAD_MODEL = args.vad or None
    PUNC_MODEL = args.punc or None

    log.info(f"启动 FunASR Server：host={args.host}, port={args.port}, "
             f"model={MODEL_NAME}, vad={VAD_MODEL}, punc={PUNC_MODEL}")

    uvicorn.run(app, host=args.host, port=args.port, log_level="info")


if __name__ == "__main__":
    main()
