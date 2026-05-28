from __future__ import annotations

import base64
from typing import Any

import httpx

from desktop_visual_agent.vlm.base import VLMImage, VLMMessage, VLMResult, VisionLanguageModel


def _image_to_data_url(img: VLMImage) -> str:
    if img.base64:
        b64 = img.base64
    elif img.data:
        b64 = base64.standard_b64encode(img.data).decode("ascii")
    else:
        raise ValueError("empty image")
    return f"data:{img.mime_type};base64,{b64}"


def _messages_to_openai_payload(messages: list[VLMMessage]) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for m in messages:
        parts: list[dict[str, Any]] = []
        if m.text:
            parts.append({"type": "text", "text": m.text})
        for im in m.images:
            parts.append({"type": "image_url", "image_url": {"url": _image_to_data_url(im)}})
        if not parts:
            parts.append({"type": "text", "text": ""})
        out.append({"role": m.role, "content": parts})
    return out


class OpenAICompatibleVLM(VisionLanguageModel):
    """任意 OpenAI Chat Completions 兼容端点（含 /v1/chat/completions 与 vision）。"""

    def __init__(
        self,
        *,
        base_url: str,
        api_key: str,
        model: str,
        timeout_s: float = 120.0,
        extra_body: dict[str, Any] | None = None,
    ) -> None:
        self._base = base_url.rstrip("/")
        self._api_key = api_key
        self._model = model
        self._timeout = timeout_s
        self._extra = extra_body or {}

    async def complete(self, messages: list[VLMMessage], **kwargs: Any) -> VLMResult:
        url = f"{self._base}/v1/chat/completions"
        payload: dict[str, Any] = {
            "model": self._model,
            "messages": _messages_to_openai_payload(messages),
            "temperature": kwargs.get("temperature", 0.2),
            **self._extra,
        }
        for k, v in kwargs.items():
            if k in ("temperature",):
                continue
            if k not in payload:
                payload[k] = v

        headers = {"Authorization": f"Bearer {self._api_key}"}
        async with httpx.AsyncClient(timeout=self._timeout) as client:
            r = await client.post(url, json=payload, headers=headers)
            r.raise_for_status()
            data = r.json()

        choice0 = data["choices"][0]
        msg = choice0.get("message") or {}
        text = msg.get("content") or ""
        if isinstance(text, list):
            text = "".join(
                part.get("text", "") if isinstance(part, dict) else str(part) for part in text
            )
        return VLMResult(text=str(text), raw=data)
