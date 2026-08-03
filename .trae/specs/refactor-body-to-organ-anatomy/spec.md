# 身体器官化解构（Body Organ Anatomy Refactor）Spec

## Why

当前 `BodyCenter` 的 8 个模块中有 5 个命名为 `*Cortex`（MotorCortex / VisualCortex / AuditoryCortex / SomatoCortex / VestibularCortex），但按人体解剖学，"皮层"（Cortex）是脑内结构，身体侧只有器官与执行器。这导致：

1. **脑身边界模糊**：`BrainCenter` 已有 `SensoryCortex`（感官皮层，含 listen/look/speak），`BodyCenter` 又建了 `VisualCortex`/`AuditoryCortex`/`VocalCortex`，命名重叠让人误以为 body 覆盖了 brain 的职责
2. **违背仿真初衷**：项目本质是"模拟真人结构"，brain 以下应是身体器官（眼/耳/嘴/手/皮肤），而非另一套皮层
3. **职责错位**：当前 BodyCenter 的 `*Cortex` 既做硬件采集又做信号处理，与 BrainCenter.SensoryCortex 的"理解层"职责重叠

本 spec 将 BodyCenter 的 5 个 `*Cortex` 重命名为身体器官，职责收窄为"传感器与执行器硬件"，脑内皮层功能回归 BrainCenter.SensoryCortex。

## What Changes

### 命名重构（BodyCenter 5 个模块）

| 原名 | 新名 | 人体部位 | 文件 |
|------|------|---------|------|
| MotorCortex | Hand | 手 | `motor-cortex.ts` → `hand.ts` |
| VisualCortex | Eye | 眼 | `visual-cortex.ts` → `eye.ts` |
| AuditoryCortex | Ear | 耳 | `auditory-cortex.ts` → `ear.ts` |
| VocalCortex | Mouth | 嘴 | `vocal-cortex.ts` → `mouth.ts` |
| SomatoCortex | Skin | 皮肤 | `somato-cortex.ts` → `skin.ts` |
| VestibularCortex | VestibularApparatus | 前庭器 | `vestibular-cortex.ts` → `vestibular-apparatus.ts` |
| HomeostasisCore | HomeostasisCore（保留） | 内脏 | 不变 |
| ReflexArc | ReflexArc（保留） | 脊髓反射 | 不变 |

**BREAKING**：`BodyModuleKind` 枚举值改变（motor→hand / visual→eye / auditory→ear / vocal→mouth / somato→skin），外部引用需同步更新。

### 信号主题改名（BodyBus）

| 原主题 | 新主题 |
|--------|--------|
| body.visual.frame | body.eye.frame |
| body.visual.camera_frame | body.eye.camera_frame |
| body.auditory.transcript | body.ear.transcript |
| body.vocal.spoken | body.mouth.spoken |
| body.somato.device_change | body.skin.device_change |
| body.somato.sensor_reading | body.skin.sensor_reading |
| body.motor.task_progress | body.hand.task_progress |
| body.motor.task_done | body.hand.task_done |
| body.vestibular.* | 保留 |
| body.homeostasis.* | 保留 |

### 工具路由前缀映射调整

BodyGateway.routeTable 的 module 参数改用新 BodyModuleKind：
- `desktop.` / `agent_browser.` / `file.` / `file_doc.` / `code.` / `code_sandbox.` → `hand`
- `tts.` / `voice.` / `voice_message.` / `phone_bridge.` → `mouth`
- `smart_home.` / `device.` / `device.sensor.` → `skin`
- `embodiment.` → `vestibular`（保留）

### BrainCenter 侧订阅主题同步

- **MODIFIED** `SensoryCortex.attachBodyBus`：订阅主题从 `body.visual.frame` / `body.auditory.transcript` / `body.vocal.spoken` 改为 `body.eye.frame` / `body.ear.transcript` / `body.mouth.spoken`
- **MODIFIED** `AwarenessCortex.attachBodyBus`：订阅主题从 `body.somato.device_change` 改为 `body.skin.device_change`（其他两个保留）

### 职责边界澄清（BrainCenter.SensoryCortex）

明确 `SensoryCortex` 是脑内感官皮层聚合（含视觉/听觉/语言理解子功能），不新增独立皮层文件：
- `look()` —— 视觉皮层功能：处理 Eye 传来的图像，调 VLM 生成描述
- `listen()` —— 听觉皮层功能：处理 Ear 传来的音频，调 ASR 转写
- `speak()` —— 布洛卡区功能：组织语言文本（不合成音频，合成交 Mouth）
- `buildSensoryFrame()` —— 组装认知上下文

BodyCenter 的器官只做硬件层：采集/执行，不做语义理解。

### HTTP 路由与 snapshot 字段

- `GET /body/modules` 返回的 `BodyModuleSnapshot.name` 字段值改变（如 "motor" → "hand"）
- `body.calibrate` 工具的 `module` 参数可选值改变（hand/eye/ear/mouth/skin/vestibular/homeostasis）

## Impact

- **Affected specs**：
  - `add-agent-body-center` —— 本 spec 是其后续重构，命名与信号主题全面调整
  - `add-agent-brain-center` —— SensoryCortex / AwarenessCortex 订阅主题同步改
  - `jarvis-stage3-multimodal-env` —— BrainStem 周期性视觉感知的主题名改变
- **Affected code**：
  - 重命名：`server/src/body/{motor,visual,auditory,vocal,somato,vestibular}-cortex.ts` → 器官命名
  - 修改：`server/src/body/types.ts`（BodyModuleKind）、`body-gateway.ts`（路由）、`body-center.ts`、`index.ts`
  - 修改：`server/src/brain/sensory-cortex.ts`、`awareness-cortex.ts`（订阅主题）
  - 修改：`server/src/bootstrap/create-app-services.ts`（装配 + routeTable）
  - 修改：`server/src/tools/body-tools.ts`（calibrate 参数说明）
  - 修改：`server/src/routes/http/body.ts`（snapshot 字段名）
- **Rollout**：与 `BODY_CENTER_ENABLED` 开关一致，`=0` 时不影响任何行为

## ADDED Requirements

### Requirement: BodyCenter 器官化命名

系统 SHALL 将 BodyCenter 的 5 个 `*Cortex` 模块重命名为身体器官（Hand / Eye / Ear / Mouth / Skin / VestibularApparatus），`BodyModuleKind` 枚举值同步改变。

#### Scenario: 工具路由到 Hand

- **WHEN** BrainCenter 决定执行 `desktop.visual.run_task`
- **THEN** BodyGateway 路由到 `Hand.act()`（原 MotorCortex）
- **AND** Hand 内部调用 desktop-visual handler
- **AND** 完成后发布 `body.hand.task_done` 信号（原 body.motor.task_done）

#### Scenario: Eye 发布视觉帧

- **WHEN** Eye（原 VisualCortex）完成截屏
- **THEN** 发布 `body.eye.frame` 信号（原 body.visual.frame）
- **AND** SensoryCortex 订阅该主题填充 SensoryFrame

### Requirement: BrainCenter.SensoryCortex 作为脑内感官皮层

系统 SHALL 明确 `SensoryCortex` 是脑内感官皮层聚合，承担视觉/听觉/语言理解，不新增独立皮层文件。BodyCenter 的器官只做硬件采集与执行。

#### Scenario: 视觉理解流程

- **WHEN** Eye 发布 `body.eye.frame` 信号
- **THEN** SensoryCortex 订阅该信号
- **AND** 调用 `look()` 方法（脑内视觉皮层）调 VLM 生成描述
- **AND** 填入 SensoryFrame.visualDescription

#### Scenario: 发声流程

- **WHEN** BrainCenter 决定回复文本 "你好"
- **THEN** SensoryCortex.speak() 组织语言文本（脑内布洛卡区）
- **AND** ActionExecutor 委托 BodyGateway → Mouth.act()（原 VocalCortex）
- **AND** Mouth 调用 TtsService 合成 mp3（硬件执行）
- **AND** 完成后发布 `body.mouth.spoken` 信号

## MODIFIED Requirements

### Requirement: BodyModule 命名

**修改为**：BodyModule 的 `name` 字段使用器官名（hand/eye/ear/mouth/skin/vestibular/homeostasis/reflex），不再使用 `*Cortex` 命名。`BodyModuleKind` 枚举同步调整。

### Requirement: BodyBus 信号主题

**修改为**：BodyBus 信号主题使用器官域（body.eye.* / body.ear.* / body.mouth.* / body.skin.* / body.hand.*），不再使用皮层域（body.visual.* / body.auditory.* / body.vocal.* / body.somato.* / body.motor.*）。

### Requirement: BrainCenter 订阅 BodyBus 主题

**修改为**：SensoryCortex 订阅 `body.eye.frame` / `body.ear.transcript` / `body.mouth.spoken`；AwarenessCortex 订阅 `body.skin.device_change`（其他主题名保留）。

## REMOVED Requirements

### Requirement: BodyCenter 包含 *Cortex 命名的模块

**Reason**：违背人体解剖学，"皮层"是脑内结构，身体侧只有器官。
**Migration**：5 个 `*Cortex` 重命名为器官，类名/文件名/枚举值/信号主题/路由前缀全部同步调整。脑内皮层功能由 BrainCenter.SensoryCortex 承担（已有 listen/look/speak，无需新增）。
