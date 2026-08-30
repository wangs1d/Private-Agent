# Agent 主动性底层机制设计（Proactivity Architecture）

> 目标：让 agent 真实地"主动感知 → 主动决策 → 主动做事/说话 → 越用越懂分寸"。
> 本文是对现状的诊断 + 统一底层机制的设计，所有结论均基于当前代码实际链路（含文件行号），可直接按阶段落地。
>
> **落地状态（2026-08-30）**：统一管道已实现并接线（§4 L1→L5 全部）——
> `server/src/proactivity/` 新增 `pipeline-types.ts`、`persist-file.ts`、`presence-service.ts`、
> `proposal-store.ts`、`arbiter.ts`、`delivery-service.ts`、`outcome-store.ts`、
> `upcoming-schedule-watcher.ts`、`proactive-pipeline.ts`；`frequency-governor.ts` 增加快照恢复与
> outcome 自适应冷却；`proactivity-hub.ts` 增加 known actor 持久化；`ws-connection-registry.ts`
> 增加连接变化回调；bootstrap 完成装配（共享频控、到点提醒离线必达、临近日程提前感知、
> known actor 恢复、onClose 清理）；诊断/回传路由 `GET /api/proactivity/diagnostics`、
> `POST /api/proactivity/outcome`；客户端高重要度主动消息升级原生弹窗并回传 outcome。
> 测试：`server/test/proactivity-pipeline.test.ts`（25 用例）+ `server/scripts/verify-proactivity-pipeline.ts`
> （6 场景端到端）。LLM 调用约束：仲裁链路零 LLM；每条主动消息仅在无 `directText` 时走一次
> speak 话术生成；到点提醒改为"在线只发 ScheduleReminderFired 弹窗、离线落 MessageHub"，
> 不再叠加话术二次调用。

---

## 1. 诊断：为什么现在的 agent"完全无感"

项目里其实已经散落了大量主动性部件（ProactivityHub、日程 1s tick、智能提醒三级升级、SynapseBus 投递、原生弹窗），但实际体验为零感。逐条核对代码后，根因有六个：

| # | 根因 | 证据（代码位置） | 影响 |
|---|------|----------------|------|
| 1 | **LLM 通用主动性默认关闭** | `proactivity/proactivity-hub.ts:198` `PROACTIVITY_LLM_INITIATIVE` 默认 false | 通用路径（LLM 自主判断"要不要主动"）从不运行，只剩少数快路径规则 |
| 2 | **感知依赖"已知 actor"+ 内存态，重启即失忆** | `proactivity-hub.ts:185` `knownActors` 仅在对话/事件时注入，纯内存 | 服务重启后没有任何用户是"已知的"，agent 在用户开口前永远不会主动；30min tick（`proactivity-hub.ts:134-139`）进一步拉长感知延迟 |
| 3 | **日程只有"到点即发"，没有提前量与状态语义** | `schedule-task-service.ts:190` 1s tick 只判 `nextRunAt <= now`；日程仅作为快照在 LLM 通用路径中被消费（`proactivity-hub.ts:393-397`，而该路径默认关） | 没有"会前 15 分钟提醒""错过了提醒""今天 3 件事先说哪件"——主动性最有价值的场景全部缺失 |
| 4 | **主动消息触达层级断裂** | `bootstrap/create-app-services.ts:1878-1892` 主动消息投 `agent.proactive_message`；客户端 `client/flutter_app/lib/main.dart:1354-1386` 只弹 SnackBar，而 `schedule.reminder_fired`（main.dart:948-975）才走原生 Acrylic 弹窗 | 即使 agent 主动了，用户也极容易看不见；客户端未连接（人不在电脑前）时只有 MessageHub 离线暂存，微信/飞书出站在 `message-platform-gateway.ts:76` 仅"queued locally"占位未接通 |
| 5 | **多套主动体系并存，无统一权威** | ProactivityHub / proactive-agent-center.ts / proactive-life-runtime-service.ts / anticipation-engine-service.ts / embodiment-autonomy-service.ts / morning+evening digest / intelligent-reminder 各有触发源、频控与投递路径 | 无法整体调"分寸"；互相可能重复或互相压制；"为什么发了/为什么没发"无法回答 |
| 6 | **没有反馈闭环与可解释性** | FrequencyGovernor 状态纯内存（`frequency-governor.ts:65`，重启清零）；主动消息的 accept/dismiss/ignore 结果没有统一落库回灌 | 无法自适应预算；排查"无感"只能翻日志 |

结论：**部件齐全，缺的是一条"统一权威"的底层机制**——所有主动行为必须经过同一条管道：感知 → 提案 → 仲裁 → 执行 → 投递 → 反馈。下面按这条管道设计。

---

## 2. 设计原则

1. **一个咽喉（One Throat to Choke）**：任何子系统想主动，只能提交"提案"，不能自行投递。仲裁层是唯一决策口。
2. **事件驱动为主，tick 为辅**：确定性事件（日程到期、webhook、IM 入站、hookBus 事件）实时入队；周期 tick 只做"扫描型"感知（临近事件、沉默问候、机会发现），扫描用纯规则、零 LLM。
3. **提案-仲裁分离**：触发源只负责"发现+举证"（便宜、可并发、可丢失）；仲裁层负责"去重、合并、频控、择时、选通道"（集中、可调参、可解释）。
4. **触达分层、离线必达**：按"用户在场状态 × 消息重要性"选择通道（应用内卡片 → 原生弹窗 → IM 推送 → TTS/电话升级）；离线不是终点，是换通道的信号。
5. **可协商、可解释、可学习**：每条主动行为有 outcome（接受/忽略/拒绝），回灌频控；每条有决策链日志，"为什么没主动"必须可查询。
6. **规则优先、LLM 按需**：确定性场景零 LLM（快、省钱、可测）；LLM 只用在两处——话术生成（已有）与多提案竞争仲裁/模糊场景判断。

---

## 3. 总体架构

```
                        ┌────────────────────────────────────────────────┐
                        │                L0 感知层（多源接入）              │
                        │  日程tick │ 临近扫描 │ presence │ IM入站 │ hookBus │
                        │  兴趣观察 │ 节律信号 │ 待办闭环 │ 任务完成 │ webhook │
                        └───────────────┬────────────────────────────────┘
                                        │ 统一为 ProactiveProposal（带证据/dedupKey/保质期）
                        ┌───────────────▼────────────────────────────────┐
                        │         L1 提案队列（持久化 data/proactive-*.json）│
                        └───────────────┬────────────────────────────────┘
                                        │
                        ┌───────────────▼────────────────────────────────┐
                        │                L2 仲裁层（唯一决策口）            │
                        │ 过期→去重合并→负反馈抑制→联系策略(静默)→分层频控    │
                        │ →时机(now/defer/bundle)→模式(speak/act/escalate) │
                        │      （多提案竞争预算时才调 LLM 仲裁）             │
                        └───────────────┬────────────────────────────────┘
                                        │ ProactiveDecision
                        ┌───────────────▼────────────────────────────────┐
                        │  L3 执行层：speak(话术) / act(工具,黑名单门) / 升级  │
                        └───────────────┬────────────────────────────────┘
                                        │
                        ┌───────────────▼────────────────────────────────┐
                        │  L4 投递层：通道仲裁（在场×重要性）+ 离线必达        │
                        │  in_app → native_popup → IM → tts/phone 升级     │
                        │  deliveryId + 客户端 ack/confirm/dismiss 回传     │
                        └───────────────┬────────────────────────────────┘
                                        │ outcome
                        ┌───────────────▼────────────────────────────────┐
                        │  L5 反馈学习：outcome 落库 → 自适应预算/冷却/抑制    │
                        │             → 主动性周报（自我审计）               │
                        └────────────────────────────────────────────────┘
```

---

## 4. 分层详细设计

### L0 感知层：统一信号接入

**保留**：`PerceptionFeed`（`proactivity/perception-feed.ts`）继续作为观察流；各触发器继续存在。

**新增 1：`PresenceService`（在场判定，投递层的地基）**

现状没有统一的"用户在不在场"。新建 `server/src/proactivity/presence-service.ts`：

```ts
type PresenceState = "active" | "idle" | "away" | "offline";
// active : WS 已连接 且 近 X 分钟有交互（对话/鼠标/桌面视觉 presence 信号）
// idle   : WS 已连接 但近期无交互
// away   : 客户端进入后台/锁屏（桌面端上报）
// offline: WS 无连接
```

信号源（全部已存在，只缺汇聚）：`ws-connection-registry.ts` 连接/断开事件、`desktop-presence-signal-service.ts`、`device-bus`、对话活跃（`observeConversationTurn` 已在记 `lastInteractionAt`）。
提供 `getPresence(actorId): PresenceState` 与 `onPresenceChange` 事件（仲裁与投递层消费）。

**新增 2：`UpcomingScheduleWatcher`（提前量感知——价值最高的单一改动）**

现状 `ScheduleTaskService.tick` 只处理"已到期"。新增轻量扫描（挂进同一个 1s tick 或独立 30s 扫描）：

- 对 `status=active` 的任务，在 `nextRunAt - leadMinutes` 时刻发出 `schedule_upcoming` 提案；
- leadMinutes 按 kind 配置：itinerary 类默认 T-15（可由任务元数据覆盖），weather_brief 不提前；
- **错过补发语义**：启动/补跑时若 `nextRunAt` 已过且未发过，发 `schedule_missed` 提案（话术模板："刚才 10:00 的 XX，现在方便处理吗"），而不是默默补一条普通提醒；
- 每条提案带 `dedupKey = schedule_upcoming:{taskId}:{nextRunAt}`，天然防重发。

**改造 3：把日程变成一级感知源（不再依赖 LLM 通用路径）**

`buildSchedulePromptSnapshot`（`services/schedule-prompt-snapshot.ts`）目前只在 `evaluateInitiative`（默认关闭）中被消费。改为：每日两条固定提案走快路径——早晨的"今日安排"摘要（与 morning-briefing 合并，避免双发）、临近事件的提前提醒（上面的 Watcher）。

**新增 4：机会发现类扫描器（Phase 4，可选）**：兴趣观察（`interest-watcher.ts` 已有）、待办跟进（`session-epitome` 闭环检测已有 `onUserLoopCompleted`）、知识缺口（`knowledge-gap-executor`）、消费预算（管家场景已有）。统一改走提案队列即可，不新建机制。

### L1 提案层：持久化提案队列

**统一提案结构**（扩展现有 `ProactiveIntent`，`proactivity/proactivity-types.ts`）：

```ts
type ProactiveProposal = {
  proposalId: string;            // ulid
  actorId: string;
  kind: string;                  // schedule_upcoming | schedule_missed | greeting | care | interest_alert | ...
  importance: "critical" | "high" | "medium" | "low";
  dedupKey: string;              // 指纹：schedule_upcoming:{taskId}:{runAt} / interest:{name}:{title}
  evidence: string[];            // 触发证据（可解释性：为什么提案）
  titleHint: string;
  summaryHint: string;           // 给话术生成的素材（沿用现有 intent 语义）
  createdAt: number;
  deliverAfter?: number;         // 最早可发（择时下界）
  expiresAt?: number;            // 保质期：会议开始后"提前提醒"提案自动作废
  interruptible?: boolean;       // 是否允许打断正在进行的对话（critical 默认 true）
  requiredChannel?: "im" | "phone" | null;  // 必达类：用户离线也必须换通道触达
  actions?: ProactiveActStep[];  // act 模式步骤（复用现有，受黑名单门约束）
  source: string;                // 触发源标识（诊断用）
};
```

**持久化**：`data/proactive-proposals.json`（对齐 schedule-tasks 的 JSON 落盘模式），重启恢复。提案是有生命周期的小对象，JSON 足够；单条记录即审计。

**入口唯一**：所有触发源一律 `ProactivityHub.submitProposal(proposal)`（即现有 `submitIntent` 的演进，`proactivity-hub.ts:356`）。schedule 的 `reminderHandler`、`agent_task` handler、morning/evening digest、intelligent-reminder、care/rhythm tools 全部改走此入口。**对应地，旧的多头投递点（各自直接 trySend/sendToUser）废弃。**

### L2 仲裁层：唯一决策口（本设计的核心）

固定流水线（全部规则实现，确定性可测）：

```
提案 → ① 保质期检查 → ② 去重合并 → ③ 负反馈抑制 → ④ 联系策略(静默时段)
     → ⑤ 分层频控 → ⑥ 时机决策 → ⑦ 模式决策 → ⑧ (可选)LLM 竞争仲裁 → Decision
```

① **保质期**：`expiresAt` 已过 → 丢弃（记录原因，进诊断）。

② **去重合并**：
- 同 `dedupKey` 在窗口内（默认 30min）只保留最新一条；
- 同 kind 多条低重要度提案（如 5 条 interest_alert）→ 合并为一条 digest 式提案（"这几件事顺便说一下"），只占一次预算。

③ **负反馈抑制**：现有 `suppression-store.ts`（kind 级/关键词级）前移保留，用户意愿最高优先。

④ **联系策略**：现有 `proactive-contact-policy.ts` 静默时段语义（23:00–7:00）保留，但改为**择时而非丢弃**——非 critical 的静默期提案转入 `defer`（见⑥），次日早晨并入早报，而不是被静默时段直接吃掉（现状是直接拦截，`frequency-governor.ts:125-127`）。

⑤ **分层频控**（改造 FrequencyGovernor，语义不变、增加两层）：
- **必达类不占社交预算**：`schedule_upcoming / schedule_missed / weather_alert` 等"用户明确要求过的事"走独立预算（上限=当日相关任务数），社交类（greeting/share/care/interest）共享现有每日预算（默认 6）；
- **状态持久化**：`kindLastAt` 与当日计数落盘 `data/proactivity-frequency.json`，重启不重置；
- 冷却表（`frequency-governor.ts:13-25`）沿用，新增 kind 补充即可。

⑥ **时机决策**（新增，现状完全没有）：

| 用户状态 | critical/high | medium | low |
|---|---|---|---|
| active（对话中） | 立即发（interruptible）或附在当前回复尾注 | 入队，本轮对话结束后发 | 入队，合并进后续消息 |
| idle / away | 立即发 | 立即发 | 入队 |
| offline | 换通道（IM/离线补发） | defer 到重连后立即补发 | defer，合并进下次早报/摘要 |
| 静默时段 | 立即发 | defer 到次日早晨 | defer 合并 |

"用户正在对话时不打断"已有雏形（`agent-core.ts` 中 `BrainCenter.interruptProactive` 的抑制逻辑），把它从"抑制"升级为"入队延迟"，主动行为不丢、只是等时机。

⑦ **模式决策**：沿用 speak / act / advise 三模式与 act 黑名单门（`proactivity-hub.ts:125-130`）。新增第四种组合语义：**act+speak 打包**（act 备好材料、speak 一句话汇报），现有 `routeDecision` 的 act 后附带 speak 已是此形态，保留。

⑧ **LLM 竞争仲裁（仅此一处用 LLM 决策）**：当多条 medium 及以下提案同时竞争剩余社交预算时，把候选清单（titleHint+evidence+预算余量）交给 InitiativeEngine 一次性排序择优（一次调用，不是每提案一次）。模糊场景（如"要不要现在发"）一律规则决定，不交给 LLM。`PROACTIVITY_LLM_INITIATIVE` 原来的"定期扫描全量决策"职责由快路径+扫描器取代后，此开关改为控制"竞争仲裁+机会发现"。

### L3 执行层

- **speak 话术生成**：保留现有 `executeProactiveDecision`（`create-app-services.ts:1774-1945`）——风格指纹注入、SILENT 模板兜底、输出脱敏、StreamSegmenter 分段、写入记忆，全部保留；它只是不再自己直接 sendToUser，产出交给 L4。
- **act**：保留 `executeActs` 黑名单门+步数上限+审计（`proactivity-hub.ts:678-703`）。
- **升级链**：critical 级提醒发出后 N 分钟未确认 → 复用 `intelligent-reminder` 已有的 popup(1)→tts_alarm(2)→phone_call(3) 升级链（`intelligent-reminder-service.ts:15-29`），作为仲裁层的"escalate"动作接入，而不是独立体系。

### L4 投递层：通道仲裁 + 离线必达

新建 `server/src/proactivity/delivery-service.ts`，成为**所有主动内容的唯一出口**（替换散落的 `wsConnectionRegistry.trySend` 与 `synapseBus.sendToUser` 直调）：

**通道仲裁矩阵**（presence × importance）：

| 在场 \ 重要性 | critical | high | medium | low |
|---|---|---|---|---|
| active + 前台 | in_app 卡片（常驻+确认） | in_app 卡片 | in_app 卡片 | 静默进消息列表 |
| idle / away | native popup | native popup | native popup（低干扰样式） | 静默 |
| offline | **IM 推送** + 离线补发 | 必达类 IM 推送，其余离线补发 | 离线补发 | 静默/合并 |

- **in_app**：现有 `agent.proactive_message` WS 事件（保留格式，加 `deliveryId` 与 `actions[]` 字段）。
- **native popup**：客户端把 `agent.proactive_message` 从 SnackBar 升级为复用 `DesktopNotificationLauncher`（`client/flutter_app/lib/core/services/desktop_notification_launcher.dart`，与 `schedule.reminder_fired` 同级待遇），并把原生弹窗已有的 confirm/dismiss/timeout 回调（`.cpp` 层已实现）按 `deliveryId` 回传服务端。**这是"有感"的最小改动、最大收益点。**
- **IM 推送**：接通 `message-platform-gateway.ts` 已预留的 wechat/feishu bridge 出站（微信走既有 OpenClaw 网关通道，加发送限频）；发送失败/未配置 → 降级为离线补发并记录。
- **离线补发**：MessageHub（`message-hub-service.ts`）落库保留，WS 重连时补推未读主动消息（现有机制扩展一个 replay 标记）。

每条投递生成 `deliveryId`，客户端回传 outcome：`accepted / dismissed / snoozed / ignored(timeout) / replied`。

**可协商提醒（主动性从"通知"升级为"对话"的关键）**：提醒类主动消息带快捷操作，服务端接住回写：
- `snooze` → `PATCH /schedule/tasks/:id` 推迟 `runAt`（路由已有）；
- `done` → 置 completed（复用今日打卡语义）；
- `cancel` → 置 cancelled。
客户端弹窗按钮已有（confirm/dismiss），缺的只是语义回传与回写。

### L5 反馈学习层

- **outcome 落库**：`data/proactivity-outcomes.json`（append-only，按日分文件防膨胀），记录 `{deliveryId, kind, importance, channel, outcome, latencyMs}`。
- **自适应（简单规则先行，不搞模型）**：
  - 某 kind 滚动接受率 < 20%（近 20 条）→ 冷却 ×1.5（上限 48h）；
  - 接受率 > 60% → 冷却恢复默认；
  - 用户显式负反馈 → suppression-store（已有）。
- **主动性周报（自我审计）**：每周汇总发给自己/管理员：发了多少、分通道触达率、接受率、被频控/抑制拦截 Top 原因。这是调"分寸"的依据，也是向用户证明"agent 在主动做事但克制"的界面。

### 可解释性诊断（排查"无感"的手术刀）

新增 `GET /api/proactivity/diagnostics`：

```jsonc
{
  "presence": { "default": "active" },
  "budget": { "social": "3/6", "mustReach": "1/∞" },
  "recentProposals": [
    {
      "proposalId": "...", "kind": "schedule_upcoming", "dedupKey": "...",
      "verdict": "deferred",           // delivered | deferred | merged | suppressed | throttled | expired | dropped
      "reasonChain": ["quiet_hours_defer_to_morning_briefing"],  // 完整决策链
      "evidence": ["task=项目评审 runAt=10:00 lead=15m"]
    }
  ]
}
```

每条提案从生到死每一步的允许/拒绝原因都记录。**"agent 为什么没主动"从此是可查询的，而不是玄学。**

---

## 5. 关键默认值调整（让它"有感"但不出格）

| 项 | 现状 | 调整为 | 理由 |
|---|---|---|---|
| `PROACTIVITY_LLM_INITIATIVE` | false | true（职责改为竞争仲裁+机会发现） | 通用主动性从未运行过 |
| ProactivityHub tick | 30min | 扫描类拆走后 5min（只跑问候/机会发现） | 提前量由 UpcomingScheduleWatcher 事件驱动承担，tick 降级为兜底 |
| knownActors | 内存，重启清空 | 落盘 + 启动时从 chat-threads/schedule-tasks/user_profiles 恢复 | 重启后 agent 才能自主早问好（受静默时段+预算保护） |
| 每日预算 | 6 次单一池 | 社交池 6 + 必达池独立 | 提醒是用户要的，不该被社交配额挤掉 |
| 静默时段命中 | 直接拦截丢弃 | defer 到早晨合并进早报 | "没发"和"择机发"是两种产品体验 |
| proactive_message 客户端 | SnackBar | 原生弹窗 + 操作按钮回传 | 触达层级断裂的最小修复 |

---

## 6. 与"扣子类"产品的差异定位

扣子等办公 agent 的"主动性"= 用户自己搭工作流触发器（cron/webhook），本质是**用户编排的自动化**，用户必须知道"我想要什么、什么时候触发"，搭完不碰就僵化。

本设计是 **agent 自治的主动性闭环**：用户只表达意图（"明天有会提前叫我""每天提醒我喝水"）和给反馈（接受/忽略/"别再提这个"），agent 自己负责感知、择时、择通道、合并、升级、学习。四个竞品难以复制的壁垒：

1. **统一仲裁**——不自嗨、不打扰，多源信号收敛成恰好的几次触达；
2. **时机与在场感知**——提前量、静默 defer、离线换通道，"在正确的时间用正确的方式说"；
3. **反馈学习**——越用越懂分寸，而不是固定 cron 噪音；
4. **可解释**——每次主动/不主动都有决策链可查，产品级可信度。

---

## 7. 分阶段实施路线图（每阶段独立可验收）

### Phase 1：让现状"有感"（最小改动，1~2 天量级）
1. 客户端 `agent.proactive_message` 升级原生弹窗 + confirm/dismiss 回传（main.dart L1354 处改造）。
2. `UpcomingScheduleWatcher`：临近任务 T-15 提案 + 错过补发语义（快路径，零 LLM）。
3. knownActors 持久化与启动恢复。
4. FrequencyGovernor 状态落盘。
5. 开启 `PROACTIVITY_LLM_INITIATIVE=1`（灰度观察日志）。

**验收**：重启服务后，早晨 agent 自主发来问好+今日安排；会议前 15 分钟收到原生弹窗提醒；离开电脑时主动消息不会"静默消失"（至少有原生弹窗或离线暂存）。

### Phase 2：统一决策口
6. 提案结构 + 持久化队列；各触发源（schedule reminderHandler / digest / intelligent-reminder / care tools）改走 `submitProposal`。
7. 仲裁流水线（去重合并 / defer / bundle）+ PresenceService。
8. DeliveryService 统一出口 + deliveryId + outcome 落库。
9. 诊断接口 `GET /api/proactivity/diagnostics`。

**验收**：同类信号自动合并；对话进行中的主动消息延迟到回合结束；诊断接口能回答任意一条"为什么发/为什么没发"。

### Phase 3：离线必达
10. 接通 message-platform-gateway 微信/飞书出站（限频）。
11. critical 未确认 → intelligent-reminder 升级链接入仲裁层。
12. 可协商提醒：snooze/done/cancel 回写 schedule。
13. 桌面 presence 信号（前台/锁屏）接入 PresenceService。

**验收**：人不在电脑前，微信收到临会提醒；critical 提醒 10 分钟未确认自动升级；弹窗上点"稍后提醒"10 分钟后真的再来。

### Phase 4：自适应与机会发现
14. outcome 反馈自适应冷却/预算；LLM 竞争仲裁；机会发现类提案（兴趣/知识缺口/待办跟进）全量接入；主动性周报。

**验收**：连续忽略的话题自动沉寂；周报可见"本月主动 23 次、接受率 61%、被你按掉的 Top 3 话题"。

---

## 8. 风险与边界

- **打扰失控**：四道闸门固定顺序（抑制→静默→分层预算→合并 defer），且所有闸门可解释、可配置；宁缺勿滥，预算默认保守。
- **LLM 成本**：决策侧几乎全部规则化，LLM 只出现在话术生成（已有）与偶发竞争仲裁；决策缓存（`initiative-decision-cache.ts`）保留。
- **安全**：act 黑名单门（`proactivity-hub.ts:125`）与输出脱敏（`checkOutputSafety`）原样保留；IM 出站仅发送文本，不接受入站外的写操作。
- **微信风控**：出站走 OpenClaw 网关并限频（同类 ≤1 条/小时），失败降级离线补发，不做重试轰炸。
- **数据膨胀**：提案/outcome 均按 TTL 与按日分文件治理（对齐现有 JSON 落盘模式，不引入 DB）。
