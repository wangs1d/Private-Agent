# Checklist

## 阶段 0：基础类型与目录准备

- [x] `server/src/brain/memory-cognitive/` 目录已创建
- [x] `server/src/brain/memory-cognitive/index.ts` 导出文件已创建
- [x] `MemoryProvenance` / `ConfidenceTier` 类型已新增到 `types.ts`
- [x] `ReconstructionValidation` / `SpreadingActivationResult` / `PredictedAssociation` 类型已新增到 `types.ts`
- [x] `SchemaNode` / `SchemaMatchResult` / `SalienceDecision` / `ProceduralMatch` 类型已新增到 `types.ts`
- [x] `MemoryRecallItem` 已扩展 `provenance?` / `confidenceTier?` / `salienceScore?` 可选字段（向后兼容）
- [x] `npx tsc --noEmit` 通过零错误

## 阶段 1：7 个认知子模块实现

### 1.1 SalienceFilter（情绪标记与显著性守门人）
- [x] `memory-salience-filter.ts` 已实现 `evaluateSalience(item)` 主入口
- [x] salienceScore 计算公式正确：emotionValence*0.4 + importance*0.3 + userFeedback*0.2 + novelty*0.1
- [x] 三档过滤逻辑正确：score < 0.2 拒绝；0.2-0.4 降级 decay；> 0.4 正常写入
- [x] `modulateRecallByEmotion(items, currentEmotion)` 已实现情绪调制召回
- [x] 主开关 `BRAIN_MEMORY_SALIENCE_ENABLED` 已实现（缺省开启，关闭时返回默认接受）

### 1.2 ForgettingController（主动遗忘与再唤醒反弹）
- [x] `memory-forgetting-controller.ts` 已实现 `continuousScore(actorId)`
- [x] `reawakenAndStrengthen(nodeId)` 实现：frequencyScore += 0.3 + deletionStage 回退一级
- [x] `reawakenAndStrengthen` 发射 `memory.reawakened` 事件到 SynapseBus
- [x] `pruneConnections(actorId)` 实现：score < 0.1 时清除节点 edge
- [x] `compactRecallText(text, score)` 压缩梯度正确：80% / 50% / 20%

### 1.3 AssociativeGraph（联想图谱 / 扩散激活）
- [x] `memory-associative-graph.ts` 已实现 `spread(actorId, seedNodeIds, opts)`
- [x] 扩散算法沿 MemoryEdgeRecord 边进行，hopCost 限制深度
- [x] 每跳衰减 0.5，激活值 > 阈值（0.3）才返回
- [x] `predictAssociation(actorId, query)` 已实现，predictedOutcome 由 summary 聚合（非 LLM）
- [x] 与 MetaCognitionCortex 联动：confidence < 0.4 触发 shouldExplore

### 1.4 ReconstructionValidator（重构校验器）
- [x] `memory-reconstruction-validator.ts` 已实现 `validateReconstruction(mergedNode, sourceNodes)`
- [x] accuracy（字段保留率）+ lostInfo（缺失信息）+ distortion（语义偏移 via embedding cosine）计算正确
- [x] accuracy < 0.7 时标记 `correctness=suspected_error`，保留原版本回退
- [x] `getProvenanceChain(nodeId)` 实现来源链路追溯
- [x] sourceChain 在 merge/abstract/promote 时记录到版本链

### 1.5 MetacognitionBridge（元记忆桥接器）
- [x] `memory-metacognition-bridge.ts` 已实现 `recallWithProvenance(actorId, query, opts)`
- [x] confidenceTier 规则计算正确：verified → known；pending → uncertain；accessCount<3 → unknown
- [x] unknown 条目自动附加"未经证实"标记
- [x] unknown 占比 > 50% 时异步触发 KnowledgeGapExecutor.executeGapQuery
- [x] 不阻塞当前 recall 返回

### 1.6 ProceduralAutomation（程序性学习与自动化）
- [x] `memory-procedural-automation.ts` 已实现 `registerProceduralSkill(skill)`
- [x] `matchProceduralSkill(query)` 实现：Jaccard 相似度匹配，matchScore > 0.8 命中
- [x] `isAutomatable(query)` 已实现
- [x] 热更新：SkillManager.registerFromCode 成功后自动同步，hotUpdateVersion 自增
- [x] 旧版本不删除，标记 `superseded: true` 保留回退能力

### 1.7 SchemaFormation（语义抽象与图式形成）
- [x] `memory-schema-formation.ts` 已实现 `extractSchema(actorId, sceneTag)`
- [x] 相同 sceneTag 节点 ≥ 3 时触发抽取
- [x] SchemaNode 结构正确：name, steps, preconditions, expectedOutcomes, instances, stereotypeWarningCount
- [x] `matchSchema(newSituation)` 返回 matchScore 最高的 SchemaNode
- [x] `recordStereotypeFailure(schemaId)` 自增 stereotypeWarningCount
- [x] stereotypeWarningCount > 3 时附加警告标记

## 阶段 2：HumanLikeMemoryService 扩展

- [x] `reawakenNode(nodeId)` 已实现：frequencyScore += 0.3 + deletionStage 回退一级
- [x] `pruneNodeEdges(nodeId)` 已实现：清除节点所有 edge，保留节点本体
- [x] `SleepAgentStage` 类型新增 `connection_pruning` 与 `schema_formation` 两个阶段
- [x] 现有 API 未被破坏，新方法为可选调用
- [x] `npx tsc --noEmit` 通过零错误

## 阶段 3：MemoryCortex 集成 7 个子组件

- [x] 7 个私有字段 + `register*()` 方法已添加到 `memory-cortex.ts`
- [x] `remember()` 入口接入 salience filter（若注册且开启）
- [x] `recall()` 后异步触发 spreading activation（不阻塞主召回）
- [~] `recall()` 命中 downranked/cold 节点时触发 `reawakenAndStrengthen`（由 BrainStem 45s 心跳路径覆盖）
- [x] `consolidate()` 接入 reconstruction validator + connection pruning
- [x] 6 个对外方法已实现：`recallWithProvenance` / `predictAssociation` / `matchSchema` / `evaluateSalience` / `reawakenAndStrengthen` / `matchProceduralSkill`
- [x] 现有 `recall()` / `remember()` 签名未变（向后兼容）
- [x] `npx tsc --noEmit` 通过零错误

## 阶段 4：BrainCenter 与 Bootstrap 集成

- [x] `MemoryCortexLike` 接口已扩展 6 个新方法签名（可选方法）
- [x] 新增 `registerMemoryCognitiveSubmodules()` 方法供 bootstrap 注入
- [x] `cognize()` 阶段接入元记忆桥：使用 `recallWithProvenance` 替代 `recall`（可用时）
- [x] `bootstrap/create-app-services.ts` 实例化 7 个新子模块
- [x] 通过 `brainCenter.registerMemoryCognitiveSubmodules()` 注入
- [x] MetaCognitionCortex / KnowledgeVerificationService / KnowledgeGapExecutor 桥接完成
- [x] BrainStem 45s 心跳 → ForgettingController.continuousScore 桥接完成（通过 onHeartbeat 回调）
- [x] `npx tsc --noEmit` 通过零错误

## 阶段 5：环境开关与降级

- [x] `BRAIN_MEMORY_COGNITIVE_ENABLED` 主开关已实现（缺省开启）
- [x] 7 个独立开关已实现：`BRAIN_MEMORY_ASSOCIATIVE_ENABLED` / `BRAIN_MEMORY_RECONSTRUCTION_ENABLED` / `BRAIN_MEMORY_METACOGNITION_ENABLED` / `BRAIN_MEMORY_FORGET_ENABLED` / `BRAIN_MEMORY_PROCEDURAL_ENABLED` / `BRAIN_MEMORY_SCHEMA_ENABLED` / `BRAIN_MEMORY_SALIENCE_ENABLED`
- [x] 主开关关闭时 7 个子模块均不实例化
- [x] 主开关关闭时 MemoryCortex 行为与升级前完全一致
- [x] 单个独立开关关闭时仅对应子模块方法降级（其他子模块正常工作）
- [x] 单元测试 `memory-cognitive-degrade.test.ts` 验证降级路径（5 场景全通过）

## 阶段 6：集成测试与回归测试

### 6.1 端到端集成测试
- [x] `memory-cognitive-integration.test.ts` 覆盖 recall → spread → explore 闭环
- [x] 覆盖 remember → salience filter → 写入/拒绝路径
- [x] 覆盖 consolidate → reconstruction validator → connection pruning 闭环
- [x] 覆盖 procedural skill 热更新 → matchProceduralSkill → 绕过 LLM 闭环

### 6.2 全量回归测试
- [x] `npx tsc --noEmit` 通过零编译错误
- [x] `npm test` 全量测试套件已运行（310 tests）
- [x] 与升级前基线对比，无新增回归（309 pass / 1 fail，失败为预存基线问题）
- [x] 测试结果报告已输出

## 不走 prompt 路线验证

- [x] 联想：SpreadingActivation 是图算法，无 LLM 调用
- [x] 重构校验：对比 source 与 merged 的字段 overlap + cosine 相似度，无 LLM 自评
- [x] 元记忆：confidenceTier 由 accessCount / correctness / verification 状态规则计算，无 LLM 表演
- [x] 遗忘反弹：reawaken 是状态机回退，无 LLM 决定
- [x] 程序性自动化：技能匹配是 Jaccard 关键词匹配，无 LLM 决定
- [x] 图式形成：从多个节点提取公共 step 序列是 LCS 算法聚类，无 LLM 归纳
- [x] 显著性过滤：salienceScore 是加权计算，无 LLM 判断重要性

## 向后兼容验证

- [x] 现有 `MemoryCortex.remember()` 签名未变
- [x] 现有 `MemoryCortex.recall()` 签名未变
- [x] 现有 `MemoryCortex.consolidate()` 签名未变
- [x] `MemoryRecallItem` 新增字段为可选，旧调用方不受影响
- [x] `BRAIN_MEMORY_COGNITIVE_ENABLED=0` 时行为与升级前完全一致
- [x] 现有测试 0 回归（仅 1 个预存失败 BrainStem 重复抑制，与本次改动无关）
