# Checklist

## Task 1: 行为基线建立
- [x] TimeRhythmState 新增 `buildBaseline()` 方法
- [x] 基线含每小时活跃概率、常用时段、工作节奏切换点
- [x] 基线数据持久化到 KV（key=`behavior_baseline`）
- [x] 基线含 lastUpdated 和 sampleCount
- [x] TimeRhythmState 更新时触发基线刷新（距上次 > 24h）

## Task 2: BrainStem 预测触发器
- [x] `brain-stem.ts` 新增 `predictNextAction(actorId)` 方法
- [x] 从 user-personalization-service 读取行为基线
- [x] 基于当前时间查找预测窗口内（前 5 分钟）的高概率动作
- [x] 命中时合成预测信号（kind=`predicted_action`，source=`agent_inference`）
- [x] 信号 payload 含预测动作/置信度/预测时间点
- [x] sweepOnce 中调用 predictNextAction
- [x] 命中则 emitSynthetic 回流到 LifeSignalHub
- [x] 同预测动作 30 分钟内不重复发

## Task 3: VAD 情绪状态机
- [x] `limbic-cortex.ts` 新增 VAD 状态结构 `{ valence, arousal, dominance, timestamp }`
- [x] inferEmotion 读取上一次 VAD 状态
- [x] 新情绪 = 本轮推断 * 0.6 + 上轮 * 0.4（惯性叠加）
- [x] VAD 状态持久化到 KV（key=`emotion_state_${actorId}`）
- [x] 进程重启时加载上次 VAD 状态
- [x] happy→neutral 不会瞬间跳到 sad

## Task 4: 结构化人格内核
- [x] `memory-cortex.ts` 新增 personality 域
- [x] 存储结构化人格特质 `{ values, speech_style, beliefs, quirks }`
- [x] 新增 `getPersonalityCore(actorId)` 和 `setPersonalityCore(actorId, core)` 方法
- [ ] system prompt 组装时从 personality 域拉取特质注入稳定前缀
- [x] 未设置人格时用默认人格，不阻塞启动

## Task 5: Agent 风格指纹与输出校验
- [x] 新增 `AgentStyleProfile` 数据结构
- [x] 持久化到 KV
- [x] 话术生成 LLM 调用时注入风格指纹到 system prompt
- [x] 新增 `validateStyleConsistency(text, profile)` 方法
- [x] 校验句长是否在 ±30% 范围
- [x] 偏离超过 30% 记录警告日志（非阻塞）
- [x] 话术输出后调用 validateStyleConsistency

## 编译与集成
- [x] `cd server; npx tsc --noEmit` 零错误
- [x] 现有 brain-end-to-end 测试仍通过
- [x] 现有 brain-subcortical 测试未回归
