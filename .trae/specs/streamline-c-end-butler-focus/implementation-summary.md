# 记忆链路 LLM 调用收敛 —— 实施总结（任务A：单轮 turn 路径 LLM 调用点审计）

> 审计范围：C 端私人管家 Agent 单轮对话（turn）路径上全部 LLM 调用点。
> 记忆架构为多通道融合（memory-arbitrator 统一仲裁）：STM 词法网关 → session epitome → rolling summarizer → human-like 图谱 → agentic-memory → KV summary → 关联合成器。
> 审计方式：逐文件读代码确认触发条件 + `server/data/llm-token-audit.ndjson`（1021 条记录）按 stage 聚合统计 token 占比。

## 一、turn 路径 LLM 调用点触发条件表

| # | 调用点 | 文件 | 触发条件 | 频率 | token 占比（实测） | 处置建议 |
|---|--------|------|----------|------|--------------------|----------|
| 1 | 主对话回复 + 工具循环 | `server/src/external-model/openai-compatible-tool-loop.ts`（经 `abstract-chat-provider` / agent-core `streamCompletion` 驱动） | 每轮必然执行：首轮生成回复；带工具时每 round 记一条（main_chat_tools） | 每轮 ≥1 次，工具循环每 round 1 次 | **91.1%**（main_chat 507 次 / 375.2 万 token，含工具循环） | **保留**（核心价值链路，不可降频）；靠 prefix cache / prompt 瘦身降本 |
| 2 | 主动意图决策（llmComplete） | `server/src/proactivity/initiative-engine.ts` | ProactivityHub 周期 tick 且**有新观察才调**（perception-feed 无新观察零调用）+ 高显著事件即时评估；不在 turn 关键路径，后台旁路 | 后台周期性（非每轮） | 5.3%（385 次 / 21.9 万 token） | 保留但观察 tick 密度；已有频控（frequency-governor）与决策缓存 |
| 3 | 记忆写决策兜底 | `server/src/services/memory-decision-engine.ts` | 记忆写入时启发式**不置信**（`shouldTrustHeuristic` 各决策档置信度阈值未达标）才调 LLM 仲裁 | 条件触发（写入时） | 2.5%（76 次 / 10.5 万 token） | 保留（记忆质量关键）；启发式命中率高时自动少调 |
| 4 | 低信号记忆批次摘要 | `server/src/agentic-memory/ingest.ts`（及 `memory-manager-service.ts`） | 低信号记忆** flush 时**批量压缩（非每轮） | 条件/周期触发 | 0.7%（32 次 / 2.7 万 token） | 保留（后台批处理，已天然降频） |
| 5 | 用户画像深度合成 | `server/src/brain/user-profile-aggregator.ts` | 画像定期聚合（非每轮） | 低频周期 | 0.2%（9 次） | 保留 |
| 6 | 情绪推断（analyzeMessage） | `server/src/services/mood-inference-service.ts` | 每轮用户消息触发：① limbic-cortex `inferEmotion`（cognize 感知 emotion 通道，**await 阻塞**）；② agent-core cognize 返回后 fire-and-forget 二次调用（被 5 分钟 TTL 缓存挡住，实际每轮最多 1 次 LLM） | 每轮 1 次（有 TTL 缓存去重） | 0.1%（10 次 / 2659 token） | **低价值高侵入**：占比极小但①路径阻塞 cognize 感知阶段；建议降频（每 N 轮/会话开场/情绪突变信号触发），非本次范围 |
| 7 | 滚动摘要（LLM 增量 recap） | `server/src/services/conversation-rolling-summarizer.ts`（经 `chat-thread-store.enhanceRecap` 调用） | 仅当 thread 上下文超窗、`trimThread` **丢弃历史消息时** fire-and-forget 触发（seq 守卫防覆盖）；DEFAULT_MODEL gpt-4.1-mini，实际跟随主 provider，`AGENT_RECAP_SUMMARIZE_MODEL` 可覆盖 | 条件触发（长会话截断时） | ~0%（2 次 / 1203 token） | 保留（上下文连续性关键，天然低频） |
| 8 | 跨记忆联想合成 | `server/src/brain/memory-cognitive/memory-association-synthesizer.ts`（调用点在 `memory-cortex.ts`） | 两条路径：① recall 收尾 `finalizeRecallItems` 命中 ≥2 条时 `void synthesize()` **fire-and-forget**（不阻塞 recall 返回）；② 写入时关联（新记忆落库后，按 actor 45s 节流，`MEMORY_WRITE_ASSOCIATION_INTERVAL_MS`） | recall ≥2 条时每轮可触发（异步） | **未打点**（无 token 审计 stage，未计入 ndjson） | **确认不在用户等待路径**（两处调用均 fire-and-forget，错误静默只记日志）；建议补 token 审计打点以便后续观测 |
| 9 | 跨会话开放环路提取（epitome） | `server/src/services/session-epitome.ts`（调用点在 `brain-center.ts` cognize 记忆写入后） | **纯规则提取（正则归类 openLoops/commitments/preferences），不调 LLM**；每轮在 cognize 记忆写入 fire-and-forget 块内执行，写 KV `session_epitome` | 每轮（旧实现） | 不适用（零 LLM） | **本次改造**：改为每 N 轮批量提取 + 会话边界兜底（见下文任务B1），降 KV 写频为 1/N |
| 10 | 召回结果压缩（recall_compress） | stage 已在 `llm-token-audit.ts` 定义 | 召回结果超阈值时压缩（当前代码库无活跃调用点） | — | 0 次（无记录） | 无需处理 |

**审计口径说明**：
- ndjson 落盘字段为 `stage`（非 `purpose`），统计基于 `server/data/llm-token-audit.ndjson` 全量 1021 条按 stage 聚合 `inputTokens + outputTokens`。
- 合计约 411.7 万 token；其中 turn 主链路（main_chat + mood_inference + rolling_summary）≈ 91.2%，后台旁路（proactive_intent + memory_write_decision + memory_flush_summarize + user_profile_aggregate）≈ 8.7%。
- `memory-association-synthesizer` 未接入 token 审计（无 `recordLlmUsageByChars` 打点），为审计盲区，建议后续补点。

## 二、turn 路径时序（调用点发生位置）

```
用户消息
 └─ agent-core.processMessage
     ├─ brainCenter.cognize（感知 → 决策）
     │   ├─ 阶段1 感知并行: limbic.inferEmotion → moodInference.analyzeMessage【LLM #6，await 阻塞】
     │   ├─ recall 门控通过时: MemoryCortex.recall → finalizeRecallItems
     │   │     └─ ≥2 条命中 → triggerAssociationSynthesis【LLM #8，void fire-and-forget，不阻塞】
     │   └─ 阶段3 后置: 记忆写入（fire-and-forget，含 memory_write_decision【LLM #3 条件触发】）
     │        └─ 【改造点】epitome 提取（#9，纯规则）→ KV session_epitome
     ├─ cognize 返回后: agent-core fire-and-forget mood analyzeMessage（TTL 缓存挡住，多数不产生新 LLM 调用）
     └─ streamCompletion【LLM #1 主对话 + 工具循环】
          └─ trimThread 超窗时: enhanceRecap【LLM #7，fire-and-forget】
（后台并行）ProactivityHub tick → initiative-engine.evaluate【LLM #2，有新观察才调】
```

## 三、结论

1. **turn 路径上真正的 LLM 消耗主体是主对话（91.1%）**，记忆链路各旁路合计不足 1%（mood 0.1% + rolling ~0% + association 未打点）。
2. session-epitome **不消耗 LLM**（任务假设的"每轮提取 openLoops/commitments/preferences"是规则提取），其成本是每轮 KV 写；降频目标是写频收敛与 cognize 尾部路径减负。
3. memory-association-synthesizer 两处调用（recall 侧 / 写入侧）均已是 fire-and-forget 异步执行、错误静默记日志，**不在用户等待路径上**，无需改造（任务B2 确认结论）。
4. 本次实际改造：session-epitome 提取降频（每 N 轮 + 会话边界兜底）。

---

# 任务B：降频改造记录

## B1：session-epitome 每 N 轮触发 + 会话边界兜底

**改动文件**：
- `server/src/services/session-epitome.ts`：新增 `SessionEpitomeTurnGate`（轮次门控）与 `loadSessionEpitomeEveryNTurns()`（env `SESSION_EPITOME_EVERY_N_TURNS`，默认 5，≤1 视为每轮）。
- `server/src/brain/brain-center.ts`：cognize 阶段 3 的 epitome 提取从「每轮、记忆写入 fire-and-forget 块内」改为「经 TurnGate 门控的批量同步提取」。

**逻辑**：
1. 每轮 cognize 登记一轮快照（query / memoryWrites / 脱敏后回复）进 per-actor pending 缓冲（轻量引用，最多 N 条）。
2. 触发条件（任一）：① 轮次计数达 N（默认 5）；② **会话边界兜底**——本轮判定为会话开场（thread 非 system 消息数 ≤1，与 recall-gate `NEW_SESSION_THREAD_MAX` 同口径）且 pending 有上一会话残留时立即批量提取。
3. 触发时批量合并提取（逐轮 `extractEpitomeEntries` 后 concat，`SessionEpitomeStore.record` 内 `clampList` 限量去重），一次 `updateSessionEpitome` 落 KV（turnText 拼接供完成检测）。
4. **兜底可靠性**：提取是纯规则 + 同步内存合并 + 一次同步 KV setEntry（毫秒级），放在 cognize 主路径同步执行——新会话开场轮 cognize 返回后，agent-core `buildRecentConversationHistoryBlock` 读取【上一会话待办】（KV `session_epitome`）时兜底数据**已落盘，无竞态**。
5. 行为增强（非回退）：旧实现仅在 `memoryWrites.length > 0` 时才提取（query-only 的请求轮会被漏掉）；新实现每轮都登记，无记忆写入的轮次用户请求同样进入待办提取。

**不回退硬约束**（只读未改）：召回确定性截断（`dedupeAndLimitRecallItems`）、检索 query 只用用户原文（recall-gate 注释约束）、场景门控（`shouldRecallLongTerm` 白名单）、窗口指示词"刚才"短路（`isWindowDeixisShortCircuit`）、STM/journal 结果去重——均未触碰。

## B2：memory-association-synthesizer 异步化确认

**结论：无需改造。** 读 `server/src/brain/memory-cortex.ts` 两个调用点：
- recall 路径：`finalizeRecallItems`（1673 行）→ `triggerAssociationSynthesis` → `void synthesizer.synthesize(...).then(...)`，fire-and-forget，不 await、不阻塞 recall 返回；`.catch` 内静默记日志不外抛。
- 写入时路径：`triggerWriteTimeAssociation`（614 行）→ `void (async () => { ... })()` IIFE，同样异步且按 actor 45s 节流。

## 验证（实际结果）

- `npm.cmd run build --workspace=server`：**通过，零错误**（agent-world tsc + server tsc 全量类型检查；期间工作区另一并行任务曾短暂引入 create-app-services.ts 语法错误，非本改动引入，对方修复后构建即通过，本改动文件全程无报错）。
- 测试：`session-epitome.test.ts`（含新增 6 个 `SessionEpitomeTurnGate` 用例）、`memory-association-synthesizer.test.ts`、`memory-cross-session.test.ts`、`memory-arbitrator.test.ts`、`recap-layering.test.ts` 共 **48/48 全部通过**。
- 已知预存失败（与本次改动无关，改动前即失败）：`conversation-rolling-summarizer.test.ts` 中 2 个「同步阶段不应生成正则 recap」断言失败，涉及 `chat-thread-store.ts` trimThread 同步 recap 行为，该文件及相关测试文件与 git HEAD 完全一致（`git diff` 为空），属仓库既有问题。

---

# P5：最终验证（2026-08-29）

> 验证轮覆盖：全量构建 / 全量测试回归 / 默认 env 冒烟（node 直跑 dist 产物纯逻辑层）/ token 审计对比。全程未修改 `server/src`（无新失败需要修复）、未触碰 `server/src/tools/tool-search/`。

## 1. 构建结果

`npm.cmd run build --workspace=server`（先 `agent-world` tsc，再 server `tsc -p tsconfig.json`）：**通过，exit 0，零错误**。

## 2. 测试统计

命令 `npm.cmd test --workspace=server`（`tsx --test test/**/*.test.ts`，node:test runner，耗时 ~97s）：

- **329 tests / 327 pass / 2 fail / 0 cancelled / 0 skipped**。
- 基线对比：基线 286/284 → 本次 329/327，**新增 43 个测试全部通过，零新增失败**（新增来自 P2 `SessionEpitomeTurnGate` 与 P3/P4 生活域五场景用例，含 consumption-ledger 7 项、evening-digest 4 项等）。
- 2 个失败均为已知预存项：`test/conversation-rolling-summarizer.test.ts`（断言点 :136「LLM 增强完成后插入/回写 recap 消息」与 :244「无同步 recap 时 LLM 增强插入到 system 之后」），与本轮变更无关（见上文任务B验证记录）。

## 3. 默认 env 冒烟（纯逻辑层，5/5 PASS）

不起 HTTP 服务、不依赖 LLM key，node 直接加载 dist 编译产物：

| # | 验证项 | 结果 |
|---|--------|------|
| 1 | 五开关默认值全 false：`isBrainEvolutionEnabled()`、`isAgentWorldSocialEnabled()`，以及 `envFlagEnabled("BRAIN_DMN_ENABLED"/"EXTERNAL_TECH_SCANNER_ENABLED"/"BENCHMARK_SELF_ASSESSMENT_ENABLED")` 在未设任何 env 时均返回 false | PASS |
| 2 | 旧变量兼容：`AGENT_EVOLUTION_LOOP_ENABLED=1` 与 `BRAIN_SELF_DRIVEN_EVOLUTION_ENABLED=1` 均使 `isBrainEvolutionEnabled()` 为 true（删除后回落 false）；`AGENT_WORLD_SOCIAL_ENABLED=1` 开启社交域 | PASS |
| 3 | `filterSocialChatTools(AGENT_WORLD_CHAT_TOOLS)`：**29 → 4**，保留 identity/pairing 最小集（world.open_registry.get_challenge / submit / agent_quick、world.room.create），`world.free_market.*` / `world.social.*` / `world.music.*` 全部过滤 | PASS |
| 4 | `EveningDigestScheduler` 静态构造 + subscribe / start（二次 start 幂等）/ stop 生命周期无异常、未误触发（tick 需命中 EVENING_DIGEST_HOUR） | PASS |
| 5 | `ConsumptionLedgerListener` 事件入账（复用测试逻辑）：HookBus emit `tool.executed`（wallet.purchase ¥35.5）→ finance-deep 自动入账 1 笔 expense，分类映射 food_delivery→餐饮 | PASS |

**落地形态说明（如实边界）**：P1 五开关最终收敛为 2 个 env 变量——`BRAIN_EVOLUTION_ENABLED`（收编 EvolutionCortex 后台自动驱动的进化循环 / 技术扫描 / benchmark，兼容两个旧变量）与 `AGENT_WORLD_SOCIAL_ENABLED`（社交经济域）。`BRAIN_DMN_ENABLED` / `EXTERNAL_TECH_SCANNER_ENABLED` / `BENCHMARK_SELF_ASSESSMENT_ENABLED` 未作为独立变量落地：tech-scanner / benchmark 走 tasks.md Task 6 的「被 Task 5 总开关覆盖」分支；DMN 空闲模拟（brain-stem `DMN_CHECK_EVERY_N_SWEEPS`）本身为纯规则零 LLM 路径（`brain-stem.ts` 文件头注释「不调 LLM，纯规则 + 定时器」），其下游记忆整理（memory-manager consolidate）属记忆主链路而非实验性子系统。冒烟第 1 项对三个未落地变量名按 `envFlagEnabled` 读取规则验证默认 false，如实反映最终实现。

## 4. token 审计结论

`server/data/llm-token-audit.ndjson` 现存 **1044 条**（上次审计时点 1021 条，其后新增 23 条且全部为 proactive_intent；时间范围 2026-08-25 → 2026-08-29），合计约 **413.0 万 token**。全量 stage 分布：

| stage | calls | token | 占比 |
|-------|-------|-------|------|
| main_chat | 507 | 3,751,969 | 90.84% |
| proactive_intent | 408 | 232,205 | 5.62% |
| memory_write_decision | 76 | 104,657 | 2.53% |
| memory_flush_summarize | 32 | 27,330 | 0.66% |
| user_profile_aggregate | 9 | 10,194 | 0.25% |
| mood_inference | 10 | 2,659 | 0.06% |
| rolling_summary | 2 | 1,203 | 0.03% |

- 实验性子系统相关 stage：**`self_evolution` / `other`（外部科技扫描旁路）/ `interest_watch` 全部 0 条记录**——历史数据即无调用（`self_evolution` 仅存在于 stage 类型定义，代码中无打点调用点）。
- **代码路径佐证（默认 env 下不会再产生调用）**：
  - `create-app-services.ts:1375-1379`：`brainEvolutionEnabled` 默认 false → `evolutionCortex = null` 并输出 `[skip] EvolutionCortex disabled by ENV`；行 1484 / 1511 / 1520 / 1553 四处 `if (evolutionCortex)` 注册块（进化循环、知识缺口执行器、审批推送、皮层注册）全部跳过——evolution-loop / knowledge-gap / 自学习等周期性 LLM 触发源不被挂接。
  - 全量 `setInterval` 清单（server/src 共 28 处）中无 tech-scanner / benchmark / evolution 独立定时器，与 `server/.env.example` 注释一致：「开启后……不再有后台自动驱动的进化循环 / 技术扫描 / benchmark」。
  - `create-app-services.ts:800`：`isAgentWorldSocialEnabled()` 默认 false → `[skip] AgentWorld social domain disabled by ENV`，社交路由 mount、WS world.social.* 事件处理、A2A escrow 对账全部跳过；LLM 工具列表经 `filterSocialChatTools` 过滤（冒烟实测 29 → 4）。
- 观察项（非本次开关范围）：`proactive_intent` 最近 200 条中占 45.87%（161 calls / 9.16 万 token，ProactivityHub 周期评估），属 C 端管家主动触达主链路（P4 五场景共用频率通道），未被本次开关关闭；其既有约束为 perception-feed「有新观察才调」+ frequency-governor 频控。

## 5. 跳过的子系统清单（默认 env，启动时输出 `[skip] xxx disabled by ENV`）

| 子系统 | 控制开关 | 默认关闭效果 |
|--------|----------|--------------|
| EvolutionCortex（自学习 / 技能生成 / 晋升管道 / 进化循环 / 知识缺口执行） | `BRAIN_EVOLUTION_ENABLED`（兼容旧变量 `BRAIN_SELF_DRIVEN_EVOLUTION_ENABLED`、`AGENT_EVOLUTION_LOOP_ENABLED`） | 整块不装配、self_evolution.* 工具不创建、后台自动驱动的进化循环 / 每日技术扫描 / 每周 benchmark 自评不再发生 |
| Agent World 社交经济域（world-free-market / world-music / world-social 路由与工具、a2a-outsourcing、community-skill-store、A2A escrow 对账） | `AGENT_WORLD_SOCIAL_ENABLED` | 路由不 mount、WS 事件不处理、LLM 工具列表过滤为 identity/pairing 最小集（29 → 4） |

（DMN 空闲模拟、external-tech-scanner、benchmark 自评三个名字未单独落地 env 变量，分别以「纯规则零 LLM」与「被 BRAIN_EVOLUTION_ENABLED 总开关收编」达成同等目标，见第 3 节说明。）
