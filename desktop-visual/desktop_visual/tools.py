from __future__ import annotations

import logging
from typing import Any, Callable, Optional

from desktop_visual.structured_output import ActionKind

logger = logging.getLogger(__name__)


ActionHandler = Callable[..., tuple[bool, str]]


class ActionResult:
    __slots__ = ("is_done", "note", "error")

    def __init__(self, is_done: bool = False, note: str = "", error: str | None = None) -> None:
        self.is_done = is_done
        self.note = note
        self.error = error


class RegisteredAction:
    __slots__ = ("kind", "handler", "description", "example", "requires_coords", "is_terminal")

    def __init__(
        self,
        kind: ActionKind,
        handler: ActionHandler,
        description: str = "",
        example: str = "",
        requires_coords: bool = False,
        is_terminal: bool = False,
    ) -> None:
        self.kind = kind
        self.handler = handler
        self.description = description
        self.example = example
        self.requires_coords = requires_coords
        self.is_terminal = is_terminal


class DesktopTools:
    """Registerable action system inspired by browser-use's @tools.action() pattern.

    Usage:
        tools = DesktopTools()
        tools.register(ActionKind.CLICK, my_click_handler, description="Click at coordinates")
    """

    def __init__(self) -> None:
        self._actions: dict[ActionKind, RegisteredAction] = {}

    def register(
        self,
        kind: ActionKind,
        handler: ActionHandler,
        *,
        description: str = "",
        example: str = "",
        requires_coords: bool = False,
        is_terminal: bool = False,
    ) -> None:
        self._actions[kind] = RegisteredAction(
            kind=kind,
            handler=handler,
            description=description,
            example=example,
            requires_coords=requires_coords,
            is_terminal=is_terminal,
        )
        logger.debug("Registered action: %s (coords=%s)", kind.value, requires_coords)

    def get(self, kind: ActionKind) -> RegisteredAction | None:
        return self._actions.get(kind)

    def execute(self, kind: ActionKind, payload: dict[str, Any]) -> ActionResult:
        registered = self._actions.get(kind)
        if not registered:
            logger.warning("Unknown action: %s", kind.value)
            return ActionResult(is_done=False, note=f"Unknown action '{kind.value}'; skipped")

        try:
            result = registered.handler(payload)
            if isinstance(result, tuple) and len(result) == 2:
                is_done, note = result
                return ActionResult(is_done=is_done, note=note)
            return ActionResult(is_done=False, note=str(result))
        except Exception as exc:
            logger.exception("Action %s failed", kind.value)
            return ActionResult(is_done=False, note=f"Action failed: {exc}", error=str(exc))

    @property
    def registered_kinds(self) -> list[ActionKind]:
        return list(self._actions.keys())

    def generate_schema_text(self) -> str:
        lines: list[str] = []
        for _kind, a in self._actions.items():
            lines.append(f"  {a.kind.value}: {a.description}")
            if a.example:
                lines.append(f"    Example: {a.example}")
            if a.requires_coords:
                lines.append("    Requires: x, y coordinates")
            if a.is_terminal:
                lines.append("    NOTE: This ends the task.")
        return "\n".join(lines)
