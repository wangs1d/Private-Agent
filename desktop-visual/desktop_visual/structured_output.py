from __future__ import annotations

from enum import Enum
from typing import Optional, Literal

from pydantic import BaseModel, Field, model_validator


class ActionKind(str, Enum):
    CLICK = "click"
    DOUBLE_CLICK = "double_click"
    RIGHT_CLICK = "right_click"
    MOVE = "move"
    SCROLL = "scroll"
    TYPE = "type"
    KEY = "key"
    WAIT = "wait"
    DONE = "done"


class ClickButton(str, Enum):
    LEFT = "left"
    RIGHT = "right"
    MIDDLE = "middle"


class DesktopActionOutput(BaseModel):
    action: ActionKind = Field(..., description="The action to perform")
    x: Optional[int] = Field(None, description="X pixel coordinate relative to the screenshot")
    y: Optional[int] = Field(None, description="Y pixel coordinate relative to the screenshot")
    button: ClickButton = Field(ClickButton.LEFT, description="Mouse button for click actions")
    clicks: int = Field(1, ge=1, le=3, description="Number of clicks")
    move_duration_s: float = Field(0.0, ge=0.0, le=5.0, description="Move duration in seconds")
    scroll_clicks: Optional[int] = Field(None, description="Scroll amount: positive=up, negative=down")
    text: Optional[str] = Field(None, description="Text to type")
    key: Optional[str] = Field(None, description="Key to press: enter, tab, esc, etc.")
    wait_s: float = Field(0.5, ge=0.0, le=30.0, description="Wait duration in seconds")
    summary: Optional[str] = Field(None, description="Task completion summary, required for done")
    reasoning: Optional[str] = Field(None, description="Brief reasoning for this action (1-2 sentences)")

    @model_validator(mode="after")
    def validate_coordinates(self) -> "DesktopActionOutput":
        actions_needing_coords = {ActionKind.CLICK, ActionKind.DOUBLE_CLICK, ActionKind.RIGHT_CLICK, ActionKind.MOVE}
        if self.action in actions_needing_coords:
            if self.x is None or self.y is None:
                raise ValueError(f"Action '{self.action.value}' requires x and y coordinates")
        return self


class LoopResult(BaseModel):
    ok: bool
    steps: int
    summary: Optional[str] = Field(None, description="Task completion summary")
    error: Optional[str] = Field(None, description="Error message if failed")


class StepResult(BaseModel):
    step: int
    action: ActionKind
    success: bool
    note: str
    screenshot_size: Optional[tuple[int, int]] = None


class OCRContext(BaseModel):
    text: str
    lines: list[dict] = Field(default_factory=list, description="OCR text lines with position info")
    width: int = 0
    height: int = 0
