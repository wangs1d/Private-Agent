# Checklist

## Task 1: BrainStem 周期性视觉感知
- [x] `brain-stem.ts` 新增 `periodicVisualCheck(actorId, activityState)` 方法
- [x] busy 时每 5 分钟调 sensoryCortex.look() + describe()
- [x] sleeping/idle 时不调
- [x] 发布 desktop_app_focus 信号到 LifeSignalHub
- [x] sweepActor 中调用 periodicVisualCheck
- [x] lastVisualCheck 时间戳控制频率
- [x] sensoryCortex 依赖已注册

## Task 2: SmartHomeService 设备状态轮询
- [x] `smart-home-service.ts` 新增 startStatePolling/stopStatePolling
- [x] 30s 间隔轮询 getAllStates
- [x] 对比快照检测状态变化
- [x] 发布 smart_home.state_change 信号到 LifeSignalHub
- [x] 信号 payload 含 entity_id/oldState/newState/domain
- [x] create-app-services.ts 中启动轮询

## Task 3: SensoryFrame 落地
- [x] cognize 阶段 1 收集完后调 buildSensoryFrame 组装
- [x] SensoryFrame 作为 CognitiveContext 字段
- [x] buildSensoryFrame 正确融合所有模态

## Task 4: meeting/in_focus 场景识别
- [x] UserActivityKind 增加 "meeting" 和 "in_focus"
- [x] inferActivity 增加 meeting 分支（查询日历事件）
- [x] inferActivity 增加 in_focus 分支（持续 busy > 25min）
- [x] adjustSampleRate 增加 meeting=120s、in_focus=120s

## Task 5: 修复 inferActions smart_home 调用
- [x] 深夜场景改用 smart_home.scene 激活
- [x] 不再使用不匹配的 control_device 参数

## 编译与集成
- [x] `cd server; npx tsc --noEmit` 零错误
- [ ] 现有 brain-end-to-end 测试仍通过
- [ ] 现有 brain-subcortical 测试未回归
