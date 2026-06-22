"""
Python 翻译 HTTP 客户端：调用主服务 `/api/translate/screen-region`。

输入：图片字节（PNG/JPEG）
输出：TranslateResult dataclass

环境变量：
  PRIVATE_AI_AGENT_BASE_URL  主服务地址，默认 http://127.0.0.1:8787
  TRANSLATE_TIMEOUT_S         请求超时（秒），默认 30
  TRANSLATE_TARGET_LANG       默认目标语言，默认 zh
"""
from __future__ import annotations

import base64
import logging
import os
from dataclasses import dataclass, field
from typing import Any

import httpx

LOG = logging.getLogger("translate_api_client")


@dataclass
class TranslateResult:
    ok: bool
    source_text: str = ""
    translated_text: str = ""
    target_lang: str = "zh"
    translated_by: str = "none"
    line_count: int = 0
    error: str | None = None
    width: int | None = None
    height: int | None = None
    raw: dict[str, Any] = field(default_factory=dict)


class TranslateApiClient:
    def __init__(self, base_url: str | None = None, timeout_s: float | None = None) -> None:
        self.base_url = (
            base_url
            or os.environ.get("PRIVATE_AI_AGENT_BASE_URL", "http://127.0.0.1:8787").strip()
        ).rstrip("/")
        self.timeout_s = float(
            timeout_s
            or os.environ.get("TRANSLATE_TIMEOUT_S", "30").strip()
        )

    def translate_image(
        self,
        image_bytes: bytes,
        mime_type: str = "image/png",
        target_lang: str | None = None,
        source_lang: str | None = None,
    ) -> TranslateResult:
        target = (target_lang or os.environ.get("TRANSLATE_TARGET_LANG", "zh") or "zh").strip() or "zh"
        b64 = base64.b64encode(image_bytes).decode("ascii")
        payload: dict[str, Any] = {
            "imageBase64": b64,
            "mimeType": mime_type,
            "targetLang": target,
        }
        if source_lang:
            payload["sourceLang"] = source_lang
        try:
            with httpx.Client(timeout=self.timeout_s) as cli:
                r = cli.post(f"{self.base_url}/api/translate/screen-region", json=payload)
        except Exception as e:
            LOG.exception("翻译请求失败")
            return TranslateResult(ok=False, error=f"无法连接主服务: {e}")
        if r.status_code < 200 or r.status_code >= 300:
            return TranslateResult(ok=False, error=f"主服务 HTTP {r.status_code}: {r.text[:200]}")
        try:
            data = r.json()
        except Exception as e:
            return TranslateResult(ok=False, error=f"无法解析响应 JSON: {e}")
        if not isinstance(data, dict):
            return TranslateResult(ok=False, error="响应非 JSON 对象")
        ok = bool(data.get("ok"))
        if not ok:
            return TranslateResult(
                ok=False,
                error=str(data.get("error") or "主服务返回 ok=false"),
                raw=data,
            )
        lines = data.get("lines") or []
        return TranslateResult(
            ok=True,
            source_text=str(data.get("sourceText") or ""),
            translated_text=str(data.get("translatedText") or ""),
            target_lang=str(data.get("targetLang") or target),
            translated_by=str(data.get("translatedBy") or "none"),
            line_count=len(lines) if isinstance(lines, list) else 0,
            width=(data.get("width") if isinstance(data.get("width"), int) else None),
            height=(data.get("height") if isinstance(data.get("height"), int) else None),
            raw=data,
        )

    def health(self) -> tuple[bool, str | None, dict[str, Any] | None]:
        try:
            with httpx.Client(timeout=3.0) as cli:
                r = cli.get(f"{self.base_url}/api/translate/health")
        except Exception as e:
            return False, f"无法连接主服务: {e}", None
        if r.status_code < 200 or r.status_code >= 300:
            return False, f"主服务 HTTP {r.status_code}", None
        try:
            data = r.json()
        except Exception as e:
            return False, f"无法解析健康检查响应: {e}", None
        paddle = (data or {}).get("paddleOcr") or {}
        available = bool(paddle.get("available"))
        err = paddle.get("error")
        return available, err, (data if isinstance(data, dict) else None)
