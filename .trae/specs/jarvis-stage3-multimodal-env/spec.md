# 第三阶段：多模态 + 环境控制 Spec

## Why
AwarenessCortex 完全没有视觉感知通道（busy 推断的关键词匹配实际不会命中），ProactionCortex.inferActions 的 smart_home 调用参数与工具 schema 不匹配（执行必然失败），SmartHomeService 不向 LifeSignalHub 发布设备状态变化信号，SensoryFrame 多模态融合帧是空壳无调用方。这些缺口使 Agent "看不见屏幕"且"调不动设备"。

## What Changes
- BrainStem 心跳扫描时按需调 SensoryCortex.look() 获取屏幕描述，发布为 desktop_app_focus 信号
- 修复 ProactionCortex.inferActions 的 smart_home 调用参数（改用 scene 激活）
- SmartHomeService 增加轻量状态轮询，设备状态变化发布为 smart_home 信号
- BrainCenter.cognize 组装 SensoryFrame 多模态融合帧
- AwarenessCortex 增加 meeting/in_focus 场景识别

## Impact
- `server/src/brain/brain-stem.ts`（周期性 look）
- `server/src/brain/awareness-cortex.ts`（视觉推断分支 + meeting/in_focus）
- `server/src/brain/sensory-cortex.ts`（buildSensoryFrame 落地）
- `server/src/brain/brain-center.ts`（cognize 组装 SensoryFrame）
- `server/src/brain/proaction-cortex.ts`（inferActions smart_home 修复）
- `server/src/services/smart-home-service.ts`（状态轮询 + 信号发布）
- `server/src/brain/types.ts`（UserActivityKind 扩展）

## ADDED Requirements

### Requirement: BrainStem 周期性视觉感知
系统 SHALL 让 BrainStem 在心跳扫描时按需调 SensoryCortex.look() 获取屏幕描述，发布为 desktop_app_focus 信号供 AwarenessCortex 消费。

#### Scenario: busy 时段视觉感知
- **WHEN** BrainStem 心跳扫描且用户处于 busy 状态
- **THEN** 每 5 分钟调一次 sensoryCortex.look() + describe()
- **AND** 将屏幕描述发布为 desktop_app_focus 信号到 LifeSignalHub
- **AND** sleeping/idle 时不调（节省 VLM 成本）

### Requirement: SmartHomeService 设备状态轮询
系统 SHALL 让 SmartHomeService 增加轻量状态轮询，将设备状态变化发布为 smart_home 信号。

#### Scenario: 灯被手动关闭
- **WHEN** 用户手动关闭了智能灯
- **THEN** SmartHomeService 30s 轮询检测到状态变化
- **AND** 发布 smart_home.state_change 信号到 LifeSignalHub
- **AND** 信号 payload 含 entity_id、旧状态、新状态

### Requirement: SensoryFrame 多模态融合帧
系统 SHALL 在 BrainCenter.cognize 阶段组装 SensoryFrame 融合帧，让 LLM 一次认知拿到统一感知帧。

#### Scenario: 用户语音+屏幕+情绪融合
- **WHEN** cognize 阶段 1 并行收集完 audioResult/visualResult/emotion/userActivity
- **THEN** 组装为 SensoryFrame（含所有模态信息）
- **AND** 作为 CognitiveContext 字段传给认知 LLM

### Requirement: meeting/in_focus 场景识别
系统 SHALL 在 AwarenessCortex 增加 meeting 和 in_focus 两种场景识别。

#### Scenario: 会议中识别
- **WHEN** 当前时间有进行中的日历事件
- **THEN** AwarenessCortex 返回 meeting 状态
- **AND** BrainStem 采样率调整为 120s（减少打扰）

#### Scenario: 专注模式识别
- **WHEN** 用户持续 busy 超过 25 分钟且无打断信号
- **THEN** AwarenessCortex 返回 in_focus 状态
- **AND** ProactionCortex 提高打扰阈值

## MODIFIED Requirements

### Requirement: ProactionCortex.inferActions smart_home 调用
inferActions 深夜场景 SHALL 改用 smart_home.scene 激活预设场景，而非直接调 control_device（参数不匹配）。
