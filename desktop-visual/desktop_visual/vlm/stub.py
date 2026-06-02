from __future__ import annotations

from typing import Any

from desktop_visual.vlm.base import VLMMessage, VLMResult, VisionLanguageModel


class StubVLM(VisionLanguageModel):
    """Offline stub VLM for local testing."""

    def __init__(self, reply_json: str | None = None) -> None:
        self._reply = reply_json or '{"action":"done","summary":"offline_mode"}'

    async def complete(self, messages: list[VLMMessage], **kwargs: Any) -> VLMResult:
        _ = messages, kwargs
        return VLMResult(text=self._reply, raw={"mode": "offline"})
