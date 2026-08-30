from __future__ import annotations

import time
from typing import Literal

import pyautogui
from pynput.mouse import Button, Controller

ButtonName = Literal["left", "right", "middle"]


class HybridPointer:
    """Mouse and keyboard controller used by desktop visual actions.

    坐标系约定：屏幕物理像素（进程为 Per-Monitor V2 DPI aware）。
    动作集对齐主流 computer-use（Anthropic / OpenAI CUA）：
    click(1-3 连击)/move/scroll(纵+横)/down-up 分离/hold_key。
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
        for i in range(max(1, clicks)):
            self._mouse.click(btn, 1)
            if i < clicks - 1:
                time.sleep(interval_s)

    def mouse_down(self, button: ButtonName = "left") -> None:
        self._mouse.press(_to_pynput_button(button))

    def mouse_up(self, button: ButtonName = "left") -> None:
        self._mouse.release(_to_pynput_button(button))

    def scroll(self, clicks: int) -> None:
        pyautogui.scroll(int(clicks))

    def hscroll(self, clicks: int) -> None:
        """水平滚动：正=向右，负=向左。"""
        pyautogui.hscroll(int(clicks))

    def scroll_at(self, x: int, y: int, clicks: int, *, hclicks: int = 0) -> None:
        """先把光标移到 (x, y) 再滚动（等效主流 scroll 带目标坐标）。"""
        self.move(x, y)
        time.sleep(0.05)
        if hclicks:
            self.hscroll(hclicks)
        if clicks:
            self.scroll(clicks)

    def type_text(self, text: str, *, interval_s: float = 0.02) -> None:
        pyautogui.write(text, interval=interval_s)

    def key_tap(self, key: str) -> None:
        pyautogui.press(key)

    def hold_key(self, key: str, duration_s: float) -> None:
        """按住 key 再松开（主流 hold_key 语义）。"""
        pyautogui.keyDown(key)
        try:
            time.sleep(max(0.05, duration_s))
        finally:
            pyautogui.keyUp(key)

    def drag_to(
        self,
        x: int,
        y: int,
        to_x: int,
        to_y: int,
        *,
        duration_s: float = 0.3,
        button: ButtonName = "left",
    ) -> None:
        pyautogui.moveTo(int(x), int(y))
        pyautogui.drag(int(to_x) - int(x), int(to_y) - int(y), duration=max(0.05, duration_s), button=button)


def _to_pynput_button(button: ButtonName) -> Button:
    if button == "right":
        return Button.right
    if button == "middle":
        return Button.middle
    return Button.left
