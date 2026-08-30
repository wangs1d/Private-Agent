from __future__ import annotations

import io
from dataclasses import dataclass
from datetime import datetime, timezone

from PIL import Image, ImageGrab

from desktop_visual.runtime.displays import MonitorInfo, resolve_monitor


@dataclass(frozen=True)
class GrabResult:
    """一次截屏的完整标定信息（坐标系 = 屏幕物理像素）。"""

    png: bytes
    width: int  # 图片宽（降采样后）
    height: int  # 图片高（降采样后）
    screen_width: int  # 实际截取区域宽（物理像素）
    screen_height: int  # 实际截取区域高（物理像素）
    scale: float  # image→screen 倍率（>1 表示已降采样；screen = image * scale）
    display: int  # 1-based 显示器编号
    origin_x: int  # 该显示器在虚拟屏幕中的原点 X
    origin_y: int  # 原点 Y
    captured_at: str


def grab_screen_png(region: tuple[int, int, int, int] | None = None) -> tuple[bytes, tuple[int, int]]:
    """向后兼容接口：主屏截图，返回 (png_bytes, (width, height))。"""
    result = grab_display_png(display=None, region=region, max_dim=None)
    return result.png, (result.width, result.height)


def grab_display_png(
    *,
    display: int | None = None,
    region: tuple[int, int, int, int] | None = None,
    max_dim: int | None = None,
) -> GrabResult:
    """截取指定显示器（默认主屏）。

    - region: [left, top, width, height]，相对该显示器左上角的物理像素；
      省略则截取整屏。
    - max_dim: 最长边像素上限；超出时等比降采样（LANCZOS），scale>1。
      坐标换算：screen = image * scale（多屏时再加显示器原点）。
    """
    monitor: MonitorInfo = resolve_monitor(display)

    left, top = monitor.left, monitor.top
    width, height = monitor.width, monitor.height
    if region is not None:
        rl, rt, rw, rh = (int(v) for v in region)
        if rw <= 0 or rh <= 0:
            raise ValueError(f"region 宽高必须为正数，收到 {region!r}")
        left += rl
        top += rt
        width, height = rw, rh

    bbox = (left, top, left + width, top + height)
    # all_screens=True 让 bbox 使用虚拟屏幕坐标（多屏场景必需）
    img: Image.Image = ImageGrab.grab(bbox=bbox, all_screens=True)

    shrink = 1.0
    if max_dim is not None and max_dim > 0 and max(img.size) > max_dim:
        shrink = max_dim / max(img.size)
        new_size = (max(1, round(img.size[0] * shrink)), max(1, round(img.size[1] * shrink)))
        img = img.resize(new_size, Image.LANCZOS)

    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return GrabResult(
        png=buf.getvalue(),
        width=img.size[0],
        height=img.size[1],
        screen_width=width,
        screen_height=height,
        scale=round(1.0 / shrink, 4),
        display=monitor.index,
        origin_x=monitor.left,
        origin_y=monitor.top,
        captured_at=datetime.now(timezone.utc).isoformat(),
    )
