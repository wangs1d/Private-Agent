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
import webbrowser
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


# ---- open ----
def _handle_open(req: dict) -> dict:
    """
    原生 API 打开文件/网页/软件（不走 shell，不经 shell_policy 判定）。
    - url  → webbrowser.open（跨平台，用默认浏览器）
    - file → os.startfile（Windows）/ xdg-open（Linux）/ open（macOS）
    - app  → subprocess.Popen([path])（无 shell=True，直接启动可执行文件）
    """
    target = req.get("target")
    path = req.get("path")
    if not isinstance(target, str) or target not in ("file", "url", "app"):
        return {"ok": False, "error": f"target 必须是 file/url/app，收到 {target!r}"}
    if not isinstance(path, str) or not path.strip():
        return {"ok": False, "error": "path 不能为空"}

    try:
        if target == "url":
            # webbrowser.open 返回 True/False，不抛异常
            success = webbrowser.open(path)
            if not success:
                return {"ok": False, "error": f"webbrowser.open 返回 False：{path}"}
        elif target == "file":
            if os.name == "nt":
                os.startfile(path)  # type: ignore[attr-defined]
            elif sys.platform == "darwin":
                subprocess.Popen(["open", path])
            else:
                subprocess.Popen(["xdg-open", path])
        else:  # app
            # 直接启动可执行文件，不经过 shell
            subprocess.Popen([path])
    except FileNotFoundError as e:
        return {"ok": False, "error": f"找不到目标: {e}"}
    except OSError as e:
        return {"ok": False, "error": f"打开失败: {e}"}

    return {
        "ok": True,
        "target": target,
        "path": path,
        "openedAt": datetime.now(timezone.utc).isoformat(),
    }


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
    if action == "open":
        return _handle_open(req)
    if action == "uia_query":
        return _handle_uia_query(req)
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

    loop = VisualDesktopLoop(vlm, uia=_get_uia_for_loop())
    out = await loop.run(LoopConfig(max_steps=max_steps, task=task, region=region_t))
    return out


def _get_uia_for_loop():
    """获取共享 UiaController 实例供 visual_loop 隐式兜底用。非 Windows 或 pywinauto 未装时返回 None。"""
    try:
        from desktop_visual.runtime.uia_controller import get_uia_controller

        ctrl = get_uia_controller()
        return ctrl if ctrl.is_available() else None
    except Exception:
        return None


def _handle_uia_query(req: dict) -> dict:
    """UIA 结构化查询。mode: query | read_children | inspect_point。"""
    from desktop_visual.runtime.uia_controller import get_uia_controller

    ctrl = get_uia_controller()
    if not ctrl.is_available():
        return {
            "ok": False,
            "error": "UIA 不可用（非 Windows 或 pywinauto 未安装）",
            "available": False,
        }

    mode = req.get("mode", "query")
    try:
        if mode == "inspect_point":
            point = req.get("point") or {}
            x = int(point.get("x", 0))
            y = int(point.get("y", 0))
            return ctrl.inspect_point(x, y)

        if mode == "query":
            selector = req.get("selector") or {}
            top_only = bool(req.get("topOnly", True))
            limit = int(req.get("limit", 100))
            elements = ctrl.query(selector, top_only=top_only, limit=limit)
            # 剥掉 __ref 字段（不可序列化）
            return {
                "ok": True,
                "mode": "query",
                "selector": selector,
                "count": len(elements),
                "elements": [_strip_ref(e) for e in elements],
            }

        if mode == "read_children":
            # 先用 selector 找父元素，再读子树
            selector = req.get("selector") or {}
            limit = int(req.get("limit", 200))
            parents = ctrl.query(selector, top_only=True, limit=1)
            if not parents:
                return {"ok": False, "error": "未找到匹配父元素", "selector": selector}
            parent_ref = parents[0].get("__ref")
            children = ctrl.read_children(parent_ref, limit=limit)
            return {
                "ok": True,
                "mode": "read_children",
                "parent": _strip_ref(parents[0]),
                "count": len(children),
                "elements": [_strip_ref(c) for c in children],
            }

        return {"ok": False, "error": f"未知 mode: {mode!r}（应为 query/read_children/inspect_point）"}
    except Exception as exc:
        return {"ok": False, "error": f"UIA 查询失败: {exc}", "mode": mode}


def _strip_ref(elem: dict) -> dict:
    """剥掉不可序列化的 __ref 字段。"""
    if not isinstance(elem, dict):
        return elem
    return {k: v for k, v in elem.items() if k != "__ref"}


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
