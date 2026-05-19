from __future__ import annotations

from typing import Any

from desktop_visual_agent.vlm.base import VLMMessage, VLMResult, VisionLanguageModel


class StubVLM(VisionLanguageModel):
    """离线模式下的模拟实现，返回固定响应（用于本地调试）。"""

    def __init__(self, reply_json: str | None = None) -> None:
        self._reply = reply_json or '{"action":"done","summary":"offline_mode"}'

    async def complete(self, messages: list[VLMMessage], **kwargs: Any) -> VLMResult:
        _ = messages, kwargs
        return VLMResult(text=self._reply, raw={"mode": "offline"})
