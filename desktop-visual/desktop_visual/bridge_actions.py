"""服务端 → stdio_worker 的 action 字段白名单映射。

bridge_ws_client 把 server 的 desktop.bridge.invoke payload 转成 stdio_worker
请求时，只允许透传各 action 声明过的字段；未知 action 直接抛
UnknownBridgeAction 拒绝，而不是像历史实现那样掉进默认分支被静默当成
run_task(task=None) 而必然失败。

字段名与 server/src/services/desktop-visual-subprocess.ts 的 spawn payload
保持一致（run_input 用 inputAction，run_automation 用 action_name）。
"""
from __future__ import annotations

# action → 允许透传给 stdio_worker 的字段（白名单；vlm 由调用方单独附加）
ACTION_FIELD_ALLOWLIST: dict[str, tuple[str, ...]] = {
    "screenshot": ("region", "display", "maxDim"),
    "open": ("target", "path"),
    "uia_query": ("mode", "selector", "point", "topOnly", "limit", "windowTitle", "maxDepth"),
    "run_shell": ("command", "shell", "cwd", "timeoutMs", "allowDestructive"),
    "show_message": ("text", "durationMs", "fontSize", "bgColor", "fgColor"),
    "run_input": (
        "inputAction", "x", "y", "toX", "toY", "button", "text", "key", "keys",
        "scrollClicks", "scrollX", "interval", "moveDuration", "waitMs", "waitS",
        "holdSeconds", "imageWidth", "imageHeight", "coordSpace", "display",
    ),
    "run_automation": ("action_name", "selector", "value", "index", "topOnly", "windowTitle"),
    "http_get": ("url", "headers", "timeoutMs"),
    "web_search": ("query", "limit"),
    "web_fetch": ("url",),
    "window": ("windowOp", "title", "index", "hwnd", "x", "y", "width", "height"),
    "clipboard": ("clipboardOp", "text"),
    "run_task": ("task", "maxSteps", "region", "stub", "vlm", "maxScreenshotDim"),
    # 情境感知专用（不暴露给 LLM 工具循环）：文档文本提取 / 系统通知勿扰
    "read_document": ("path", "maxChars"),
    "set_dnd": ("dndOp",),
}


class UnknownBridgeAction(ValueError):
    """服务端下发了未登记的 action；直接拒绝而非误路由到 run_task。"""


def build_worker_request(payload: dict) -> dict:
    """把 desktop.bridge.invoke payload 转成 stdio_worker 请求。

    抛出 UnknownBridgeAction 表示 action 未登记；调用方应把错误回传给
    server，而不是降级成 run_task。
    """
    action = str(payload.get("action") or "run_task").strip()
    fields = ACTION_FIELD_ALLOWLIST.get(action)
    if fields is None:
        raise UnknownBridgeAction(f"不支持的桥接 action: {action!r}")
    req: dict = {"action": action}
    for name in fields:
        value = payload.get(name)
        if value is not None:
            req[name] = value
    return req
