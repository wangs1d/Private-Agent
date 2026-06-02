from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any


@dataclass(frozen=True)
class VLMImage:
    """One screenshot image, provided as PNG bytes or base64."""

    mime_type: str = "image/png"
    data: bytes | None = None
    base64: str | None = None

    def __post_init__(self) -> None:
        if (self.data is None) == (self.base64 is None):
            raise ValueError("VLMImage must set exactly one of data or base64")


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
    """Abstract vision-language model interface."""

    @abstractmethod
    async def complete(self, messages: list[VLMMessage], **kwargs: Any) -> VLMResult:
        """Run one multimodal completion."""
