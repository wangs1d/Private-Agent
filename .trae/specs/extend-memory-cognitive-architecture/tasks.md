# Tasks

## 阶段 0：基础类型与目录准备

- [x] Task 0.1: 创建 `server/src/brain/memory-cognitive/` 目录与 `index.ts` 导出文件
  - [x] SubTask 0.1.1: 新建目录 `server/src/brain/memory-cognitive/`
  - [x] SubTask 0.1.2: 创建 `index.ts` 占位导出文件（待 7 个子模块完成后逐个 re-export）
- [x] Task 0.2: 在 `server/src/brain/types.ts` 新增 9 个核心类型
  - [x] SubTask 0.2.1: 新增 `MemoryProvenance` / `ConfidenceTier` 类型
  - [x] SubTask 0.2.2: 新增 `ReconstructionValidation` / `SpreadingActivationResult` / `PredictedAssociation` 类型
  - [x] SubTask 0.2.3: 新增 `SchemaNode` / `SchemaMatchResult` / `SalienceDecision` / `ProceduralMatch` 类型
  - [x] SubTask 0.2.4: 扩展 `MemoryRecallItem` 加 `provenance?` / `confidenceTier?` / `salienceScore?` 可选字段（向后兼容）
  - [x] SubTask 0.2.5: 跑 `npx tsc --noEmit` 确认零错误

## 阶段 1：7 个认知子模块实现（并行开发，无相互依赖）

- [x] Task 1.1: 实现 `memory-salience-filter.ts`（情绪标记与显著性守门人）
- [x] Task 1.2: 实现 `memory-forgetting-controller.ts`（主动遗忘与再唤醒反弹）
- [x] Task 1.3: 实现 `memory-associative-graph.ts`（联想图谱 / 扩散激活）
- [x] Task 1.4: 实现 `memory-reconstruction-validator.ts`（重构校验器）
- [x] Task 1.5: 实现 `memory-metacognition-bridge.ts`（元记忆桥接器）
- [x] Task 1.6: 实现 `memory-procedural-automation.ts`（程序性学习与自动化）
- [x] Task 1.7: 实现 `memory-schema-formation.ts`（语义抽象与图式形成）

## 阶段 2：HumanLikeMemoryService 扩展

- [x] Task 2.1: 在 `human-like-memory-service.ts` 新增公开方法
  - [x] SubTask 2.1.1: 实现 `reawakenNode(nodeId)`：frequencyScore += 0.3 + deletionStage 回退一级
  - [x] SubTask 2.1.2: 实现 `pruneNodeEdges(nodeId)`：清除节点所有 edge，保留节点本体
  - [x] SubTask 2.1.3: 在 `SleepAgentStage` 类型新增 `connection_pruning` 与 `schema_formation` 两个阶段
  - [x] SubTask 2.1.4: 跑 `npx tsc --noEmit` 确认零错误

## 阶段 3：MemoryCortex 集成 7 个子组件

- [x] Task 3.1: 在 `memory-cortex.ts` 注册 7 个子组件
  - [x] SubTask 3.1.1: 新增 7 个私有字段 + `registerAssociativeGraph` / `registerReconstructionValidator` / `registerMetacognitionBridge` / `registerForgettingController` / `registerProceduralAutomation` / `registerSchemaFormation` / `registerSalienceFilter` 方法
  - [x] SubTask 3.1.2: `remember()` 入口接入 salience filter（若注册且开启）
  - [x] SubTask 3.1.3: `recall()` 后异步触发 spreading activation（不阻塞主召回）
  - [~] SubTask 3.1.4: `recall()` 命中 downranked/cold 节点时触发 `reawakenAndStrengthen`（由 BrainStem 45s 心跳 → forgettingController.continuousScore 路径覆盖，recall 路径不直接查询 deletionStage）
  - [x] SubTask 3.1.5: `consolidate()` 接入 reconstruction validator + connection pruning
- [x] Task 3.2: 在 MemoryCortex 新增 6 个对外方法
  - [x] SubTask 3.2.1: `recallWithProvenance(actorId, query, opts)` 委托 MetacognitionBridge
  - [x] SubTask 3.2.2: `predictAssociation(actorId, query)` 委托 AssociativeGraph
  - [x] SubTask 3.2.3: `matchSchema(situation)` 委托 SchemaFormation
  - [x] SubTask 3.2.4: `evaluateSalience(item)` 委托 SalienceFilter
  - [x] SubTask 3.2.5: `reawakenAndStrengthen(nodeId)` 委托 ForgettingController
  - [x] SubTask 3.2.6: `matchProceduralSkill(query)` 委托 ProceduralAutomation
  - [x] SubTask 3.2.7: 跑 `npx tsc --noEmit` 确认零错误

## 阶段 4：BrainCenter 与 Bootstrap 集成

- [x] Task 4.1: 在 `brain-center.ts` 注入 7 个子组件
  - [x] SubTask 4.1.1: 扩展 `MemoryCortexLike` 接口新增 6 个方法签名（可选方法）
  - [x] SubTask 4.1.2: 新增 `registerMemoryCognitiveSubmodules()` 方法供 bootstrap 注入
  - [x] SubTask 4.1.3: `cognize()` 阶段接入元记忆桥：使用 `recallWithProvenance` 替代 `recall`（可用时）
- [x] Task 4.2: 在 `bootstrap/create-app-services.ts` 实例化与注入
  - [x] SubTask 4.2.1: 实例化 7 个新子模块（BRAIN_MEMORY_COGNITIVE_ENABLED 主开关块内）
  - [x] SubTask 4.2.2: 通过 `brainCenter.registerMemoryCognitiveSubmodules()` 注入
  - [x] SubTask 4.2.3: 桥接 MetaCognitionCortex / KnowledgeVerificationService / KnowledgeGapExecutor（已提升至外层作用域供使用）
  - [x] SubTask 4.2.4: 桥接 BrainStem 45s 心跳 → ForgettingController.continuousScore（通过 `brainStemRef.onHeartbeat()` 注册回调）
  - [x] SubTask 4.2.5: 跑 `npx tsc --noEmit` 确认零错误

## 阶段 5：环境开关与降级

- [x] Task 5.1: 实现主开关 + 7 个独立开关
  - [x] SubTask 5.1.1: 新增 `BRAIN_MEMORY_COGNITIVE_ENABLED` 环境变量读取（缺省开启）
  - [x] SubTask 5.1.2: 7 个子模块独立开关已实现：`BRAIN_MEMORY_ASSOCIATIVE_ENABLED` / `BRAIN_MEMORY_RECONSTRUCTION_ENABLED` / `BRAIN_MEMORY_METACOGNITION_ENABLED` / `BRAIN_MEMORY_FORGET_ENABLED` / `BRAIN_MEMORY_PROCEDURAL_ENABLED` / `BRAIN_MEMORY_SCHEMA_ENABLED` / `BRAIN_MEMORY_SALIENCE_ENABLED`
  - [x] SubTask 5.1.3: 主开关关闭时 7 个子模块均不实例化，MemoryCortex 行为与升级前一致
  - [x] SubTask 5.1.4: 单元测试 `memory-cognitive-degrade.test.ts` 验证降级路径（已合并到 Phase 6.1）

## 阶段 6：集成测试与回归测试

- [x] Task 6.1: 端到端集成测试
  - [x] SubTask 6.1.1: 新增 `memory-cognitive-integration.test.ts` 覆盖 recall → spread → explore 闭环（12 场景 A-L 全部通过）
  - [x] SubTask 6.1.2: 覆盖 remember → salience filter → 写入/拒绝/降级路径（场景 A/B/C）
  - [x] SubTask 6.1.3: 覆盖 consolidate → reconstruction validator → connection pruning 闭环（场景 K）
  - [x] SubTask 6.1.4: 覆盖 procedural skill 热更新 → matchProceduralSkill → 绕过 LLM 闭环（场景 H/I）
  - [x] SubTask 6.1.5: 新增 `memory-cognitive-degrade.test.ts` 验证主开关与独立开关降级（5 场景 M-Q 全部通过）
- [x] Task 6.2: 跑全量回归测试
  - [x] SubTask 6.2.1: 运行 `npx tsc --noEmit` 确认零编译错误（exit code 0）
  - [x] SubTask 6.2.2: 运行 `npm test` 跑全量测试套件（310 tests / 309 pass / 1 fail）
  - [x] SubTask 6.2.3: 对比升级前基线，确认无新增回归（仅 1 个预存失败：BrainStem 重复抑制）
  - [x] SubTask 6.2.4: 输出测试结果报告（通过/失败/新增/预存失败分类）

# Task Dependencies

- [Task 0.1, 0.2] 必须先完成，是后续所有任务的基础
- [Task 1.1-1.7] 7 个子模块相互独立，可并行开发
- [Task 2.1] 与 [Task 1.1-1.7] 可并行（HumanLikeMemoryService 扩展）
- [Task 3.1, 3.2] 依赖 [Task 1.1-1.7] + [Task 2.1] 完成
- [Task 4.1, 4.2] 依赖 [Task 3.1, 3.2] 完成
- [Task 5.1] 依赖 [Task 4.1, 4.2] 完成
- [Task 6.1] 依赖 [Task 5.1] 完成
- [Task 6.2] 依赖 [Task 6.1] 完成
