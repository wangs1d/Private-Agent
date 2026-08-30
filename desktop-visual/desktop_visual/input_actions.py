"""run_input 的纯逻辑：动作白名单、参数归一化、图像坐标→屏幕坐标换算。

不 import pyautogui / pynput / ctypes，可独立单元测试（tests/test_input_actions.py）。

动作空间对齐主流 computer-use agent（Anthropic computer tool / OpenAI CUA）：
- click / double_click / triple_click / middle_click / right_click / move
- type（非 ASCII 文本由执行层走剪贴板粘贴路径）
- key / shortcut / hold_key / wait / cursor_position
- scroll（支持目标坐标 + 横向）

坐标约定：全链路统一"屏幕物理像素"；若模型给出的是降采样截图上的像素坐标，
传 coordSpace="image" + imageWidth/imageHeight，由 map_image_point_to_screen
换算（仅对整屏截图有效，区域截图请直接用屏幕坐标）。
"""
from __future__ import annotations

RUN_INPUT_ACTIONS = (
    "click", "double_click", "triple_click", "middle_click", "right_click",
    "move", "type", "key", "shortcut", "drag", "scroll",
    "wait", "cursor_position", "hold_key",
)

# 需要 x, y 起点（或目标）坐标的动作
_ACTIONS_NEED_XY = frozenset({"click", "double_click", "triple_click", "middle_click", "right_click", "move", "drag"})
_ACTIONS_NEED_XY_AND_TO = frozenset({"drag"})

BUTTONS = ("left", "right", "middle")

MAX_WAIT_MS = 10_000
MAX_HOLD_SECONDS = 5.0
MAX_SHORTCUT_KEYS = 4

# 常见别名 → pyautogui KEYBOARD_KEYS 标准名（执行层再校验全集）
KEY_ALIASES: dict[str, str] = {
    "esc": "escape",
    "del": "delete",
    "return": "enter",
    "win": "winleft",
    "super": "winleft",
    "meta": "winleft",
    "cmd": "winleft",
    "command": "winleft",
    "ctl": "ctrl",
    "control": "ctrl",
    "option": "alt",
    "opt": "alt",
    "ins": "insert",
    "pgup": "pageup",
    "pgdn": "pagedown",
    "prtsc": "printscreen",
    "break": "pause",
}


class RunInputError(ValueError):
    """参数校验失败；message 面向 LLM 可读。"""


def resolve_action_name(req: dict) -> str | None:
    """从请求里取输入动作名：inputAction 优先（子进程/桥接报文），其次 action。

    顶层 action="run_input" 是外层动作名，不算输入动作。
    """
    action = req.get("inputAction") or req.get("action")
    if action is None:
        return None
    action = str(action).strip().lower()
    if action in ("", "run_input"):
        return None
    return action


def _as_number(value, field: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise RunInputError(f"{field} 必须是数字，收到 {value!r}")
    return float(value)


def _as_int(value, field: str) -> int:
    return int(round(_as_number(value, field)))


def normalize_key(key: str) -> str:
    """按键名归一化（别名展开 + 小写），不校验是否真实存在。"""
    lowered = key.strip().lower()
    return KEY_ALIASES.get(lowered, lowered)


def map_image_point_to_screen(
    x: float,
    y: float,
    image_width: float,
    image_height: float,
    monitor_rect: tuple[int, int, int, int],
) -> tuple[int, int]:
    """把整屏截图上的像素坐标换算为屏幕物理坐标。

    monitor_rect = (left, top, width, height)，为该显示器在虚拟屏幕中的矩形。
    """
    if image_width <= 0 or image_height <= 0:
        raise RunInputError(f"imageWidth/imageHeight 必须为正数，收到 {image_width}x{image_height}")
    scale_x = monitor_rect[2] / image_width
    scale_y = monitor_rect[3] / image_height
    return int(round(monitor_rect[0] + x * scale_x)), int(round(monitor_rect[1] + y * scale_y))


def normalize_run_input(req: dict, monitor_lookup) -> dict:
    """校验并归一化 run_input 请求，返回执行层可直接消费的字段 dict。

    monitor_lookup: callable(display: int | None) -> (left, top, width, height)，
    仅在 coordSpace="image" 时被调用。

    返回字段（按动作取子集）：
      action, x?, y?, toX?, toY?, button, text?, key?, keys?,
      scrollClicks?, scrollX?, waitMs?, holdSeconds?, interval, moveDuration
    坐标均已换算为屏幕物理像素（int）。
    """
    action = resolve_action_name(req)
    if action is None:
        raise RunInputError(f"缺少 inputAction，支持: {', '.join(RUN_INPUT_ACTIONS)}")
    if action not in RUN_INPUT_ACTIONS:
        raise RunInputError(f"未知 inputAction: {action!r}，支持: {', '.join(RUN_INPUT_ACTIONS)}")

    out: dict = {"action": action, "interval": 0.05, "moveDuration": 0.0}

    coord_space = str(req.get("coordSpace") or "screen").strip().lower()
    if coord_space not in ("screen", "image"):
        raise RunInputError(f"coordSpace 必须是 screen 或 image，收到 {coord_space!r}")

    def resolve_xy(raw_x, raw_y, field_prefix: str) -> tuple[int, int]:
        x = _as_number(raw_x, f"{field_prefix}x")
        y = _as_number(raw_y, f"{field_prefix}y")
        if coord_space == "image":
            image_width = req.get("imageWidth")
            image_height = req.get("imageHeight")
            if not isinstance(image_width, (int, float)) or not isinstance(image_height, (int, float)):
                raise RunInputError("coordSpace='image' 需要同时传 imageWidth 与 imageHeight（截图返回值）")
            display = req.get("display")
            display_int = int(display) if isinstance(display, (int, float)) else None
            return map_image_point_to_screen(x, y, image_width, image_height, monitor_lookup(display_int))
        return int(round(x)), int(round(y))

    if action in _ACTIONS_NEED_XY:
        if req.get("x") is None or req.get("y") is None:
            raise RunInputError(f"{action} 需要 x, y 坐标")
        x, y = resolve_xy(req.get("x"), req.get("y"), "")
        out["x"], out["y"] = x, y

    if action in _ACTIONS_NEED_XY_AND_TO:
        if req.get("toX") is None or req.get("toY") is None:
            raise RunInputError("drag 需要 toX, toY 终点坐标")
        to_x, to_y = resolve_xy(req.get("toX"), req.get("toY"), "to")
        out["toX"], out["toY"] = to_x, to_y

    button = str(req.get("button") or "").strip().lower()
    if action in ("right_click",):
        out["button"] = "right"
    elif action in ("middle_click",):
        out["button"] = "middle"
    elif button:
        if button not in BUTTONS:
            raise RunInputError(f"button 必须是 {', '.join(BUTTONS)} 之一，收到 {button!r}")
        out["button"] = button
    else:
        out["button"] = "left"

    if action == "type":
        text = req.get("text")
        if not isinstance(text, str) or not text:
            raise RunInputError("type 需要 text（非空字符串）")
        out["text"] = text

    if action in ("key", "hold_key"):
        key = req.get("key")
        if not isinstance(key, str) or not key.strip():
            raise RunInputError(f"{action} 需要 key 参数")
        out["key"] = normalize_key(key)
        if action == "hold_key":
            hold = req.get("holdSeconds")
            hold_s = _as_number(hold, "holdSeconds") if hold is not None else 0.5
            if not 0.05 <= hold_s <= MAX_HOLD_SECONDS:
                raise RunInputError(f"holdSeconds 需在 0.05-{MAX_HOLD_SECONDS}s 之间，收到 {hold_s}")
            out["holdSeconds"] = hold_s

    if action == "shortcut":
        keys = req.get("keys")
        if not isinstance(keys, str) or not keys.strip():
            raise RunInputError("shortcut 需要 keys 参数（如 'ctrl+v'）")
        parts = [normalize_key(p) for p in keys.split("+") if p.strip()]
        if not 1 <= len(parts) <= MAX_SHORTCUT_KEYS:
            raise RunInputError(f"shortcut 需要 1-{MAX_SHORTCUT_KEYS} 个键，收到 {keys!r}")
        out["keys"] = parts

    if action == "scroll":
        has_v = req.get("scrollClicks") is not None
        has_h = req.get("scrollX") is not None
        if not has_v and not has_h:
            raise RunInputError("scroll 需要 scrollClicks（垂直，正=上滚）或 scrollX（水平，正=右滚）")
        if has_v:
            out["scrollClicks"] = _as_int(req.get("scrollClicks"), "scrollClicks")
        if has_h:
            out["scrollX"] = _as_int(req.get("scrollX"), "scrollX")
        if req.get("x") is not None and req.get("y") is not None:
            x, y = resolve_xy(req.get("x"), req.get("y"), "")
            out["x"], out["y"] = x, y

    if action == "wait":
        wait_ms = req.get("waitMs")
        wait_s = req.get("waitS") or req.get("wait_s")
        if wait_ms is not None:
            out["waitMs"] = _as_int(wait_ms, "waitMs")
        elif wait_s is not None:
            out["waitMs"] = int(round(_as_number(wait_s, "waitS") * 1000))
        else:
            out["waitMs"] = 500
        if not 1 <= out["waitMs"] <= MAX_WAIT_MS:
            raise RunInputError(f"wait 需在 1-{MAX_WAIT_MS}ms 之间，收到 {out['waitMs']}")

    if action in ("click", "type", "key"):
        interval = req.get("interval")
        if interval is not None:
            out["interval"] = max(0.001, _as_number(interval, "interval"))
    if action in ("click", "move", "drag"):
        move_duration = req.get("moveDuration")
        if move_duration is not None:
            out["moveDuration"] = max(0.0, _as_number(move_duration, "moveDuration"))

    return out
