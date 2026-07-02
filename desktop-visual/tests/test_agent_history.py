"""
Tests for the v2 desktop-visual improvements (browser-use inspired).

Usage:
    cd desktop-visual
    python -m pytest tests/test_agent_history.py -v
"""
from __future__ import annotations

import pytest
from desktop_visual.structured_output import ActionKind, DesktopActionOutput, LoopResult
from desktop_visual.agent_history import AgentHistory, StepRecord
from desktop_visual.actions import DELUXE_SYSTEM_PROMPT, parse_action_json, validate_action_output, DesktopAction


class TestStructuredOutput:
    def test_valid_click(self):
        output = DesktopActionOutput(action=ActionKind.CLICK, x=100, y=200, reasoning="clicking button")
        assert output.action == ActionKind.CLICK
        assert output.x == 100
        assert output.y == 200

    def test_click_requires_coords(self):
        with pytest.raises(ValueError, match="requires x and y"):
            DesktopActionOutput(action=ActionKind.CLICK)

    def test_double_click_requires_coords(self):
        with pytest.raises(ValueError):
            DesktopActionOutput(action=ActionKind.DOUBLE_CLICK)

    def test_done_does_not_require_coords(self):
        output = DesktopActionOutput(action=ActionKind.DONE, summary="task done")
        assert output.action == ActionKind.DONE
        assert output.summary == "task done"

    def test_move_requires_coords(self):
        with pytest.raises(ValueError):
            DesktopActionOutput(action=ActionKind.MOVE)

    def test_scroll_no_coords_needed(self):
        output = DesktopActionOutput(action=ActionKind.SCROLL, scroll_clicks=3)
        assert output.scroll_clicks == 3

    def test_type_no_coords_needed(self):
        output = DesktopActionOutput(action=ActionKind.TYPE, text="hello")
        assert output.text == "hello"

    def test_key_no_coords_needed(self):
        output = DesktopActionOutput(action=ActionKind.KEY, key="enter")
        assert output.key == "enter"

    def test_wait_no_coords_needed(self):
        output = DesktopActionOutput(action=ActionKind.WAIT, wait_s=2.0)
        assert output.wait_s == 2.0

    def test_clicks_range(self):
        output = DesktopActionOutput(action=ActionKind.CLICK, x=1, y=1, clicks=3)
        assert output.clicks == 3

    def test_clicks_exceeds_max(self):
        with pytest.raises(ValueError):
            DesktopActionOutput(action=ActionKind.CLICK, x=1, y=1, clicks=10)

    def test_model_validate_from_dict(self):
        raw = {"action": "click", "x": 500, "y": 300, "reasoning": "clicking"}
        output = DesktopActionOutput.model_validate(raw)
        assert output.x == 500
        assert output.y == 300
        assert output.reasoning == "clicking"


class TestActionParsing:
    def test_parse_simple_click(self):
        action = parse_action_json('{"action":"click","x":100,"y":200}')
        assert action.kind == "click"
        assert action.payload["x"] == 100

    def test_parse_with_code_fence(self):
        action = parse_action_json('```json\n{"action":"done","summary":"ok"}\n```')
        assert action.kind == "done"
        assert action.payload["summary"] == "ok"

    def test_parse_with_surrounding_text(self):
        action = parse_action_json('Let me click here: {"action":"click","x":50,"y":60}.')
        assert action.kind == "click"
        assert action.payload["x"] == 50

    def test_parse_with_unquoted_keys(self):
        text = "{action:\"move\",x:100,y:200}"
        action = parse_action_json(text)
        assert action.kind == "move"
        assert action.payload["x"] == 100

    def test_parse_missing_action_field(self):
        with pytest.raises(ValueError, match="missing action field"):
            parse_action_json('{"x":100,"y":200}')

    def test_parse_not_a_dict(self):
        with pytest.raises(ValueError, match="must be a JSON object"):
            parse_action_json('["string", "array"]')

    def test_validate_action_output_from_valid_json(self):
        output = validate_action_output('{"action":"click","x":100,"y":200,"reasoning":"test"}')
        assert output.action == ActionKind.CLICK
        assert output.x == 100

    def test_validate_action_output_invalid(self):
        with pytest.raises(ValueError):
            validate_action_output('{"action":"click"}')

    def test_parse_with_reasoning_field(self):
        action = parse_action_json('{"action":"type","text":"hello","reasoning":"typing a message"}')
        assert action.kind == "type"
        assert action.payload["text"] == "hello"
        assert action.payload["reasoning"] == "typing a message"


class TestAgentHistory:
    def test_record_single_step(self):
        history = AgentHistory()
        history.record(
            action_kind=ActionKind.CLICK,
            action_payload={"x": 100, "y": 200},
            note="clicked button",
        )
        assert history.step_count == 1
        results = history.to_step_results()
        assert len(results) == 1
        assert results[0].action == ActionKind.CLICK
        assert results[0].success is True

    def test_record_multiple_steps(self):
        history = AgentHistory()
        for i in range(5):
            history.record(
                action_kind=ActionKind.CLICK,
                action_payload={"x": i * 10, "y": i * 10},
                note=f"step {i}",
            )
        assert history.step_count == 5
        assert len(history.to_step_results()) == 5

    def test_record_failed_step(self):
        history = AgentHistory()
        history.record(
            action_kind=ActionKind.CLICK,
            action_payload={"x": 0, "y": 0},
            note="failed to click",
            success=False,
        )
        results = history.to_step_results()
        assert results[0].success is False

    def test_is_stuck_repeated_waits(self):
        history = AgentHistory()
        for _ in range(4):
            history.record(ActionKind.WAIT, {}, "waiting")
        assert history.is_stuck(threshold=3) is True

    def test_is_stuck_repeated_clicks_same_position(self):
        history = AgentHistory()
        for _ in range(4):
            history.record(ActionKind.CLICK, {"x": 100, "y": 200}, "clicking")
        assert history.is_stuck(threshold=3) is True

    def test_is_stuck_varied_actions_not_stuck(self):
        history = AgentHistory()
        history.record(ActionKind.MOVE, {"x": 100, "y": 200}, "move")
        history.record(ActionKind.CLICK, {"x": 100, "y": 200}, "click")
        history.record(ActionKind.KEY, {"key": "enter"}, "press enter")
        assert history.is_stuck(threshold=3) is False

    def test_is_stuck_different_positions_not_stuck(self):
        history = AgentHistory()
        history.record(ActionKind.CLICK, {"x": 100, "y": 200}, "click1")
        history.record(ActionKind.CLICK, {"x": 200, "y": 300}, "click2")
        history.record(ActionKind.CLICK, {"x": 300, "y": 400}, "click3")
        assert history.is_stuck(threshold=3) is False

    def test_is_stuck_below_threshold(self):
        history = AgentHistory()
        history.record(ActionKind.WAIT, {}, "wait")
        history.record(ActionKind.WAIT, {}, "wait")
        assert history.is_stuck(threshold=3) is False

    def test_build_context_messages_basic(self):
        history = AgentHistory(max_history_steps=2, include_screenshots=False)
        history.record(ActionKind.CLICK, {"x": 100, "y": 200}, "clicked start")
        history.record(ActionKind.KEY, {"key": "enter"}, "pressed enter")
        fake_png = b"fake_png_data"
        messages = history.build_context_messages(
            system_prompt="You are a test agent.",
            task="test task",
            current_screenshot=fake_png,
            screenshot_size=(1920, 1080),
        )
        assert len(messages) == 2
        assert messages[0].role == "system"
        assert "Previous 2 Step(s)" in (messages[1].text or "")
        assert "Step 1: click" in (messages[1].text or "")
        assert "Step 2: key" in (messages[1].text or "")
        assert "test task" in (messages[1].text or "")

    def test_build_context_messages_with_stuck_warning(self):
        history = AgentHistory(max_history_steps=2, include_screenshots=False)
        for _ in range(4):
            history.record(ActionKind.CLICK, {"x": 100, "y": 200}, "clicking same spot")
        fake_png = b"fake_png_data"
        messages = history.build_context_messages(
            system_prompt="You are a test agent.",
            task="test task",
            current_screenshot=fake_png,
            screenshot_size=(1920, 1080),
        )
        assert "WARNING" in (messages[1].text or "")
        assert "stuck" in (messages[1].text or "")

    def test_build_context_messages_with_ocr(self):
        history = AgentHistory(max_history_steps=0, include_screenshots=False)
        fake_png = b"fake_png_data"
        messages = history.build_context_messages(
            system_prompt="You are a test agent.",
            task="test task",
            current_screenshot=fake_png,
            screenshot_size=(1920, 1080),
            ocr_text="Hello World",
        )
        assert "OCR Text on Screen" in (messages[1].text or "")
        assert "Hello World" in (messages[1].text or "")

    def test_history_includes_screenshots(self):
        history = AgentHistory(max_history_steps=2, include_screenshots=True)
        history.record(
            ActionKind.CLICK,
            {"x": 100, "y": 200},
            "clicked",
            screenshot_png=b"prev_screenshot",
            screenshot_size=(1920, 1080),
        )
        fake_png = b"current_screenshot"
        messages = history.build_context_messages(
            system_prompt="You are a test agent.",
            task="test task",
            current_screenshot=fake_png,
            screenshot_size=(1920, 1080),
        )
        assert len(messages[1].images) == 2
        assert messages[1].images[0].data == b"current_screenshot"
        assert messages[1].images[1].data == b"prev_screenshot"


class TestDeluxeSystemPrompt:
    def test_deluxe_prompt_has_rules(self):
        assert "CRITICAL RULES" in DELUXE_SYSTEM_PROMPT
        assert "reasoning" in DELUXE_SYSTEM_PROMPT

    def test_deluxe_prompt_has_all_actions(self):
        for action in ["click", "double_click", "right_click", "move", "scroll", "type", "key", "wait", "done"]:
            assert action in DELUXE_SYSTEM_PROMPT, f"Missing action: {action}"

    def test_deluxe_prompt_has_stuck_guidance(self):
        assert "stuck" in DELUXE_SYSTEM_PROMPT.lower()


class TestLoopStepCount:
    def test_step_increment(self):
        history = AgentHistory()
        for i in range(3):
            history.record(ActionKind.CLICK, {"x": i, "y": i}, f"step{i}")
        results = history.to_step_results()
        assert [r.step for r in results] == [1, 2, 3]
