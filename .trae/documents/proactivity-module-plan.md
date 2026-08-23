# 主动性多元化模块（ProactivityHub）实施计划

## Summary

把"主动性"从零散触发点解耦为独立模块 **ProactivityHub**（`server/src/proactivity/`），实现：
1. **多元触发**：任务完成恭喜、兴趣分享（用户喜欢/agent 挑选）、时段问候、过劳干预（调日程+放音乐）、对话内关怀/跟进（从 agent-core 迁移）
2. **三种行为模式**：`speak`（主动消息，复用现有 ProactionCortex 闭环）、`act`（静默后台执行工具）、`advise`（建议注入下一轮对话，不打扰）
3. **全局频控**：每日预算 + 分 kind 冷却 + 静默时段，防止频繁打扰
4. **感知归 body**：新增 `body/rhythm-core.ts` 节律感知模块（连续工作/深夜活跃检测），body 不依赖 brain，由装配层喂活动数据
5. **真实挂载**（新旧替换）：删除 agent-core 里的对话钩子实现，全部迁入新模块并接线

## Current State Analysis

### 现有资产（复用，不重造）
- **speak 闭环已完整**：`LifeSignalHub.subscribe → BrainCenter.decide → ProactionCortex`（value/disturb 双轨 + e2e LLM）`→ scheduleProactive → executeProactiveDecision`（LLM function calling 可自主调工具：media.play/calendar/smart_home 均在 ToolRegistry）
- **频控部分存在**：ProactionCortex 的 repeat_suppress（同 kind 10min）+ disturb 评分；`ProactiveContactPolicyService` 有静默时段 + `maxDailyProactiveContacts`（但无全局每日计数器喂入）
- **执行工具齐全**：`media.search/play`（MediaMusicService）、`calendar.create_task`（ScheduleTaskService，支持 agent_task 类型）、`smart_home.*`
- **用户知识源**：`OnlineLearningCortex.getProfile`（preferences/habits/topics）、`UserProfileAggregator` → USER_PROFILE.md、`SessionEpitomeStore`（openLoops + 完成语检测 `closeCompletedLoops`）
- **body 架构**：BodyCenter 启动 9 模块（create-app-services.ts 装配，body-center.ts:254-271 逐个 startModule），BodyBus → SynapseBus 桥接已通

### 断点/缺口（本计划要修的）
1. **触发源单一**：只有 mood、desktop_*、market、conversation_proactive（仅 care/followup）
2. **task_completed 不进 LifeSignalHub**：agent-task-orchestrator.ts:685-701 `emitProgress` 只走 `onProgress` 回调（WS 推送），主动决策层看不到 → 恭喜链路断
3. **SessionEpitome 完成检测无消费**：session-epitome.ts:262 `closeCompletedLoops` 关闭的 loop 被静默丢弃，不触发任何主动行为
4. **无问候/分享/过劳触发**：完全缺失
5. **无 act/advise 模式**：主动性只能表现为"发消息"
6. **无全局频控**：各信号源独立，可能叠加打扰
7. **body 无节律感知**：无连续工作/熬夜检测

## Proposed Changes

### 新增：`server/src/proactivity/` 模块（6 个文件）

#### 1. `proactivity-types.ts`
```ts
export type ProactiveIntentKind =
  | "task_celebration" | "interest_share" | "greeting"
  | "overwork_care" | "care" | "followup";

export type ProactiveBehaviorMode = "speak" | "act" | "advise";

export type ProactiveIntent = {
  actorId: string;
  kind: ProactiveIntentKind;
  importance: "high" | "medium" | "low";
  title: string;        // 信号标题（喂 ProactionCortex）
  summary: string;      // 上下文：用户原话/任务目标/画像兴趣
  mode: ProactiveBehaviorMode;
  actArgs?: Array<{ tool: string; args: Record<string, unknown> }>; // act 模式直接执行
  source: "conversation" | "task" | "rhythm" | "profile" | "time" | "epitome";
};
```

#### 2. `frequency-governor.ts` — 全局频控
- 状态（内存，per-actor）：当日计数 + 日期、per-kind lastAt
- `canTrigger(actorId, kind, now)` → `{ allowed, reason }`；`record(actorId, kind)`
- 规则（env 可覆盖）：
  - 每日总预算 `PROACTIVITY_DAILY_BUDGET` 默认 6
  - 分 kind 冷却：greeting 24h、interest_share 24h、care 8h、followup 4h、task_celebration 30min、overwork_care 8h
  - 静默时段（23-7 点）：仅 importance=high 放行（对齐 ProactiveContactPolicy quietHours 语义）

#### 3. `triggers/` — 触发器（纯逻辑，可单测）
- `conversation-triggers.ts`：**迁移** agent-core 的 `CONV_HOOK_CARE_RE`/`CONV_HOOK_FOLLOWUP_RE`/`detectConversationProactiveHook`（care/followup）
- `celebration-trigger.ts`：`buildCelebrationIntent(actorId, goal)`（复杂任务完成）、`buildLoopCompletedIntent(actorId, loopText)`（用户待办完成）
- `share-trigger.ts`：`buildShareIntent(actorId, profileText)` —— 从 OnlineLearningCortex topics/preferences 挑一个兴趣点，summary 写明"用户长期喜欢X，可分享相关内容/agent 自己的视角"，话术由 speak 闭环 LLM 自然生成（prompt 已要求朋友口吻，agent 喜好由 LLM 带出，不单独建 agent 偏好库）
- `greeting-trigger.ts`：`shouldGreet(lastInteractionAt, now)` —— 早安（7-10 点且 >10h 未聊）、久别（>48h）→ 各自 24h 冷却兜底
- `overwork-trigger.ts`：`buildOverworkIntent(actorId, rhythmPayload)` —— mode=act+speak：actArgs 现算（`media.search`+`media.play` 放用户偏好轻音乐、`calendar.create_task` 明晚休息提醒），同时发布 speak 信号告知

#### 4. `advice-store.ts` — advise 模式载体
- per-actor 队列（内存，上限 3 条，48h 过期），`push`/`drain`

#### 5. `proactivity-hub.ts` — 核心编排器
```ts
class ProactivityHub {
  constructor(deps: {
    lifeSignalHub: LifeSignalHubService;
    toolRegistry: ToolRegistry;
    governor: FrequencyGovernor;
    adviceStore: AdviceStore;
    getProfile?(actorId): { topics: string[]; preferences?: ... } | null;   // OnlineLearningCortex
    observeUserState?(actorId, history): Promise<{ activity?, mental? }>;  // brainCenter.observeWithMental
    getLastInteractionAt(actorId): number | null;  // awareness/最近对话时间
  })
  // ---- 对外入口（各模块薄接线点）----
  observeConversationTurn(actorId, text, recentHistory)  // agent-core 每轮 fire-and-forget
  onAgentTaskCompleted(actorId, goal)                    // agent-task-orchestrator
  onUserLoopCompleted(actorId, loopText)                 // session-epitome record 透出
  onRhythmSignal(actorId, kind, payload)                 // body.rhythm.* 订阅
  onTick(actorId)                                        // 自身 interval 30min：问候/分享判定
  start()/stop()                                         // interval 生命周期
  // ---- 内部路由 ----
  private async route(intent) {
    // 频控 canTrigger → 不通过直接丢
    // speak → lifeSignalHub.publish({ kind: intent.kind, importance, title, summary, metadata: {...} })
    // act   → 逐个 toolRegistry.execute(actArgs)，失败仅日志；overwork_care 等复合场景 act 后再发 speak 信号
    // advise→ adviceStore.push
  }
}
```

#### 6. `index.ts` 导出

### 新增：`server/src/body/rhythm-core.ts` — 节律感知（感知归 body）
- 实现 BodyModule 接口（对齐 homeostasis-core 模式：start/stop/getSnapshot）
- 输入（不 import brain 服务，解耦）：
  - 订阅 BodyBus：`body.skin.device_change`、`body.vestibular.device_switch`（活跃标记）
  - `noteActivity(actorId, source)` 公开喂入接口——装配层把 awareness.observe 的 busy 状态、桌面 presence 变化喂进来
- 状态：per-actor 最近活跃时刻、连续工作时长（busy 持续）、当日深夜活跃次数
- 输出（BodyBus publish，同时经既有 bridgeToSynapse 上达）：
  - `body.rhythm.overwork_detected`（连续工作 ≥3h 或当日深夜活跃 ≥2 次，阈值 env 可调）

### 修改：接线与新旧替换

#### 7. `server/src/services/agent-core.ts`
- **删除**：`CONVERSATION_PROACTIVE_COOLDOWN_MS`、两个正则、`detectConversationProactiveHook`、`conversationProactiveLastAt`、`maybeTriggerConversationProactive`（agent-core.ts:23-63、226-227、554-624、787-793）
- **替换为**：`this.proactivityHub?.observeConversationTurn(actorId, text, cognitiveRecentConversationHistory)`（fire-and-forget，位置不变 cognize 后）
- 新增 `setProactivityHub(hub)` 注入

#### 8. `server/src/services/agent-task-orchestrator.ts`
- emitProgress 的 `task_completed` 分支（L190、L678 两处）加 `this.proactivityHub?.onAgentTaskCompleted(task.actorId, task.goal)`；新增可选 setter

#### 9. `server/src/services/session-epitome.ts`
- `record()` 内 diff `closeCompletedLoops` 前后 openLoops，被关闭项通过返回值透出（`record(): { closedLoops: EpitomeEntry[]; ... }` 或新增回调参数）；调用方转发 `hub.onUserLoopCompleted`

#### 10. `server/src/brain/proaction-cortex.ts`
- `SIGNAL_PRIORITY_MAP`（L42-49）新增：`task_celebration: 6`、`overwork_care: 7`、`interest_share: 3`、`greeting: 3`、`care: 5`、`followup: 4`
- `ACTION_TOOL_WHITELIST`（L605-609）新增 `media.search`、`media.play`

#### 11. `server/src/body/body-center.ts`
- 构造并启动 `RhythmCore`（第 10 个 startModule，L254-271 与 stop 对称加）；暴露 `getRhythm()` 供装配层喂数据

#### 12. `server/src/bootstrap/create-app-services.ts`
- 实例化 FrequencyGovernor / AdviceStore / ProactivityHub（deps 注入 lifeSignalHub、toolRegistry、OnlineLearningCortex.getProfile、brainCenter.observeWithMental 包装、awareness 最近活动时间）
- hub 订阅 `bodyCenter.getBus()` 的 `body.rhythm.*`
- `agentCore.setProactivityHub(hub)`、orchestrator/epitome 接线
- hub.start() 挂 bootLoads、stop 挂关闭链
- awareness/desktop presence 变化处调 `rhythmCore.noteActivity(actorId, ...)`（在既有 desktopPresenceSignalService.handleSync 调用点附近）

#### 13. `server/src/agent/prompt-context-builder.ts`
- 注入 advise：`adviceStore.drain(actorId)` → `【Agent 主动建议】`块（有建议才注入，零开销）

### 测试
#### 14. `server/test/proactivity-hub.test.ts`
- 频控：预算耗尽拒、分 kind 冷却、静默时段放行 high
- 路由：speak 发布正确 LifeSignal（mock hub）、act 执行 mock toolRegistry、advise 入队
- 触发器：celebration/share/greeting/overwork intent 构建正确性
#### 15. `server/test/rhythm-core.test.ts`
- 连续工作 ≥3h 触发 overwork_detected、深夜计数、noteActivity 喂入
#### 16. 扩展 `server/scripts/verify-conversation-proactive.ts`
- 多 kind 信号（celebration/overwork/greeting）过真实 ProactionCortex → 全部 speak
- act 路径：mock toolRegistry 验证 media.play/calendar.create_task 真实被调

## Assumptions & Decisions

1. **speak 话术不重造**：新模块只决定"何时/为何/何种模式"，消息质量交给现有 executeProactiveDecision（LLM function calling 本就能边做事边说话）
2. **频控双层**：hub 前置频控（粗）+ ProactionCortex disturb/repeat_suppress（细）保留为第二道防线，不冲突
3. **act 白名单**：仅 `media.search/media.play/calendar.create_task/smart_home.*`；删除类操作永不自动执行
4. **agent"自己喜欢的"**：由 speak 闭环 LLM 话术自然带出（prompt 已是朋友口吻），触发时机由用户画像兴趣驱动，不建独立 agent 偏好库（避免过度工程）
5. **body 解耦**：rhythm-core 不 import brain 服务，靠装配层 `noteActivity` 喂数据
6. **单窗口对话约束**（项目记忆）：advise 用注入而非强插消息，尊重现有短句/分段风格
7. **默认参数 env 可调**：`PROACTIVITY_DAILY_BUDGET`、`PROACTIVITY_TICK_MS`（30min）、`RHYTHM_OVERWORK_HOURS`（3h）等
8. **epitome record 返回值变更**是破坏性小改：需同步更新其现有调用方（agent-core 每轮 record 处）

## Verification Steps

1. `npx tsc -p tsconfig.json --noEmit` 零错误
2. `npx tsx --test test/proactivity-hub.test.ts test/rhythm-core.test.ts` 全过
3. `npx tsx scripts/verify-conversation-proactive.ts`：多 kind 全 speak + act mock 执行成功
4. 全量回归 `npx tsx --test test/**/*.test.ts`（142+ 项全过，含既有 conversation-proactive.test.ts 改为从新模块导入）
5. 真实体验（可选）：起服务后发"任务完成了"+ 等待 30min tick，观察日志 `[ProactivityHub]` 系列输出与 `agent.proactive_message` 投递
