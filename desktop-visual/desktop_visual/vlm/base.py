from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any


@dataclass(frozen=True)
class VLMImage:
    """单张屏幕截图：PNG bytes 或 base64 文本（无 data URL 前缀）。"""

    mime_type: str = "image/png"
    data: bytes | None = None
    base64: str | None = None

    def __post_init__(self) -> None:
        if (self.data is None) == (self.base64 is None):
            raise ValueError("VLMImage 必须且仅能设置 data 或 base64 之一")


@dataclass
class VLMMessage:
    role: str
    text: str | None = None
    images: list[VLMImage] = field(default_factory=list)


@dataclass
class VLMResult:
    text: str
    raw: dict[str, Any] | None = None


class VisionLanguageModel(ABC):
    """视觉语言模型抽象接口：多模态入参、文本出参。"""

    @abstractmethod
    async def complete(self, messages: list[VLMMessage], **kwargs: Any) -> VLMResult:
        """完成一轮 VLM 推理（可由实现映射到 OpenAI / Anthropic / 本地 ollama 等）。"""
