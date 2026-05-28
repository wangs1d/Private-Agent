"""纯视觉桌面操控：VLM 抽象接口 + pyautogui / pynput 混合执行。"""

from desktop_visual_agent.agent_loop import VisualDesktopLoop, LoopConfig
from desktop_visual_agent.vlm.base import VisionLanguageModel, VLMMessage, VLMResult

__all__ = [
    "VisualDesktopLoop",
    "LoopConfig",
    "VisionLanguageModel",
    "VLMMessage",
    "VLMResult",
]
