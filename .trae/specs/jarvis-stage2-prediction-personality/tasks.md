# Tasks

- [ ] Task 1: 行为基线建立
  - [ ] SubTask 1.1: 在 `user-personalization-service.ts` 扩展 TimeRhythmState，新增 `buildBaseline()` 方法：基于 7 天滑动窗口计算每日时间线基线（每小时活跃概率、常用时段、工作节奏切换点）
  - [ ] SubTask 1.2: 基线数据持久化到 KV（key 如 `behavior_baseline`），含 lastUpdated 和 sampleCount
  - [ ] SubTask 1.3: 在 TimeRhythmState 更新时（recordActivity 等）触发基线刷新（若距上次刷新 > 24h）

- [ ] Task 2: BrainStem 预测触发器
  - [ ] SubTask 2.1: 在 `brain-stem.ts` 新增 `predictNextAction(actorId)` 方法：从 user-personalization-service 读取行为基线，基于当前时间查找预测窗口内（前 5 分钟）的高概率动作
  - [ ] SubTask 2.2: 命中预测时合成预测信号（kind=`predicted_action`，source=`agent_inference`，payload 含预测动作/置信度/预测时间点）
  - [ ] SubTask 2.3: 在 sweepOnce 中调用 predictNextAction，命中则 emitSynthetic 回流到 LifeSignalHub
  - [ ] SubTask 2.4: 重复抑制：同预测动作 30 分钟内不重复发（复用现有 emitSynthetic 的抑制逻辑）

- [ ] Task 3: VAD 情绪状态机
  - [ ] SubTask 3.1: 在 `limbic-cortex.ts` 新增 VAD 状态结构 `{ valence, arousal, dominance, timestamp }`，替代单纯的 EmotionVector 缓存
  - [ ] SubTask 3.2: 修改 inferEmotion：读取上一次 VAD 状态，新情绪 = 本轮推断 * 0.6 + 上轮 * 0.4（惯性叠加）
  - [ ] SubTask 3.3: VAD 状态持久化到 KV（key 如 `emotion_state_${actorId}`），进程重启时加载
  - [ ] SubTask 3.4: 验证 happy→neutral 不会瞬间跳到 sad

- [ ] Task 4: 结构化人格内核
  - [ ] SubTask 4.1: 在 `memory-cortex.ts` 新增 personality 域（与 working/episodic 等并列），存储结构化人格特质 `{ values, speech_style, beliefs, quirks }`
  - [ ] SubTask 4.2: 新增 `getPersonalityCore(actorId)` 和 `setPersonalityCore(actorId, core)` 方法
  - [ ] SubTask 4.3: 在 `prompt-context-builder.ts` 或 `prompt-builder.ts` 的 system prompt 组装中，从 personality 域拉取特质注入稳定前缀
  - [ ] SubTask 4.4: 人格特质默认值（若未设置则用默认人格，不阻塞启动）

- [ ] Task 5: Agent 风格指纹与输出校验
  - [ ] SubTask 5.1: 新增 `AgentStyleProfile` 数据结构 `{ avgSentenceLength, favoriteParticles, vocabularyPreference, toneMarkers }`，持久化到 KV
  - [ ] SubTask 5.2: 在话术生成 LLM 调用时（executeProactiveDecision / cognize），将风格指纹注入 system prompt
  - [ ] SubTask 5.3: 新增 `validateStyleConsistency(text, profile)` 方法：校验句长是否在 ±30% 范围，偏离则记录警告日志
  - [ ] SubTask 5.4: 在话术输出后调用 validateStyleConsistency（非阻塞，仅记录）

# Task Dependencies
- Task 2 依赖 Task 1（预测触发器依赖行为基线）
- Task 1、Task 3、Task 4、Task 5 相互独立，可并行
