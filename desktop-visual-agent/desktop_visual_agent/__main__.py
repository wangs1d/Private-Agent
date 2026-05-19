from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys

from desktop_visual_agent.agent_loop import LoopConfig, VisualDesktopLoop
from desktop_visual_agent.vlm.openai_compatible import OpenAICompatibleVLM
from desktop_visual_agent.vlm.stub import StubVLM


def _build_vlm(args: argparse.Namespace):
    if args.stub:
        return StubVLM()
    base = args.openai_base or os.environ.get("OPENAI_BASE_URL", "https://api.openai.com")
    key = args.openai_key or os.environ.get("OPENAI_API_KEY", "")
    model = args.model or os.environ.get("OPENAI_VISION_MODEL", "gpt-4o-mini")
    if not key and not args.stub:
        print("缺少 API Key：设置 OPENAI_API_KEY 或 --openai-key，或使用 --stub", file=sys.stderr)
        sys.exit(2)
    return OpenAICompatibleVLM(base_url=base, api_key=key, model=model)


async def _amain() -> int:
    p = argparse.ArgumentParser(description="纯视觉桌面操控（VLM + pyautogui/pynput）")
    p.add_argument("--task", required=True, help="自然语言任务描述")
    p.add_argument("--max-steps", type=int, default=40)
    p.add_argument("--stub", action="store_true", help="使用 StubVLM，不调用真实模型")
    p.add_argument("--openai-base", default=None, help="OpenAI 兼容 Base URL")
    p.add_argument("--openai-key", default=None, help="API Key")
    p.add_argument("--model", default=None, help="多模态模型名")
    args = p.parse_args()

    loop = VisualDesktopLoop(_build_vlm(args))
    out = await loop.run(LoopConfig(max_steps=args.max_steps, task=args.task))
    print(json.dumps(out, ensure_ascii=False, indent=2))
    return 0 if out.get("ok") else 1


def main() -> None:
    raise SystemExit(asyncio.run(_amain()))


if __name__ == "__main__":
    main()
