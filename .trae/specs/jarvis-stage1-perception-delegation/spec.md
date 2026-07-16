# 第一阶段：持续感知 + 任务委派 Spec

## Why
当前 BrainStem 仅靠 45s 固定轮询感知，会漏掉短时事件（窗口切换、对话框弹出）；任务委派完全靠主 Agent LLM 被动决定，无规则层主动 delegate。感知是输入端、委派是执行端，这两端不补齐，中间的认知/决策/行动都是空中楼阁。本阶段补齐「感知→认知→委派执行」主回路。

## What Changes
- 桌面 bridge 增加主动事件推送通道（与现有 `desktop.bridge.invoke` 请求-响应通道并存）
- Python desktop-visual 端实现窗口焦点变化监听（SetWinEventHook + WinEventProc）
- Python desktop-visual 端实现 UIAutomation 事件订阅（窗口打开/关闭、控件状态变化）
- server 端接收桌面事件推送并 publish 为 LifeSignal
- BrainStem 增加感知预算机制（用户 busy/sleeping 时动态降采样）
- PlannerCortex 增加 `shouldDelegate` 主动判断（规则层主动 delegate，非等 LLM 决定）

## 暂缓项（非本阶段范围）
- 文件系统监控：场景较窄，后续按需补
- 剪贴板监听：隐私敏感，需用户明确需求
- `creative` 子 Agent 类型：当前 life/tech/info 三类已覆盖主要场景

## Impact
- Affected specs: `add-agent-brain-center`、`extend-brain-neuroanatomy`、`optimize-token-consumption`
- Affected code:
  - `desktop-visual/desktop_visual/bridge_ws_client.py`（新增主动推送通道）
  - `desktop-visual/desktop_visual/`（新增事件订阅模块）
  - `server/src/services/desktop-bridge-coordinator.ts`（接收事件推送）
  - `server/src/services/desktop-visual-subprocess.ts`（事件推送协议）
  - `server/src/services/life-signal-hub-service.ts`（新信号源）
  - `server/src/brain/brain-stem.ts`（感知预算 + 动态采样）
  - `server/src/brain/awareness-cortex.ts`（暴露活动状态给 BrainStem）
  - `server/src/brain/planner-cortex.ts`（shouldDelegate 判断）

## ADDED Requirements

### Requirement: 桌面 bridge 主动事件推送通道
系统 SHALL 在桌面 bridge 上增加主动事件推送通道，使 Python 端能主动推送事件到 server，而非仅响应 invoke 请求。

#### Scenario: 窗口焦点变化推送
- **WHEN** 用户切换前台窗口
- **THEN** Python 端通过主动推送通道发送 `desktop.event` 消息到 server
- **AND** 消息含事件类型（focus_change）、窗口标题、进程名、时间戳
- **AND** 不阻塞现有 `desktop.bridge.invoke` 请求-响应通道

### Requirement: 窗口焦点变化监听
系统 SHALL 在 Python desktop-visual 端通过 SetWinEventHook 监听窗口焦点变化事件，而非仅一次性 GetForegroundWindow 查询。

#### Scenario: 用户切换应用
- **WHEN** 用户从浏览器切换到 IDE
- **THEN** Python 端捕获 EVENT_SYSTEM_FOREGROUNDWINDOW 事件
- **AND** 提取窗口标题与进程名
- **AND** 通过主动推送通道发送 focus_change 事件到 server

### Requirement: UIAutomation 事件订阅
系统 SHALL 在 Python desktop-visual 端通过 UIAutomation AddAutomationEventHandler 订阅窗口打开/关闭事件，补充焦点变化信号。

#### Scenario: 新窗口打开
- **WHEN** 应用弹出新窗口或对话框
- **THEN** Python 端捕获 WindowOpened 事件
- **AND** 通过主动推送通道发送 window_open 事件到 server
- **AND** 事件含窗口标题、进程名、UIA 元素类型

### Requirement: 桌面事件转 LifeSignal
系统 SHALL 在 server 端接收桌面事件推送并 publish 为 LifeSignal，使 BrainStem/ProactionCortex 能消费。

#### Scenario: 收到 focus_change 事件
- **WHEN** server 收到 Python 端推送的 focus_change 事件
- **THEN** 转换为 LifeSignal（kind=`desktop_focus_change`，source=`desktop`）
- **AND** publish 到 LifeSignalHub
- **AND** 信号含 title/process/duration 等元数据

### Requirement: BrainStem 感知预算机制
系统 SHALL 让 BrainStem 根据用户活动状态动态调整心跳采样率，避免 busy/sleeping 时浪费资源。

#### Scenario: 用户 busy 时降采样
- **WHEN** AwarenessCortex.observe 返回 `busy`
- **THEN** BrainStem 心跳间隔从 45s 调整为 90s
- **AND** 切回 idle 时恢复 45s

#### Scenario: 用户 sleeping 时深度降采样
- **WHEN** AwarenessCortex.observe 返回 `sleeping`
- **THEN** BrainStem 心跳间隔从 45s 调整为 300s
- **AND** 切回 idle/busy 时恢复对应采样率

### Requirement: PlannerCortex 主动 shouldDelegate 判断
系统 SHALL 在 PlannerCortex 增加规则层 `shouldDelegate` 判断，对符合委派条件的任务主动 delegate，而非完全依赖主 Agent LLM 决定。

#### Scenario: 复杂 RPA 任务主动委派
- **WHEN** 用户请求涉及多步 RPA 操作（如"打开浏览器查三个网站并对比价格"）
- **AND** 任务步骤数估算 > 3
- **THEN** PlannerCortex.shouldDelegate 返回 true
- **AND** 主动调用 delegate 委派给 tech 子 Agent
- **AND** 不等待主 Agent LLM 自行决定是否调 delegate 工具

#### Scenario: 简单任务不委派
- **WHEN** 用户请求是单步操作或简单问答（如"现在几点"）
- **THEN** PlannerCortex.shouldDelegate 返回 false
- **AND** 走原 standard path 或 fast_chat 路径
