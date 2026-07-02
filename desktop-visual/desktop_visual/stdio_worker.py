"""
Node 端通过 stdin 收 JSON、stdout 出一行 JSON 的 worker。
也支持 `python -m desktop_visual` CLI 直接跑；DESKTOP_VISUAL_STUB=1 走 stub VLM。
"""
from __future__ import annotations

import asyncio
import base64
import json
import logging
import os
import shlex
import subprocess
import sys
from datetime import datetime, timezone

from desktop_visual.shell_policy import (
    evaluate_shell_command,
    format_command_for_log,
    sanitize_env,
)


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
    """截整屏或区域，返回 base64 PNG + 尺寸。"""
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
        return {"ok": False, "error": f"截图失败: {str(e)}"}


# ---- run_shell ----
# 默认配置：30s 超时，硬上限 5min，最大 stdout/stderr 各 256KB
DEFAULT_SHELL_TIMEOUT_S = 30
MAX_SHELL_TIMEOUT_S = 300
MAX_SHELL_OUTPUT_BYTES = 256 * 1024


async def _handle_run_shell(req: dict) -> dict:
    """
    在 PC 本机跑一条 shell 命令（cmd / powershell / bash）。
    安全流程：evaluate_shell_command → 拒则直接回 ok=false；通则 subprocess。
    """
    command = req.get("command")
    if not isinstance(command, str) or not command.strip():
        return {"ok": False, "error": "missing command"}
    shell = req.get("shell")
    if shell is not None and shell not in ("cmd", "powershell", "bash"):
        return {"ok": False, "error": f"unsupported shell={shell!r}"}
    allow_destructive = bool(req.get("allowDestructive"))
    cwd_raw = req.get("cwd")
    cwd = cwd_raw if isinstance(cwd_raw, str) and cwd_raw.strip() else None

    try:
        timeout_s = float(req.get("timeoutMs", DEFAULT_SHELL_TIMEOUT_S * 1000)) / 1000.0
    except (TypeError, ValueError):
        timeout_s = DEFAULT_SHELL_TIMEOUT_S
    timeout_s = max(0.1, min(timeout_s, MAX_SHELL_TIMEOUT_S))

    decision = evaluate_shell_command(
        command,
        shell=shell,
        allow_destructive=allow_destructive,
    )

    loggable = format_command_for_log(command)
    logging.info(
        "[run_shell] shell=%s first=%s allowed=%s reason=%s cmd=%s timeout=%.1fs cwd=%s",
        decision.detected_shell, decision.first_token, decision.allowed,
        decision.reason, loggable, timeout_s, cwd or "<inherit>",
    )

    if not decision.allowed:
        return {
            "ok": False,
            "error": f"shell 命令被策略拒绝: {decision.reason}",
            "decision": {
                "allowed": False,
                "shell": decision.detected_shell,
                "firstToken": decision.first_token,
                "reason": decision.reason,
            },
            "command": loggable,
        }

    # 拼 shell 调用
    sh = decision.detected_shell
    if sh == "cmd":
        argv = ["cmd.exe", "/d", "/c", command]
    elif sh == "powershell":
        # -NoProfile -NonInteractive 防止启动 profile 脚本绕开策略
        argv = [
            "powershell.exe",
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy", "Bypass",
            "-Command", command,
        ]
    else:  # bash
        argv = ["bash", "-lc", command]

    # 强制剥离敏感 env
    safe_env = decision.sanitized_env
    if isinstance(safe_env, dict) and "PATH" in os.environ and "PATH" not in safe_env:
        safe_env["PATH"] = os.environ["PATH"]
    if isinstance(safe_env, dict) and "SystemRoot" in os.environ and "SystemRoot" not in safe_env:
        safe_env["SystemRoot"] = os.environ["SystemRoot"]

    started = datetime.now(timezone.utc)
    try:
        proc = await asyncio.create_subprocess_exec(
            *argv,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            cwd=cwd,
            env=safe_env,
        )
    except FileNotFoundError as e:
        return {
            "ok": False,
            "error": f"shell 解释器未找到: {e}",
            "command": loggable,
            "shell": sh,
        }
    except Exception as e:
        return {
            "ok": False,
            "error": f"启动 shell 失败: {e}",
            "command": loggable,
            "shell": sh,
        }

    killed = False
    try:
        stdout_b, stderr_b = await asyncio.wait_for(proc.communicate(), timeout=timeout_s)
    except asyncio.TimeoutError:
        killed = True
        try:
            proc.kill()
        except ProcessLookupError:
            pass
        try:
            stdout_b, stderr_b = await asyncio.wait_for(proc.communicate(), timeout=2.0)
        except (asyncio.TimeoutError, ProcessLookupError):
            stdout_b, stderr_b = b"", b""
    duration = (datetime.now(timezone.utc) - started).total_seconds()

    # 截断输出
    def _clip(b: bytes) -> str:
        if not b:
            return ""
        if len(b) > MAX_SHELL_OUTPUT_BYTES:
            return b[:MAX_SHELL_OUTPUT_BYTES].decode("utf-8", errors="replace") + "\n...<truncated>"
        return b.decode("utf-8", errors="replace")

    stdout_s = _clip(stdout_b)
    stderr_s = _clip(stderr_b)
    exit_code = proc.returncode if proc.returncode is not None else -1

    return {
        "ok": exit_code == 0 and not killed,
        "command": loggable,
        "shell": sh,
        "firstToken": decision.first_token,
        "exitCode": exit_code,
        "stdout": stdout_s,
        "stderr": stderr_s,
        "durationMs": int(duration * 1000),
        "killed": killed,
        "decision": {
            "allowed": True,
            "shell": sh,
            "firstToken": decision.first_token,
            "reason": decision.reason,
        },
    }


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
    if action == "run_shell":
        return await _handle_run_shell(req)

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
