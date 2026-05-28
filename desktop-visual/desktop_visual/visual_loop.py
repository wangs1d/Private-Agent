from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass
from typing import Any, Callable, Awaitable

from desktop_visual.actions import SYSTEM_PROMPT, parse_action_json
from desktop_visual.runtime.capture import grab_screen_png
from desktop_visual.runtime.mouse_controller import HybridPointer
from desktop_visual.vlm.base import VLMImage, VLMMessage, VisionLanguageModel

logger = logging.getLogger(__name__)


@dataclass
class LoopConfig:
    max_steps: int = 40
    task: str = ""
    region: tuple[int, int, int, int] | None = None


class VisualDesktopLoop:
    """
    纯视觉闭环：截屏 �?VLM �?解析 JSON 动作 �?pyautogui/pynput 执行 �?下一步�?
    """

    def __init__(
        self,
        vlm: VisionLanguageModel,
        *,
        pointer: HybridPointer | None = None,
        on_step: Callable[[dict[str, Any]], Awaitable[None] | None] | None = None,
    ) -> None:
        self._vlm = vlm
        self._pointer = pointer or HybridPointer()
        self._on_step = on_step

    async def run(self, cfg: LoopConfig) -> dict[str, Any]:
        if not cfg.task.strip():
            raise ValueError("cfg.task 不能为空")

        history_note = ""
        for step in range(cfg.max_steps):
            png, (w, h) = grab_screen_png(cfg.region)
            user_text = (
                f"任务：{cfg.task}\n"
                f"当前截图尺寸：{w}x{h} 像素。\n"
                f"上一步执行反馈：{history_note or '（首轮无�?}\n"
                "根据截图决定下一步动作，输出一�?JSON�?
            )
            messages = [
                VLMMessage(role="system", text=SYSTEM_PROMPT),
                VLMMessage(role="user", text=user_text, images=[VLMImage(data=png)]),
            ]
            result = await self._vlm.complete(messages)
            try:
                action = parse_action_json(result.text)
            except Exception as e:
                history_note = f"解析动作失败：{e}；模型原文前 200 字：{result.text[:200]!r}"
                logger.warning(history_note)
                continue

            payload = {"step": step, "action": action.kind, "raw": action.payload}
            if self._on_step:
                maybe = self._on_step(payload)
                if asyncio.iscoroutine(maybe):
                    await maybe

            done, history_note = await self._execute(action.kind, action.payload)
            if done:
                return {"ok": True, "steps": step + 1, "summary": history_note}

        return {"ok": False, "error": "达到 max_steps 仍未 done", "steps": cfg.max_steps}

    async def _execute(self, kind: str, p: dict[str, Any]) -> tuple[bool, str]:
        def xy() -> tuple[int, int]:
            return int(p.get("x", 0)), int(p.get("y", 0))

        if kind == "move":
            x, y = xy()
            dur = float(p.get("move_duration_s", 0) or 0)
            self._pointer.move(x, y, duration_s=dur)
            return False, f"move ({x},{y})"

        if kind == "click":
            x, y = xy()
            btn = str(p.get("button", "left"))
            clicks = int(p.get("clicks", 1) or 1)
            self._pointer.click(x, y, button=btn, clicks=clicks)  # type: ignore[arg-type]
            return False, f"click ({x},{y}) x{clicks}"

        if kind == "double_click":
            x, y = xy()
            self._pointer.click(x, y, clicks=2)
            return False, f"double_click ({x},{y})"

        if kind == "right_click":
            x, y = xy()
            self._pointer.click(x, y, button="right", clicks=1)
            return False, f"right_click ({x},{y})"

        if kind == "scroll":
            n = int(p.get("scroll_clicks", 0))
            self._pointer.scroll(n)
            return False, f"scroll {n}"

        if kind == "type":
            text = str(p.get("text", ""))
            self._pointer.type_text(text)
            return False, f"type len={len(text)}"

        if kind == "key":
            key = str(p.get("key", "")).strip()
            if key:
                self._pointer.key_tap(key)
            return False, f"key {key!r}"

        if kind == "wait":
            s = float(p.get("wait_s", 0.5) or 0.5)
            await asyncio.sleep(max(0.0, s))
            return False, f"wait {s}s"

        if kind == "done":
            summary = str(p.get("summary", ""))
            return True, summary

        return False, f"未知 action：{kind!r}，已跳过"
