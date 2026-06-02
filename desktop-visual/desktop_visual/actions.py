from __future__ import annotations

import json
import re
from dataclasses import dataclass
from typing import Any


@dataclass
class DesktopAction:
    kind: str
    payload: dict[str, Any]


def parse_action_json(text: str) -> DesktopAction:
    """Parse a single action JSON object from model output."""
    raw = text.strip()
    fence = re.search(r"```(?:json)?\s*([\s\S]*?)\s*```", raw, re.IGNORECASE)
    if fence:
        raw = fence.group(1).strip()
    obj = json.loads(raw)
    if not isinstance(obj, dict):
        raise ValueError("action must be a JSON object")
    action = str(obj.get("action", "")).strip().lower()
    if not action:
        raise ValueError("missing action field")
    return DesktopAction(kind=action, payload=obj)


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
