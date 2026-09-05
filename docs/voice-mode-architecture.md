# 语音模式架构（Voice Mode / 竖波悬浮件）

> 目标：切入语音模式后，主窗口退场，**所有交互由对话完成**；桌面上没有任何画面，
> 只有一枚**常驻的竖波悬浮件**——细长的竖向波纹胶囊（无框/透明/置顶/不抢焦点），
> 波纹随对话状态起伏。悬停悬浮件 → 右侧滑出「界面模式」选择组件，点击切回界面模式。
> 信息面板（今日安排、图片/视频等）不再依赖按钮/侧栏，而是**通过对话召唤**，
> 以临时浮层卡呈现在悬浮件左侧（自动淡出、可关闭）。
>
> 本文基于现有代码实际链路（含文件行号），Phase 1 已按此落地。

---

## 1. 形态定义

| 状态 | 桌面上可见的东西 |
|---|---|
| 待机 | **竖波悬浮件**（深灰波纹慢呼吸），常驻可见，orb 同步跑唤醒监听 |
| 聆听 / 思考 / 播报 | 悬浮件波纹变色加速（蓝/琥珀/绿），随麦响度/音节包络起伏 |
| 对话召唤 | 悬浮件左侧浮现**浮层卡**（今日安排 / 图片视频墙），TTL 自动淡出、可关闭 |
| 悬停悬浮件 | 右侧滑出「界面模式」选择组件，点击切回完整界面模式 |
| 主窗口 | 进入语音模式即 hide（进程保留、WS 保持），悬浮件/语音口令恢复 |

语音模式 = `Flutter 主窗口隐藏 + 竖波悬浮件常驻 + 唤醒监听`；
退出语音模式 = 恢复主窗口 + orb 进程结束。再次进入走 ChatPage 的 mic 按钮。

## 2. 组件与链路

```
┌─ Flutter 主进程（窗口已隐藏，WS 保持）────────────────────┐
│  main.dart                                                │
│   · _invokeVoiceOrb：拉起 orb 进程（env 注入 session 等）    │
│   · stdout 事件：ORB_READY / PAGE_MODE_REQUESTED /         │
│     MIC_UNAVAILABLE / PARENT_EXITED / STARTUP_FAILED       │
│   · WS: mode.changed 上报；surface.show 处理                │
│     （语音模式下 _voiceOrbReady 守卫让位给 orb）             │
│   · ScheduleFloatingLauncher → Win32 悬浮窗（页面模式用）    │
└──────────────┬────────────────────────────────────────────┘
               │ WS (同一 sessionId，语音/文字共享上下文)
┌──────────────▼───────────── server ───────────────────────┐
│  chat.user_message → LLM（工具含 surface.show）             │
│  surface.show → trySend(actorId, {surface, ttlSeconds})    │
│  （registry 按 actor fan-out：orb 与 Flutter 都收到）        │
│  chat.media_ready / assistant_done.mediaCards →             │
│  （发到发起轮次的 socket，语音模式下即 orb 的连接）           │
│  voice-mode-state.ts：记录 actor 当前是否处于语音模式         │
└──────────────┬────────────────────────────────────────────┘
┌──────────────▼──────── client/voice-orb-py（独立进程）──────┐
│  VerticalWaveOrb：常驻竖波悬浮件（待机/聆听/思考/播报/提示）   │
│    · 左键点击 = 点击说话开关；拖动换位；右键静音/打开主界面     │
│    · 悬停 → ModeSelector（「界面模式」，右侧滑出）           │
│    · 悬停 → StatusPill 状态提示（上方）                     │
│  CardStack：悬浮件左侧浮层卡（日程/媒体/文本）               │
│    · surface.show(today_schedule) → GET /api/schedule/today │
│    · chat.media_ready / mediaCards → 缩略图墙，点击浏览器打开 │
│  WakeListener：唤醒词（滑窗 ASR 匹配；Phase2 换本地热词模型）  │
│  ListeningRecorder：VAD 端点检测（静默 700ms / 上限 20s）     │
│  ASR: POST /brain/sensory/listen → 文本                     │
│  退出（「界面模式」/ 口令）→ PAGE_MODE_REQUESTED → 进程退出    │
│  chat.user_message → assistant_chunk/done →                 │
│  TTS: POST /brain/sensory/speak → QMediaPlayer 播放          │
└─────────────────────────────────────────────────────────────┘
```

## 3. Surface-on-Demand（对话召唤浮层卡）

- 服务端新工具 `surface.show({ surface, ttlSeconds })`
  （`server/src/tools/surface-tools.ts`），经 WS 下发
  `surface.show` 事件（`ServerEventType.SurfaceShow`）。
- **语音模式（orb 常驻）**：orb 收到后按 surface 名执行——
  - `today_schedule`：`GET /api/schedule/today?sessionId=<actorId>` 自取数据
    → `ScheduleCard` 时间轴（TTL 默认 30s）。Flutter 侧 `_handleSurfaceShow`
    有 `_voiceOrbReady` 守卫，不再召唤原生日程窗（避免双份）。
  - LLM 同时用文本回答（orb 会 TTS 朗读）——**念 + 显双通道**：语音给摘要，
    悬浮件旁的浮层卡给可视化细节。
- **页面模式**：`main.dart _handleSurfaceShow` 原路径——
  `_loadTodayScheduleFuture()` 取今日事项 → 映射 `ScheduleFloatingItem` →
  `ScheduleFloatingLauncher.show() + setSchedule()` → TTL 后自动隐藏
  （召唤前已常驻的窗口只刷新数据、不自动隐藏）。
- 反向语音操作复用现有链路：改日程 → LLM 调 schedule 工具 →
  `schedule.tasks_changed` → 客户端 `_syncScheduleFromServer()` 刷新本地数据。
- 媒体结果（照片/视频）：`search_images` / `search_videos` 完成 →
  `chat.media_ready`（边说边出图）与 `chat.assistant_done.mediaCards` →
  orb `MediaCard` 缩略图墙（最多 6 块，视频 ▶ 角标，点击浏览器打开），
  `(traceId, thumbnailUrl)` 去重。页面模式下仍进聊天流卡片。
- Phase 2 候选 surface：`morning_briefing`（早报卡）、`reminder_confirm`
  （提醒确认卡，语音 yes/no 回传 outcome）、`weather`（`TextCard` 即可承接）。

## 4. 语音交互栈（Phase 1 行为）

1. **唤醒 / 点击说话**：WakeListener 持续监听（响度门限 + 1.5s 滑窗 ASR +
   唤醒词文本匹配）；或左键点击悬浮件直接开始聆听（再点取消）。
   触发 → 悬浮件切聆听态 → 停唤醒监听释放麦克风 → 开录音。
2. **免按键连续对话**：ListeningRecorder 能量 VAD——超阈值判定开始说话，
   静默 700ms 判定说完（上限 20s），自动提交 ASR，无需任何按键。
3. **打断（barge-in lite）**：TTS 播放期间跑 RMS 监视，持续 ~0.5s 人声
   （或点击悬浮件）→ 停止播放直接回到聆听态（规避回声问题，Phase 3 上
   AEC 全双工）。
4. **追问窗口**：播报结束后保持聆听 ~10s，开口即继续（无需再喊唤醒词）；
   静默超时 → 悬浮件回待机呼吸，继续唤醒待命。
5. **模式切换（两条等价入口）**：悬停悬浮件 → 右侧「界面模式」组件点击；
   或语音口令 `打开界面 / 回到页面 / 显示主界面 / 退出语音…`
   → 打印 `PAGE_MODE_REQUESTED` → orb 进程退出 → Flutter 恢复主窗口并上报
   `mode.changed(false)`。
6. **故障自愈**：麦克风不可用 → orb 打印 `MIC_UNAVAILABLE` 后退出，
   Flutter 立即恢复主窗口（不会出现"窗口消失且无法找回"）。

## 5. 协议改动

| 事件 | 方向 | 说明 |
|---|---|---|
| `mode.changed` | 客户端→服务端 | `{active: bool, source}`；服务端 `voice-mode-state.ts` 记录 per-actor 状态（诊断/后续投递矩阵用） |
| `surface.show` | 服务端→客户端 | `{surface, ttlSeconds, jobId}`；未实现的客户端忽略即可 |

## 6. 分期路线图

- **Phase 1（本次）**：波形形态改造、VAD 连续对话、`surface.show`/今日安排、
  语音退出、故障自愈、mode.changed 上报。
- **Phase 2**：sherpa-onnx 本地唤醒热词（替换滑窗 ASR 唤醒）、分句流式 TTS
  （降低首响应延迟）、新 Surface（早报/提醒确认）、主动消息语音化投递
  （delivery-service 在 `voice-mode` 在场态改走 TTS + 悬浮卡）。
- **Phase 3**：AEC 全双工、分句级 barge-in、orb 收编为 Win32 原生窗口、
  结合 `/brain/sensory/look` 的桌面视觉感知。

## 7. 关键文件

| 文件 | 职责 |
|---|---|
| `client/voice-orb-py/voice_orb/app.py` | orb 全部：竖波悬浮件、模式选择、浮层卡、唤醒、录音、ASR/TTS、WS |
| `client/flutter_app/lib/main.dart` | orb 进程管理、stdout 事件、`surface.show` 处理（语音模式让位 orb）、`mode.changed` 上报 |
| `server/src/tools/surface-tools.ts` | `surface.show` 工具（LLM 可调用） |
| `server/src/proactivity/voice-mode-state.ts` | per-actor 语音模式状态（内存态，Phase 2 投递矩阵消费） |
| `server/src/ws/connection.ts` | `mode.changed` 事件接入 |
| `server/src/protocol.ts` | 事件类型定义 |
| `server/src/external-model/openai-compatible-tool-loop.ts` | `surface.show` 的 LLM schema |
