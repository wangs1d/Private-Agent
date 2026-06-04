"""
电脑端常驻进程：连接服务端 WebSocket（与手机同一 userId），接收 desktop.bridge.invoke，
在本机调用 desktop_visual.stdio_worker 执行纯视觉任务并回传 desktop.bridge.result。

默认无需配对码：须设置 DESKTOP_BRIDGE_USER_ID 与手机一致；session.init 使用 desktopBridge:true 后由服务端自动绑定。
若服务端配置了 DESKTOP_BRIDGE_TOKEN，则在本脚本环境变量中设置相同值，连接后会自动发送 register。

环境变量：
  DESKTOP_BRIDGE_WS_URL   例如 ws://192.168.1.2:3000/ws
  DESKTOP_BRIDGE_USER_ID  与 Flutter ApiConfig.userId 一致（必填）
  DESKTOP_BRIDGE_TOKEN    可选，与服务端一致时用于额外校验
  DESKTOP_BRIDGE_SESSION_ID 可选，默认 pc-bridge
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import sys
from pathlib import Path

import websockets

ROOT = str(Path(__file__).resolve().parent.parent)


async def run_stdio_worker_on_pc(payload: dict) -> dict:
    exe = sys.executable
    proc = await asyncio.create_subprocess_exec(
        exe,
        "-m",
        "desktop_visual.stdio_worker",
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        cwd=ROOT,
        env={**os.environ},
    )
    line = (json.dumps(payload, ensure_ascii=False) + "\n").encode("utf-8")
    out_b, err_b = await proc.communicate(input=line)
    if proc.returncode != 0:
        err = err_b.decode("utf-8", errors="replace").strip()
        return {"ok": False, "error": err or f"stdio_worker exit {proc.returncode}"}
    text = out_b.decode("utf-8", errors="replace").strip()
    if not text:
        return {"ok": False, "error": "empty stdout from stdio_worker"}
    last = text.splitlines()[-1]
    try:
        return json.loads(last)
    except json.JSONDecodeError:
        return {"ok": False, "error": f"invalid json: {last[:400]!r}"}


async def one_connection(url: str, token: str | None, init_payload: dict) -> None:
    async with websockets.connect(url, ping_interval=20, ping_timeout=120) as ws:
        await ws.send(json.dumps({"type": "session.init", "payload": init_payload}, ensure_ascii=False))
        if token:
            await ws.send(
                json.dumps({"type": "desktop.bridge.register", "payload": {"token": token}}, ensure_ascii=False)
            )
        logging.info("已连接桌面桥接，等待任务…")
        async for raw in ws:
            msg = json.loads(raw)
            mtype = msg.get("type")
            if mtype in ("desktop.bridge.register_ack", "desktop.bridge.sync"):
                logging.info("信令 %s %s", mtype, msg.get("payload"))
                continue
            if mtype == "error.event":
                pl = msg.get("payload") or {}
                raise RuntimeError(pl.get("message") or str(pl))
            if mtype != "desktop.bridge.invoke":
                continue
            pl = msg.get("payload") or {}
            job_id = pl.get("jobId")
            if not job_id:
                continue
            action = pl.get("action") or "run_task"
            if action == "screenshot":
                worker_req: dict = {
                    "action": "screenshot",
                    "region": pl.get("region"),
                }
            else:
                worker_req: dict = {
                    "action": "run_task",
                    "task": pl.get("task"),
                    "maxSteps": pl.get("maxSteps", 40),
                    "region": pl.get("region"),
                    "stub": bool(pl.get("stub")),
                }
                if isinstance(pl.get("vlm"), dict):
                    worker_req["vlm"] = pl.get("vlm")
            out = await run_stdio_worker_on_pc(worker_req)
            await ws.send(
                json.dumps(
                    {
                        "type": "desktop.bridge.result",
                        "payload": {"jobId": job_id, **out},
                    },
                    ensure_ascii=False,
                )
            )


async def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    url = os.environ.get("DESKTOP_BRIDGE_WS_URL", "").strip()
    token = os.environ.get("DESKTOP_BRIDGE_TOKEN", "").strip() or None
    user_id = os.environ.get("DESKTOP_BRIDGE_USER_ID", "").strip()
    session_id = os.environ.get("DESKTOP_BRIDGE_SESSION_ID", "pc-bridge").strip()
    if not url:
        logging.error("需要环境变量 DESKTOP_BRIDGE_WS_URL")
        sys.exit(2)
    if not user_id:
        logging.error("需要环境变量 DESKTOP_BRIDGE_USER_ID（须与手机端 USER_ID 一致）")
        sys.exit(2)

    init_payload: dict = {
        "sessionId": session_id,
        "deviceId": "desktop-bridge",
        "userAlias": "desktop_bridge",
        "desktopBridge": True,
        "userId": user_id,
    }

    while True:
        try:
            await one_connection(url, token, init_payload)
            logging.warning("连接已结束，2s 后重连")
        except (OSError, websockets.InvalidURI, websockets.InvalidHandshake) as e:
            logging.warning("连接失败 %s，2s 后重试", e)
        except asyncio.CancelledError:
            raise
        except Exception as e:
            logging.exception("桥接异常: %s", e)
        await asyncio.sleep(2.0)


if __name__ == "__main__":
    asyncio.run(main())
