# Agent Body Center（身体中心）Spec

## Why

BrainCenter 已落地 11 个皮层分区 + 2 个皮下分区 + ActionExecutor 作为统一动作执行入口，但 ActionExecutor 直接 delegate 到 `ToolRegistry` —— 中间缺一层"身体"抽象。当前感官器官（眼/耳/嘴）、运动器官（手/UI 操作）、设备控制（智能家居/手机桥接/浏览器）、3D 具身（球形 avatar）全部散落在 `server/src/tools/*.ts` 与 `server/src/services/*-embodiment*.ts` 里，没有形成与人脑对称的"身体中心"。

`add-agent-brain-center` spec 自己也写了"具身（Body / Embodiment）作为后续独立 spec 处理"。本 spec 即为这一独立模块。

核心问题：
1. **工具无归属**：80+ 个工具全部直接挂 `ToolRegistry`，没有"哪个器官负责哪类操作"的概念
2. **感官/运动碎片化**：SensoryCortex 只是抽象层；真实截屏在 `desktop-visual-port`、ASR 在 `voice-dialogue/adapters`、TTS 在 `tts-service`、3D avatar 在 `agent-embodiment`——大脑无法统一调度身体
3. **无身体状态**：电量、位置、算力配额、当前在哪台设备渲染等"身体内部状态"散落在各服务，无统一查询入口
4. **无反射弧**：所有安全检查都在 LimbicCortex（脑侧），需要走完整 LLM 流程；像 `rm -rf` / `format` 这种硬危险应被身体直接反射式拒绝
5. **多设备具身不连续**：用户从手机切到桌面再切到眼镜时，agent 身体状态丢失

## What Changes

### 新增

- 新建 `server/src/body/` 目录作为身体中心模块，包含：
  - `BodyCenter` —— 统一外观与编排器，持有 8 个 BodyModule 引用，对外暴露 `act() / sense() / state() / registerModule() / snapshot()` 单一入口
  - `BodyGateway` —— 大脑→身体的下行网关：把 `BrainDecisionAction[]` 路由到对应 BodyModule，承担反射弧拦截
  - `BodyBus` —— 身体内部消息总线（类比 `SynapseBus`）：BodyModule 之间、Body→Brain 信号通路
  - `BodyModule` 抽象基类 —— 每个 BodyModule 暴露 `name / tools / act(action) / sense(query) / snapshot() / start() / stop()`
  - 8 个 BodyModule（详见 ADDED Requirements）：
    1. `MotorCortex`（运动皮层/手）—— UI 自动化（desktop-visual、agent-browser、file-doc、code-sandbox）
    2. `VocalCortex`（发声皮层/嘴）—— 语音输出（tts、voice-dialogue、voice-message、phone-bridge 出站）
    3. `VisualCortex`（视觉皮层/眼）—— 视觉输入（camera-adapter、desktop-screenshot、VLM 描述）
    4. `AuditoryCortex`（听觉皮层/耳）—— 语音输入（ASR adapters、phone-bridge 入站音频）
    5. `SomatoCortex`（体感皮层/皮肤）—— 设备传感器/智能家居（smart-home、device-bus sensor streams）
    6. `VestibularCortex`（前庭皮层/平衡）—— 3D 具身位置与多设备渲染状态（agent-embodiment、window_place）
    7. `HomeostasisCore`（稳态核心）—— 身体内部状态（电量、位置、算力配额、负载、疲劳度）
    8. `ReflexArc`（反射弧）—— 身体侧硬安全门（rm -rf、format、shutdown 等直接 DENY，不经 LLM）
  - `types.ts` —— 统一类型定义（`BodyAction / BodySignal / BodyState / BodyModuleSnapshot / ReflexVerdict`）
  - `index.ts` —— 对外导出 + `registerBodyRoutes` / `registerBodyTools`

- 新增 HTTP 路由 `server/src/routes/http/body.ts`：
  - `GET /body/state` —— 全部身体模块状态快照（含电量、位置、当前设备、各器官在线状态）
  - `GET /body/where_am_i?actorId=` —— 当前具身位置（哪台设备在渲染、3D 坐标、mood）
  - `GET /body/modules` —— 列出所有 BodyModule 及其工具清单
  - `POST /body/act` —— 注入一个 BodyAction 走完整反射+执行流水线（调试用）

- 新增 agent 工具（`server/src/tools/body-tools.ts`），让 LLM 通过工具认识身体：
  - `body.where_am_i` —— 查询自己当前在哪台设备渲染、3D 位置、mood
  - `body.state` —— 查询身体内部状态（电量/位置/算力配额/负载）
  - `body.list_modules` —— 列出所有 BodyModule 及其工具
  - `body.calibrate` —— 触发某器官重新校准（如重新截屏、重新拉取设备列表）

### 工具下沉（"将工具下沉到这一块"的具体含义）

- 现有 `tools/*.ts` 文件按归属 BodyModule **重新组织归属**（不删文件，只改注册路径）：
  - `tools/desktop-visual-*.ts` → MotorCortex.registerTools
  - `tools/agent-browser-*` (capability-modules/agent-browser) → MotorCortex.registerTools
  - `tools/file-doc-*` (capability-modules/file-doc) → MotorCortex.registerTools
  - `tools/code-sandbox-*` (capability-modules/code-sandbox) → MotorCortex.registerTools
  - `tools/embodiment-*.ts` → VestibularCortex.registerTools
  - `tools/smart-home-*.ts` → SomatoCortex.registerTools
  - `tools/phone-bridge-*.ts` → VocalCortex + AuditoryCortex（按入站/出站方向拆分）
  - `tools/agent-voice-*.ts` → VocalCortex.registerTools
  - `tools/device-*.ts` → 按设备 CapabilityId 路由到对应 BodyModule（camera→Visual，microphone→Auditory，speaker→Vocal，actuator.*→Somato，agent.embodiment→Vestibular）
  - `tools/calendar-tools.ts` / `tools/clock-tools.ts` / `tools/notes-tools.ts` / `tools/weather-tools.ts` 等**信息查询类**：暂不下沉，留在 ToolRegistry 作"通用工具池"（它们不操纵身体，相当于脑内的"知识检索"）
  - `tools/brain-*.ts`：**保留在 BrainCenter**，是大脑自省工具，不属于身体
- `ToolRegistry` 改造为**薄路由层**：tool name → 查 BodyModule 映射表 → BodyModule.execute；未匹配的工具走 fallback handler（保留兼容）
- 每个 BodyModule 通过 `registerTools(registry: ToolRegistry)` 把自己的工具挂到 registry，handler 内部委托 `this.act()`

### 修改

- **MODIFIED** `server/src/brain/action-executor.ts`：`execute()` 内部把 `BrainDecisionAction` 委托到 `BodyGateway.execute(action)` 而非直接 `toolRegistry.execute`；保留对 ToolRegistry 的 fallback 兼容未下沉工具
- **MODIFIED** `server/src/bootstrap/create-app-services.ts`：实例化 `BodyCenter` 与 8 个 BodyModule，把现有感官/运动/具身服务注册为子系统；注入 `agentCore` / `toolRegistry` / HTTP 路由；注入 `BrainCenter` 让 BrainCenter 持有 BodyGateway 引用
- **MODIFIED** `server/src/brain/brain-center.ts`：新增 `registerBodyGateway(gw: BodyGatewayLike)` 方法；`cognize()` 阶段 1 并行收集感官时调 `bodyGateway.sense(query)` 补全身体状态
- **MODIFIED** `server/src/services/agent-embodiment.ts` + `embodiment-autonomy-service.ts`：归属到 VestibularCortex 下作为子系统，不再由 AgentCore 直接调用
- **MODIFIED** `server/src/services/agent-core.ts`：移除对 `embodimentAutonomy` 的直接持有，改为通过 BodyCenter.snapshot() 读取身体状态

### 大脑如何控制身体

三层控制通路：

1. **下行通路（Brain → Body）**：
   - BrainCenter 的 `ProactionCortex.decide()` 产出 `BrainDecision.actions: BrainDecisionAction[]`
   - `ActionExecutor.execute()` 把每个 action 委托到 `BodyGateway.execute(action)`
   - `BodyGateway` 先过 `ReflexArc.check(action)`：硬危险 → 直接 DENY（不经 LLM），返回 `{ ok:false, refused:true, reason }`
   - 通过反射检查后，按 `action.tool` 前缀路由到对应 BodyModule（如 `desktop.visual.*` → MotorCortex，`embodiment.*` → VestibularCortex）
   - BodyModule.act() 内部调用具体工具 handler，返回结果

2. **上行通路（Body → Brain）**：
   - BodyModule 在状态变化时（截屏完成、设备下线、电量低于阈值）发布 `BodySignal` 到 `BodyBus`
   - `SensoryCortex` 订阅 BodyBus 的 sensory.* 主题（如 sensory.visual_frame / sensory.audio_chunk / sensory.device_event）
   - `AwarenessCortex` 订阅 state.* 主题（如 state.battery_low / state.device_offline）
   - 信号回流到 BrainCenter.cognize() 作为认知输入

3. **反射覆盖（Body → Brain 的硬否决）**：
   - ReflexArc 维护 DENY_PATTERNS（rm -rf、format、shutdown、del /s、reg delete 等）
   - 在 BrainCenter 决定执行 action 之前，BodyGateway 已经过反射检查
   - 若 ReflexArc 拒绝，BrainCenter 收到 `{ refused: true }` 并触发 LLM 生成"我做不到这件事"话术
   - ReflexArc 不产生话术，只做硬拒绝

### 身体内部模块容纳清单

按"人体器官对照"组织，便于直观理解：

| 人体器官 | BodyModule | 当前承载的现有服务/工具 |
|---------|-----------|----------------------|
| 手 | MotorCortex | desktop-visual-tools、agent-browser、file-doc、code-sandbox |
| 嘴 | VocalCortex | tts-service、voice-dialogue-service、voice-message-service、phone-bridge 出站 |
| 耳 | AuditoryCortex | voice-dialogue/adapters/funasr-asr、openai-asr、phone-bridge 入站音频 |
| 眼 | VisualCortex | camera-adapter、desktop-visual-port 截屏、VLM describe |
| 皮肤 | SomatoCortex | smart-home-service、device-bus sensor streams、haptic |
| 前庭 | VestibularCortex | agent-embodiment（3D 球形 avatar）、window_place、多设备 presence |
| 内脏 | HomeostasisCore | 电量、GPS 位置、compute-quota、负载、疲劳度（新建聚合服务） |
| 脊髓反射 | ReflexArc | rm -rf / format / shutdown / del 等硬拒绝模式 |

未来可扩展：
- **OlfactoryCortex**（嗅觉）—— 接入气体传感器（IoT 场景）
- **GustatoryCortex**（味觉）—— 智能厨电场景
- **MotorPlannerCortex**（运动规划）—— 高层动作链编排（如"泡一杯咖啡"分解为多步手部动作）
- **EndocrineCore**（内分泌）—— 全局激素水平（影响情绪/警觉度，与 EmotionModulator 联动）

## Impact

- **Affected specs**：
  - `add-agent-brain-center` —— ActionExecutor 改为委托 BodyGateway，BrainCenter 新增 registerBodyGateway
  - `extend-brain-neuroanatomy` —— 不直接修改，但 BrainStem 心跳扫描可读 BodyCenter.snapshot() 替代直接读散落服务
  - `jarvis-stage3-multimodal-env` —— SensoryCortex.look() 改为从 VisualCortex 拉取帧，BrainStem 周期性视觉感知改为 BodyGateway.sense()
  - `optimize-token-consumption` —— body.list_modules 替代脑内硬编码能力清单，进一步省 token
- **Affected code**：
  - 新增：`server/src/body/`（全部新增，含 8 个 BodyModule）
  - 新增：`server/src/tools/body-tools.ts`、`server/src/routes/http/body.ts`
  - 修改：`server/src/brain/action-executor.ts`、`server/src/brain/brain-center.ts`、`server/src/bootstrap/create-app-services.ts`、`server/src/services/agent-core.ts`、`server/src/services/agent-embodiment.ts`、`server/src/services/embodiment-autonomy-service.ts`
  - 工具归属重组（不改实现，只改注册路径）：`tools/desktop-visual-*`、`tools/embodiment-*`、`tools/smart-home-*`、`tools/phone-bridge-*`、`tools/agent-voice-*`、`tools/device-*`、对应 capability-modules 子目录
- **Rollout**：默认开启，`BODY_CENTER_ENABLED=0` 完全降级回现状（ActionExecutor 直接走 ToolRegistry）

## ADDED Requirements

### Requirement: BodyCenter 作为身体统一入口

系统 SHALL 提供 `BodyCenter` 类作为 agent 身体的单一对外入口，持有 8 个 BodyModule 引用，对外暴露 `act(action) / sense(query) / state(actorId) / registerModule() / snapshot()` 五个核心方法。

#### Scenario: 大脑通过 BodyGateway 调度身体动作

- **WHEN** BrainCenter 的 ActionExecutor 收到 `BrainDecisionAction { tool: "desktop.visual.run_task", args: {...} }`
- **THEN** ActionExecutor 委托到 `BodyGateway.execute(action)`
- **AND** BodyGateway 先过 ReflexArc 反射检查
- **AND** 通过后路由到 MotorCortex.act()
- **AND** 单次调用 < 5ms 路由开销（不含实际工具执行耗时）

#### Scenario: 大脑查询身体当前状态

- **WHEN** BrainCenter.cognize() 阶段 1 调用 `bodyGateway.sense({ kind: "where_am_i", actorId })`
- **THEN** 返回 `{ device: "desktop", x: 0.3, y: 0.7, mood: "thinking", rendering: true }`
- **AND** 该状态由 VestibularCortex 实时维护

#### Scenario: BodyCenter 启动顺序

- **WHEN** `create-app-services.ts` 启动
- **THEN** 先实例化 8 个 BodyModule 并各自注册现有服务为子系统
- **AND** 然后 `bodyCenter.start()` 各模块
- **AND** 任意 BodyModule 初始化失败不阻断其他模块（降级而非崩溃）
- **AND** BodyCenter 通过 `registerBodyGateway` 注入到 BrainCenter

### Requirement: MotorCortex 运动皮层（手）

系统 SHALL 提供 `MotorCortex` 作为环境操纵类工具的归属 BodyModule，统一管理 UI 自动化、浏览器操作、文件处理、代码沙盒。

#### Scenario: 执行桌面 UI 自动化任务

- **WHEN** BrainCenter 决定执行 `desktop.visual.run_task { task: "打开微信发送文件" }`
- **THEN** BodyGateway 路由到 MotorCortex.act()
- **AND** MotorCortex 内部调用 desktop-visual handler
- **AND** 执行过程中发布 `body.motor.task_progress` 信号到 BodyBus
- **AND** 完成后发布 `body.motor.task_done` 信号

#### Scenario: 浏览器多步操作

- **WHEN** BrainCenter 决定执行 `agent_browser.navigate + click + extract`
- **THEN** MotorCortex 协调 agent-browser 工具按序执行
- **AND** 中间步骤失败时 MotorCortex 自主重试或回退

### Requirement: VocalCortex 发声皮层（嘴）

系统 SHALL 提供 `VocalCortex` 统一管理语音输出（TTS、voice-dialogue、voice-message、phone-bridge 出站语音）。

#### Scenario: 大脑决定用语音回复

- **WHEN** BrainCenter 的 ProactionCortex 决定 `{ tool: "tts.speak", args: { text: "你好" } }`
- **THEN** BodyGateway 路由到 VocalCortex.act()
- **AND** VocalCortex 选最优 TTS 通道（voice-dialogue > tts-service > voice-capability fallback）
- **AND** 合成完成后发布 `body.vocal.spoken` 信号

#### Scenario: 用户在通话中

- **WHEN** phone-bridge 处于通话状态且 BrainCenter 决定回复
- **THEN** VocalCortex 自动选择 phone-bridge 出站通道
- **AND** 不抢占其他 TTS 通道

### Requirement: VisualCortex 视觉皮层（眼）

系统 SHALL 提供 `VisualCortex` 统一管理视觉输入（截屏、摄像头、VLM 描述），替代 SensoryCortex 仅作抽象层的现状。

#### Scenario: BrainStem 周期性截屏

- **WHEN** BrainStem 心跳扫描（jarvis-stage3）触发周期性视觉感知
- **THEN** 调 `bodyGateway.sense({ kind: "visual.desktop_frame", actorId })`
- **AND** VisualCortex 调用 desktop-visual-port 截屏
- **AND** 截屏帧发布为 `body.visual.frame` 信号
- **AND** SensoryCortex 订阅该信号组装 SensoryFrame

#### Scenario: 摄像头流接入

- **WHEN** device-bus 注册了 camera 设备且 VisualCortex 启用
- **THEN** VisualCortex 订阅 camera 设备的 video stream
- **AND** 帧到达时发布 `body.visual.camera_frame` 信号

### Requirement: AuditoryCortex 听觉皮层（耳）

系统 SHALL 提供 `AuditoryCortex` 统一管理语音输入（ASR adapters、phone-bridge 入站音频）。

#### Scenario: 用户语音消息到达

- **WHEN** voice-message-service 收到一段音频
- **THEN** AuditoryCortex 调用最优 ASR adapter（funasr > openai-asr）转写
- **AND** 转写文本发布为 `body.auditory.transcript` 信号
- **AND** SensoryCortex 订阅该信号填入 SensoryFrame.audioText

### Requirement: SomatoCortex 体感皮层（皮肤）

系统 SHALL 提供 `SomatoCortex` 统一管理设备传感器与智能家居状态。

#### Scenario: 智能灯被手动关闭

- **WHEN** SmartHomeService 30s 轮询检测到灯状态变化
- **THEN** SomatoCortex 发布 `body.somato.device_change` 信号
- **AND** AwarenessCortex 订阅该信号推断用户活动

#### Scenario: 设备传感器流接入

- **WHEN** device-bus 有 sensor.temperature 设备
- **THEN** SomatoCortex 订阅其 stream 并周期发布 `body.somato.sensor_reading` 信号

### Requirement: VestibularCortex 前庭皮层（平衡）

系统 SHALL 提供 `VestibularCortex` 管理 3D 具身位置、窗口位置、多设备渲染状态。

#### Scenario: 大脑决定挪动球形身体

- **WHEN** BrainCenter 决定 `embodiment.window_place { screenX: 0.5, screenY: 0.3 }`
- **THEN** BodyGateway 路由到 VestibularCortex.act()
- **AND** VestibularCortex 调用 emitEmbodimentPatch 推送给前端
- **AND** 完成后更新自身状态并发布 `body.vestibular.moved` 信号

#### Scenario: 多设备切换具身

- **WHEN** 用户从桌面切换到手机（desktop 离线，phone 上线）
- **THEN** VestibularCortex 把当前 mood/caption 转移到 phone 设备
- **AND** 发布 `body.vestibular.device_switch` 信号
- **AND** 身体连续性状态（lastMood / lastCaption）跨设备保留

### Requirement: HomeostasisCore 稳态核心

系统 SHALL 提供 `HomeostasisCore` 聚合身体内部状态：电量、GPS 位置、算力配额、负载、疲劳度。

#### Scenario: 电量低于阈值

- **WHEN** 某设备的 sensor.battery < 20%
- **THEN** HomeostasisCore 发布 `body.homeostasis.battery_low` 信号
- **AND** ProactionCortex 收到信号后提高打扰阈值（用户手机快没电时别打扰）

#### Scenario: 算力配额耗尽

- **WHEN** ComputeQuotaService 报告配额 < 10%
- **THEN** HomeostasisCore 发布 `body.homeostasis.quota_low` 信号
- **AND** BrainCenter.cognize() 进入降级模式（跳过非必要 LLM 调用）

#### Scenario: 查询身体稳态

- **WHEN** LLM 调用 `body.state` 工具
- **THEN** 返回 `{ battery: 0.65, location: "Shanghai", quota: 0.42, load: 0.3, fatigue: 0.1 }`
- **AND** 各字段聚合自各 BodyModule 的子状态

### Requirement: ReflexArc 反射弧（身体侧硬安全门）

系统 SHALL 提供 `ReflexArc` 作为身体侧硬安全门，对硬危险动作直接 DENY，**不经 LLM**。

#### Scenario: rm -rf 拒绝

- **WHEN** BrainCenter 决定执行 `desktop.run_shell { command: "rm -rf C:\\" }`
- **THEN** BodyGateway.execute 先调 ReflexArc.check(action)
- **AND** ReflexArc 命中 DENY_PATTERN，返回 `{ verdict: "deny", reason: "destructive operation" }`
- **AND** BodyGateway 直接返回 `{ ok: false, refused: true }`
- **AND** BrainCenter 不调用 LLM，直接生成"我做不到这件事"话术

#### Scenario: format / shutdown 拒绝

- **WHEN** BrainCenter 决定执行包含 `format` / `shutdown` / `del /s` 的命令
- **THEN** ReflexArc 命中 DENY_PATTERN 并拒绝
- **AND** 拒绝事件记入审计日志（包含 actorId / tool / args / reason）

#### Scenario: 反射规则可扩展

- **WHEN** 管理员通过 `POST /body/reflex/patterns` 注入新危险模式
- **THEN** ReflexArc 热加载新模式
- **AND** 不重启服务

### Requirement: BodyBus 身体内部消息总线

系统 SHALL 提供 `BodyBus` 作为身体内部消息总线，支持 BodyModule 之间、Body→Brain 的信号通路。

#### Scenario: 截屏后通知运动皮层

- **WHEN** VisualCortex 完成截屏并发布 `body.visual.frame` 信号
- **THEN** MotorCortex 订阅该信号，自动更新当前焦点窗口上下文
- **AND** SensoryCortex 订阅该信号组装 SensoryFrame

#### Scenario: 大脑订阅身体信号

- **WHEN** 任意 BodyModule 发布 `body.*` 信号
- **THEN** BrainCenter 通过 SynapseBus 桥接到 brain 域
- **AND** AwarenessCortex 与 SensoryCortex 各自订阅自己关心的子主题

### Requirement: 身体工具暴露给 LLM

系统 SHALL 通过 `body.list_modules / body.where_am_i / body.state / body.calibrate` 四个工具让 LLM 程序化认识身体。

#### Scenario: LLM 查询当前具身位置

- **WHEN** LLM 调用 `body.where_am_i` 工具
- **THEN** 返回 `{ device: "desktop", screenX: 0.3, screenY: 0.7, mood: "thinking", rendering: true }`
- **AND** 不让 LLM 自己根据聊天历史猜

#### Scenario: LLM 触发器官校准

- **WHEN** LLM 调用 `body.calibrate { module: "visual" }`
- **THEN** VisualCortex 重新截屏并刷新缓存
- **AND** 返回 `{ ok: true, calibratedAt }`

## MODIFIED Requirements

### Requirement: ActionExecutor 直接委托 ToolRegistry

**修改为**：ActionExecutor SHALL 把 `BrainDecisionAction` 委托到 `BodyGateway.execute(action)`，BodyGateway 内部先过 ReflexArc 反射检查，再路由到对应 BodyModule.act()。未下沉的工具保留 fallback 走 `toolRegistry.execute` 以兼容历史。

### Requirement: BrainCenter 持有感官抽象

**修改为**：BrainCenter 的 SensoryCortex 仍保留感官抽象（buildSensoryFrame / listen / look / speak），但实际感知数据**来源**从 BodyModule 上行信号获取。SensoryCortex 订阅 BodyBus 的 sensory.* 主题填充 SensoryFrame 各字段。

### Requirement: agent-embodiment 直接被 AgentCore 持有

**修改为**：agent-embodiment 与 embodiment-autonomy-service 归属到 VestibularCortex 下作为子系统，AgentCore 通过 BodyCenter.snapshot() 读取身体状态而非直接持有这两个服务。

## REMOVED Requirements

### Requirement: 工具直接挂到 ToolRegistry 无归属

**Reason**：80+ 工具无归属模块，新增能力时无法判断属于哪个器官，且 BrainCenter 无法按器官路由动作。
**Migration**：按归属重组到对应 BodyModule.registerTools()，ToolRegistry 改为薄路由层。原 tools/*.ts 文件保留，仅注册路径改变，handler 实现不动。信息查询类工具（calendar、clock、notes、weather）保留在 ToolRegistry 通用工具池。
