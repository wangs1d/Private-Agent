# 代办足迹（Agent Activity Ledger）定位与架构

> 2026-09-16 明确。代码权威注释见 `server/src/proactivity/activity-store.ts` 头部，
> 本文档是产品/架构层面的定位说明。

## 一句话定位

**代办足迹是 Agent 的可回溯代办账本**——回答"Agent 替我办的事办得怎么样了"和
"Agent 替我盯到了什么"，不承担通知的实时触达职责。

## 是什么 / 不是什么

| 边界 | 说明 |
| --- | --- |
| ✅ 是：执行类条目的账本 | Agent 真正替用户办的事（订牛奶/缴水电费/改日程/代发消息），含进行中状态（下单待配送…） |
| ✅ 是：告知类条目的回执 | Agent 盯梢到的信号（日程变动等）在主动告知用户之后留下的「已告知」记录 |
| ❌ 不是：通知流 | 主动消息的**实时触达**走对话流（proactive_pipeline fan-out 弹窗/系统推送），足迹只做事后可回溯 |
| ❌ 不是：任务清单 | 待办/日程的管理走 schedule/goal-board 体系；足迹是"已完成/进行中的代办结果"，不是"计划要做的事" |

## 两类条目与状态语义

| 条目类型 | 写入方 | status | statusLabel | 例子 |
| --- | --- | --- | --- | --- |
| **执行类** | `activity.report` LLM 工具 / `POST /agent/activities` | `pending`→`done`/`failed` | 配送中/已完成/未办成 | 「已为你订购牛奶」 |
| **告知类** | `ProactiveDeliveryService` 投递成功后自动落库（`action.*` 提案） | `changed` | **已告知**（固定） | 「发现日程变动：评审会延迟到4点」 |

「盯到 → 办完」弧线：盯梢信号告知用户（告知类条目落库）→ 用户在对话中确认
「帮我改一下」→ Agent 执行后调 `activity.report` → 执行类条目落库。两条共同
构成完整的代办叙事；**告知类条目永远不伪装成"已办完"**。

## 全链路（写入侧）

```
执行类：
  对话中 Agent 办完代办 → activity.report 工具 ─┐
                                              ├→ AgentActivityStore.record()
告知类：                                        │     ├─ persist（data/proactivity/activities.json）
  消息桥入站 → MessageHubService.ingestInbound │     └─ onRecord → WS agent.activity_new（实时刷新）
    → MessageWatchTrigger（零 LLM 规则识别）    │
    → ProactivePipeline 仲裁 → 投递成功        ─┘
        （投递失败不落库——提案挂起重投，送达才算"已告知"）
```

## 全链路（读取侧）

```
客户端右侧面板「代办足迹」卡（唯一展示面）
  ├─ 挂载拉取  GET /agent/activities?actorId=&limit=20
  ├─ 实时刷新  WS agent.activity_new → AgentActivityBus → 立即重拉（轮询 1min 仅兜底）
  └─ 已读      POST /agent/activities/read（点开详情/打开全量列表时）
```

## actorId 归一规则（P1 修复 2026-09-16）

- 触达（WS 设备 fan-out、离线推送）与足迹台账一律按**基础 actor**（裸 id，
  如 `session-mvp-001`）归属；设备绑定与客户端查询用的都是裸 id。
- 渠道隔离会话（`actorId@wechat`，见 `master-chat-session.ts`）只隔离对话
  线程/记忆；`MessageWatchTrigger` 在提交提案前用 `resolveBaseActorId()` 剥回。
- 修复前后果：桥接无显式绑定时提案投到不存在的 `xxx@wechat` 设备（永不送达、
  永不落库），即便落库客户端也查不到。

## 已知边界（有意不做）

- **告知类不做确认闭环的强约束**：`directText` 会问"要我帮你改日程吗？"，但
  系统不假设用户一定回复；真正的代办动作由 Agent 在对话流里完成并经
  `activity.report` 留痕——不在足迹层重复造确认协议。
- **单实例语义**：台账是单 JSON 文件原子替换，无跨进程合并；多实例部署需要
  先改造存储层。
- **每 actor 200 条上限 + 24h dedupKey 窗口**：重连重投不会刷屏，超量裁剪最旧的。
