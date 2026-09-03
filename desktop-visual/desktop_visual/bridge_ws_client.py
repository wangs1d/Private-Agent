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
import threading
import time
from pathlib import Path

import websockets

from desktop_visual.bridge_actions import UnknownBridgeAction, build_worker_request

ROOT = str(Path(__file__).resolve().parent.parent)

# stdio_worker 在 stderr 上以 "##STEP {json}" 行上报 run_task 的每步动作，
# 桥接转发为 desktop.task.step 事件，server 端可实时展示操作步骤。
STEP_LINE_PREFIX = "##STEP "


async def _pump_stderr_steps(stream: asyncio.StreamReader, job_id: str | None) -> str:
    """逐行读 stderr：##STEP 行转发为 desktop.task.step 事件，其余收集为尾部日志。"""
    tail: list[str] = []
    while True:
        try:
            line = await stream.readline()
        except Exception:
            break
        if not line:
            break
        text = line.decode("utf-8", errors="replace").rstrip("\r\n")
        if text.startswith(STEP_LINE_PREFIX):
            try:
                step = json.loads(text[len(STEP_LINE_PREFIX):])
            except json.JSONDecodeError:
                tail.append(text)
                continue
            send_event("desktop.task.step", {"jobId": job_id, **step})
        else:
            tail.append(text)
    return "\n".join(tail[-50:])


async def run_stdio_worker_on_pc(payload: dict, job_id: str | None = None) -> dict:
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
    # communicate() 会接管全部管道，无法边读边转发；改为手动 pump：
    # stdout 读到 EOF，stderr 逐行转发 ##STEP 事件后收集尾部日志。
    assert proc.stdin is not None and proc.stdout is not None and proc.stderr is not None
    line = (json.dumps(payload, ensure_ascii=False) + "\n").encode("utf-8")
    proc.stdin.write(line)
    await proc.stdin.drain()
    proc.stdin.close()
    stderr_task = asyncio.create_task(_pump_stderr_steps(proc.stderr, job_id))
    stdout_task = asyncio.create_task(proc.stdout.read())
    await proc.wait()
    out_b = await stdout_task
    err_text = await stderr_task
    if proc.returncode != 0:
        return {"ok": False, "error": err_text.strip() or f"stdio_worker exit {proc.returncode}"}
    text = out_b.decode("utf-8", errors="replace").strip()
    if not text:
        return {"ok": False, "error": "empty stdout from stdio_worker"}
    last = text.splitlines()[-1]
    try:
        return json.loads(last)
    except json.JSONDecodeError:
        return {"ok": False, "error": f"invalid json: {last[:400]!r}"}


# ============================================================
# 主动事件推送通道（desktop.event）
# Python 端可主动向 server 推送事件（如窗口焦点变化），
# 与 desktop.bridge.invoke 请求-响应通道并存且互不阻塞：
#   - invoke：server→Python 请求，Python 回 desktop.bridge.result（jobId 配对）
#   - event ：Python→server 单向推送，无 jobId，不进入 pending 队列
# ws 连接由 asyncio 事件循环拥有，send_event 可在任意线程调用，
# 通过 run_coroutine_threadsafe 把 send 调度到 ws 所在的事件循环；
# threading.Lock 保护 _bridge_state 的读写。
# ============================================================
_bridge_lock = threading.Lock()
_bridge_state: dict = {"ws": None, "loop": None}


def _set_active_bridge(ws, loop: asyncio.AbstractEventLoop) -> None:
    with _bridge_lock:
        _bridge_state["ws"] = ws
        _bridge_state["loop"] = loop


def _clear_active_bridge() -> None:
    with _bridge_lock:
        _bridge_state["ws"] = None
        _bridge_state["loop"] = None


def send_event(event_type: str, payload: dict | None = None) -> bool:
    """主动推送 desktop.event 消息到 server（线程安全）。

    与 desktop.bridge.invoke 请求-响应通道并存且互不阻塞：event 是 Python→server
    的单向推送，不参与 invoke 的 jobId 配对与 pending 队列。

    可在任意线程调用：通过 run_coroutine_threadsafe 把 send 调度到 ws 所在的
    事件循环；返回 True 表示已调度，False 表示当前无活动桥接连接或循环已关闭。
    """
    with _bridge_lock:
        ws = _bridge_state["ws"]
        loop = _bridge_state["loop"]
    if ws is None or loop is None:
        logging.warning("send_event 失败：桌面桥接未连接（event_type=%s）", event_type)
        return False
    msg = {
        "type": "desktop.event",
        "event_type": event_type,
        "payload": payload or {},
        "timestamp": time.time(),
    }
    try:
        asyncio.run_coroutine_threadsafe(_do_send_event(ws, msg), loop)
        return True
    except RuntimeError as e:
        logging.warning("send_event 调度失败（event_type=%s）：%s", event_type, e)
        return False


async def _do_send_event(ws, msg: dict) -> None:
    try:
        await ws.send(json.dumps(msg, ensure_ascii=False))
    except Exception as e:
        logging.warning("推送 desktop.event 失败：%s", e)


async def one_connection(url: str, token: str | None, init_payload: dict) -> None:
    loop = asyncio.get_running_loop()
    try:
        async with websockets.connect(url, ping_interval=20, ping_timeout=120) as ws:
            _set_active_bridge(ws, loop)
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
                try:
                    worker_req = build_worker_request(pl)
                except UnknownBridgeAction as exc:
                    # 未登记的 action 直接回错误，绝不能误路由成 run_task
                    logging.warning("拒绝未知桥接 action: %s", exc)
                    out: dict = {"ok": False, "error": str(exc)}
                else:
                    # vlm 配置由 server 附加在 payload 顶层，仅 run_task 会消费
                    if isinstance(pl.get("vlm"), dict):
                        worker_req["vlm"] = pl.get("vlm")
                    out = await run_stdio_worker_on_pc(worker_req, job_id)
                await ws.send(
                    json.dumps(
                        {
                            "type": "desktop.bridge.result",
                            "payload": {"jobId": job_id, **out},
                        },
                        ensure_ascii=False,
                    )
                )
    finally:
        _clear_active_bridge()


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

    # 启动桌面事件监听（焦点变化 + 窗口开闭，SetWinEventHook + 独立消息循环线程）。
    # listener 在 ws 重连期间也保持运行：send_event 在无活动桥接时会安全返回 False，
    # 不会因 ws 未连接而抛错。此处 try/finally 保证 bridge 退出时调用 stop。
    from desktop_visual.event_subscribers import (
        start_focus_listener,
        start_scene_reporter,
        start_window_listener,
        stop_focus_listener,
        stop_scene_reporter,
        stop_window_listener,
    )

    start_focus_listener()
    start_window_listener()
    # 场景心跳：每 30s 上报前台窗口，供 server 情境感知计算停留时长
    # （DESKTOP_SCENE_TICK_SECONDS=0 可关闭；默认 30s，钳制在 10-300s）
    try:
        tick = float(os.environ.get("DESKTOP_SCENE_TICK_SECONDS", "30") or "30")
    except ValueError:
        tick = 30.0
    if tick > 0:
        start_scene_reporter(tick)
    try:
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
    finally:
        stop_focus_listener()
        stop_window_listener()
        stop_scene_reporter()


if __name__ == "__main__":
    asyncio.run(main())
