# Agent 纯语音对话模式 —— PySide6 声纹波形（无常驻悬浮球）

独立的桌面语音对话客户端，与 PAI server 通信。
**桌面上没有常驻 UI**：待机时 orb 隐身运行（只跑唤醒监听），唤醒或对话进行时
屏幕下方浮现一块声纹波形，对话结束自动淡出。设计详见 `docs/voice-mode-architecture.md`。

## 形态与状态

| 状态 | 桌面表现 |
|------|----------|
| 待机（唤醒监听中） | 什么都没有（进程隐身） |
| 聆听 | 蓝色声纹，随麦克风实时响度起伏 |
| 思考 | 琥珀色声纹，缓慢行进 |
| 播报 | 绿色声纹，随音节包络起伏（TTS 播放中） |
| 提示（没听清/断线/静音…） | 灰色声纹 + 一句提示，2.6s 后淡出 |

## 交互

- **语音唤醒**："小助手 / 嘿助手 / 嘿agent…"（Phase 2 计划换本地热词模型）
- **免按键连续对话**：说完静默 700ms 自动提交；播报结束后保持 10s 追问窗口，
  开口即继续，无需再喊唤醒词
- **打断（barge-in lite）**：播报中持续开口 ~0.5s → 停播直接回聆听
- **语音退出**："打开界面 / 回到页面 / 退出语音…" → 恢复 Flutter 主窗口并退出
- **波形右键菜单**：打开主界面 / 静音
- **故障自愈**：麦克风不可用 → 通知父进程恢复主窗口后退出（不会"失联"）

## 运行

```powershell
# 安装依赖（首次）
python -m pip install -r requirements.txt

# 启动
.\start-voice-orb.ps1
```

环境变量（可选，正常由 Flutter 客户端注入）：

- `PAI_WS_URL`：WebSocket 地址，默认 `ws://127.0.0.1:3000/ws`
- `PAI_HTTP_BASE`：HTTP 地址，默认 `http://127.0.0.1:3000`
- `PAI_SESSION_ID` / `PAI_ACTOR_ID` / `PAI_USER_ID`
- `PAI_ORB_PARENT_PID`：父进程 PID（父进程退出后 orb 自动跟随退出）

## 与 Flutter 客户端集成

Flutter 桌面端（Windows）点击输入框 mic 按钮后：
1. 启动 `client/voice-orb-py/main.py` 子进程（隐身）
2. 收到 `__VOICE_ORB_EVENT__:ORB_READY` 后 `windowManager.hide()` 隐藏主窗口，
   并向服务端上报 `mode.changed {active:true}`
3. 监听子进程 stdout：
   - `PAGE_MODE_REQUESTED`：恢复主窗口 + 上报 `mode.changed {active:false}`
   - `MIC_UNAVAILABLE`：立即恢复主窗口（麦克风不可用兜底）
4. orb 进程退出（含崩溃）时恢复主窗口

语音/文字共用同一条会话（`PAI_SESSION_ID`），上下文与记忆在两种模式间连续。

详见 `client/flutter_app/lib/main.dart` 中 `_invokeVoiceOrb` / `_onVoiceOrbStdout` /
`_handleSurfaceShow`。
