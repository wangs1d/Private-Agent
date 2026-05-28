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
    """
    从模型输出中解析单条动作 JSON。
    支持裸 JSON 或 ```json ... ``` 包裹。
    """
    raw = text.strip()
    fence = re.search(r"```(?:json)?\s*([\s\S]*?)\s*```", raw, re.IGNORECASE)
    if fence:
        raw = fence.group(1).strip()
    obj = json.loads(raw)
    if not isinstance(obj, dict):
        raise ValueError("动作必须是 JSON 对象")
    action = str(obj.get("action", "")).strip().lower()
    if not action:
        raise ValueError("缺少 action 字段")
    return DesktopAction(kind=action, payload=obj)


SYSTEM_PROMPT = """你是桌面 GUI 自动化助手，只能通过屏幕截图理解界面。
每次只输出**一条** JSON 对象，不要输出其它解释文字。字段如下：
- action: click | double_click | right_click | move | scroll | type | key | wait | done
- x, y: 整数像素坐标（相对当前截图分辨率；全屏截图即屏幕坐标）
- button: 可选，left|right|middle，默认 left
- clicks: 可选，默认 1
- move_duration_s: 可选，移动耗时秒数，默认 0
- scroll_clicks: scroll 时必填，整数，正上负下
- text: type 时必填，要输入的文本
- key: key 时必填，单键名，如 enter, tab, esc（pyautogui 键名）
- wait_s: wait 时可选，默认 0.5
- summary: done 时建议填写任务结论

示例：{"action":"click","x":512,"y":340}
"""
