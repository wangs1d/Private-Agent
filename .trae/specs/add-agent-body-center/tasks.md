# Tasks

- [x] Task 1: 搭建 BodyCenter 骨架与类型定义
  - [x] SubTask 1.1: 新建 `server/src/body/types.ts`，定义 `BodyAction / BodySignal / BodyState / BodyModuleSnapshot / ReflexVerdict / BodyModuleLike` 等核心类型
  - [x] SubTask 1.2: 新建 `server/src/body/body-bus.ts`：BodyBus 实现（类比 SynapseBus，提供 publish/subscribe 主题路由）
  - [x] SubTask 1.3: 新建 `server/src/body/body-gateway.ts`：BodyGateway 实现，含 ReflexArc 拦截 + BodyModule 路由表 + ToolRegistry fallback
  - [x] SubTask 1.4: 新建 `server/src/body/body-center.ts`：BodyCenter 外观类，持有 8 个 BodyModule 引用 + BodyBus + BodyGateway，暴露 `act / sense / state / registerModule / snapshot / start / stop`
  - [x] SubTask 1.5: 新建 `server/src/body/index.ts` 导出 + `registerBodyRoutes` / `registerBodyTools`

- [x] Task 2: 实现 ReflexArc 反射弧（硬安全门）
  - [x] SubTask 2.1: 新建 `server/src/body/reflex-arc.ts`：DENY_PATTERNS（rm -rf、format、shutdown、del /s、reg delete、takeown、bcdedit、diskpart、net user、powershell -enc 等）
  - [x] SubTask 2.2: 实现 `check(action): ReflexVerdict` 方法，纯规则匹配，**不经 LLM**
  - [x] SubTask 2.3: 暴露 `registerPattern(pattern)` 支持热加载新危险模式
  - [x] SubTask 2.4: 拒绝事件写入审计日志（actorId / tool / args / reason / timestamp）

- [ ] Task 3: 实现 MotorCortex 运动皮层（手）
  - [x] SubTask 3.1: 新建 `server/src/body/motor-cortex.ts`：注册 desktop-visual、agent-browser、file-doc、code-sandbox 工具
  - [x] SubTask 3.2: 实现 `act(action)` 路由到对应工具 handler，执行过程发布 `body.motor.task_progress` / `body.motor.task_done` 信号
  - [x] SubTask 3.3: 实现 `sense(query)` 返回当前正在执行的任务状态
  - [ ] SubTask 3.4: 在 bootstrap 中把 desktop-bridge-coordinator / agent-browser-service / file-processing-service / code-sandbox-service 注入 MotorCortex（Task 14 装配）

- [x] Task 4: 实现 VocalCortex 发声皮层（嘴）
  - [x] SubTask 4.1: 新建 `server/src/body/vocal-cortex.ts`：聚合 tts-service / voice-dialogue-service / voice-message-service / phone-bridge 出站
  - [x] SubTask 4.2: 实现 `act(action)` 选择最优 TTS 通道（phone 通话中 → phone-bridge，否则 → voice-dialogue，再否则 → voice-capability fallback）
  - [x] SubTask 4.3: 完成后发布 `body.vocal.spoken` 信号

- [ ] Task 5: 实现 VisualCortex 视觉皮层（眼）
  - [x] SubTask 5.1: 新建 `server/src/body/visual-cortex.ts`：聚合 desktop-visual-port 截屏 + camera-adapter + VLM describe
  - [x] SubTask 5.2: 实现 `sense({ kind: "visual.desktop_frame" })` 拉取截屏并发布 `body.visual.frame` 信号
  - [x] SubTask 5.3: 订阅 device-bus camera 设备的 video stream，帧到达时发布 `body.visual.camera_frame` 信号
  - [ ] SubTask 5.4: BrainStem 周期性视觉感知改为通过 BodyGateway.sense 调用而非直接调 SensoryCortex.look()（Task 10/11 接入）

- [ ] Task 6: 实现 AuditoryCortex 听觉皮层（耳）
  - [x] SubTask 6.1: 新建 `server/src/body/auditory-cortex.ts`：聚合 funasr-asr-adapter / openai-asr-adapter / phone-bridge 入站音频
  - [x] SubTask 6.2: 实现音频转写流程：音频到达 → 选择最优 ASR adapter → 转写 → 发布 `body.auditory.transcript` 信号
  - [ ] SubTask 6.3: SensoryCortex 订阅 `body.auditory.transcript` 信号填充 SensoryFrame.audioText（Task 11 接入）

- [x] Task 7: 实现 SomatoCortex 体感皮层（皮肤）
  - [x] SubTask 7.1: 新建 `server/src/body/somato-cortex.ts`：聚合 smart-home-service + device-bus sensor streams
  - [x] SubTask 7.2: 订阅 SmartHomeService 状态变化事件，发布 `body.somato.device_change` 信号
  - [x] SubTask 7.3: 订阅 device-bus sensor.* stream，发布 `body.somato.sensor_reading` 信号
  - [x] SubTask 7.4: 实现 `act(action)` 路由 smart_home.* 工具调用

- [ ] Task 8: 实现 VestibularCortex 前庭皮层（平衡）
  - [x] SubTask 8.1: 新建 `server/src/body/vestibular-cortex.ts`：聚合 agent-embodiment + embodiment-autonomy-service
  - [x] SubTask 8.2: 实现 `act(action)` 路由 embodiment.* 工具调用（window_place / roam / move / set_state / excite）
  - [x] SubTask 8.3: 维护多设备渲染状态：当前在哪台设备渲染、3D 坐标、mood、caption
  - [x] SubTask 8.4: 设备切换时迁移 mood/caption 到新设备，发布 `body.vestibular.device_switch` 信号
  - [ ] SubTask 8.5: AgentCore 移除对 embodimentAutonomy 的直接持有，改为通过 BodyCenter.snapshot() 读取（Task 10/14 接入）

- [x] Task 9: 实现 HomeostasisCore 稳态核心
  - [x] SubTask 9.1: 新建 `server/src/body/homeostasis-core.ts`：聚合 device-bus sensor.battery + user-location-service + compute-quota-service
  - [x] SubTask 9.2: 电量 < 20% 时发布 `body.homeostasis.battery_low` 信号
  - [x] SubTask 9.3: 算力配额 < 10% 时发布 `body.homeostasis.quota_low` 信号，BrainCenter.cognize() 进入降级模式
  - [x] SubTask 9.4: 实现 `sense({ kind: "state" })` 返回 `{ battery, location, quota, load, fatigue }` 聚合快照

- [x] Task 10: 接入 BrainCenter（下行通路）
  - [x] SubTask 10.1: BrainCenter 新增 `registerBodyGateway(gw: BodyGatewayLike)` 方法
  - [x] SubTask 10.2: action-executor.ts 改造：`execute()` 内部委托到 `bodyGateway.execute(action)`，未注入 BodyGateway 时 fallback 到 toolRegistry.execute
  - [x] SubTask 10.3: BrainCenter.cognize() 阶段 1 并行收集感官时调 `bodyGateway.sense({ kind: "where_am_i" })` 补全身体状态
  - [x] SubTask 10.4: 保留 `BODY_CENTER_ENABLED=0` 环境变量降级开关，关闭时 BrainCenter 不感知 BodyCenter 存在

- [x] Task 11: 接入 BrainCenter（上行通路）
  - [x] SubTask 11.1: SensoryCortex 订阅 BodyBus 的 `body.visual.frame` / `body.auditory.transcript` / `body.vocal.spoken` 主题填充 SensoryFrame
  - [x] SubTask 11.2: AwarenessCortex 订阅 `body.homeostasis.battery_low` / `body.somato.device_change` / `body.vestibular.device_switch` 主题用于用户活动推断
  - [x] SubTask 11.3: BodyBus 与 SynapseBus 之间建立桥接：body.* 信号转发到 synapse 总线供 brain 域消费

- [x] Task 12: 工具下沉（重组归属，不改实现）
  - [x] SubTask 12.1: tools/desktop-visual-*.ts 改为通过 MotorCortex.registerTools 注册
  - [x] SubTask 12.2: tools/embodiment-*.ts 改为通过 VestibularCortex.registerTools 注册
  - [x] SubTask 12.3: tools/smart-home-*.ts 改为通过 SomatoCortex.registerTools 注册
  - [x] SubTask 12.4: tools/phone-bridge-*.ts 按 action 拆分：出站 → VocalCortex，入站音频 → AuditoryCortex
  - [x] SubTask 12.5: tools/agent-voice-*.ts 改为通过 VocalCortex.registerTools 注册
  - [x] SubTask 12.6: tools/device-*.ts 按设备 CapabilityId 路由：camera→Visual，microphone→Auditory，speaker→Vocal，actuator.*→Somato，agent.embodiment→Vestibular
  - [x] SubTask 12.7: ToolRegistry 改造为薄路由层：tool name → BodyModule 映射表 → BodyModule.execute；未匹配走 fallback handler
  - [x] SubTask 12.8: capability-modules/agent-browser、file-doc、code-sandbox 改为通过 MotorCortex.registerTools 注册

- [x] Task 13: 新增 HTTP 路由 + LLM 工具
  - [x] SubTask 13.1: 新建 `server/src/routes/http/body.ts`：GET /body/state、GET /body/where_am_i、GET /body/modules、POST /body/act、POST /body/reflex/patterns
  - [x] SubTask 13.2: 新建 `server/src/tools/body-tools.ts`：body.where_am_i / body.state / body.list_modules / body.calibrate 四个 LLM 工具
  - [x] SubTask 13.3: 在 routes/http/index.ts 注册 body 路由
  - [x] SubTask 13.4: 在 getBuiltinAgentChatTools 合并 body 工具 schema

- [x] Task 14: bootstrap 装配 + 环境变量
  - [x] SubTask 14.1: 在 create-app-services.ts 实例化 8 个 BodyModule + BodyCenter，注入现有服务为子系统
  - [x] SubTask 14.2: BodyCenter 通过 registerBodyGateway 注入到 BrainCenter
  - [x] SubTask 14.3: BODY_CENTER_ENABLED=0 时跳过 BodyCenter 装配，BrainCenter fallback 到原 ToolRegistry 直连路径
  - [x] SubTask 14.4: 启动日志输出各 BodyModule 注册状态（已注册工具数 / 子系统在线状态）

# Task Dependencies

- Task 1 必须先完成（其他任务依赖 BodyCenter 骨架与类型）
- Task 2 独立（ReflexArc 可独立实现，被 Task 3/10 使用）
- Task 3-9 互相独立，可**并行**（8 个 BodyModule 实现互不依赖）
- Task 10、11 依赖 Task 1-9（需要 BodyGateway + BodyBus 就绪）
- Task 12 依赖 Task 1-9（需要 BodyModule 实现就绪才能下沉工具）
- Task 13 依赖 Task 1（路由与工具 schema 依赖类型定义）
- Task 14 依赖 Task 1-13 全部完成（最后装配）

**并行批次建议**：
- 批次 1：Task 1 + Task 2 + Task 13（schema 与路由骨架）
- 批次 2：Task 3 / 4 / 5 / 6 / 7 / 8 / 9（7 个 BodyModule 并行实现）
- 批次 3：Task 10 + Task 11 + Task 12（接入与下沉）
- 批次 4：Task 14（最终装配）
