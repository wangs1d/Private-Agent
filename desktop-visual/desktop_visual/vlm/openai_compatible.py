from __future__ import annotations

import base64
from typing import Any

import httpx

from desktop_visual.vlm.base import VLMImage, VLMMessage, VLMResult, VisionLanguageModel


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
    for message in messages:
        parts: list[dict[str, Any]] = []
        if message.text:
            parts.append({"type": "text", "text": message.text})
        for image in message.images:
            parts.append({
                "type": "image_url",
                "image_url": {"url": _image_to_data_url(image)},
            })
        if not parts:
            parts.append({"type": "text", "text": ""})
        out.append({"role": message.role, "content": parts})
    return out


class OpenAICompatibleVLM(VisionLanguageModel):
    """OpenAI-compatible chat completions client for vision models."""

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
        for key, value in kwargs.items():
            if key == "temperature":
                continue
            if key not in payload:
                payload[key] = value

        headers = {"Authorization": f"Bearer {self._api_key}"}
        async with httpx.AsyncClient(timeout=self._timeout) as client:
            response = await client.post(url, json=payload, headers=headers)
            if response.status_code >= 400:
                body_preview = (response.text or "")[:400]
                raise RuntimeError(
                    f"VLM HTTP {response.status_code} for {url}: {body_preview}",
                )
            data = response.json()

        choice0 = data["choices"][0]
        message = choice0.get("message") or {}
        text = message.get("content") or ""
        if isinstance(text, list):
            text = "".join(
                part.get("text", "") if isinstance(part, dict) else str(part)
                for part in text
            )
        return VLMResult(text=str(text), raw=data)
