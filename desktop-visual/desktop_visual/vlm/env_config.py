from __future__ import annotations

import os
from typing import Any


def _normalize_openai_base(url: str) -> str:
    u = url.strip().rstrip("/")
    if u.endswith("/v1"):
        return u[:-3].rstrip("/")
    return u


def resolve_vlm_from_environ() -> dict[str, str] | None:
    """与 Node resolveDesktopVisualVlmConfig 对齐：优先 Moonshot，其次 OpenAI。"""
    moonshot_key = os.environ.get("MOONSHOT_API_KEY", "").strip()
    if moonshot_key:
        base = _normalize_openai_base(
            os.environ.get("MOONSHOT_BASE_URL", "https://api.moonshot.cn/v1"),
        )
        model = (
            os.environ.get("DESKTOP_VISUAL_VLM_MODEL", "").strip()
            or os.environ.get("OPENAI_VISION_MODEL", "").strip()
            or "moonshot-v1-8k-vision-preview"
        )
        return {"apiKey": moonshot_key, "baseUrl": base, "model": model}

    openai_key = os.environ.get("OPENAI_API_KEY", "").strip()
    if openai_key:
        base = _normalize_openai_base(
            os.environ.get("OPENAI_BASE_URL", "https://api.openai.com/v1"),
        )
        model = (
            os.environ.get("DESKTOP_VISUAL_VLM_MODEL", "").strip()
            or os.environ.get("OPENAI_VISION_MODEL", "").strip()
            or os.environ.get("OPENAI_MODEL", "").strip()
            or "gpt-4o-mini"
        )
        return {"apiKey": openai_key, "baseUrl": base, "model": model}

    return None


def resolve_vlm_from_request(req: dict[str, Any]) -> dict[str, str] | None:
    """桥接 invoke / stdio 请求体中的 vlm 字段优先于本机环境变量。"""
    raw = req.get("vlm")
    if isinstance(raw, dict):
        api_key = str(raw.get("apiKey") or raw.get("api_key") or "").strip()
        base_url = str(raw.get("baseUrl") or raw.get("base_url") or "").strip()
        model = str(raw.get("model") or "").strip()
        if api_key and base_url and model:
            return {
                "apiKey": api_key,
                "baseUrl": _normalize_openai_base(base_url),
                "model": model,
            }
    return resolve_vlm_from_environ()
