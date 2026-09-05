# Agent 纯语音对话模式 —— 常驻声纹胶囊

独立的桌面语音对话客户端，与 PAI server 通信。
**桌面上只有一枚常驻的横向玻璃胶囊**（无框/半透明/置顶/不抢焦点，黑白单色）：
左侧状态呼吸点 + 中部横向声纹条 + 右侧状态文字，停靠屏幕底部居中，
即语音模式的"化身"。设计详见 `docs/voice-mode-architecture.md`。

## 形态与状态

| 状态 | 悬浮件表现 |
|------|------------|
| 待机 | 声纹条慢呼吸，胶囊半透静置（常驻可见） |
| 聆听 | 声纹条随麦克风实时响度起伏，右侧「聆听中」 |
| 思考 | 声纹条行进波动，右侧「思考中」 |
| 播报 | 声纹条随音节包络起伏（TTS 播放中），右侧「播报中」 |
| 提示（没听清/断线/静音…） | 声纹条微动 + 下方提示药丸，随后回待机 |

## 交互

- **语音唤醒**："小助手 / 嘿助手 / 嘿agent…"（Phase 2 计划换本地热词模型）
- **点击说话**：左键点击悬浮件（未拖动）即开始聆听，免唤醒词；再点取消
- **免按键连续对话**：说完静默 700ms 自动提交；播报结束后保持 10s 追问窗口，
  开口即继续，无需再喊唤醒词
- **打断（barge-in lite）**：播报中持续开口 ~0.5s → 停播直接回聆听
- **模式切换**：鼠标悬停悬浮件 → **下方滑出「界面模式」选择组件**，点击切回
  完整界面模式（等价于语音说"打开界面"）；悬浮件可拖动换位置
- **右键菜单**：打开主界面 / 静音
- **浮层卡片（对话直达能力）**：对话中 agent 召唤的信息面板自动淡出、可关闭、
  悬停暂停淡出。分两类呈现：
  - **今日安排（侧卡）**：agent 调 `surface.show(today_schedule)` → orb 拉
    `GET /api/schedule/today` 在悬浮件左侧渲染时间轴（TTL 默认 30s）
  - **图片/视频（中央展示页）**：`search_images` / `search_videos` 完成 →
    `chat.media_ready` / `chat.assistant_done(mediaCards)` → `CenterStage`
    **屏幕中央大图展示**（3 列大块、视频带 ▶ 角标，点击用系统浏览器打开）。
    **不会自动消失**：点 ✕ 关闭，或对话说「把图片收了」→
    LLM 调 `surface.dismiss` → orb 收起展示页
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
1. 启动 `client/voice-orb-py/main.py` 子进程（竖波悬浮件常驻桌面）
2. 收到 `__VOICE_ORB_EVENT__:ORB_READY` 后 `windowManager.hide()` 隐藏主窗口，
   并向服务端上报 `mode.changed {active:true}`
3. 监听子进程 stdout：
   - `PAGE_MODE_REQUESTED`（悬停「界面模式」/ 语音口令）：恢复主窗口 +
     上报 `mode.changed {active:false}`，orb 进程退出
   - `MIC_UNAVAILABLE`：立即恢复主窗口（麦克风不可用兜底）
4. orb 进程退出（含崩溃）时恢复主窗口

语音/文字共用同一条会话（`PAI_SESSION_ID`），上下文与记忆在两种模式间连续。
语音模式下 `surface.show` 由 orb 消费（`main.dart _handleSurfaceShow` 里有
`_voiceOrbReady` 守卫让位），页面模式下仍走原生的 ScheduleFloatingLauncher。

详见 `client/flutter_app/lib/main.dart` 中 `_invokeVoiceOrb` / `_onVoiceOrbStdout` /
`_handleSurfaceShow`。
