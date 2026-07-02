from __future__ import annotations

from dataclasses import dataclass, field
from typing import Optional

from desktop_visual.structured_output import ActionKind, StepResult
from desktop_visual.vlm.base import VLMImage, VLMMessage


@dataclass
class StepRecord:
    step: int
    action_kind: ActionKind
    action_payload: dict
    note: str
    screenshot_png: bytes | None = None
    screenshot_size: tuple[int, int] = (0, 0)
    success: bool = True
    vlm_raw_response: str | None = None


@dataclass
class AgentHistory:
    max_history_steps: int = 3
    include_screenshots: bool = True
    _steps: list[StepRecord] = field(default_factory=list)

    def record(
        self,
        action_kind: ActionKind,
        action_payload: dict,
        note: str,
        *,
        screenshot_png: bytes | None = None,
        screenshot_size: tuple[int, int] | None = None,
        success: bool = True,
        vlm_raw_response: str | None = None,
    ) -> None:
        step_no = len(self._steps) + 1
        self._steps.append(StepRecord(
            step=step_no,
            action_kind=action_kind,
            action_payload=action_payload,
            note=note,
            screenshot_png=screenshot_png,
            screenshot_size=screenshot_size or (0, 0),
            success=success,
            vlm_raw_response=vlm_raw_response,
        ))

    @property
    def step_count(self) -> int:
        return len(self._steps)

    def is_stuck(self, threshold: int = 3) -> bool:
        if len(self._steps) < threshold:
            return False
        recent = self._steps[-threshold:]
        actions = [s.action_kind for s in recent]
        if len(set(actions)) == 1 and actions[0] == ActionKind.WAIT:
            return True
        click_positions = [
            (s.action_payload.get("x"), s.action_payload.get("y"))
            for s in recent
            if s.action_kind in (ActionKind.CLICK, ActionKind.DOUBLE_CLICK)
        ]
        if len(click_positions) >= threshold and len(set(click_positions)) == 1:
            return True
        return False

    def build_context_messages(
        self,
        system_prompt: str,
        task: str,
        current_screenshot: bytes,
        screenshot_size: tuple[int, int],
        ocr_text: str | None = None,
    ) -> list[VLMMessage]:
        messages: list[VLMMessage] = [VLMMessage(role="system", text=system_prompt)]

        history_parts: list[str] = [f"Task: {task}"]
        history_parts.append(f"Current screenshot size: {screenshot_size[0]}x{screenshot_size[1]} pixels.")

        recent_steps = self._steps[-self.max_history_steps:] if self.max_history_steps > 0 else []

        if recent_steps:
            history_parts.append(f"\n--- Previous {len(recent_steps)} Step(s) ---")
            for s in recent_steps:
                status = "OK" if s.success else "FAILED"
                history_parts.append(f"  Step {s.step}: {s.action_kind.value} → {s.note} [{status}]")

        if self.is_stuck():
            history_parts.append(
                "\nWARNING: You appear to be stuck. The last few actions were repetitive and did not "
                "make progress. Try a DIFFERENT approach or strategy. Consider:\n"
                "- Are you clicking the same area repeatedly? Try a different position.\n"
                "- Did you scroll enough? The target might be off-screen.\n"
                "- Should you wait for a page/animation to finish?"
            )

        if ocr_text:
            history_parts.append(f"\n--- OCR Text on Screen ---\n{ocr_text}")

        history_parts.append("\nDecide the next UI action. Return exactly one valid JSON object.")

        user_text = "\n".join(history_parts)

        images: list[VLMImage] = [VLMImage(data=current_screenshot)]

        if self.include_screenshots and recent_steps:
            prev_steps_with_screenshots = [s for s in recent_steps if s.screenshot_png]
            for s in prev_steps_with_screenshots[-1:]:
                images.append(VLMImage(data=s.screenshot_png))

        messages.append(VLMMessage(role="user", text=user_text, images=images))
        return messages

    def to_step_results(self) -> list[StepResult]:
        return [
            StepResult(
                step=s.step,
                action=s.action_kind,
                success=s.success,
                note=s.note,
                screenshot_size=s.screenshot_size,
            )
            for s in self._steps
        ]
