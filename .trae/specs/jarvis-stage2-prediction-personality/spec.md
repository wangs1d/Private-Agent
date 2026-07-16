# 第二阶段：预测性 + 人格化 Spec

## Why
当前 Agent 完全反应式：BrainStem 只检测已发生异常不预测未来，cognize 只按当前 query 召回不预判意图；人格仅自由文本 persona 无结构化内核，情绪每次重新推断无惯性，无 Agent 自身风格指纹。这些缺口使 Agent 缺乏"预判用户需求"和"稳定人格表现"的贾维斯感。本阶段补齐行为基线预测 + 情绪状态机 + 风格一致性。

## What Changes
- 扩展 TimeRhythmState 增加行为基线建立逻辑（7 天数据建立日时间线基线）
- BrainStem 增加预测触发器（基于基线预测用户下一步，合成预测信号回流）
- LimbicCortex 增加 VAD 情绪状态机（情绪惯性衰减，不瞬间切换）
- MemoryCortex 新增 personality_core 存储区域（结构化人格特质）
- 新增 Agent 风格指纹（句长/用词偏好/语气词）+ 输出校验

## 暂缓项（非本阶段范围）
- 意图预判（工具预加载）：依赖行为基线成熟后再做，第三阶段考虑
- 记忆引用优化：已实现，小幅优化留后续

## Impact
- Affected specs: `add-agent-brain-center`、`extend-brain-neuroanatomy`、`jarvis-stage1-perception-delegation`
- Affected code:
  - `server/src/services/user-personalization/user-personalization-service.ts`（TimeRhythmState 基线）
  - `server/src/brain/brain-stem.ts`（预测触发器）
  - `server/src/brain/limbic-cortex.ts`（VAD 状态机）
  - `server/src/brain/memory-cortex.ts`（personality_core 域）
  - `server/src/agent/prompt-context-builder.ts`（风格指纹注入）
  - `server/src/agent/prompt-builder.ts`（人格内核注入）

## ADDED Requirements

### Requirement: 行为基线建立
系统 SHALL 基于 TimeRhythmState 的历史数据建立用户行为基线，支持预测触发。

#### Scenario: 7 天数据建立基线
- **WHEN** TimeRhythmState 累计满 7 天数据
- **THEN** 系统计算每日时间线基线（每小时活跃概率、常用应用序列、工作节奏切换点）
- **AND** 基线持久化存储，供预测触发器使用
- **AND** 后续数据持续更新基线（滑动窗口）

### Requirement: BrainStem 预测触发器
系统 SHALL 让 BrainStem 基于行为基线预测用户下一步动作，在预测时间点前合成预测信号回流。

#### Scenario: 预测用户即将查天气
- **WHEN** 基线显示用户每天 18:00 查天气
- **AND** 当前时间到达 17:55（预测窗口前 5 分钟）
- **THEN** BrainStem 合成预测信号（kind=`predicted_action`，source=`agent_inference`）
- **AND** 信号 payload 含预测动作、置信度、预测时间点
- **AND** 信号回流到 LifeSignalHub 供 ProactionCortex 消费

### Requirement: VAD 情绪状态机
系统 SHALL 在 LimbicCortex 实现 VAD（valence/arousal/dominance）情绪状态机，使情绪有惯性不瞬间切换。

#### Scenario: 情绪惯性衰减
- **WHEN** 用户上一轮情绪为 happy（valence=0.8）
- **AND** 本轮输入中性文本（valence=0.5）
- **THEN** 推断情绪时叠加上轮惯性（新 valence = 0.5 * 0.6 + 0.8 * 0.4 = 0.62）
- **AND** 情绪不会从 happy 瞬间跳到 sad

#### Scenario: 情绪跨会话持久化
- **WHEN** 进程重启后用户发消息
- **THEN** LimbicCortex 从持久化存储加载上次的 VAD 状态
- **AND** 基于加载的状态做惯性叠加

### Requirement: 结构化人格内核
系统 SHALL 在 MemoryCortex 新增 personality_core 存储区域，存储结构化人格特质，防止人格漂移。

#### Scenario: 人格特质注入
- **WHEN** system prompt 组装时
- **THEN** 从 personality_core 拉取结构化特质（values/speech_style/beliefs/quirks）
- **AND** 注入 system prompt 的稳定前缀部分
- **AND** 人格特质不随单次对话漂移

### Requirement: Agent 风格指纹与输出校验
系统 SHALL 维护 Agent 自身风格指纹（句长/用词偏好/语气词），并在话术生成后校验一致性。

#### Scenario: 风格指纹注入
- **WHEN** 话术生成 LLM 调用时
- **THEN** system prompt 注入 Agent 风格指纹（平均句长、常用语气词、用词偏好）
- **AND** LLM 生成的话术遵循风格指纹

#### Scenario: 风格一致性校验
- **WHEN** LLM 生成话术后
- **THEN** 校验话术句长是否在风格指纹的 ±30% 范围内
- **AND** 若偏离超过 30% 记录警告日志（不阻塞输出）

## MODIFIED Requirements

### Requirement: LimbicCortex 情绪推断
LimbicCortex.inferEmotion SHALL 读取上一次情绪状态做惯性叠加，而非每次从零推断。
