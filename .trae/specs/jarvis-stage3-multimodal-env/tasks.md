# Tasks

- [ ] Task 1: BrainStem 周期性视觉感知
  - [ ] SubTask 1.1: 在 brain-stem.ts 新增 `periodicVisualCheck(actorId, activityState)` 方法：busy 时每 5 分钟调 sensoryCortex.look() + describe()，sleeping/idle 不调
  - [ ] SubTask 1.2: 将屏幕描述发布为 desktop_app_focus 信号（kind=`desktop_app_focus`, source=`desktop`）到 LifeSignalHub
  - [ ] SubTask 1.3: 在 sweepActor 中调用 periodicVisualCheck，用 lastVisualCheck 时间戳控制频率
  - [ ] SubTask 1.4: 注册 sensoryCortex 依赖（registerSensory 方法或构造器注入）

- [ ] Task 2: SmartHomeService 设备状态轮询
  - [ ] SubTask 2.1: 在 smart-home-service.ts 新增 `startStatePolling()` 和 `stopStatePolling()` 方法，30s 间隔轮询 getAllStates
  - [ ] SubTask 2.2: 对比上次 states 快照，检测到状态变化时调 LifeSignalHub.publish 发布 smart_home.state_change 信号
  - [ ] SubTask 2.3: 信号 payload 含 entity_id、oldState、newState、domain（light/climate/switch 等）
  - [ ] SubTask 2.4: 在 create-app-services.ts 中启动轮询（若 SmartHomeService 已配置）

- [ ] Task 3: SensoryFrame 多模态融合帧落地
  - [ ] SubTask 3.1: 在 brain-center.ts cognize 阶段 1 收集完 audioResult/visualResult/emotion/userActivity 后，调 sensory.buildSensoryFrame 组装
  - [ ] SubTask 3.2: 将 SensoryFrame 作为 CognitiveContext 的 sensoryFrame 字段
  - [ ] SubTask 3.3: 验证 buildSensoryFrame 正确融合所有模态

- [ ] Task 4: meeting/in_focus 场景识别
  - [ ] SubTask 4.1: 在 types.ts 的 UserActivityKind 增加 "meeting" 和 "in_focus" 枚举值
  - [ ] SubTask 4.2: 在 awareness-cortex.ts inferActivity 增加 meeting 分支（查询 schedule-task-service 日历事件）
  - [ ] SubTask 4.3: 在 awareness-cortex.ts inferActivity 增加 in_focus 分支（持续 busy > 25min 且无打断）
  - [ ] SubTask 4.4: 在 brain-stem.ts adjustSampleRate 增加 meeting=120s、in_focus=120s 分支

- [ ] Task 5: 修复 ProactionCortex.inferActions smart_home 调用
  - [ ] SubTask 5.1: 将深夜场景的 smart_home 调用从 control_device(deviceType:"light", action:"dim") 改为 scene 激活
  - [ ] SubTask 5.2: 使用 smart_home.scene 工具激活预设场景（如"晚安"场景）

# Task Dependencies
- Task 1 独立
- Task 2 独立
- Task 3 独立
- Task 4 独立（但 adjustSampleRate 依赖 Task 4.1 的类型扩展）
- Task 5 独立
- 全部可并行
