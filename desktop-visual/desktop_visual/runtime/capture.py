from __future__ import annotations

import io

import pyautogui
from PIL import Image


def grab_screen_png(region: tuple[int, int, int, int] | None = None) -> tuple[bytes, tuple[int, int]]:
    """Capture the current screen as PNG bytes."""
    img: Image.Image = pyautogui.screenshot(region=region)
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    width, height = img.size
    return buf.getvalue(), (width, height)
