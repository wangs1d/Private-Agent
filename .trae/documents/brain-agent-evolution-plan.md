# Brain Agent 进化计划：6 领域增强 + Token 效率优化

## 总览

在现有 BrainCenter（11 皮层 + 2 皮层下）+ BodyCenter（8 模块）架构基础上，增强 6 个领域，同时通过规则前置、模型分级、上下文压缩降低 token 消耗。核心原则：**能规则不 LLM，能小模型不大模型，能复用不新增**。

### Token 效率总策略（跨领域约束）
1. **规则前置过滤**：所有 LLM 调用前加规则闸门，低价值信号直接跳过（已在 ProactionCortex 实现，扩展到其他路径）
2. **模型分级**：routine 任务用 `gpt-4.1-mini` / `gpt-4.1-nano`，复杂决策才用主模型；通过环境变量 `*_MODEL` 配置
3. **上下文压缩**：复用现有 `compactPromptBlock`、`maxThreadMessages`、`AGENT_USER_PROFILE_PROMPT_MAX_CHARS` 机制
4. **状态复用**：UserPersonalizationService 每 turn 已收集 9 类状态，新增功能复用这些数据，不引入新的 per-turn LLM 调用
5. **批量合并**：多个低优先级信号合并为单次 LLM 调用（cognize 已是端到端单调用，扩展到自我进化扫描）

---

## Phase 1: 领域 1 + 6 — 人格微调 + 长期关系记忆（用户建模层，无新 LLM 调用）

### 现状分析
- `PersonalityCore` 已支持 per-actor（KV key `personality_core_<actorId>`），但只有 `setPersonalityCore` 显式调用才更新，**无自动学习闭环**
- `UserPersonalizationService` 每 turn 收集 9 类状态（emotion/relationship/style/time_rhythm/behavior_baseline/...），但这些状态**未反向影响 agent 自己的人格**
- `HumanLikeMemoryService` 有通用内容图（nodes/edges/communities），但无专门的"用户关系图谱"
- `MemoryManagerService` 有 relationshipSnapshots（最多 6 行），但无关系里程碑/轨迹时间线

### 改动 1.1: PersonalityAdaptiveAdjuster（规则驱动人格微调）
**文件**: `server/src/brain/personality-adjuster.ts`（新建）
**作用**: 基于 UserPersonalizationService 的 RelationshipState + StyleProfileState + EmotionState，**规则推导** PersonalityCore 微调建议，写入 `personality_core_<actorId>` KV
**为何无新 LLM 调用**: 完全规则映射（如 warmth > 0.7 → speech_style.tone 加 "亲密"； humorTolerance > 0.6 → humor 加 "活泼"）
**调用时机**: 每 N turn（默认 16，复用 `AGENT_USER_PROFILE_LLM_EVERY_N` 的一半）由 `MemoryCortex.observeTurn` 触发
**防漂移**: 保留原 `DEFAULT_PERSONALITY_CORE` 作为 baseline，调整幅度 clamp 在 ±30% 范围内

### 改动 1.2: RelationshipGraphService（关系图谱，复用 HumanLikeMemory）
**文件**: `server/src/services/relationship-graph-service.ts`（新建）
**作用**: 在 `HumanLikeMemoryService` 的 `relationship` domain 上封装一层关系专用 API：
- `recordMilestone(actorId, milestone: {type, title, occurredAt, emotionalValence})` — 里程碑（首次见面/首次倾诉/首次冲突解决/信任达成）
- `getRelationshipTrajectory(actorId, timeRange?)` — 返回关系演化时间线
- `getSharedExperiences(actorId, limit?)` — 返回 agent 与用户共同经历的事件
**为何无新 LLM 调用**: 里程碑检测基于规则（如 warmth 从 < 0.3 跳到 > 0.5 → "信任建立"），存储复用 HumanLikeMemory 的 ingest
**注册**: `create-app-services.ts` 中注入到 `MemoryCortex.registerRelationshipGraph()`

### 改动 1.3: MemoryCortex 扩展关系召回
**文件**: `server/src/brain/memory-cortex.ts`（修改）
**改动**:
- `recall` 新增 `domain: "relationship"` 路由，调用 `RelationshipGraphService.getRelationshipTrajectory`
- `recall` 默认路径增加关系片段（最多 2 条，每条 ≤ 200 char，避免 token 膨胀）
- `formatPersonalityCorePrompt` 输出保持 ≤ 400 char（现有约束）

### Token 影响
- **新增 per-turn LLM 调用**: 0
- **新增 prompt token**: ≤ 300 char（关系记忆片段，复用 `relationshipMemory` slice 现有位置）
- **规则计算开销**: 可忽略（纯内存数值映射）

---

## Phase 2: 领域 4 — 情感/共情（规则检测 + LLM 仅生成话术）

### 现状分析
- `LimbicCortex` 有 emotion/tone policy 但无主动情感识别
- `UserPersonalizationService.EmotionState` 只存最近 6 个情绪标签，无情感强度/原因
- `SemanticAwarenessInferrer`（LLM 增强）是 AwarenessCortex 的扩展点，但未注册
- cognize LLM 已接收 emotion 字段，但 emotion 来源浅

### 改动 2.1: EmotionRecognitionService（规则优先，LLM 兜底）
**文件**: `server/src/services/emotion-recognition-service.ts`（新建）
**分层策略**:
- **L1 规则层**（无 LLM）: 基于用户文本关键词 + 表情符号 + 标点强度 + 时段 + 历史情绪，输出 `EmotionVector { primary, secondary, intensity, cause }`
- **L2 LLM 层**（仅 L1 置信度 < 0.5 时触发）: 调用 `gpt-4.1-mini`（通过 `EMOTION_RECOGNITION_MODEL` 环境变量），输出结构化 JSON
**Token 节省**: 90%+ 情绪可由规则识别（关键词表覆盖常见情绪词 + 表情），仅复杂/模糊文本才调 LLM
**缓存**: 同一 actorId 5 分钟内相同 primary emotion 复用结果

### 改动 2.2: LimbicCortex 情感响应策略
**文件**: `server/src/brain/limbic-cortex.ts`（修改）
**改动**:
- 新增 `computeEmpathyResponse(emotion: EmotionVector, relationship: RelationshipState)` — 规则映射出语气参数（如 intensity > 0.7 + negative → 共情优先； intensity < 0.3 → 轻松回应）
- 这些参数注入 `toneGuidance` slice（现有 prompt 位置），**不新增 prompt section**
- 输出格式：`{tone_modifier, pacing, acknowledgment_required}`，由 cognize LLM 自然融合

### 改动 2.3: EmotionVector 接入 SensoryFrame
**文件**: `server/src/brain/types.ts`（修改）
**改动**: `SensoryFrame.emotion` 字段从 `EmotionVector` 扩展为包含 `cause` 和 `intensity`（现有 `EmotionVector` 保留兼容）
**Token 影响**: SensoryFrame 已是 cognize LLM 输入，增加 ≤ 50 char

### Token 影响
- **新增 LLM 调用**: 仅 L1 置信度低时，用 mini 模型（预计 < 10% 调用）
- **新增 prompt token**: ≤ 80 char（toneGuidance 扩展）
- **规则计算开销**: 关键词匹配 + 数值映射，可忽略

---

## Phase 3: 领域 2 — 主动预测（基于历史模式，纯规则 + 现有 LLM）

### 现状分析
- `BrainStem.predictNextAction` 已基于 behavior baseline 预测（active periods + hourly probability）
- `AnticipationEngineService` 已生成 anticipation candidates（category/confidence/urgency）
- `PredictiveCodingCortex` 用于 reactive cognize bypass（System 0），**不用于主动预测**
- **缺口**: 无基于事件序列的模式预测（如"用户连续 3 天 22:00 搜索夜宵 → 预测今晚也会"）

### 改动 3.1: SequencePatternMiner（事件序列模式挖掘，纯规则）
**文件**: `server/src/services/sequence-pattern-miner.ts`（新建）
**作用**: 从 `LifeSignalHubService` 历史（最近 100 信号）+ `HumanLikeMemoryService` episodic domain 挖掘重复序列模式
**算法**: 简化版 PrefixSpan — 挖掘长度 2-4 的事件序列，支持时间窗口约束（如 A 后 30min 内出现 B）
**输出**: `Pattern { sequence: string[], support: number, confidence: number, avgIntervalMs: number, lastSeenAt: Date }`
**为何无 LLM**: 纯算法挖掘，无语义理解需求
**调用时机**: BrainStem 45s 心跳时，每 10 min 重新挖掘一次（缓存）

### 改动 3.2: PredictiveActionSynthesizer（预测合成器，复用现有 LLM）
**文件**: `server/src/brain/predictive-action-synthesizer.ts`（新建）
**作用**: 接收 SequencePatternMiner 的模式 + 当前事件流，若当前事件匹配某模式前缀，合成 `predicted_action` LifeSignal
**为何无新 LLM 调用**: 复用 BrainStem 现有的 `predicted_action` 信号发布路径（信号已由 ProactionCortex 的 EndToEndDecisionMaker 处理）
**Token 节省**: 预测信号走现有 ProactionCortex 管线，无额外 LLM 调用

### 改动 3.3: BrainStem 整合预测源
**文件**: `server/src/brain/brain-stem.ts`（修改）
**改动**:
- `sweepActor` 中 `predictNextAction` 调用后，额外调用 `PredictiveActionSynthesizer.predict(actorId, recentSignals)`
- 合并两个预测源的结果，去重后发布 `predicted_action` 信号
**Token 影响**: 0（纯规则 + 复用现有信号管线）

### Token 影响
- **新增 LLM 调用**: 0
- **新增 prompt token**: 0（预测走信号管线，不进 prompt）
- **计算开销**: PrefixSpan 算法对 100 信号规模 < 50ms

---

## Phase 4: 领域 3 — 多模态融合（架子搭好，ASR 先行）

### 现状分析
- ASR 已集成（FunAsR + Whisper fallback），`Ear` body 模块 3 级优先级
- `SensoryCortex.buildSensoryFrame` 是轻量聚合点（无 cross-attention）
- `SensoryFrame` 类型已定义（audioText + visualDescription + emotion + activity）
- 缺口：无专门融合模块，融合靠 cognize LLM 在 prompt 中隐式完成

### 改动 4.1: MultimodalFusionCortex（融合架子，纯结构化）
**文件**: `server/src/brain/multimodal-fusion-cortex.ts`（新建）
**设计原则**: **不引入 embedding 级融合**（token 成本高），而是在 SensoryFrame 基础上做**结构化冲突检测 + 优先级仲裁**
**职责**:
- `fuse(inputs: SensoryInput[]): FusedFrame` — 接收多模态输入，输出融合帧
- 冲突检测：如 ASR 说"很高兴"但 emotion 检测为 negative → 标记 `conflict: true` 并以 emotion 优先（规则）
- 优先级：audio > visual > activity（人类对话中语音优先）
- 输出 `FusedFrame { primaryText, secondaryText?, emotion?, activity?, conflictFlags?, confidence }`
**为何无 LLM**: 融合是规则仲裁，语义理解交给 cognize LLM

### 改动 4.2: ASR 流式接入（启用 dormant 代码）
**文件**: `server/src/services/voice-dialogue/adapters/funasr-asr-adapter.ts`（修改）
**改动**: `startStreamingTranscribe` 已实现但未被调用，接入 `SensoryCortex.listen` 的新 `stream` 模式
**新增接口**: `SensoryCortex.listenStream(audioStream): AsyncIterable<PartialTranscript>`
**Token 节省**: 流式 ASR 允许 cognize LLM 在用户说话过程中就开始推理（未来支持），减少等待
**当前阶段**: 仅搭架子，接入流式 ASR 到 SensoryCortex，cognize 仍用最终文本

### 改动 4.3: SensoryFrame 升级为 FusedFrame
**文件**: `server/src/brain/types.ts`（修改）
**改动**: `SensoryFrame` 扩展为 `FusedFrame`（向后兼容，旧字段保留）
**CognizeContext.sensoryFrame** 类型更新为 `FusedFrame`
**Token 影响**: cognize prompt 中 sensoryFrame 描述更结构化，预计 token 持平或略降（冲突标记减少 LLM 误判）

### 改动 4.4: 注册到 BrainCenter
**文件**: `server/src/brain/brain-center.ts`（修改）
**改动**: 新增 `registerMultimodalFusion(cortex)`，cognize 阶段 1.5 调用 `fusionCortex.fuse()` 替代直接 `buildSensoryFrame`
**降级开关**: `BRAIN_MULTIMODAL_FUSION_ENABLED=0` 时回退到 `buildSensoryFrame`

### Token 影响
- **新增 LLM 调用**: 0
- **prompt token 变化**: ±0（结构化替换，冲突标记可能减少 LLM 修正轮次）
- **计算开销**: 规则仲裁 < 5ms

---

## Phase 5: 领域 5 — 自我改写进化（内部驱动，规则触发 + LLM 代码生成）

### 现状分析
- `EvolutionCortex` 已实现三层学习闭环（经验/技能/知识），**纯规则触发**，无 LLM 参与 gap 检测
- `CodeRepairCortex` 已实现 bug 自愈（isolate → analyze → patch → test → apply），白名单覆盖 `src/` 和 `scripts/`
- **关键缺口**: 无外部技术扫描（GitHub/npm/博客），无"我的工具过时了"检测，无 benchmark 驱动的自我优化
- `KnowledgeGapExecutor` 仅在用户重复提问 3 次时触发，**非主动探索**

### 改动 5.1: ExternalTechScanner（外部技术扫描，规则 + 小模型）
**文件**: `server/src/services/external-tech-scanner.ts`（新建）
**分层策略**:
- **L1 规则层**（无 LLM）: 维护 `tech-watchlist.json`（关注的领域：ASR/TTS/VLM/LLM/MCP/...），定期（默认每天 03:00）用 `desktop.http_get` 拉取 GitHub releases API + npm registry API，对比当前已安装版本
- **L2 LLM 层**（仅发现新版本时）: 调用 `gpt-4.1-mini`（`TECH_SCANNER_MODEL` 环境变量）评估"这个新版本是否值得升级 + 升级方案概要"，输出 JSON
**Token 节省**: 90%+ 扫描无新版本时跳过 LLM；有新版本时用 mini 模型，输入仅 changelog 摘要（≤ 2000 char）
**输出**: `TechScanResult { repo, currentVersion, latestVersion, upgradeBenefit, riskLevel, suggestedAction }`

### 改动 5.2: SelfDrivenEvolutionProposer（内部驱动进化提案）
**文件**: `server/src/brain/self-driven-evolution-cortex.ts`（新建）
**触发条件**（纯规则）:
1. ExternalTechScanner 发现 high benefit + low risk 的升级
2. AgentSelfLearningService 显示某能力失败率 > 30% 持续 3 天
3. Benchmark 脚本（复用现有 `scripts/bench-*.ts`）检测到性能回归
**输出**: 复用 `EvolutionProposal` 类型，`type: "self_upgrade"`
**为何无新 LLM**: 触发完全规则化，LLM 仅在执行阶段（复用 SkillGenerator / CodeRepairCortex）

### 改动 5.3: EvolutionCortex 扩展 self_upgrade 类型
**文件**: `server/src/brain/evolution-cortex.ts`（修改）
**改动**:
- `EvolutionProposalType` 新增 `"self_upgrade"`
- `execute()` 对 `self_upgrade` 类型路由到 `CodeRepairCortex`（升级依赖）或 `SkillGenerator`（新技能）
- 依赖升级走 CodeRepairCortex 的 patch 流程（已有 tsc + test 门禁）
**Token 节省**: 复用现有 CodeRepairCortex 管线，无新 LLM 调用

### 改动 5.4: BenchmarkSelfAssessment（基准自评，复用现有脚本）
**文件**: `server/src/services/benchmark-self-assessment.ts`（新建）
**作用**: 定期（默认每周日 04:00）运行 `scripts/bench-*.ts` 子集，对比历史基线，检测回归
**为何无 LLM**: 纯脚本执行 + 数值对比
**输出**: 回归报告写入 `AgentSelfLearningService`，触发 SelfDrivenEvolutionProposer

### 改动 5.5: 安全约束扩展
**文件**: `server/src/brain/code-repair-cortex.ts`（修改）
**改动**:
- `DENY_FILES` 新增 `"src/brain/limbic-cortex.ts"` 已存在，补充 `"src/services/external-tech-scanner.ts"`（防自我修改扫描逻辑）
- `PATCH_FORBIDDEN_PATTERNS` 新增 `package.json` 修改检测（依赖升级走专门审批流程，不通过 patch）
- 依赖升级需用户确认（通过 `brain.report_bug` 工具的 `source: "user_report"` 路径）

### Token 影响
- **新增 LLM 调用**: 仅发现新版本时，mini 模型，预计 < 5 次/天
- **prompt token**: 0（扫描结果不进 prompt，走 EvolutionCortex 管线）
- **计算开销**: GitHub/npm API 调用 + 脚本执行，非 LLM

---

## Phase 6: Token 效率全局优化（跨领域）

### 改动 6.1: 模型分级配置中心化
**文件**: `server/src/config/model-routing.ts`（新建）
**作用**: 集中管理所有 LLM 调用的模型选择，基于任务复杂度分级：
- **nano**（`gpt-4.1-nano`）: 情绪识别 L2、技术扫描 L2、简单分类
- **mini**（`gpt-4.1-mini`）: EndToEndDecisionMaker、SkillGenerator、CodeRepairCortex analyze/patch、子 Agent
- **full**（主模型）: cognize、master_delegate、复杂推理
**配置**: 环境变量 `MODEL_ROUTING_OVERRIDE` 支持 JSON 覆盖
**Token 节省**: 预计 40%+ LLM 调用从 full 降到 mini/nano

### 改动 6.2: 上下文压缩增强
**文件**: `server/src/agent/prompt-context-builder.ts`（修改）
**改动**:
- `compactPromptBlock` 新增 `importance` 参数，低重要性内容压缩更激进
- `relationshipMemory` slice 从 6 行降到 3 行（高价值保留，低价值丢弃）
- `userProfileSummary` 优先级高于 `userProfile`（已有逻辑，强化优先级标记）
- 新增 `compactRelationshipTrajectory` — 关系轨迹压缩为"3 个关键转折点"而非完整时间线

### 改动 6.3: Cognize 单调用强化
**文件**: `server/src/brain/brain-center.ts`（修改 cognize 阶段）
**改动**:
- 确保 cognize 仍是单次 LLM 调用（已是端到端）
- 所有新增领域（情感/预测/融合/关系）的数据**注入 CognitiveContext**，不新增 LLM 调用
- CognitiveContext 字段增加 token 预算控制：`sensoryFrame ≤ 300 char`、`emotionContext ≤ 200 char`、`relationshipContext ≤ 300 char`
**Token 节省**: 单调用 + 严格预算，避免多轮 LLM

### 改动 6.4: 缓存层强化
**文件**: `server/src/services/llm-response-cache.ts`（新建）
**作用**: 对确定性 LLM 调用（如情绪识别、技术扫描评估）做基于输入 hash 的缓存
**TTL**: 情绪识别 5min，技术扫描 24h，EndToEndDecisionMaker 不缓存（信号差异大）
**Token 节省**: 预计 20%+ 重复调用被缓存命中

---

## 实现顺序（按依赖关系）

1. **Phase 6.1 模型分级配置**（基础设施，其他模块依赖）
2. **Phase 1 用户建模层**（人格微调 + 关系图谱，无依赖）
3. **Phase 2 情感共情**（依赖 UserPersonalizationService 状态）
4. **Phase 3 主动预测**（依赖 LifeSignalHub 历史）
5. **Phase 4 多模态融合**（依赖 SensoryCortex）
6. **Phase 5 自我进化**（依赖 CodeRepairCortex + EvolutionCortex）
7. **Phase 6.2-6.4 Token 优化**（收尾，基于实际 token 消耗数据调优）

## 验证步骤

### 每个 Phase 验证
1. `npx tsc --noEmit` 零错误
2. 新增模块的单元测试（`scripts/test-*.ts`）
3. 端到端集成测试（复用现有 `test-*-e2e.ts` 模式）
4. 降级开关验证（`*_ENABLED=0` 时回退正常）

### Token 效率验证
1. 运行 `scripts/bench-tokens.ts`（如不存在则新建）对比优化前后 token 消耗
2. 目标：单轮 cognize 调用 token 降低 ≥ 15%
3. 目标：全链路 LLM 调用次数降低 ≥ 30%（规则前置 + 缓存）

### 能力验证（不降级）
1. 人格微调：不同 actorId 产生不同 PersonalityCore
2. 情感共情：负面情绪识别 + 共情响应
3. 主动预测：基于历史模式预测下一动作
4. 多模态融合：ASR + visual 冲突检测
5. 自我进化：扫描到新技术 + 生成升级提案
6. 长期关系：里程碑记录 + 轨迹查询

## 假设与决策

1. **不引入 embedding 级多模态融合**（token 成本过高，LLM 隐式融合已够用）
2. **不新增 per-turn LLM 调用**（所有新功能复用现有 cognize 单调用或规则）
3. **自我进化的依赖升级需用户确认**（安全考虑，patch 不修改 package.json）
4. **关系图谱复用 HumanLikeMemory 存储**（不新建存储后端）
5. **模型分级通过环境变量配置**（保持灵活性，默认值保守）
6. **所有新模块支持降级开关**（`*_ENABLED=0` 回退原行为）

## 文件清单

### 新建（11 个）
- `server/src/brain/personality-adjuster.ts`
- `server/src/services/relationship-graph-service.ts`
- `server/src/services/emotion-recognition-service.ts`
- `server/src/services/sequence-pattern-miner.ts`
- `server/src/brain/predictive-action-synthesizer.ts`
- `server/src/brain/multimodal-fusion-cortex.ts`
- `server/src/services/external-tech-scanner.ts`
- `server/src/brain/self-driven-evolution-cortex.ts`
- `server/src/services/benchmark-self-assessment.ts`
- `server/src/config/model-routing.ts`
- `server/src/services/llm-response-cache.ts`

### 修改（10 个）
- `server/src/brain/memory-cortex.ts` — 关系召回 + PersonalityAdaptiveAdjuster 触发
- `server/src/brain/limbic-cortex.ts` — 情感响应策略
- `server/src/brain/types.ts` — FusedFrame / EmotionVector 扩展
- `server/src/brain/brain-stem.ts` — 整合预测源
- `server/src/brain/brain-center.ts` — 注册 MultimodalFusion + cognize token 预算
- `server/src/brain/evolution-cortex.ts` — self_upgrade 类型
- `server/src/brain/code-repair-cortex.ts` — 安全约束扩展
- `server/src/agent/prompt-context-builder.ts` — 压缩增强
- `server/src/services/voice-dialogue/adapters/funasr-asr-adapter.ts` — 流式接入
- `server/src/bootstrap/create-app-services.ts` — 新模块注册
