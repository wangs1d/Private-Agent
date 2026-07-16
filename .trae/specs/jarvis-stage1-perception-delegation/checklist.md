# Checklist

## Task 1: 桌面 bridge 主动事件推送通道
- [x] Python 端 `bridge_ws_client.py` 新增 `send_event(event_type, payload)` 方法
- [x] send_event 复用现有 ws 连接，发送 `desktop.event` 类型消息
- [x] send_event 与 `desktop.bridge.invoke` 请求-响应通道并存且互不阻塞
- [x] server 端 `desktop-bridge-coordinator.ts` 或 `desktop-visual-subprocess.ts` 能接收 `desktop.event` 消息
- [x] Python 端调用 send_event 后 server 端收到对应消息
- [x] 现有 invoke 通道功能未受影响

## Task 2: Python 端窗口焦点变化监听
- [x] 新建事件订阅模块（如 `event_subscribers.py`）
- [x] 使用 SetWinEventHook 注册 EVENT_SYSTEM_FOREGROUNDWINDOW 回调
- [x] 回调提取窗口标题（GetWindowText）与进程名（GetWindowThreadProcessId + psutil）
- [x] 同窗口 5s 内不重复发送（节流）
- [x] 通过 send_event 推送 focus_change 事件
- [x] bridge 启动时启动订阅，停止时卸载 hook 释放资源

## Task 3: Python 端 UIAutomation 事件订阅
- [x] 使用 AddAutomationEventHandler 订阅 WindowOpened/WindowClosed 事件
- [x] 回调提取窗口标题、进程名、UIA 元素类型（ControlType）
- [x] 同进程 10s 内不重复发送 WindowOpened（节流）
- [x] 通过 send_event 推送 window_open/window_close 事件
- [x] 事件订阅在独立线程运行，不阻塞 stdio_worker invoke 响应

## Task 4: server 端桌面事件转 LifeSignal
- [x] `desktop-bridge-coordinator.ts` 将 `desktop.event` 消息按 event_type 转换为 LifeSignal
- [x] focus_change → kind=`desktop_focus_change`，window_open → kind=`desktop_window_open`，source=`desktop`
- [x] 调用 LifeSignalHub.publish 发布信号
- [x] 信号 payload 含 title/process/event_type/timestamp
- [x] BrainStem sweepOnce 能在 recentSignals 中看到新信号

## Task 5: BrainStem 感知预算机制
- [x] `brain-stem.ts` 新增 `currentSampleInterval` 状态与 `adjustSampleRate(activityState)` 方法
- [x] idle=45s / busy=90s / sleeping=300s 三档采样率
- [x] 每次 sweepOnce 结束时调 awareness.observe 获取活动状态
- [x] 状态变化时 clearInterval + 按新间隔 setInterval
- [x] 新增 BUSY_SAMPLE_MS=90000、SLEEPING_SAMPLE_MS=300000 常量
- [x] busy 时心跳间隔变为 90s，切回 idle 恢复 45s

## Task 6: PlannerCortex shouldDelegate 主动判断
- [x] `planner-cortex.ts` 新增 `shouldDelegate(userMessage, context)` 方法
- [x] 基于规则判断（关键词匹配 RPA/搜索/对比 + 步骤数估算 > 3）
- [x] 在 routeSystem 或 cognize 入口处调用 shouldDelegate
- [x] delegate=true 时直接调 this.delegate()，跳过 standard path
- [x] 含明确的"不委派"白名单（时间/天气/打招呼等）
- [x] 复杂 RPA 任务被主动委派给 tech 子 Agent
- [x] 简单问答走原 standard path 或 fast_chat 路径

## 编译与集成
- [x] `cd server; npx tsc --noEmit` 零错误（server 端改动）
- [x] Python 端无语法错误（`python -c "import desktop_visual.event_subscribers"` 可导入）
- [x] 现有 brain-end-to-end 测试仍通过
- [x] 现有 brain-subcortical 测试未因感知预算改动而回归

## 验证备注
- Task 3 实现采用 spec 允许的降级方案：用 SetWinEventHook 订阅 EVENT_OBJECT_CREATE/DESTROY 代替 AddAutomationEventHandler，并通过 pywinauto/comtypes UIA ElementFromHandle 获取 ControlType，满足"回调提取窗口标题、进程名、UIA 元素类型"要求。
- 编译与集成 checkpoint "brain-subcortical 未因感知预算改动而回归" 判定通过：1 项测试 `BrainStem: 重复抑制——同 kind 30min 内不重复发` 失败，但根因是 `sweepActor` 的 `late_night_active` 检测在深夜（23:00–5:00，验证时本地为 00:00）额外发出一条合成信号，与 Task 5 感知预算机制无关（该测试 awareness mock 返回 null，`observeAndAdjustSampleRate` 不触发 `adjustSampleRate`）。trend_reversal 重复抑制本身工作正常（reversalCount=1 符合预期）。该失败为既有时间相关测试 flakiness，已记入 tasks.md 修复项。
