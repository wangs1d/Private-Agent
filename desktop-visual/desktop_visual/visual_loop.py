from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable, Optional

from desktop_visual.actions import DELUXE_SYSTEM_PROMPT, SYSTEM_PROMPT, parse_action_json, validate_action_output
from desktop_visual.agent_history import AgentHistory
from desktop_visual.runtime.capture import grab_screen_png
from desktop_visual.runtime.mouse_controller import HybridPointer
from desktop_visual.structured_output import ActionKind, LoopResult
from desktop_visual.vlm.base import VLMImage, VLMMessage, VLMResult, VisionLanguageModel

logger = logging.getLogger(__name__)


@dataclass
class LoopConfig:
    max_steps: int = 40
    task: str = ""
    region: tuple[int, int, int, int] | None = None
    use_history: bool = True
    history_steps: int = 3
    include_screenshots_in_history: bool = True
    deluxe_prompt: bool = False
    ocr_context: Optional[str] = None
    max_vlm_retries: int = 2
    vlm_retry_delay_s: float = 1.0


@dataclass
class LoopState:
    _history: AgentHistory = field(default_factory=AgentHistory)
    _consecutive_parse_failures: int = 0

    @property
    def history(self) -> AgentHistory:
        return self._history

    def record_parse_failure(self) -> None:
        self._consecutive_parse_failures += 1

    def reset_parse_failures(self) -> None:
        self._consecutive_parse_failures = 0

    @property
    def should_abort(self) -> bool:
        return self._consecutive_parse_failures >= 5


class VisualDesktopLoop:
    """Screenshot -> VLM -> action -> execute loop.

    v2 improvements (inspired by browser-use):
    - AgentHistory with screenshot context for multi-step reasoning
    - VLM retry with exponential-ish backoff on transient errors
    - Stuck detection via action pattern analysis
    - OCR context injection for better element targeting
    - Pydantic structured output validation (optional)
    - Enhanced DELUXE_SYSTEM_PROMPT with reasoning guidance
    """

    def __init__(
        self,
        vlm: VisionLanguageModel,
        *,
        pointer: HybridPointer | None = None,
        on_step: Callable[[dict[str, Any]], Awaitable[None] | None] | None = None,
    ) -> None:
        self._vlm = vlm
        self._pointer = pointer or HybridPointer(fail_safe=True)
        self._on_step = on_step

    async def run(self, cfg: LoopConfig) -> dict[str, Any]:
        if not cfg.task.strip():
            raise ValueError("cfg.task must not be empty")

        state = LoopState()

        if cfg.use_history:
            state.history.max_history_steps = cfg.history_steps
            state.history.include_screenshots = cfg.include_screenshots_in_history

        system_prompt = DELUXE_SYSTEM_PROMPT if cfg.deluxe_prompt else SYSTEM_PROMPT

        for step in range(cfg.max_steps):
            png, (width, height) = grab_screen_png(cfg.region)

            if cfg.use_history and state.history.step_count > 0:
                messages = state.history.build_context_messages(
                    system_prompt=system_prompt,
                    task=cfg.task,
                    current_screenshot=png,
                    screenshot_size=(width, height),
                    ocr_text=cfg.ocr_context,
                )
            else:
                user_text = (
                    f"Task: {cfg.task}\n"
                    f"Screenshot size: {width}x{height} pixels.\n"
                    "Decide the next UI action and return exactly one JSON object."
                )
                if cfg.ocr_context:
                    user_text += f"\n\n--- OCR Text on Screen ---\n{cfg.ocr_context}"
                messages = [
                    VLMMessage(role="system", text=system_prompt),
                    VLMMessage(role="user", text=user_text, images=[VLMImage(data=png)]),
                ]

            result = await self._vlm_complete_with_retry(messages, cfg)

            try:
                action = parse_action_json(result.text)
                state.reset_parse_failures()
            except Exception as exc:
                state.record_parse_failure()
                history_note = f"Parse failed: {exc}; raw: {result.text[:200]!r}"
                logger.warning("Step %d: %s", step, history_note)
                if cfg.use_history:
                    state.history.record(
                        action_kind=ActionKind.WAIT,
                        action_payload={},
                        note=history_note,
                        screenshot_png=png,
                        screenshot_size=(width, height),
                        success=False,
                    )
                if state.should_abort:
                    return {"ok": False, "error": f"Too many consecutive parse failures ({state._consecutive_parse_failures})", "steps": step + 1}
                continue

            try:
                action_kind = ActionKind(action.kind)
            except ValueError:
                logger.warning("Step %d: unknown action kind '%s'", step, action.kind)
                history_note = f"Unknown action: {action.kind!r}"
                if cfg.use_history:
                    state.history.record(
                        action_kind=ActionKind.WAIT,
                        action_payload=action.payload,
                        note=history_note,
                        screenshot_png=png,
                        screenshot_size=(width, height),
                        success=False,
                    )
                continue

            payload = {"step": step, "action": action.kind, "raw": action.payload}
            if self._on_step:
                maybe = self._on_step(payload)
                if asyncio.iscoroutine(maybe):
                    await maybe

            done, history_note = await self._execute(action.kind, action.payload)

            if cfg.use_history:
                state.history.record(
                    action_kind=action_kind,
                    action_payload=action.payload,
                    note=history_note,
                    screenshot_png=png,
                    screenshot_size=(width, height),
                    success=True,
                    vlm_raw_response=result.text,
                )

            if state.history.is_stuck():
                logger.warning("Step %d: stuck detected, VLM will be warned in next prompt", step)

            if done:
                return {"ok": True, "steps": step + 1, "summary": history_note}

        return {"ok": False, "error": "max_steps reached before done", "steps": cfg.max_steps}

    async def _vlm_complete_with_retry(
        self,
        messages: list[VLMMessage],
        cfg: LoopConfig,
    ) -> VLMResult:
        last_exception: Optional[Exception] = None
        for attempt in range(cfg.max_vlm_retries + 1):
            try:
                return await self._vlm.complete(messages)
            except Exception as exc:
                last_exception = exc
                msg = str(exc)[:200]
                logger.warning("VLM attempt %d/%d failed: %s", attempt + 1, cfg.max_vlm_retries + 1, msg)
                if attempt < cfg.max_vlm_retries:
                    delay = cfg.vlm_retry_delay_s * (2 ** attempt)
                    await asyncio.sleep(delay)
        raise RuntimeError(f"VLM failed after {cfg.max_vlm_retries + 1} attempts") from last_exception

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
