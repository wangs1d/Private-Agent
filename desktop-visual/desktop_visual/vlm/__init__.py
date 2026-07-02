"""VLM providers.

Sub-modules can be imported directly:
    from desktop_visual.vlm.base import VisionLanguageModel, VLMImage, VLMMessage, VLMResult
    from desktop_visual.vlm.stub import StubVLM
"""
from __future__ import annotations

from desktop_visual.vlm.base import VisionLanguageModel, VLMMessage, VLMResult, VLMImage


def __getattr__(name: str):
    if name == "OpenAICompatibleVLM":
        from desktop_visual.vlm.openai_compatible import OpenAICompatibleVLM
        return OpenAICompatibleVLM
    if name == "StubVLM":
        from desktop_visual.vlm.stub import StubVLM
        return StubVLM
    raise AttributeError(f"module 'desktop_visual.vlm' has no attribute {name!r}")


__all__ = [
    "VisionLanguageModel",
    "VLMMessage",
    "VLMResult",
    "VLMImage",
    "OpenAICompatibleVLM",
    "StubVLM",
]
