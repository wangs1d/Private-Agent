from __future__ import annotations

import io

import pyautogui
from PIL import Image


def grab_screen_png(region: tuple[int, int, int, int] | None = None) -> tuple[bytes, tuple[int, int]]:
    """
    截取当前屏幕为 PNG。
    region: (left, top, width, height)，与 pyautogui 一致；None 表示全屏。
    返回 (png_bytes, (width, height))。
    """
    img: Image.Image = pyautogui.screenshot(region=region)
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    w, h = img.size
    return buf.getvalue(), (w, h)
