#!/usr/bin/env python3
"""Agent 纯语音对话模式 —— PySide6 声纹波形入口。

形态：无常驻悬浮球——待机时隐身只跑唤醒监听，唤醒/对话时浮现声纹波形。
详见 docs/voice-mode-architecture.md 与 voice_orb/app.py 模块注释。
"""
import sys

from voice_orb.app import main

if __name__ == "__main__":
    sys.exit(main())
