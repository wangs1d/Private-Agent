from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass
from typing import Any, Awaitable, Callable

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
    """Screenshot -> VLM -> action -> execute loop."""

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
            raise ValueError("cfg.task must not be empty")

        history_note = ""
        for step in range(cfg.max_steps):
            png, (width, height) = grab_screen_png(cfg.region)
            user_text = (
                f"Task: {cfg.task}\n"
                f"Screenshot size: {width}x{height} pixels.\n"
                f"Previous step feedback: {history_note or '(first step)'}\n"
                "Decide the next UI action and return exactly one JSON object."
            )
            messages = [
                VLMMessage(role="system", text=SYSTEM_PROMPT),
                VLMMessage(role="user", text=user_text, images=[VLMImage(data=png)]),
            ]
            result = await self._vlm.complete(messages)
            try:
                action = parse_action_json(result.text)
            except Exception as exc:
                history_note = (
                    f"Action parse failed: {exc}; first 200 chars: {result.text[:200]!r}"
                )
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

        return {"ok": False, "error": "max_steps reached before done", "steps": cfg.max_steps}

    async def _execute(self, kind: str, payload: dict[str, Any]) -> tuple[bool, str]:
        def xy() -> tuple[int, int]:
            return int(payload.get("x", 0)), int(payload.get("y", 0))

        if kind == "move":
            x, y = xy()
            duration_s = float(payload.get("move_duration_s", 0) or 0)
            self._pointer.move(x, y, duration_s=duration_s)
            return False, f"move ({x},{y})"

        if kind == "click":
            x, y = xy()
            button = str(payload.get("button", "left"))
            clicks = int(payload.get("clicks", 1) or 1)
            self._pointer.click(x, y, button=button, clicks=clicks)  # type: ignore[arg-type]
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
            clicks = int(payload.get("scroll_clicks", 0))
            self._pointer.scroll(clicks)
            return False, f"scroll {clicks}"

        if kind == "type":
            text = str(payload.get("text", ""))
            self._pointer.type_text(text)
            return False, f"type len={len(text)}"

        if kind == "key":
            key = str(payload.get("key", "")).strip()
            if key:
                self._pointer.key_tap(key)
            return False, f"key {key!r}"

        if kind == "wait":
            wait_s = float(payload.get("wait_s", 0.5) or 0.5)
            await asyncio.sleep(max(0.0, wait_s))
            return False, f"wait {wait_s}s"

        if kind == "done":
            summary = str(payload.get("summary", ""))
            return True, summary

        return False, f"unknown action {kind!r}; skipped"
