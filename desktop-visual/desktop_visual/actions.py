from __future__ import annotations

import json
import re
from dataclasses import dataclass
from typing import Any

from desktop_visual.structured_output import ActionKind, DesktopActionOutput


@dataclass
class DesktopAction:
    kind: str
    payload: dict[str, Any]


def _extract_json_object(raw: str) -> str:
    start = raw.find("{")
    end = raw.rfind("}")
    if start >= 0 and end > start:
        return raw[start : end + 1]
    return raw


def parse_action_json(text: str) -> DesktopAction:
    """Parse a single action JSON object from model output with 3-layer fallback."""
    raw = text.strip()
    fence = re.search(r"```(?:json)?\s*([\s\S]*?)\s*```", raw, re.IGNORECASE)
    if fence:
        raw = fence.group(1).strip()
    raw = _extract_json_object(raw)
    try:
        obj = json.loads(raw)
    except json.JSONDecodeError:
        repaired = re.sub(r"(\{|,)\s*([A-Za-z_][A-Za-z0-9_]*)\s*:", r'\1 "\2":', raw)
        obj = json.loads(repaired)
    if not isinstance(obj, dict):
        raise ValueError("action must be a JSON object")
    action = str(obj.get("action", "")).strip().lower()
    if not action:
        raise ValueError("missing action field")
    return DesktopAction(kind=action, payload=obj)


def validate_action_output(text: str) -> DesktopActionOutput:
    """Parse model output through Pydantic validation for structured guarantees."""
    raw = text.strip()
    fence = re.search(r"```(?:json)?\s*([\s\S]*?)\s*```", raw, re.IGNORECASE)
    if fence:
        raw = fence.group(1).strip()
    raw = _extract_json_object(raw)

    try:
        obj = json.loads(raw)
    except json.JSONDecodeError:
        repaired = re.sub(r"(\{|,)\s*([A-Za-z_][A-Za-z0-9_]*)\s*:", r'\1 "\2":', raw)
        obj = json.loads(repaired)

    return DesktopActionOutput.model_validate(obj)


BUILTIN_ACTION_SCHEMA = """Allowed actions:
  click: Click at (x,y). Requires x, y. Optional: button (left/right/middle), clicks (1-3).
    Example: {"action":"click","x":512,"y":340,"reasoning":"Clicking the Start button"}
  double_click: Double click at (x,y). Requires x, y.
    Example: {"action":"double_click","x":200,"y":150,"reasoning":"Opening the file"}
  right_click: Right click at (x,y). Requires x, y.
    Example: {"action":"right_click","x":300,"y":400,"reasoning":"Opening context menu"}
  move: Move mouse to (x,y). Requires x, y. Optional: move_duration_s (0-5s).
    Example: {"action":"move","x":500,"y":300,"move_duration_s":0.5,"reasoning":"Moving to target"}
  scroll: Scroll mouse wheel. Requires scroll_clicks (positive=up, negative=down).
    Example: {"action":"scroll","scroll_clicks":-3,"reasoning":"Scrolling down to find more content"}
  type: Type text at current cursor. Requires text.
    Example: {"action":"type","text":"Hello World","reasoning":"Typing the search query"}
  key: Press a keyboard key. Requires key (enter, tab, esc, backspace, etc.).
    Example: {"action":"key","key":"enter","reasoning":"Submitting the form"}
  wait: Pause execution. Optional: wait_s (default 0.5, max 30).
    Example: {"action":"wait","wait_s":2.0,"reasoning":"Waiting for page to load"}
  done: Task completed. Requires summary. This action ends the loop.
    Example: {"action":"done","summary":"Successfully opened Notepad and typed the message"}
"""

DELUXE_SYSTEM_PROMPT = f"""You are a precise desktop GUI automation assistant. You control the mouse and keyboard.

{ BUILTIN_ACTION_SCHEMA }

CRITICAL RULES:
1. Return EXACTLY one JSON object per response with no surrounding text.
2. Always include a "reasoning" field explaining WHY you chose this action in 1-2 sentences.
3. Look carefully at the EXACT pixel positions of UI elements before clicking.
4. If you are unsure about a click target, use move to check the cursor position first.
5. When a task is complete, use the "done" action with a descriptive summary.
6. If the screen appears unchanged after 2-3 clicks, try a DIFFERENT approach.
7. When you see the PREVIOUS STEPS history, use it to avoid repeating failed actions.
8. When you see WARNING: You appear to be stuck, you MUST try a completely different strategy.
9. After clicking elements that trigger loading, use wait(1-2s) before the next action.
10. For Chinese text input, first click the input field, then use type with the Chinese characters.
"""


SYSTEM_PROMPT = """You are a desktop GUI automation assistant.
You may only reason from the provided screenshot.
Return exactly one JSON object and nothing else.

Allowed schema:
- action: click | double_click | right_click | move | scroll | type | key | wait | done
- x, y: integer pixel coordinates relative to the screenshot
- button: optional, left|right|middle, default left
- clicks: optional integer, default 1
- move_duration_s: optional float seconds, default 0
- scroll_clicks: required for scroll, positive=up negative=down
- text: required for type
- key: required for key, for example enter, tab, esc
- wait_s: optional float seconds for wait, default 0.5
- summary: recommended for done

Example:
{"action":"click","x":512,"y":340}
"""
