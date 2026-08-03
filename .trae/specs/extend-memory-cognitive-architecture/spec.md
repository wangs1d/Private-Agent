# 记忆模块认知架构升级 Spec

## Why

当前 BrainCenter 的 MemoryCortex（海马体）已具备四类记忆子系统（短期/agentic/海马体/叙事）和关系图谱、权重动态、睡眠巩固等基础能力，但缺少**仿人认知的 7 项核心能力**：

1. **联想能力缺位**：记忆间虽有 edge 连接，但缺乏"突触突然活跃"的扩散激活机制，无法基于细微/隐性关联预判结果，更无法对"联想到的未知"触发主动探索
2. **重构准确性不足**：已有版本与合并机制雏形，但缺一致性校验与来源追踪，重构后记忆可能失真
3. **元记忆能力靠 prompt 演戏**：MetaCognitionCortex 与 KnowledgeVerificationService 已存在但未接入记忆召回链路，agent 无法在 recall 时"知之为知之，不知为不知"，且通过 prompt 引导而非程序化架构
4. **遗忘缺"再唤醒反弹"**：已有 decay_weight 衰减和 deletionStage 状态机，但被遗忘记忆在突然被召回时**不会反弹加强**，且无连接剪枝机制
5. **程序性学习未后台化**：SkillPromotionPipeline 已存在但未与 procedural 记忆域联动，已学技能无法作为"自动技能"绕过 LLM 决策，热更新机制未形式化
6. **无图式形成**：已有 MemoryCommunityRecord 社区结构与 monthly_abstract 阶段，但未提取"餐厅图式"等结构化知识框架，新环境无法同化
7. **无显著性守门人**：emotionTags 已存在但未形成"什么值得被记住"的守门机制，所有记忆平等进入写入路径

本 spec 在**已有 MemoryCortex 基础上**新增 7 个认知子模块，**全部通过程序化 API + 事件驱动实现**，不通过 prompt 引导。完成后跑全量回归测试。

## What Changes

### 新增（`server/src/brain/memory-cognitive/` 下新增 7 个子模块文件）

- **`memory-associative-graph.ts`**（联想图谱 / 扩散激活引擎）
  - 实现 SpreadingActivation 算法：recall 命中节点后，沿 MemoryEdgeRecord 边扩散激活，hopCost 限制深度
  - 暴露 `spread(actorId, seedNodeIds, opts)` → 返回激活节点列表 + 综合激活值
  - 预测联想：`predictAssociation(actorId, query)` 基于激活节点预判可能结果
  - 与 MetaCognitionCortex 联动：联想置信度 < 阈值时触发 `shouldExplore` 信号 → 调用 KnowledgeGapExecutor 主动探索
  - 注册为 MemoryCortex 子组件，recall 后自动异步扩散（不阻塞主召回）

- **`memory-reconstruction-validator.ts`**（重构与更新校验器）
  - 校验 merge / abstract 产出的重构记忆：与 source 节点对比，检测信息丢失/扭曲
  - 暴露 `validateReconstruction(mergedNode, sourceNodes)` → 返回 `ReconstructionValidation { accuracy, lostInfo, distortion, isValid }`
  - 扩展睡眠巩固阶段：在 `weekly_merge` / `monthly_abstract` 后自动调用校验
  - 失败的重构记忆标记 `correctness=suspected_error`，保留原版本
  - 来源追踪强化：每个版本记录 sourceChain（来源链路），可追溯到原始 chat/tool/digest

- **`memory-metacognition-bridge.ts`**（元记忆桥接器）
  - 桥接 MemoryCortex ↔ MetaCognitionCortex ↔ KnowledgeVerificationService
  - 程序化"知之为知之"：recall 时附加 `provenance`（来源链）+ `confidenceTier`（known / uncertain / unknown）
  - 防幻觉过滤：`confidenceTier=unknown` 的记忆在召回时打上"未经证实"标记
  - 自动触发自我探索：confidence < 0.3 且 KnowledgeGapExecutor 可用时，异步触发 `executeGapQuery`
  - 暴露 `recallWithProvenance(actorId, query, opts)` → 返回带元记忆标记的召回结果

- **`memory-forgetting-controller.ts`**（主动遗忘与抑制控制器）
  - 连续打分器：不只是睡眠期衰减，每次 recall / 时间周期都更新 score
  - 压缩梯度：score 越低 → memory summary 越压缩（character limit 递减）
  - 连接剪枝：score < PRUNE_THRESHOLD 时清除该节点的所有 edge（保留节点本体供历史追溯）
  - **再唤醒反弹（核心新能力）**：当 deletionStage=`downranked`/`cold` 的节点被 recall 命中时，自动 `reawakenAndStrengthen(nodeId)`：
    - frequencyScore += REAWAKEN_BOOST（默认 +0.3，远超普通 recall 的 +0.06）
    - deletionStage 回退一级（cold → downranked → active）
    - 发射 `memory.reawakened` 事件供 SynapseBus 广播
  - 暴露 `reawakenAndStrengthen(nodeId)` / `continuousScore(actorId)` / `pruneConnections(actorId)` API

- **`memory-procedural-automation.ts`**（程序性学习与自动化）
  - 桥接 SkillPromotionPipeline → procedural 记忆域
  - 自动化路由：`matchProceduralSkill(query)` 检查是否已有匹配的 procedural 记忆可绕过 LLM
  - 热更新注册：SkillManager.registerFromCode 成功后自动同步写入 procedural 域
  - 后台化执行：标记为"已自动化"的任务通过工具直调，不进入 LLM 决策环节
  - 暴露 `registerProceduralSkill(skill)` / `matchProceduralSkill(query)` / `isAutomatable(query)` API

- **`memory-schema-formation.ts`**（语义抽象与图式形成）
  - 图式抽取器：从多个相似 episodic 节点提取公共结构 → 生成 SchemaNode
  - SchemaNode 结构：`{ name, steps[], preconditions[], expectedOutcomes[], stereotypeWarnings[] }`
  - 匹配与同化：`matchSchema(newSituation)` 返回最匹配的图式供决策参考
  - 刻板印象追踪：记录 schema 被错误套用的次数，触发 `stereotypeWarning`
  - 暴露 `extractSchema(actorId, domain)` / `matchSchema(situation)` / `recordStereotypeFailure(schemaId)` API

- **`memory-salience-filter.ts`**（情绪标记与显著性过滤）
  - 守门人机制：写入前评估 salienceScore，低显著性记忆直接拒绝或降级
  - 情绪向量融合：综合 emotionTags + EmotionalValence + 用户反馈 → salienceScore (0-1)
  - 显著性调制召回：当前情绪状态影响召回权重（高兴时优先召回正面记忆）
  - 暴露 `evaluateSalience(memoryItem)` → `SalienceDecision { accept, score, reason }`
  - 在 MemoryCortex.remember 入口处插入守门过滤

### 修改

- **MODIFIED** `server/src/brain/memory-cortex.ts`：
  - 新增 7 个子组件引用 + `register*()` 方法
  - 新增方法：`recallWithProvenance` / `predictAssociation` / `matchSchema` / `evaluateSalience` / `reawakenAndStrengthen` / `matchProceduralSkill`
  - 现有 `remember()` 入口处接入 salience filter
  - 现有 `recall()` 后异步触发 spreading activation
  - 现有 `consolidate()` 阶段接入 reconstruction validator + connection pruning

- **MODIFIED** `server/src/brain/types.ts`：
  - 新增类型：`MemoryProvenance` / `ConfidenceTier` / `ReconstructionValidation` / `SpreadingActivationResult` / `PredictedAssociation` / `SchemaNode` / `SchemaMatchResult` / `SalienceDecision` / `ProceduralMatch`
  - 扩展 `MemoryRecallItem`：新增 `provenance?` / `confidenceTier?` / `salienceScore?` 可选字段（向后兼容）

- **MODIFIED** `server/src/brain/brain-center.ts`：
  - `registerMemory()` 后自动注入 7 个子组件（brainNeuroEnabled 块内）
  - `cognize()` 阶段接入元记忆桥：召回结果附带 provenance 标记

- **MODIFIED** `server/src/bootstrap/create-app-services.ts`：
  - 实例化 7 个新子模块
  - 注入到 MemoryCortex（通过 register* 方法）
  - 桥接 MetaCognitionCortex / KnowledgeVerificationService / SkillPromotionPipeline / SkillManager

- **MODIFIED** `server/src/services/human-like-memory-service.ts`（仅扩展，不破坏）：
  - 新增 `reawakenNode(nodeId)` / `pruneNodeEdges(nodeId)` 公开方法供 ForgettingController 调用
  - 睡眠阶段新增 `connection_pruning` 与 `schema_formation` 两个新阶段（与现有 `consistency_audit` 同级）

### 不走 prompt 路线的具体含义

- **联想**：SpreadingActivation 是图算法，沿边权重扩散，不让 LLM "想象关联"
- **重构校验**：对比 source 与 merged 的字段 overlap + cosine 相似度，不让 LLM 自评
- **元记忆**：confidenceTier 由 accessCount / correctness / verification 状态规则计算，不让 LLM "表演谦虚"
- **遗忘反弹**：reawaken 是状态机回退，不让 LLM 决定是否加强
- **程序性自动化**：技能匹配是关键词/embedding 匹配，不让 LLM 决定是否走快速路径
- **图式形成**：从多个节点提取公共 step 序列是算法聚类，不让 LLM "归纳"
- **显著性过滤**：salienceScore 是 emotionValence + importance + feedback 加权，不让 LLM "判断重要性"

## Impact

- **Affected specs**：
  - `add-agent-brain-center`（本 spec 扩展其 MemoryCortex 子系统，向后兼容）
  - `extend-brain-neuroanatomy`（本 spec 在 11 分区基础上为 MemoryCortex 加 7 个认知子组件）
  - 后续 `self_programming`（ProceduralAutomation 与 SkillPromotion 联动）

- **Affected code**：
  - 新增：`server/src/brain/memory-cognitive/memory-associative-graph.ts` / `memory-reconstruction-validator.ts` / `memory-metacognition-bridge.ts` / `memory-forgetting-controller.ts` / `memory-procedural-automation.ts` / `memory-schema-formation.ts` / `memory-salience-filter.ts` + `index.ts`
  - 修改：`server/src/brain/memory-cortex.ts` / `brain-center.ts` / `types.ts`、`server/src/bootstrap/create-app-services.ts`、`server/src/services/human-like-memory-service.ts`
  - 收编（注册为子组件，不改实现）：`MetaCognitionCortex` / `KnowledgeVerificationService` / `KnowledgeGapExecutor` / `SkillPromotionPipeline` / `SkillManager` / `SkillGenerator`

- **Rollout**：
  - 默认开启，`BRAIN_MEMORY_COGNITIVE_ENABLED=0` 时 7 个新子模块不实例化，MemoryCortex 回退到原有行为
  - 每个子模块独立开关：`BRAIN_MEMORY_ASSOCIATIVE_ENABLED` / `BRAIN_MEMORY_RECONSTRUCTION_ENABLED` / `BRAIN_MEMORY_METACOGNITION_ENABLED` / `BRAIN_MEMORY_FORGETTING_ENABLED` / `BRAIN_MEMORY_PROCEDURAL_ENABLED` / `BRAIN_MEMORY_SCHEMA_ENABLED` / `BRAIN_MEMORY_SALIENCE_ENABLED`（缺省均开启，受主开关统辖）

## ADDED Requirements

### Requirement: MemoryAssociativeGraph 联想图谱（突触扩散激活）

系统 SHALL 提供 `MemoryAssociativeGraph`，实现仿突触的扩散激活算法，让 agent 基于细微/隐性关联联想记忆，并在联想置信度低时触发主动探索。**不让 LLM 想象关联**。

#### Scenario: recall 命中后自动扩散激活

- **WHEN** MemoryCortex.recall 返回 ≥1 个命中节点
- **THEN** 异步触发 `associativeGraph.spread(actorId, seedNodeIds, { maxHops: 2, activationThreshold: 0.3 })`
- **AND** 沿 MemoryEdgeRecord 边扩散，每跳衰减 0.5
- **AND** 返回激活值 > 阈值的节点列表作为"联想记忆"
- **AND** 不阻塞主 recall 返回

#### Scenario: 联想置信度低触发自我探索

- **WHEN** spread 返回的联想节点中包含 confidence < 0.4 的"未知关联"
- **THEN** 触发 MetaCognitionCortex 标记 `shouldExplore=true`
- **AND** 若 KnowledgeGapExecutor 可用，异步执行 `executeGapQuery` 主动学习验证
- **AND** 学习结果回写为新的 semantic 记忆，confidence 初始 0.3

#### Scenario: 联想预判

- **WHEN** 调用 `predictAssociation(actorId, query)`
- **THEN** 返回 `PredictedAssociation { seedNodes, activatedNodes, predictedOutcome, confidence }`
- **AND** predictedOutcome 由激活节点的 summary 聚合而成（规则拼接，非 LLM 生成）

### Requirement: MemoryReconstructionValidator 重构校验器

系统 SHALL 提供 `MemoryReconstructionValidator`，在记忆合并/抽象后校验重构准确性，防止信息丢失与扭曲。**不让 LLM 自评**。

#### Scenario: 合并后自动校验

- **WHEN** 睡眠巩固执行 `weekly_merge` 或 `monthly_abstract` 产出新节点
- **THEN** 自动调用 `validateReconstruction(mergedNode, sourceNodes)`
- **AND** 计算 accuracy（字段保留率）+ lostInfo（缺失的关键信息）+ distortion（语义偏移，用 embedding cosine）
- **AND** accuracy < 0.7 时标记 mergedNode `correctness=suspected_error`，保留原版本回退路径

#### Scenario: 来源链路可追溯

- **WHEN** 任意节点被重构（merge/abstract/promote）
- **THEN** 新版本记录 `sourceChain: { versionId, sourceNodeIds, sourceSummary }`
- **AND** 通过 `getProvenanceChain(nodeId)` 可向上追溯到原始 chat/tool 来源

### Requirement: MemoryMetacognitionBridge 元记忆桥接器

系统 SHALL 提供 `MemoryMetacognitionBridge`，桥接 MemoryCortex 与 MetaCognitionCortex/KnowledgeVerificationService，实现程序化的"知之为知之，不知为不知"，防幻觉并触发自我探索。**不通过 prompt 实现**。

#### Scenario: 召回附带来源与置信分层

- **WHEN** 调用 `recallWithProvenance(actorId, query)`
- **THEN** 返回 MemoryRecallItem 列表，每条附带：
  - `provenance: { source, sourceType, capturedAt, sourceChain }`
  - `confidenceTier: "known" | "uncertain" | "unknown"`（规则计算：verified → known；pending/unconfirmed → uncertain；< 3 次召回 → unknown）
- **AND** confidenceTier=unknown 的条目自动附加"未经证实"标记

#### Scenario: 低置信触发自我探索

- **WHEN** recall 返回的条目中 confidenceTier=unknown 占比 > 50%
- **AND** KnowledgeGapExecutor 可用
- **THEN** 异步触发 `executeGapQuery(query)` 主动学习
- **AND** 学习结果回写为新记忆，初始 confidence=0.3，标记为 pending_verification
- **AND** 不阻塞当前 recall 返回

#### Scenario: 防幻觉过滤

- **WHEN** LLM 即将基于召回结果生成回复
- **AND** 召回结果中存在 confidenceTier=unknown 的条目
- **THEN** 在 context 注入时附加显式标记 `【此信息未经证实，可能不准确】`
- **AND** 不删除该条目（保留可用性，但明确不确定性）

### Requirement: MemoryForgettingController 主动遗忘与再唤醒反弹

系统 SHALL 提供 `MemoryForgettingController`，实现连续打分、压缩梯度、连接剪枝，以及**被遗忘记忆再唤醒时的反弹加强**。**不让 LLM 决定是否遗忘/加强**。

#### Scenario: 连续打分（非睡眠期也衰减）

- **WHEN** BrainStem 45s 心跳扫描触发 `forgettingController.continuousScore(actorId)`
- **THEN** 对所有节点更新 score：`score = frequencyScore * 0.4 + recencyScore * 0.3 + importance * 0.2 + userFeedbackScore * 0.1`
- **AND** score < 0.2 的节点 deletionStage 推进一级（active → downranked → cold → soft_deleted）
- **AND** score < 0.1 时触发连接剪枝（清除该节点所有 edge）

#### Scenario: 再唤醒反弹（核心新能力）

- **WHEN** recall 命中一个 deletionStage=`downranked` 或 `cold` 的节点
- **THEN** 自动调用 `reawakenAndStrengthen(nodeId)`
- **AND** frequencyScore += 0.3（远超普通 recall 的 +0.06）
- **AND** deletionStage 回退一级：cold → downranked，downranked → active
- **AND** 发射 `memory.reawakened` 事件到 SynapseBus
- **AND** lastAccessedAt 更新为当前时间

#### Scenario: 压缩梯度

- **WHEN** 节点 score < 0.5 时
- **THEN** 召回时返回的 summary 按梯度压缩：
  - score 0.3-0.5：保留 80% 内容
  - score 0.1-0.3：保留 50% 内容
  - score < 0.1：保留 20% 内容（仅关键词）
- **AND** 压缩由 `compactRecallText(text, score)` 实现，非 LLM 调用

### Requirement: MemoryProceduralAutomation 程序性学习与自动化

系统 SHALL 提供 `MemoryProceduralAutomation`，将已学会的显性技能转化为绕过 LLM 的自动技能，支持热更新。**不让 LLM 决定是否走快速路径**。

#### Scenario: 技能成功后自动写入 procedural 域

- **WHEN** SkillPromotionPipeline 成功装载一个 skill
- **THEN** 自动调用 `proceduralAutomation.registerProceduralSkill(skill)`
- **AND** 写入 procedural 记忆域：`{ skillId, triggerPattern, handlerRef, hotUpdateVersion }`
- **AND** hotUpdateVersion 自增，旧版本保留为历史

#### Scenario: 任务匹配已学技能绕过 LLM

- **WHEN** 用户请求进入 BrainCenter.cognize
- **THEN** 先调用 `proceduralAutomation.matchProceduralSkill(query)`
- **AND** 命中（matchScore > 0.8）时直接执行 skill handler，跳过 LLM 决策
- **AND** 未命中走正常 cognize 路径

#### Scenario: 热更新支持

- **WHEN** SkillManager.registerFromCode 被调用（新增或更新 skill）
- **THEN** ProceduralAutomation 自动同步更新 procedural 记忆
- **AND** 旧版本不删除，标记 `superseded: true`，保留回退能力
- **AND** 正在执行的旧版本任务不受影响（最终一致）

### Requirement: MemorySchemaFormation 语义抽象与图式形成

系统 SHALL 提供 `MemorySchemaFormation`，从多次具体经验提取公共结构形成图式，供新环境同化使用，并追踪刻板印象。**不让 LLM 归纳**。

#### Scenario: 多次相似经历自动抽象图式

- **WHEN** episodic 域中相同 sceneTag 的节点累计 ≥ 3 个
- **THEN** 触发 `extractSchema(actorId, sceneTag)`
- **AND** 从节点 sequence 提取公共 step 序列（最长公共子序列 + 频次过滤）
- **AND** 生成 SchemaNode：`{ name, steps, preconditions, expectedOutcomes, instances }`
- **AND** 写入新的 schema 子域（隶属 episodic）

#### Scenario: 新环境匹配图式同化

- **WHEN** 用户进入新场景（sceneTag 变化）
- **THEN** 调用 `matchSchema(newSituation)`
- **AND** 返回 matchScore 最高的 SchemaNode（若有）
- **AND** 把 schema.steps 作为"建议操作序列"注入 context 供 PlannerCortex 参考
- **AND** 不强制执行（仅建议）

#### Scenario: 刻板印象追踪

- **WHEN** schema 被套用后实际结果与 expectedOutcomes 偏差 > 阈值
- **THEN** 调用 `recordStereotypeFailure(schemaId)`
- **AND** schema.stereotypeWarningCount 自增
- **AND** stereotypeWarningCount > 3 时在 matchSchema 时附加警告标记

### Requirement: MemorySalienceFilter 情绪标记与显著性守门人

系统 SHALL 提供 `MemorySalienceFilter`，作为"什么值得被记住"的守门人，基于情绪向量与显著性评分过滤写入。**不让 LLM 判断重要性**。

#### Scenario: 写入前守门过滤

- **WHEN** MemoryCortex.remember 被调用
- **THEN** 先调用 `salienceFilter.evaluateSalience(item)`
- **AND** 计算 salienceScore = emotionValence权重 * 0.4 + importance权重 * 0.3 + userFeedback权重 * 0.2 + novelty权重 * 0.1
- **AND** salienceScore < 0.2 时返回 `accept: false`，拒绝写入（小话术/已存在噪音）
- **AND** salienceScore 0.2-0.4 时降级为 decay（短期保留）
- **AND** salienceScore > 0.4 时正常写入

#### Scenario: 情绪状态调制召回

- **WHEN** recall 时 LimbicCortex 提供当前 EmotionVector
- **THEN** 与记忆节点的 emotionTags 计算情绪匹配度
- **AND** 匹配度高的节点 score 上浮（最高 +0.2）
- **AND** 不匹配的节点 score 下浮（最低 -0.1）
- **AND** 不删除任何记忆（仅调整召回优先级）

### Requirement: 7 个子模块的统一降级开关

系统 SHALL 提供主开关 `BRAIN_MEMORY_COGNITIVE_ENABLED=0` 完全禁用 7 个新子模块，回退到原 MemoryCortex 行为。每个子模块有独立开关，但受主开关统辖。

#### Scenario: 主开关关闭完全降级

- **WHEN** `BRAIN_MEMORY_COGNITIVE_ENABLED=0`
- **THEN** 7 个子模块均不实例化
- **AND** MemoryCortex.remember / recall / consolidate 行为与升级前完全一致
- **AND** 现有测试 0 回归

#### Scenario: 单个子模块独立关闭

- **WHEN** `BRAIN_MEMORY_ASSOCIATIVE_ENABLED=0`（其他保持开启）
- **THEN** 仅联想图谱不实例化，其他 6 个正常工作
- **AND** recall 后不触发扩散激活，其他增强保留

## MODIFIED Requirements

### Requirement: MemoryCortex 记忆皮层（海马体）

[原有 requirement 见 extend-brain-neuroanatomy spec，本 spec 扩展为：]

MemoryCortex 在原有四类记忆子系统（短期/agentic/海马体/叙事）基础上，新增 7 个认知子组件，所有方法保持向后兼容：
- `remember()` 入口接入 salience filter（可选）
- `recall()` 后异步触发 spreading activation（可选）
- `consolidate()` 接入 reconstruction validator + connection pruning（可选）
- 新增 `recallWithProvenance()` / `predictAssociation()` / `matchSchema()` / `evaluateSalience()` / `reawakenAndStrengthen()` / `matchProceduralSkill()` 方法
- 现有 `recall()` / `remember()` 签名不变，新功能通过可选注入实现

### Requirement: HumanLikeMemoryService 海马体记忆服务

[原有 requirement 见 extend-brain-neuroanatomy spec，本 spec 扩展为：]

HumanLikeMemoryService 新增公开方法供 ForgettingController 调用：
- `reawakenNode(nodeId)`：节点再唤醒，frequencyScore += 0.3，deletionStage 回退一级
- `pruneNodeEdges(nodeId)`：清除节点所有 edge，保留节点本体
- 睡眠巩固阶段新增 `connection_pruning` 与 `schema_formation` 两个阶段
- 不破坏现有 API，新方法为可选调用

## REMOVED Requirements

### Requirement: 无

本 spec 不移除任何现有 requirement，所有改动为新增与扩展。
