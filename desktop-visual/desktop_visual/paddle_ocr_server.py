"""
PaddleOCR HTTP 服务：接收 base64 图片，返回识别出的文本与每个文本块的位置。

启动：
  python -m desktop_visual.paddle_ocr_server --port 8765
  或
  uvicorn desktop_visual.paddle_ocr_server:app --host 127.0.0.1 --port 8765

环境变量：
  PADDLE_OCR_LANG         识别语种，默认 ch（中文+英文）
  PADDLE_OCR_USE_GPU      是否使用 GPU，默认 false
  PADDLE_OCR_USE_ANGLE_CLS 是否做文字方向分类，默认 true
  PADDLE_OCR_HOST         监听地址，默认 127.0.0.1
  PADDLE_OCR_PORT         监听端口，默认 8765

PaddleOCR 文档参考：https://github.com/PaddlePaddle/PaddleOCR
"""
from __future__ import annotations

import argparse
import base64
import io
import logging
import os
import sys
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

LOG = logging.getLogger("paddle_ocr_server")

# ---------- 缓存/临时/模型目录统一落 D 盘,严禁写 C 盘 ----------
# 优先级:
#   1) 显式环境变量(PADDLE_TMP_DIR / TEMP / TMP)
#   2) 顶层默认 D:\paddle\{paddleocr,paddlex,tmp,..}
_DEFAULT_ROOT = Path("D:/paddle")
_DEFAULT_MODEL_DIR = _DEFAULT_ROOT / "paddleocr"
_DEFAULT_PDX_DIR = _DEFAULT_ROOT / "paddlex"
_DEFAULT_TMP_DIR = _DEFAULT_ROOT / "tmp"

_MODEL_DIR = Path(os.environ.get("PADDLE_OCR_MODEL_DIR", str(_DEFAULT_MODEL_DIR))).expanduser()
_PDX_DIR = Path(os.environ.get("PADDLE_PDX_CACHE_HOME", str(_DEFAULT_PDX_DIR))).expanduser()
_TMP_DIR = Path(os.environ.get("PADDLE_TMP_DIR", str(_DEFAULT_TMP_DIR))).expanduser()

for _p in (_MODEL_DIR, _PDX_DIR, _TMP_DIR):
    try:
        _p.mkdir(parents=True, exist_ok=True)
    except OSError as e:
        LOG.warning("无法创建缓存目录 %s：%s", _p, e)

# 同步设置 Paddle / 通用临时目录环境变量(要在 PaddleOCR/PaddleX import 前)
os.environ["PPOCR_HOME"] = str(_MODEL_DIR)
os.environ["PADDLE_PDX_CACHE_HOME"] = str(_PDX_DIR)
os.environ["PADDLE_OCR_MODEL_DIR"] = str(_MODEL_DIR)
os.environ["TEMP"] = str(_TMP_DIR)
os.environ["TMP"] = str(_TMP_DIR)
os.environ["TMPDIR"] = str(_TMP_DIR)
# 顺手把 pip 缓存和 HF 缓存也设上(防止后续有依赖下载)
os.environ.setdefault("PIP_CACHE_DIR", str(_DEFAULT_ROOT / "pip"))
os.environ.setdefault("HF_HOME", str(_DEFAULT_ROOT / "hf"))
os.environ.setdefault("HUGGINGFACE_HUB_CACHE", str(_DEFAULT_ROOT / "hf" / "hub"))
# 让 Python 临时文件也走 D 盘
import tempfile  # noqa: E402
tempfile.tempdir = str(_TMP_DIR)

LOG.info(
    "Paddle 缓存落 D 盘: model=%s pdx=%s tmp=%s",
    _MODEL_DIR, _PDX_DIR, _TMP_DIR,
)

# PaddleOCR 实例懒加载（首次请求时再加载，避免启动过慢）
_OCR_INSTANCE: Any = None
_OCR_LANG: str | None = None
_OCR_USE_ANGLE_CLS: bool = True


def _get_ocr(lang: str | None = None, use_angle_cls: bool = True) -> Any:
    """懒加载 PaddleOCR；首次调用时初始化，后续复用。"""
    global _OCR_INSTANCE, _OCR_LANG, _OCR_USE_ANGLE_CLS
    target_lang = lang or os.environ.get("PADDLE_OCR_LANG", "ch").strip() or "ch"
    target_cls = use_angle_cls
    if _OCR_INSTANCE is not None and _OCR_LANG == target_lang and _OCR_USE_ANGLE_CLS == target_cls:
        return _OCR_INSTANCE
    from paddleocr import PaddleOCR  # type: ignore

    use_gpu = os.environ.get("PADDLE_OCR_USE_GPU", "").strip().lower() in ("1", "true", "yes", "on")
    # PaddleOCR 3.x 完全重构:不再有 use_angle_cls / lang / home_dir,统一用 *_model_name
    # 控制语种,模型目录走 PPOCR_HOME 环境变量(我们已在进程启动时设到 D 盘)。
    lang = (target_lang or "ch").lower()
    if lang in ("ch", "zh", "chinese", "zh-cn", "zh-hans"):
        det_name = "PP-OCRv5_mobile_det"
        rec_name = "PP-OCRv5_mobile_rec"
    elif lang in ("en", "english"):
        det_name = "PP-OCRv5_mobile_det"
        rec_name = "en_PP-OCRv5_mobile_rec"
    elif lang in ("ja", "japan", "japanese"):
        det_name = "PP-OCRv5_mobile_det"
        rec_name = "japan_PP-OCRv5_mobile_rec"
    elif lang in ("ko", "korean"):
        det_name = "PP-OCRv5_mobile_det"
        rec_name = "korean_PP-OCRv5_mobile_rec"
    else:
        # 兜底用中文
        det_name = "PP-OCRv5_mobile_det"
        rec_name = "PP-OCRv5_mobile_rec"

    LOG.info("加载 PaddleOCR 3.x: lang=%s det=%s rec=%s", lang, det_name, rec_name)
    _OCR_INSTANCE = PaddleOCR(
        use_doc_orientation_classify=target_cls,
        use_textline_orientation=target_cls,
        text_detection_model_name=det_name,
        text_recognition_model_name=rec_name,
    )
    _OCR_LANG = target_lang
    _OCR_USE_ANGLE_CLS = target_cls
    return _OCR_INSTANCE


class OcrRequest(BaseModel):
    imageBase64: str = Field(..., description="图片 base64 字符串（不含 data:image/...;base64, 前缀）")
    mimeType: str | None = Field(default="image/png", description="图片 MIME 类型")
    lang: str | None = Field(default=None, description="语种；为空时用 PADDLE_OCR_LANG 或 ch")
    mergeLines: bool = Field(default=True, description="是否按行合并成多行文本")


class OcrLine(BaseModel):
    text: str
    confidence: float
    box: list[list[float]]


class OcrResponse(BaseModel):
    ok: bool
    text: str = ""
    lines: list[OcrLine] = []
    width: int | None = None
    height: int | None = None
    error: str | None = None


app = FastAPI(title="PaddleOCR Server", version="1.0.0")


@app.get("/health")
def health() -> dict[str, Any]:
    return {"ok": True, "service": "paddle_ocr_server"}


@app.post("/ocr", response_model=OcrResponse)
def ocr(req: OcrRequest) -> OcrResponse:
    if not req.imageBase64:
        raise HTTPException(status_code=400, detail="imageBase64 不能为空")
    try:
        # 兼容 "data:image/png;base64,xxxx" 形式
        raw = req.imageBase64.strip()
        if "," in raw and raw.startswith("data:"):
            raw = raw.split(",", 1)[1]
        image_bytes = base64.b64decode(raw)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"imageBase64 解码失败: {e}") from e

    try:
        from PIL import Image  # type: ignore
    except ImportError as exc:
        LOG.exception("Pillow 缺失")
        raise HTTPException(status_code=500, detail=f"Pillow 缺失: {exc}") from exc

    try:
        img = Image.open(io.BytesIO(image_bytes))
        width, height = img.size
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"无法解析图片: {e}") from e

    try:
        ocr = _get_ocr(lang=req.lang, use_angle_cls=True)
    except Exception as e:
        LOG.exception("PaddleOCR 初始化失败")
        return OcrResponse(ok=False, error=f"PaddleOCR 初始化失败: {e}")

    try:
        # PaddleOCR 的 .ocr() 支持 numpy array
        import numpy as np  # type: ignore
        img_array = np.array(img.convert("RGB"))
        result = ocr.ocr(img_array, cls=True)
    except Exception as e:
        LOG.exception("OCR 识别失败")
        return OcrResponse(ok=False, error=f"OCR 识别失败: {e}")

    # 解析结果：result[0] 为识别结果列表，每个元素 [box, (text, conf)]
    raw_lines: list[OcrLine] = []
    page = result[0] if result else None
    if page:
        for item in page:
            try:
                box = item[0]
                text_info = item[1]
                text_val = str(text_info[0]) if text_info else ""
                conf = float(text_info[1]) if text_info and len(text_info) > 1 else 0.0
            except Exception:
                continue
            if not text_val:
                continue
            raw_lines.append(
                OcrLine(
                    text=text_val,
                    confidence=round(conf, 4),
                    box=[[float(p[0]), float(p[1])] for p in box] if box else [],
                )
            )

    # 按 y 坐标排序后合并
    if req.mergeLines and raw_lines:
        try:
            raw_lines.sort(key=lambda ln: (min(p[1] for p in ln.box) if ln.box else 0))
        except Exception:
            pass
        merged_text = "\n".join(ln.text for ln in raw_lines)
    else:
        merged_text = "\n".join(ln.text for ln in raw_lines)

    return OcrResponse(
        ok=True,
        text=merged_text,
        lines=raw_lines,
        width=width,
        height=height,
    )


def _parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="PaddleOCR HTTP 服务")
    p.add_argument("--host", default=os.environ.get("PADDLE_OCR_HOST", "127.0.0.1"))
    p.add_argument("--port", type=int, default=int(os.environ.get("PADDLE_OCR_PORT", "8765")))
    p.add_argument("--log-level", default="info")
    return p.parse_args()


def main() -> None:
    args = _parse_args()
    logging.basicConfig(
        level=getattr(logging, args.log_level.upper(), logging.INFO),
        format="%(asctime)s %(levelname)s %(name)s - %(message)s",
    )
    import uvicorn  # type: ignore

    LOG.info("启动 PaddleOCR HTTP 服务，监听 %s:%s", args.host, args.port)
    uvicorn.run(app, host=args.host, port=args.port, log_level=args.log_level)


if __name__ == "__main__":
    main()
