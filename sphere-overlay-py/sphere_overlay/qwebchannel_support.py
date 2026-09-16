"""qwebchannel.js 加载：Qt WebEngine 不自带 QWebChannel 构造器。

实测（PySide6 6.11）：setWebChannel 只注入 qt.webChannelTransport，
`QWebChannel` 全局是 undefined——桥初始化脚本直接 new QWebChannel 会抛
ReferenceError，桥静默失效。qwebchannel.js 从 Qt 内置资源
qrc:///qtwebchannel/qwebchannel.js 提取后随仓库分发（sphere_overlay/
qwebchannel.js，Qt 官方设计就是把它嵌进页面），页面 loadFinished 后
先注源码再注桥初始化——顺序确定，无 profile 脚本的异步竞态。
"""
from __future__ import annotations

from pathlib import Path

_QWEBCHANNEL_JS_PATH = Path(__file__).parent / "qwebchannel.js"


def load_qwebchannel_js() -> str:
    try:
        return _QWEBCHANNEL_JS_PATH.read_text(encoding="utf-8")
    except OSError:
        print("[sphere-overlay] 缺少 qwebchannel.js（桥功能不可用）")
        return ""
