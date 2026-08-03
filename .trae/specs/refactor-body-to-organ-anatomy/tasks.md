# Tasks

- [x] Task 1: BodyModuleKind 枚举与类型重命名
  - [x] SubTask 1.1: 修改 `server/src/body/types.ts` 的 `BodyModuleKind`：motor→hand / visual→eye / auditory→ear / vocal→mouth / somato→skin（vestibular/homeostasis/reflex 保留）
  - [x] SubTask 1.2: 全局搜索替换所有引用 `BodyModuleKind` 字面量的位置（如 "motor" → "hand"）

- [x] Task 2: 6 个 BodyModule 文件重命名与类名重构
  - [x] SubTask 2.1: `motor-cortex.ts` → `hand.ts`，类名 `MotorCortex` → `Hand`，更新头部注释（"运动皮层/手" → "手/运动执行器"）
  - [x] SubTask 2.2: `visual-cortex.ts` → `eye.ts`，类名 `VisualCortex` → `Eye`，注释改为"眼/视觉传感器"
  - [x] SubTask 2.3: `auditory-cortex.ts` → `ear.ts`，类名 `AuditoryCortex` → `Ear`，注释改为"耳/听觉传感器"
  - [x] SubTask 2.4: `vocal-cortex.ts` → `mouth.ts`，类名 `VocalCortex` → `Mouth`，注释改为"嘴/发声执行器"
  - [x] SubTask 2.5: `somato-cortex.ts` → `skin.ts`，类名 `SomatoCortex` → `Skin`，注释改为"皮肤/触觉与环境传感器"
  - [x] SubTask 2.6: `vestibular-cortex.ts` → `vestibular-apparatus.ts`，类名 `VestibularCortex` → `VestibularApparatus`，注释改为"前庭器/平衡器官"
  - [x] SubTask 2.7: 每个模块内部的 `name` 字段返回值同步改为新器官名

- [x] Task 3: BodyBus 信号主题改名
  - [x] SubTask 3.1: 在 6 个 BodyModule 文件中，所有 `body.visual.*` → `body.eye.*`、`body.auditory.*` → `body.ear.*`、`body.vocal.*` → `body.mouth.*`、`body.somato.*` → `body.skin.*`、`body.motor.*` → `body.hand.*`
  - [x] SubTask 3.2: `body-homeostasis-core.ts` 中订阅/发布的主题如涉及上述域，同步改名
  - [x] SubTask 3.3: `body-bus.ts` 中如有主题映射或注释引用旧域，同步改

- [x] Task 4: BodyGateway 与 BodyCenter 适配新命名
  - [x] SubTask 4.1: `body-gateway.ts` 的 `extractSenseDomain` 方法 senseMap 表项更新（visual→eye / auditory→ear / vocal→mouth / somato→skin / motor→hand）
  - [x] SubTask 4.2: `body-gateway.ts` 的 `mergeStateFromSnapshot` 方法 moduleKind 判断更新（"homeostasis"/"vestibular" 保留，其他按新 kind）
  - [x] SubTask 4.3: `body-center.ts` 中 8 个 setter 方法名与字段名更新（如 setMotorCortex → setHand 等）
  - [x] SubTask 4.4: `body/index.ts` 导出更新（re-export 新文件名与新类名）

- [x] Task 5: BrainCenter 侧订阅主题同步
  - [x] SubTask 5.1: `server/src/brain/sensory-cortex.ts` 的 `attachBodyBus` 方法：订阅主题 `body.visual.frame` → `body.eye.frame`、`body.auditory.transcript` → `body.ear.transcript`、`body.vocal.spoken` → `body.mouth.spoken`
  - [x] SubTask 5.2: `server/src/brain/awareness-cortex.ts` 的 `attachBodyBus` 方法：订阅主题 `body.somato.device_change` → `body.skin.device_change`（`body.homeostasis.battery_low` 和 `body.vestibular.device_switch` 保留）
  - [x] SubTask 5.3: 全局搜索 `body.visual.` / `body.auditory.` / `body.vocal.` / `body.somato.` / `body.motor.` 字符串，确认无遗漏引用

- [x] Task 6: bootstrap 装配层适配
  - [x] SubTask 6.1: `create-app-services.ts` 的 import 路径更新（6 个新文件名）
  - [x] SubTask 6.2: 实例化类名更新（MotorCortex → Hand 等）
  - [x] SubTask 6.3: `bodyCenter.setMotor` → `setHand` 等 8 个 setter 调用更新
  - [x] SubTask 6.4: `bodyGateway.registerToolRoute` 的第 2 参数更新（"motor" → "hand" / "vocal" → "mouth" / "somato" → "skin" / "visual" → "eye" 等）
  - [x] SubTask 6.5: `reflexModuleAdapter` / 其他适配器如引用旧类名，同步更新

- [x] Task 7: HTTP 路由与 LLM 工具 schema 适配
  - [x] SubTask 7.1: `server/src/routes/http/body.ts` 中如引用模块名常量，更新
  - [x] SubTask 7.2: `server/src/tools/body-tools.ts` 的 `body.calibrate` 工具 schema 描述更新（module 参数可选值改为 hand/eye/ear/mouth/skin/vestibular/homeostasis）
  - [x] SubTask 7.3: `registerBodyTools` 函数中如引用旧类名，更新

- [x] Task 8: 验证与 tsc 检查
  - [x] SubTask 8.1: 运行 `cd server && npx tsc --noEmit`，修复所有类型错误
  - [x] SubTask 8.2: 全局搜索 `MotorCortex` / `VisualCortex` / `AuditoryCortex` / `VocalCortex` / `SomatoCortex` / `VestibularCortex` 旧类名，确认无残留引用
  - [x] SubTask 8.3: 全局搜索 `"motor"` / `"visual"` / `"auditory"` / `"vocal"` / `"somato"` 字符串字面量（作为 BodyModuleKind），确认无残留
  - [x] SubTask 8.4: 全局搜索 `body.visual.` / `body.auditory.` / `body.vocal.` / `body.somato.` / `body.motor.` 旧信号主题，确认无残留

# Task Dependencies

- Task 1 必须先完成（BodyModuleKind 枚举是其他任务的基础）
- Task 2-3 可并行（文件重命名与信号主题改名互不依赖）
- Task 4 依赖 Task 1-3（BodyGateway/BodyCenter 引用新类型与类名）
- Task 5 独立（BrainCenter 侧订阅主题改名）
- Task 6 依赖 Task 1-4（装配层引用所有新命名）
- Task 7 依赖 Task 1-2（HTTP 与工具 schema 引用新命名）
- Task 8 依赖 Task 1-7（最终验证）

**并行批次建议**：
- 批次 1：Task 1（枚举基础）
- 批次 2：Task 2 + Task 3 + Task 5（并行：文件重命名 / 信号改名 / 脑侧订阅同步）
- 批次 3：Task 4 + Task 7（BodyGateway/BodyCenter 适配 + HTTP/工具 schema）
- 批次 4：Task 6（bootstrap 装配）
- 批次 5：Task 8（最终验证）
