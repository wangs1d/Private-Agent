from __future__ import annotations

import time
from typing import Literal

import pyautogui
from pynput.mouse import Button, Controller

ButtonName = Literal["left", "right", "middle"]


class HybridPointer:
    """
    pyautogui：截图、可选平滑移动、滚轮。
    pynput：精确点击/按压（与部分游戏/UI 兼容性更好）。
    """

    def __init__(self, *, fail_safe: bool = True) -> None:
        pyautogui.FAILSAFE = fail_safe
        pyautogui.PAUSE = 0.05
        self._mouse = Controller()

    def move(self, x: int, y: int, *, duration_s: float = 0.0) -> None:
        if duration_s and duration_s > 0:
            pyautogui.moveTo(int(x), int(y), duration=duration_s)
        else:
            self._mouse.position = (int(x), int(y))

    def click(
        self,
        x: int,
        y: int,
        *,
        button: ButtonName = "left",
        clicks: int = 1,
        interval_s: float = 0.08,
    ) -> None:
        self.move(x, y)
        btn = _to_pynput_button(button)
        for i in range(clicks):
            self._mouse.click(btn, 1)
            if i < clicks - 1:
                time.sleep(interval_s)

    def scroll(self, clicks: int) -> None:
        """垂直滚轮；正数向上、负数向下（与 pyautogui 一致）。"""
        pyautogui.scroll(int(clicks))

    def type_text(self, text: str, *, interval_s: float = 0.02) -> None:
        pyautogui.write(text, interval=interval_s)

    def key_tap(self, key: str) -> None:
        pyautogui.press(key)


def _to_pynput_button(button: ButtonName) -> Button:
    if button == "right":
        return Button.right
    if button == "middle":
        return Button.middle
    return Button.left
