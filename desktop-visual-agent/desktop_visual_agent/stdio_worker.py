"""
供 Node 服务端子进程调用：stdin 一行 JSON，stdout 一行 JSON 结果。
环境变量与 `python -m desktop_visual_agent` CLI 一致；可设 DESKTOP_VISUAL_AGENT_STUB=1 启用离线模式。
"""
from __future__ import annotations

import asyncio
import base64
import json
import logging
import os
import sys
from datetime import datetime, timezone


def _normalize_openai_base(url: str) -> str:
    u = url.strip().rstrip("/")
    if u.endswith("/v1"):
        return u[:-3].rstrip("/")
    return u


async def _handle_screenshot(req: dict) -> dict:
    """处理截图请求，返回 base64 编码的 PNG 图片数据。"""
    try:
        from desktop_visual_agent.runtime.capture import grab_screen_png

        region = req.get("region")
        region_t: tuple[int, int, int, int] | None = None
        if region is not None:
            if not isinstance(region, list) or len(region) != 4:
                return {"ok": False, "error": "region must be [left, top, width, height]"}
            region_t = (int(region[0]), int(region[1]), int(region[2]), int(region[3]))

        png_bytes, (width, height) = grab_screen_png(region=region_t)
        image_base64 = base64.b64encode(png_bytes).decode("ascii")

        return {
            "ok": True,
            "imageBase64": image_base64,
            "mimeType": "image/png",
            "width": width,
            "height": height,
            "capturedAt": datetime.now(timezone.utc).isoformat(),
        }
    except Exception as e:
        logging.exception("screenshot failed")
        return {"ok": False, "error": f"截图失败: {str(e)}"}


async def _run() -> dict:
    logging.basicConfig(stream=sys.stderr, level=logging.INFO)
    line = sys.stdin.readline()
    if not line.strip():
        return {"ok": False, "error": "empty stdin"}
    req = json.loads(line)

    action = req.get("action", "run_task")

    if action == "screenshot":
        return await _handle_screenshot(req)

    task = str(req.get("task", "")).strip()
    if not task:
        return {"ok": False, "error": "missing task"}
    max_steps = int(req.get("maxSteps", 40))
    region = req.get("region")
    region_t: tuple[int, int, int, int] | None = None
    if region is not None:
        if not isinstance(region, list) or len(region) != 4:
            return {"ok": False, "error": "region must be [left, top, width, height]"}
        region_t = (int(region[0]), int(region[1]), int(region[2]), int(region[3]))

    stub = bool(req.get("stub")) or os.environ.get("DESKTOP_VISUAL_AGENT_STUB", "").strip() in (
        "1",
        "true",
        "yes",
        "on",
    )

    from desktop_visual_agent.agent_loop import LoopConfig, VisualDesktopLoop
    from desktop_visual_agent.vlm.openai_compatible import OpenAICompatibleVLM
    from desktop_visual_agent.vlm.stub import StubVLM

    if stub:
        vlm = StubVLM()
    else:
        key = os.environ.get("OPENAI_API_KEY", "").strip()
        if not key:
            return {"ok": False, "error": "OPENAI_API_KEY not set (or use stub:true / DESKTOP_VISUAL_AGENT_STUB=1)"}
        base = _normalize_openai_base(os.environ.get("OPENAI_BASE_URL", "https://api.openai.com"))
        model = (
            os.environ.get("OPENAI_VISION_MODEL", "").strip()
            or os.environ.get("OPENAI_MODEL", "").strip()
            or "gpt-4o-mini"
        )
        vlm = OpenAICompatibleVLM(base_url=base, api_key=key, model=model)

    loop = VisualDesktopLoop(vlm)
    out = await loop.run(LoopConfig(max_steps=max_steps, task=task, region=region_t))
    return out


def main() -> None:
    try:
        result = asyncio.run(_run())
    except Exception as e:
        result = {"ok": False, "error": str(e)}
    sys.stdout.write(json.dumps(result, ensure_ascii=False))
    sys.stdout.write("\n")
    sys.stdout.flush()
    sys.stderr.flush()


if __name__ == "__main__":
    main()
