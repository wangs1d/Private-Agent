# Agent 纯语音对话模式 —— PySide6 悬浮球

独立的桌面语音对话客户端，以外置悬浮球形态与 PAI server 通信。

## 设计状态

| 状态 | 尺寸 | 说明 |
|------|------|------|
| 小球态 | 48×48 | 右下角可拖拽蓝色悬浮球，呼吸光晕 |
| 唤醒展开态 | 280×56 | 胶囊条，显示「你好，我在」+ 声波 |
| 聆听/对话态 | 320×140 | 面板，显示「正在聆听」+ 实时字幕 + 音量波形 |
| 播报态 | 320×140 | 面板，显示「正在回复」+ Agent 回复文本 |

## 交互

- **点击小球**：展开唤醒态
- **点击胶囊条**：开始录音
- **再次点击 / 自动停录**：结束录音并送 ASR
- **右上角「↩ 页面模式」**：隐藏悬浮球并通过 stdout 通知 Flutter 客户端恢复页面

## 运行

```powershell
# 安装依赖（首次）
python -m pip install -r requirements.txt

# 启动
.\start-voice-orb.ps1
```

环境变量（可选）：

- `PAI_WS_URL`：WebSocket 地址，默认 `ws://127.0.0.1:3000/ws`
- `PAI_HTTP_BASE`：HTTP 地址，默认 `http://127.0.0.1:3000`
- `PAI_SESSION_ID` / `PAI_ACTOR_ID` / `PAI_USER_ID`

## 与 Flutter 客户端集成

Flutter 桌面端（Windows）点击输入框 mic 按钮后：
1. 启动 `client/voice-orb-py/main.py` 子进程
2. 通过 `window_manager.hide()` 隐藏主窗口
3. 监听子进程 stdout
4. 收到 `__VOICE_ORB_EVENT__:PAGE_MODE_REQUESTED` 后调用 `windowManager.show()` 恢复窗口

详见 `client/flutter_app/lib/main.dart` 中 `_invokeVoiceOrb` / `_onVoiceOrbStdout`。
