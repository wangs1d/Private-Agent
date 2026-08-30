"""纯逻辑单元测试：不依赖真实桌面 / pyautogui / pywinauto。

运行：cd desktop-visual && py -3.12 -m pytest tests -q
"""
from __future__ import annotations

import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from desktop_visual.actions import parse_action_json, validate_action_output
from desktop_visual.bridge_actions import (
    ACTION_FIELD_ALLOWLIST,
    UnknownBridgeAction,
    build_worker_request,
)
from desktop_visual.input_actions import (
    KEY_ALIASES,
    RunInputError,
    map_image_point_to_screen,
    normalize_key,
    normalize_run_input,
)
from desktop_visual.structured_output import DesktopActionOutput

MONITOR = (0, 0, 2880, 1800)


def lookup(_display):
    return MONITOR


# ─── bridge_actions ────────────────────────────────────────────────────────


class TestBuildWorkerRequest:
    def test_known_actions_all_registered(self):
        # stdio_worker._run 支持的全部 action 必须在白名单里
        expected = {
            "screenshot", "open", "uia_query", "run_shell", "show_message",
            "run_input", "run_automation", "window", "clipboard",
            "http_get", "web_search", "web_fetch", "run_task",
        }
        assert expected <= set(ACTION_FIELD_ALLOWLIST)

    def test_field_allowlist_filters_unknown_fields(self):
        req = build_worker_request({
            "action": "run_shell",
            "command": "dir",
            "shell": "cmd",
            "evil_injected_field": "x",
        })
        assert req == {"action": "run_shell", "command": "dir", "shell": "cmd"}

    def test_none_fields_are_dropped(self):
        req = build_worker_request({"action": "open", "target": "app", "path": "notepad", "cwd": None})
        assert req == {"action": "open", "target": "app", "path": "notepad"}

    def test_unknown_action_raises(self):
        with pytest.raises(UnknownBridgeAction):
            build_worker_request({"action": "rm_rf_everything"})

    def test_run_automation_uses_action_name(self):
        req = build_worker_request({"action": "run_automation", "action_name": "click", "selector": {"name": "OK"}})
        assert req["action_name"] == "click"
        assert req["action"] == "run_automation"

    def test_run_input_uses_input_action(self):
        req = build_worker_request({"action": "run_input", "inputAction": "triple_click", "x": 1, "y": 2})
        assert req["inputAction"] == "triple_click"


# ─── input_actions ─────────────────────────────────────────────────────────


class TestNormalizeRunInput:
    def test_click_defaults(self):
        n = normalize_run_input({"inputAction": "click", "x": 100, "y": 200}, lookup)
        assert n["action"] == "click"
        assert (n["x"], n["y"]) == (100, 200)
        assert n["button"] == "left"

    def test_action_alias_from_action_field(self):
        n = normalize_run_input({"action": "cursor_position"}, lookup)
        assert n["action"] == "cursor_position"

    def test_top_level_run_input_is_not_input_action(self):
        with pytest.raises(RunInputError):
            normalize_run_input({"action": "run_input"}, lookup)

    def test_click_variants(self):
        assert normalize_run_input({"inputAction": "triple_click", "x": 0, "y": 0}, lookup)["button"] == "left"
        assert normalize_run_input({"inputAction": "right_click", "x": 0, "y": 0}, lookup)["button"] == "right"
        assert normalize_run_input({"inputAction": "middle_click", "x": 0, "y": 0}, lookup)["button"] == "middle"
        assert normalize_run_input(
            {"inputAction": "click", "x": 0, "y": 0, "button": "middle"}, lookup
        )["button"] == "middle"

    def test_click_requires_xy(self):
        with pytest.raises(RunInputError):
            normalize_run_input({"inputAction": "click"}, lookup)

    def test_bad_button_rejected(self):
        with pytest.raises(RunInputError):
            normalize_run_input({"inputAction": "click", "x": 0, "y": 0, "button": "both"}, lookup)

    def test_drag_needs_to_xy(self):
        with pytest.raises(RunInputError):
            normalize_run_input({"inputAction": "drag", "x": 0, "y": 0}, lookup)
        n = normalize_run_input({"inputAction": "drag", "x": 1, "y": 2, "toX": 3, "toY": 4}, lookup)
        assert (n["toX"], n["toY"]) == (3, 4)

    def test_type_accepts_unicode(self):
        n = normalize_run_input({"inputAction": "type", "text": "你好 world 🌏"}, lookup)
        assert n["text"] == "你好 world 🌏"

    def test_type_empty_rejected(self):
        with pytest.raises(RunInputError):
            normalize_run_input({"inputAction": "type", "text": ""}, lookup)

    def test_wait_units(self):
        assert normalize_run_input({"inputAction": "wait"}, lookup)["waitMs"] == 500
        assert normalize_run_input({"inputAction": "wait", "waitS": 2}, lookup)["waitMs"] == 2000
        assert normalize_run_input({"inputAction": "wait", "waitMs": 150}, lookup)["waitMs"] == 150

    def test_wait_upper_bound(self):
        with pytest.raises(RunInputError):
            normalize_run_input({"inputAction": "wait", "waitMs": 60000}, lookup)

    def test_hold_key_bounds(self):
        with pytest.raises(RunInputError):
            normalize_run_input({"inputAction": "hold_key", "key": "ctrl", "holdSeconds": 30}, lookup)
        n = normalize_run_input({"inputAction": "hold_key", "key": "ctrl", "holdSeconds": 1.5}, lookup)
        assert n["holdSeconds"] == 1.5

    def test_key_aliases_normalized(self):
        assert normalize_run_input({"inputAction": "key", "key": "esc"}, lookup)["key"] == "escape"
        assert normalize_run_input({"inputAction": "key", "key": "Return"}, lookup)["key"] == "enter"
        assert normalize_run_input({"inputAction": "key", "key": "F5"}, lookup)["key"] == "f5"

    def test_shortcut_parsing(self):
        n = normalize_run_input({"inputAction": "shortcut", "keys": "Ctrl+Shift+T"}, lookup)
        assert n["keys"] == ["ctrl", "shift", "t"]

    def test_scroll_vertical_and_horizontal(self):
        n = normalize_run_input({"inputAction": "scroll", "scrollClicks": -3}, lookup)
        assert n["scrollClicks"] == -3
        n = normalize_run_input({"inputAction": "scroll", "scrollX": 2}, lookup)
        assert n["scrollX"] == 2
        n = normalize_run_input({"inputAction": "scroll", "scrollClicks": -1, "x": 5, "y": 6}, lookup)
        assert (n["x"], n["y"]) == (5, 6)

    def test_scroll_requires_amount(self):
        with pytest.raises(RunInputError):
            normalize_run_input({"inputAction": "scroll"}, lookup)

    def test_image_coord_mapping(self):
        n = normalize_run_input(
            {
                "inputAction": "click",
                "x": 480, "y": 300,
                "coordSpace": "image",
                "imageWidth": 960, "imageHeight": 600,
            },
            lookup,
        )
        assert (n["x"], n["y"]) == (1440, 900)

    def test_image_coord_requires_dimensions(self):
        with pytest.raises(RunInputError):
            normalize_run_input({"inputAction": "click", "x": 1, "y": 1, "coordSpace": "image"}, lookup)

    def test_bad_coord_space_rejected(self):
        with pytest.raises(RunInputError):
            normalize_run_input({"inputAction": "move", "x": 1, "y": 1, "coordSpace": "pixel"}, lookup)

    def test_unknown_action_rejected(self):
        with pytest.raises(RunInputError):
            normalize_run_input({"inputAction": "hover_gently"}, lookup)


class TestMapImagePoint:
    def test_secondary_monitor_offset(self):
        # 副屏在主屏右侧：left=2880
        assert map_image_point_to_screen(10, 20, 1920, 1080, (2880, 0, 1920, 1080)) == (2890, 20)

    def test_zero_dimensions_rejected(self):
        with pytest.raises(RunInputError):
            map_image_point_to_screen(1, 1, 0, 100, (0, 0, 100, 100))


def test_key_alias_table_no_self_alias():
    for key, target in KEY_ALIASES.items():
        assert key != target, f"自引用别名无意义: {key}"


# ─── actions（VLM JSON 输出解析，向后兼容回归） ─────────────────────────────


class TestParseActionJson:
    def test_plain_json(self):
        a = parse_action_json('{"action":"click","x":1,"y":2}')
        assert a.kind == "click" and a.payload["x"] == 1

    def test_fenced_json(self):
        a = parse_action_json('```json\n{"action":"done","summary":"ok"}\n```')
        assert a.kind == "done"

    def test_unquoted_keys_repaired(self):
        a = parse_action_json('{action: "key", key: "enter"}')
        assert a.kind == "key" and a.payload["key"] == "enter"

    def test_missing_action_raises(self):
        with pytest.raises(ValueError):
            parse_action_json('{"x": 1}')

    def test_validate_action_output_roundtrip(self):
        out = validate_action_output('{"action":"click","x":5,"y":6,"reasoning":"r"}')
        assert isinstance(out, DesktopActionOutput)
        assert out.action == "click"
