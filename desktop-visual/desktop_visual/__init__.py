"""Desktop visual control helpers.

Sub-modules can be imported directly without triggering heavy dependencies:
    from desktop_visual.structured_output import ActionKind
    from desktop_visual.agent_history import AgentHistory
"""
from __future__ import annotations


def __getattr__(name: str):
    if name == "LoopConfig":
        from desktop_visual.visual_loop import LoopConfig
        return LoopConfig
    if name == "VisualDesktopLoop":
        from desktop_visual.visual_loop import VisualDesktopLoop
        return VisualDesktopLoop
    if name == "VisionLanguageModel":
        from desktop_visual.vlm.base import VisionLanguageModel
        return VisionLanguageModel
    if name == "VLMMessage":
        from desktop_visual.vlm.base import VLMMessage
        return VLMMessage
    if name == "VLMResult":
        from desktop_visual.vlm.base import VLMResult
        return VLMResult
    raise AttributeError(f"module 'desktop_visual' has no attribute {name!r}")


__all__ = [
    "VisualDesktopLoop",
    "LoopConfig",
    "VisionLanguageModel",
    "VLMMessage",
    "VLMResult",
]
