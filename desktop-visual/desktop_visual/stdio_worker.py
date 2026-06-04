"""
? Node ?????????stdin ?? JSON?stdout ?? JSON ???
????? `python -m desktop_visual` CLI ????? DESKTOP_VISUAL_STUB=1 ???????
"""
from __future__ import annotations

import asyncio
import base64
import json
import logging
import os
import sys
from datetime import datetime, timezone


def _stub_env_on() -> bool:
    for key in ("DESKTOP_VISUAL_STUB", "DESKTOP_VISUAL_AGENT_STUB"):
        if os.environ.get(key, "").strip().lower() in ("1", "true", "yes", "on"):
            return True
    return False


def _normalize_openai_base(url: str) -> str:
    u = url.strip().rstrip("/")
    if u.endswith("/v1"):
        return u[:-3].rstrip("/")
    return u


async def _handle_screenshot(req: dict) -> dict:
    """????????? base64 ??? PNG ?????"""
    try:
        from desktop_visual.runtime.capture import grab_screen_png

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
        return {"ok": False, "error": f"????: {str(e)}"}


async def _run() -> dict:
    logging.basicConfig(stream=sys.stderr, level=logging.INFO)
    line = sys.stdin.readline()
    if not line.strip():
        return {"ok": False, "error": "empty stdin"}
    try:
        req = json.loads(line)
    except json.JSONDecodeError as exc:
        return {"ok": False, "error": f"stdin JSON 无效: {exc}"}

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

    stub = bool(req.get("stub")) or _stub_env_on()

    from desktop_visual.visual_loop import LoopConfig, VisualDesktopLoop
    from desktop_visual.vlm.openai_compatible import OpenAICompatibleVLM
    from desktop_visual.vlm.stub import StubVLM

    if stub:
        vlm = StubVLM()
    else:
        from desktop_visual.vlm.env_config import resolve_vlm_from_request

        cfg = resolve_vlm_from_request(req)
        if not cfg:
            return {
                "ok": False,
                "error": "未配置视觉模型密钥：请设置 MOONSHOT_API_KEY 或 OPENAI_API_KEY，或由服务端桥接下发 vlm（use stub:true / DESKTOP_VISUAL_STUB=1 调试）",
            }
        vlm = OpenAICompatibleVLM(
            base_url=cfg["baseUrl"],
            api_key=cfg["apiKey"],
            model=cfg["model"],
        )

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
