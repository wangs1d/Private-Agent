# Tasks

- [ ] Task 1: 桌面 bridge 主动事件推送通道
  - [ ] SubTask 1.1: 在 `desktop-visual/desktop_visual/bridge_ws_client.py` 增加主动推送方法（如 `send_event(event_type, payload)`），复用现有 ws 连接发送 `desktop.event` 类型消息，与 `desktop.bridge.invoke` 请求-响应通道并存且互不阻塞
  - [ ] SubTask 1.2: 在 `server/src/services/desktop-visual-subprocess.ts` 或 `desktop-bridge-coordinator.ts` 增加对 `desktop.event` 消息类型的接收处理，转发给订阅器
  - [ ] SubTask 1.3: 验证 Python 端 send_event 调用后 server 端能收到对应消息，且不影响现有 invoke 通道

- [ ] Task 2: Python 端窗口焦点变化监听
  - [ ] SubTask 2.1: 在 `desktop-visual/desktop_visual/` 新建事件订阅模块（如 `event_subscribers.py`），用 ctypes 或 pywin32 的 SetWinEventHook 注册 EVENT_SYSTEM_FOREGROUNDWINDOW 回调
  - [ ] SubTask 2.2: 回调中提取窗口标题（GetWindowText）、进程名（GetWindowThreadProcessId + psutil.Process.name），节流（同窗口 5s 内不重复发）
  - [ ] SubTask 2.3: 通过 Task 1 的 send_event 推送 focus_change 事件到 server
  - [ ] SubTask 2.4: 在 bridge 启动时启动事件订阅，停止时卸载 hook 释放资源

- [ ] Task 3: Python 端 UIAutomation 事件订阅
  - [ ] SubTask 3.1: 在事件订阅模块中用 uiautomation 库或 comtypes 调用 AddAutomationEventHandler，订阅 WindowOpened/WindowClosed 事件
  - [ ] SubTask 3.2: 回调中提取窗口标题、进程名、UIA 元素类型（ControlType），节流（同进程 10s 内不重复发 WindowOpened）
  - [ ] SubTask 3.3: 通过 send_event 推送 window_open/window_close 事件到 server
  - [ ] SubTask 3.4: 确保事件订阅在独立线程运行，不阻塞 stdio_worker 的 invoke 响应

- [ ] Task 4: server 端桌面事件转 LifeSignal
  - [ ] SubTask 4.1: 在 `desktop-bridge-coordinator.ts` 中将收到的 `desktop.event` 消息按 event_type 转换为 LifeSignal（focus_change → kind=`desktop_focus_change`，window_open → kind=`desktop_window_open`，source=`desktop`）
  - [ ] SubTask 4.2: 调用 LifeSignalHub.publish 发布信号，信号 payload 含 title/process/event_type/timestamp
  - [ ] SubTask 4.3: 验证 BrainStem sweepOnce 能在 recentSignals 中看到新信号

- [ ] Task 5: BrainStem 感知预算机制
  - [ ] SubTask 5.1: 在 `brain-stem.ts` 增加 `currentSampleInterval` 状态与 `adjustSampleRate(activityState)` 方法，按 idle=45s / busy=90s / sleeping=300s 调整
  - [ ] SubTask 5.2: 在每次 sweepOnce 结束时调用 awareness.observe 获取活动状态，若状态变化则 clearInterval + 按新间隔 setInterval
  - [ ] SubTask 5.3: 保留 SWEEP_INTERVAL_MS 作为 idle 默认值，新增 BUSY_SAMPLE_MS=90000、SLEEPING_SAMPLE_MS=300000 常量
  - [ ] SubTask 5.4: 验证 busy 时心跳间隔变为 90s，切回 idle 恢复 45s

- [ ] Task 6: PlannerCortex shouldDelegate 主动判断
  - [ ] SubTask 6.1: 在 `planner-cortex.ts` 新增 `shouldDelegate(userMessage, context): { delegate: boolean, agentType?: SubAgentType, reason?: string }` 方法，基于规则判断（关键词匹配 RPA/搜索/对比 + 步骤数估算 > 3）
  - [ ] SubTask 6.2: 在 routeSystem 或 cognize 入口处调用 shouldDelegate，若返回 delegate=true 则直接调 this.delegate()，跳过 standard path
  - [ ] SubTask 6.3: shouldDelegate 规则需保守（避免误委派简单任务），含明确的"不委派"白名单（如时间/天气/打招呼）
  - [ ] SubTask 6.4: 验证复杂 RPA 任务被主动委派，简单问答走原路径

# Task Dependencies
- Task 2、Task 3 依赖 Task 1（推送通道先行）
- Task 4 依赖 Task 1（接收端依赖消息协议）
- Task 1、Task 5、Task 6 相互独立，可并行启动
- Task 2 与 Task 3 可并行（都是 Python 端事件订阅，但订阅不同事件源）

# 验证阶段发现的修复任务

- [ ] 修复 Task 5 验证发现：`server/test/brain-subcortical.test.ts` 中 `BrainStem: 重复抑制——同 kind 30min 内不重复发` 为时间相关 flaky 测试，深夜（23:00–5:00）运行时失败。
  - 现象：断言 `stem.snapshot().syntheticSignalsEmitted === 1` 失败，实际为 2。根因是 `makeLifeSignal()` 默认 `source: "desktop"` + `occurredAt: now`，深夜运行时 `sweepActor` 的 `late_night_active` 检测命中（hour>=23||hour<=5 且最近 desktop 信号在 10 分钟内），首次 sweep 同时发出 `late_night_active` 与 `trend_reversal_upward` 两条合成信号，导致计数为 2。
  - 影响范围：仅该测试在深夜时段失败；trend_reversal 重复抑制本身正常（reversalCount=1）。与 Task 5 感知预算机制无关（awareness mock 返回 null，`observeAndAdjustSampleRate` 不触发 `adjustSampleRate`）。
  - 修复建议（任选其一）：
    1. 该测试用例显式构造非 desktop 源信号（如 `makeLifeSignal({ source: "agent_inference", kind: "transaction_completed" })`），避开 `late_night_active` 触发条件；或
    2. 该测试用例 mock `Date.now`/`new Date()` 将小时固定在白天（如 12 点）；或
    3. 在 `late_night_active` 检测中允许测试注入时钟，使断言不依赖真实系统时间。
  - 验证方式：在 23:00–5:00 时段重跑 `cd server; npx tsx --test test/brain-subcortical.test.ts`，该用例应通过。
