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
>
> **第二批（同日，按用户反馈）**：① 社交每日预算 6→3；② **多端互通**——`ws-connection-registry.ts`
> 改为每 actor 多连接 fan-out（电脑端 + 手机端同时在线都收到，全部掉线才算离线），
> `presence-service.ts` 改引用计数；电脑端关闭但手机端在线时消息直达手机端；
> ③ 决策：**不引入短信**，通道 = 两端应用内消息/弹窗 + MessageHub 离线信箱 + critical 电话升级；
> ④ 电话升级链现状判定：仅作用于 intelligent-reminder 创建的提醒
> （popup 后 10min 无响应→TTS，再 12min 无响应→电话，按用户响应历史自适应初始级与规则，
> 响应即停）；~~统一管道的 critical 升级接线仍为 Phase 3 待办~~
> ✅ 2026-09-05 已接线：管道 `escalate` 钩子（critical 直投成功后触发）→ 装配层创建
> urgent 提醒并立即 trigger，复用整条 popup→tts_alarm→phone_call 升级链，
> reminder.acknowledge 停链。测试 28/28。
>
> **第三批（同日，按用户反馈）**：① **MessageHub 离线信箱从主动管道移除**——投递模型收敛为
> "全部在线设备 fan-out 直推"；两端离线时提案挂起待发区，任一设备重连立即直推（重连触发 flushDue），
> 投递竞态 30s 自动重试；预算计数与 outcome 只在真正送达后记录。② **弹窗保证**——payload 带
> `display:"popup"`，客户端原生弹窗失败（如移动端）降级为应用内弹窗卡片（不用 SnackBar），
> 确认/关闭经 `onUserConfirm/onUserDismiss` 回传 outcome。③ must 层提醒在对话进行中也不再延迟
> （用户点名要的事即时直推）。测试 28/28 + 端到端 7/7。
>
> **第四批（同日）：移动端推送通道**——服务部署到云主机后无需电脑开机，两端都离线时必达/critical
> 提案自动升级手机系统级推送。新增 `mobile-push-service.ts`（JPush/Bark/通用 webhook 三 provider，
> env 门控 + token 注册表 `push-tokens.json`），管道集成（离线/竞态升级、5min 退避、成功出队防重），
> HTTP 路由（`POST/DELETE /api/proactivity/push/register`、`GET /api/proactivity/push/status`、
> `POST /api/proactivity/push/test` 测试推送），客户端 `mobile_push_service.dart`（MethodChannel
> `pai/mobile_push` 上报 token，原生侧未接厂商推送时静默跳过）。测试 39/39 + 端到端 8/8。
> 待用户操作：申请极光账号填 `JPUSH_APP_KEY/JPUSH_MASTER_SECRET`（或配 BARK_URL/通用 webhook），
> 并在 App 原生侧接入厂商推送 SDK 实现 getPushToken（详见 mobile_push_service.dart 头注释）。
>
> **第五批（同日）：手机常在线模型（类微信）**——用户设定手机端常在线，消息一到就提醒。
> 新增 `flutter_local_notifications` 依赖 + `local_notification_service.dart`（Android 通道
> "proactive" 高优先级 / iOS timeSensitive）；客户端跟踪 App 生命周期：**手机后台/锁屏时**
> 收到 `agent.proactive_message`（高重要度）或 `schedule.reminder_fired` 一律走**系统通知**
> （点开回前台并按 deliveryId 回传 outcome），前台仍走应用内弹窗不重复打扰；Windows 桌面
> 不受影响（走原生弹窗）。后续项：Android 前台服务保活 WS（厂商杀进程场景由推送通道兜底）。
>
> **第六批（2026-09-05）：LLM 主动性默认开启 + 统一管道收敛（本批）**——
> ① `PROACTIVITY_LLM_INITIATIVE` 默认 false→**true**（不设 env 即生效，设 0 回退纯规则；
> 配套预算耗尽前置短路 + 抑制/频控拦截负向缓存，LLM 只在真有机会时被调用；
> 回归测试 `proactivity-hub-default-on.test.ts`）。
> ② **legacy 出站收敛**：`ProactiveOutboundMessageService` 增加可选管道提交入口（第三个构造参），
> 注入后 send() 组装提案（directText 零 LLM，reason 类别→kind、urgency→importance 映射）
> 转投 `submitProposal`——ProactiveAgentCenter / ProactiveLifeRuntime 两条 legacy 路径
> 自动获得去重/仲裁/离线挂起/outcome 反馈（原先离线只 console.log 即丢）。测试
> `proactive-outbound-pipeline.test.ts`。
> ③ **早/晚报离线必达**：MorningBriefing / EveningDigest 调度器 WS 推送失败时转管道挂起
> （dedupKey 带日期防跨日重发，重连直推），在线路径保持专用客户端事件不变。
> ④ **critical 升级链接线**：管道新增 `escalate` 钩子（critical 直投成功后触发），装配层创建
> urgent 提醒并立即 trigger，复用 intelligent-reminder 的 popup→tts_alarm→phone_call
> 三级升级链，reminder.acknowledge 停链。测试 `proactive-pipeline-escalate.test.ts`。
> 未收敛项：ProactionCortex 主链（executeProactiveDecision 的分段拟人节奏 + 专用客户端事件）
> 暂保留直发，待分段能力下沉 DeliveryService 后再收敛。

---

## 1. 诊断：为什么现在的 agent"完全无感"

项目里其实已经散落了大量主动性部件（ProactivityHub、日程 1s tick、智能提醒三级升级、SynapseBus 投递、原生弹窗），但实际体验为零感。逐条核对代码后，根因有六个：

| # | 根因 | 证据（代码位置） | 影响 |
|---|------|----------------|------|
| 1 | **LLM 通用主动性默认关闭** | `proactivity/proactivity-hub.ts:198` `PROACTIVITY_LLM_INITIATIVE` 默认 false | 通用路径（LLM 自主判断"要不要主动"）从不运行，只剩少数快路径规则。✅ 2026-09-05 已修复：默认值翻为 true（不设 env 即生效），并补预算前置短路 + 拦截负向缓存（见 §5 更新） |
| 2 | **感知依赖"已知 actor"+ 内存态，重启即失忆** | `proactivity-hub.ts:185` `knownActors` 仅在对话/事件时注入，纯内存 | 服务重启后没有任何用户是"已知的"，agent 在用户开口前永远不会主动；30min tick（`proactivity-hub.ts:134-139`）进一步拉长感知延迟 |
| 3 | **日程只有"到点即发"，没有提前量与状态语义** | `schedule-task-service.ts:190` 1s tick 只判 `nextRunAt <= now`；日程仅作为快照在 LLM 通用路径中被消费（`proactivity-hub.ts:393-397`，而该路径默认关） | 没有"会前 15 分钟提醒""错过了提醒""今天 3 件事先说哪件"——主动性最有价值的场景全部缺失 |
| 4 | **主动消息触达层级断裂** | `bootstrap/create-app-services.ts:1878-1892` 主动消息投 `agent.proactive_message`；客户端 `client/flutter_app/lib/main.dart:1354-1386` 只弹 SnackBar，而 `schedule.reminder_fired`（main.dart:948-975）才走原生 Acrylic 弹窗 | 即使 agent 主动了，用户也极容易看不见；客户端未连接（人不在电脑前）时只有 MessageHub 离线暂存，微信/飞书出站在 `message-platform-gateway.ts:76` 仅"queued locally"占位未接通 |
| 5 | **多套主动体系并存，无统一权威** | ProactivityHub / proactive-agent-center.ts / proactive-life-runtime-service.ts / anticipation-engine-service.ts / embodiment-autonomy-service.ts / morning+evening digest / intelligent-reminder 各有触发源、频控与投递路径 | 无法整体调"分寸"；互相可能重复或互相压制；"为什么发了/为什么没发"无法回答。✅ 2026-09-05 部分收敛：① legacy 出站服务（ProactiveAgentCenter / ProactiveLifeRuntime 共用的 ProactiveOutboundMessageService）改为管道薄包装，send() 组装提案转投 submitProposal（自动获得去重/离线挂起/outcome 反馈）；② 早报/晚报调度器 WS 推送失败时转管道挂起（重连直推）；③ critical 升级链接线完成。ProactionCortex 主链（分段拟人节奏 + 专用客户端事件）暂保留直发，待分段能力下沉 DeliveryService 后再收敛 |
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
| offline | **手机端应用内推送** + 离线补发 | 手机端推送（必达类），其余离线补发 | 离线补发 | 静默/合并 |

- **in_app**：现有 `agent.proactive_message` WS 事件（保留格式，加 `deliveryId` 与 `actions[]` 字段）。
- **多端互通（已实现）**：`ws-connection-registry.ts` 改为每 actor 多连接 fan-out（电脑端 + 手机端同时在线都收到）；
  `presence-service.ts` 引用计数——任一设备在线即在线，全部掉线才算 offline。**电脑端关闭但手机端在线 → 直达手机端**。
  决策：**不引入短信、不落离线信箱**——两端都离线时提案保留在待发区（`offline_wait_reconnect`），
  任一设备重连（`onConnectionChange`）即触发 `flushDue` 立即直推；投递竞态（仲裁时在线、发送时掉线）30s 后自动重试。
- **弹窗保证（已实现）**：高重要度提案 payload 带 `display:"popup"`；客户端 `agent.proactive_message` 处理器对
  high/critical 走 `DesktopNotificationLauncher` 原生弹窗，原生窗口不可用（如移动端）时降级为应用内弹窗卡片
  （`_showReminderPopupDialog`，扩展 `onUserConfirm/onUserDismiss` 回调回传 outcome）——**保证以弹窗形式展示，不用 SnackBar**。
- **移动端推送通道（已实现，离线必达升级）**：两端都不在线（或 WS 投递竞态失败）时，必达层/critical 提案
  自动升级手机系统级推送（App 被杀也能收到系统通知，通知即弹窗）。`mobile-push-service.ts` Provider 可插拔：
  `jpush`（极光 REST v3，`JPUSH_APP_KEY`+`JPUSH_MASTER_SECRET`，聚合国内厂商通道）/ `bark`（iOS，`BARK_URL`）/
  `webhook`（通用 HTTP，`MOBILE_PUSH_WEBHOOK_URL`），未配置自动禁用。设备 token 由客户端启动时上报
  （`POST /api/proactivity/push/register`，注册表 `data/proactivity/push-tokens.json`）；推送成功即出队
  （重连后不重复投递），失败 5min 退避重试；social 层永不推送。
- **离线补发**：~~MessageHub 落库~~ 已按用户决策从主动管道移除；MessageHub 仅保留其原有的消息平台会话职责。

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
| `PROACTIVITY_LLM_INITIATIVE` | false → ✅ **已默认 true**（2026-09-05 落地：控制通用路径——tick 时 InitiativeEngine 消费感知流自主决策；需接入外部模型，未配置自动回退纯规则。同时补预算耗尽前置短路、抑制/频控拦截负向缓存，LLM 调用只在真有机会时发生） | — | 通用主动性从未运行过 |
| ProactivityHub tick | 30min | 扫描类拆走后 5min（只跑问候/机会发现） | 提前量由 UpcomingScheduleWatcher 事件驱动承担，tick 降级为兜底 |
| knownActors | 内存，重启清空 | 落盘 + 启动时从 chat-threads/schedule-tasks/user_profiles 恢复 | 重启后 agent 才能自主早问好（受静默时段+预算保护） |
| 每日预算 | 6 次单一池 | **社交池 3**（用户反馈 6 太多；`PROACTIVITY_DAILY_BUDGET` 可调）+ 必达池独立 | 问候/兴趣/关怀合计每天至多两三次才像管家 |
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
5. ✅ 开启 `PROACTIVITY_LLM_INITIATIVE=1`——2026-09-05 已改为**默认开启**（不设 env 即生效，设 0 回退纯规则），配套回归测试 `test/proactivity-hub-default-on.test.ts`；灰度观察日志照旧。

**验收**：重启服务后，早晨 agent 自主发来问好+今日安排；会议前 15 分钟收到原生弹窗提醒；离开电脑时主动消息不会"静默消失"（至少有原生弹窗或离线暂存）。

### Phase 2：统一决策口
6. 提案结构 + 持久化队列；各触发源（schedule reminderHandler / digest / intelligent-reminder / care tools）改走 `submitProposal`。
7. 仲裁流水线（去重合并 / defer / bundle）+ PresenceService。
8. DeliveryService 统一出口 + deliveryId + outcome 落库。
9. 诊断接口 `GET /api/proactivity/diagnostics`。

**验收**：同类信号自动合并；对话进行中的主动消息延迟到回合结束；诊断接口能回答任意一条"为什么发/为什么没发"。

### Phase 3：离线必达
10. ~~接通 message-platform-gateway 微信/飞书出站~~ → **多端互通（已完成）**：注册表 fan-out + 在场引用计数，电脑端掉线但手机端在线时消息直达手机端；不引入短信。
11. critical 未确认 → intelligent-reminder 升级链接入仲裁层（popup→TTS→电话，判定见 §4 L3）。
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

---

## 9. 主动性系统升级：三分支执行语义与效用评估（2026-09-04）

> 方案 A-E 落地：主动行为从「发/不发」二元判定升级为
> **execute_silently / ask_first / silence** 三分支，全部决策规则确定性（零 LLM）、可测试、可反问。

### 9.1 Action Utility 评估器（方案 A，`proactivity/action-utility.ts`）

执行/投递前的统一效用评估，输入三组维度：

- **风险**：可逆性 / 金融影响（none·low·high）/ 数据敏感性（none·personal·sensitive）/ 第三方影响 → 加权合成 `riskScore`（不可逆 0.4 + 高金融 0.3 + 敏感数据 0.2 + 第三方 0.1，封顶 1）；
- **授权**：显式（用户点名）/ 隐式（长期偏好、既有配置）/ 无；
- **价值**：期望价值 − 打扰成本 − 风险拖累（`riskScore × 0.5`）= `netUtility`。

决策规则（顺序固定，先命中先出）：

1. `netUtility < 0` → **silence**（不值得做，也不值得问）
2. 不可逆 或 高金融影响 → **ask_first**
3. 无授权 且 影响第三方 → **ask_first**
4. 可逆 + 有授权 + `netUtility > 0.15` → **execute_silently**
5. 其余 → **ask_first**（保守默认）

辅助推导（生产默认，零 LLM）：`deriveRiskFromSteps`（工具名/参数模式 → 风险维度）、`deriveNotifyValue`（重要度 → 通知价值；low 净效用为负自动沉默）、`deriveActValue`（后台执行打扰成本 0.1）。

### 9.2 silenced 判定与沉默日志（方案 B）

- `ProposalVerdict` 新增 **`silenced`**：与 `suppressed` 严格区分——suppressed = 用户负反馈抑制；silenced = 效用评估后**主动选择不动作**。
- `arbiter.ts` 仲裁链**最前面**插入效用评估：声明了 `utility` 元数据的提案先过三分支（silence → silenced 出队；ask_first/execute_silently 记入 reasonChain 继续后续仲裁）。未声明 utility 的提案不评估，既有触发源行为不变。
- `proactivity/silence-log.ts`：每次沉默决策留痕（净效用/风险分/命中规则），hub（action 级）与管道（proposal 级）共用一份，落盘 `data/proactivity/silence-log.json`。诊断接口 `diagnostics().recentSilences` + `searchSilences({keyword, sinceMs, actorId})` 支持反问「你上周为什么没提醒我 XX」。

### 9.3 三分支执行语义统一（方案 C，`proactivity-hub.ts`）

act 模式行动计划统一入口 `runActPlan`（speak/advise 纯通知不走三分支，仍由抑制+频控治理）：

| 分支 | 语义 | 条件 |
|---|---|---|
| execute_silently | 直接执行不通知（act 审计留痕） | 可逆 + 已授权 + 高净效用 |
| ask_first | 暂停执行，确认请求即本次主动消息；用户回复后 `resolveConfirmation` 推进 | 不可逆 / 高金融 / 无授权涉第三方 / 低效用非负 |
| silence | 什么都不做但记录沉默日志 | 净效用为负 |

- ask_first 挂起计划有效期 10 分钟（`CONFIRMATION_TTL_MS`），过期作废不执行；
- 对话工具 `proactivity.confirmAction`（approve/reject/list）推进确认；act 黑名单安全门在确认后仍兜底（危险工具永不自动执行）；
- 对话工具 `proactivity.whySilent` 检索沉默日志，向用户解释当时的判断依据；
- 授权映射：conversation=显式，既有触发源（task/rhythm/time/.../initiative）=隐式，未知来源=无。

### 9.4 承诺驱动触发源（方案 D，`proactivity/triggers/commitment-trigger.ts`）

承诺板扫描事件（deadline 临近梯度提醒 / 超时按 escalationPolicy 升级 / 依赖满足推进）→ 带效用元数据的提案进统一管道：代催（needsAuthorization）→ 不可逆+第三方+无授权 → ask_first；自动提取承诺按置信度折算期望价值（低置信可被沉默）；手动承诺 = 显式授权。装配层 `commitmentTrigger.attach()` 接线。

### 9.5 记忆变更触发链路（方案 E，`proactivity/triggers/preference-change-trigger.ts`）

`NarrativeMemoryFacade.ingest/writeDecided` 新增 `onWrite` 钩子（fire-and-forget）→ 确定性正则检测偏好变更信号（「我现在吃素了」「以后不喝咖啡了」）→：

- **新偏好**（无冲突）：低价值提案，评估器判 silence——记忆照常学习，不打扰；
- **偏好反转**（信念偏好图联动）：与 UserFactStore 版本化主键比对，subject 归一相等（句尾助词归一）或偏好领域桶重叠（饮食/作息/运动/通勤）且值不同 → must/high 确认提案，防上一版偏好幽灵残留。同主题 24h 冷却。

**验收**：低价值推送被沉默且 `searchSilences` 可查；不可逆动作先问、同意后执行、拒绝不执行；「我现在吃素了」在既有「喜欢吃肉」偏好下触发确认；全部决策零 LLM。

### 9.6 效用评估优化轮（2026-09-04 复审）

正确性修复：
- 不可逆推导正则对齐 act 黑名单（`run_shell`/`run_automation`/`\bkill`），黑名单级工具先走 ask_first——否则静默执行被安全门拦下后无声无息；`post(?!pone)` 修复 postpone（可逆）误判；`\bkill` 不误伤 skill。
- 偏好事实库惰性共享 nightly 巩固服务的 `UserFactStore` 单例（`getNightlyMemoryTaskService().getFactStore()`），消除双实例缓存导致的反转漏检。
- 管道级 ask_first 闭环：带 `confirmAction` 的提案（如承诺代催）投递确认文案后在共享 `PendingConfirmationStore` 登记，批准经 hub resolver 回流 `onProposalApproved`（助手动态留痕）+ speak 回执；无 confirmAction 的通知类 ask_first 不登记。
- 承诺重要度映射收敛到 `commitmentProposalFromEvent` 草稿（单一事实源）。

体验优化：
- 反转精确化：同域（如饮食）还需动作动词相同（吃素 vs 吃红烧肉 → 确认；吃素 vs 喝奶茶 → 仅静默记录），消除同域误报。
- 规则 5a「不值得问」：期望价值 < 0.3 的低价值可逆动作直接 silence（问比做更打扰）；不可逆动作不受此限（危险必须问）。
- 确认执行结果 speak 反馈：成功/部分成功/全被拦截三档回执，确认闭环有始有终。
- 偏好确认冷却改按领域桶（同域换措辞同窗只确认一次）；沉默日志按 dedupKey 24h 去重。

工程质量：
- `PROACTIVITY_UTILITY_EVAL=0` 一键回退升级前语义（arbiter 跳过评估；hub act 直接执行+speak 告知）。
- `PendingConfirmationStore` 落盘 `data/proactivity/confirmations.json`，重启不丢挂起确认（步骤是纯数据，恢复后仍可执行）。
- `GET /api/proactivity/diagnostics?silenceKeyword=XX&silenceDays=7` 暴露沉默检索。

### 9.7 代催执行端闭环（2026-09-04，ask_last_mile）

「提案-仲裁-确认」决策链此前已闭环，但代催批准后的执行端是留痕 stub。现已接通真实外发：

- **CommitmentBoard** 新增 `contact` 字段（platform: wechat/qq/feishu/generic + channelId +
  participantName，commitment.create/update 工具可登记，旧库自动迁移），升级文案点名代发对象；
- **CommitmentTrigger** 代催提案的 `detail` 携带目标渠道，`sendCommitmentNudge` 执行端：
  取渠道 → `composeCommitmentNudgeText` 确定性组装（【代催】标注 + 承诺内容 + 原定时间）→
  `MessagePlatformGateway.send` 真实外发（HTTP bridge）→ `MessageHubService.createOutbound`
  会话留档 → 板上 notes 审计（delivered=yes/queued）；
- **装配层**：`onProposalApproved` 分流——代催提案走 `sendCommitmentNudge`，结果（已送达/排队/失败）
  落助手动态 + speak 回执；执行前复核承诺必须仍为 active（改期/取消/兑现即跳过）。

前提：`WECHAT_BRIDGE_SEND_URL` 等平台 bridge 环境变量已配置时消息真实送达对方；
未配置时网关降级本地排队（消息落 message-hub 会话，delivered=false，回执明确告知"排队中"）。
