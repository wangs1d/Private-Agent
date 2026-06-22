from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys

from desktop_visual.visual_loop import LoopConfig, VisualDesktopLoop
from desktop_visual.vlm.env_config import _normalize_openai_base
from desktop_visual.vlm.openai_compatible import OpenAICompatibleVLM
from desktop_visual.vlm.stub import StubVLM


def _build_vlm(args: argparse.Namespace):
    if args.stub:
        return StubVLM()
    raw_base = args.openai_base or os.environ.get("OPENAI_BASE_URL", "https://api.openai.com")
    base = _normalize_openai_base(raw_base)
    key = args.openai_key or os.environ.get("OPENAI_API_KEY", "")
    model = args.model or os.environ.get("OPENAI_VISION_MODEL", "gpt-4o-mini")
    if not key and not args.stub:
        print("?? API Key??? OPENAI_API_KEY ? --openai-key???? --stub", file=sys.stderr)
        sys.exit(2)
    return OpenAICompatibleVLM(base_url=base, api_key=key, model=model)


async def _amain() -> int:
    p = argparse.ArgumentParser(description="????????VLM + pyautogui/pynput?")
    p.add_argument("--task", required=True, help="????????")
    p.add_argument("--max-steps", type=int, default=40)
    p.add_argument("--stub", action="store_true", help="?? StubVLM????????")
    p.add_argument("--openai-base", default=None, help="OpenAI ?? Base URL")
    p.add_argument("--openai-key", default=None, help="API Key")
    p.add_argument("--model", default=None, help="??????")
    args = p.parse_args()

    loop = VisualDesktopLoop(_build_vlm(args))
    out = await loop.run(LoopConfig(max_steps=args.max_steps, task=args.task))
    print(json.dumps(out, ensure_ascii=False, indent=2))
    return 0 if out.get("ok") else 1


def main() -> None:
    raise SystemExit(asyncio.run(_amain()))


if __name__ == "__main__":
    main()
