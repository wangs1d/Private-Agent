# C 端私人管家聚焦瘦身与差异化优化 Spec

## Why

项目定位是 **C 端私人管家 / 生活伙伴 / 助手**（解决生活问题），但当前架构沿"仿人脑 + 仿人躯体 + 多 Agent 社会世界"方向过度生长：单轮对话之外存在 DMN 空闲模拟、自进化循环、每日技术扫描、每周自我 benchmark 等大量与用户价值无关的 LLM 消耗点；记忆架构有 8+ 通道多层层级，turn 路径上 LLM 调用点分散；顶层存在多套 UI 设计稿与一次性脚本。需要一次系统性瘦身 + 聚焦，把资源集中到真正可落地、差异化的生活管家能力上。

## 现状诊断（调研结论）

### 架构全貌

* **对话主链路**：`routes/http + ws → chat-turn-runner → task-router（fast/complex 分发）→ fast 直答 / complex Plan-and-Execute（PLAN→EXECUTE→SUMMARIZE）→ prompt-builder/prompt-context-builder 组装 → external-model 调用 → stream-segmenter 分段输出`

* **记忆架构**（多通道融合，`memory-arbitrator` 统一仲裁）：短期情景网关（short-term-memory-gateway，零 embedding 词法检索）→ 会话 epitome（跨会话待办/承诺/偏好）→ rolling summarizer（LLM 增量摘要）→ human-like 图谱记忆（embedding+KV）→ agentic-memory → KV summary → 遗忘恢复 → 关联合成器（LLM 跨记忆联想）。召回已改为 Letta/MemGPT 式工具化（recall-gate），记忆注入污染问题已修复

* **自主性**：proactivity-hub（感知流→双路径决策→speak/act/advise 三模式）+ initiative-engine（LLM 自主决策）+ interest-watcher（兴趣×热搜匹配主动推送）+ frequency-governor 频控

* **工具调用**：四级分层路由 + BM25/embedding RRF 融合 + Adaptive-Top-P + 三级重排（上一 spec 已完成，P99 < 16ms），forced-tool 保证天气/搜索类强制路由

* **拟人层**：`brain/` 30+ 皮层文件（DMN、evolution、self-driven-evolution、meta-cognition、limbic、cerebellum…）与 `body/` 躯体层（ear/eye/hand/skin/vestibular/homeostasis/reflex-arc）**全部在 create-app-services.ts 真实装配**，不是死代码，但多数子系统对 C 端用户价值存疑

### 可瘦身清单（按风险分级）

| 类别               | 对象                                                                                            | 证据                                               | 处置                                      |
| ---------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------ | --------------------------------------- |
| 垃圾文件             | `server/_mc.out`、`_mfp.out`、`_repro.out`、`_repro.out.json`、`_repro.ts`                        | 调试输出残留                                           | 删除                                      |
| 一次性脚本            | `server/scripts/` 下 test-\* / verify-\* / \_dbg-\* / bench-\* / live-\* / simulate-\* 约 40+ 个 | 手工验证脚本，无 CI 引用                                   | 归档至 `server/scripts/archive/`           |
| UI 设计稿           | `flutter-app-ui/`、`private-agent-ui-optimized/`                                               | PROJECT\_MAP.md 自述"预览/草案"                        | 归档至 `docs/design-drafts/`               |
| 实验性脑区            | DMN 空闲反事实模拟、EvolutionCortex 自进化管线、每日技术扫描（external-tech-scanner）、每周 benchmark 自评               | 装配在 create-app-services.ts，仅部分有 env 开关，周期性消耗 LLM | env 总开关化，**默认关闭**                       |
| agent-world 社交经济 | world-free-market / world-music / world-social / a2a-outsourcing / community-skill-store      | 硬接线（无总开关），与私人管家场景弱相关                             | 社交域 flag 化默认关闭，仅保留 identity/pairing 最小集 |
| 记忆链路 LLM 分散      | rolling summarizer、session epitome、association synthesizer、mood inference 各自独立调用              | 每轮 turn 上多个低价值 LLM 调用点                           | 审计 + 降频/合并                              |

### 真正可落地的 C 端差异化能力（已验证真实对接）

| 能力      | 真实对接证据                                               | C 端价值  | 差异化                |
| ------- | ---------------------------------------------------- | ------ | ------------------ |
| 天气      | Open-Meteo 免费真实 API（weather-service.ts）              | 高      | 生活管家基本功            |
| 热点聚合    | 微博/百度/知乎/B站公开热榜真实抓取（hot-rankings.ts）                 | 高      | 兴趣匹配主动推送           |
| 晨间简报    | 天气+日程+笔记并行聚合（morning-briefing-service.ts）            | 高      | "管家日历"核心体验         |
| 微信支付    | api.mch.weixin.qq.com v3 真实下单+签名（payment-service.ts） | 高      | 代付/生活缴费闭环          |
| 支付宝 bot | alipay-bot-cli 真实 CLI 执行链（alipay-bot-service.ts）     | 高      | 国内 C 端稀缺能力         |
| 美团      | 美团 AI Hub REST API 真实调用（meituan-service.ts）          | 高      | 外卖/到店直达            |
| 微信/手机常驻 | wechat-claw 桥 + phone-bridge + message-bridge        | 高      | **"微信里就能用"是最大差异化** |
| 兴趣主动关怀  | interest-watcher 兴趣×热搜+指纹去重+频控                       | 中高     | 陪伴感核心              |
| 记忆连续性   | 多通道记忆+跨会话待办                                          | 高      | "记得你"的伙伴感          |
| 健康记账    | health-fitness 本地存储、finance-deep 完整账本                | 中      | 私人财务管家             |
| 桌面自动化   | desktop-visual（VLM/OCR/RPA）                          | 低（偏办公） | **降优先级**           |

**差异化定位结论**：与办公 Agent 的分野在于「生活闭环 + 常驻陪伴」——用户在微信里、手机上、每天早晚的节律中无感使用；而不是深度 RPA、多 Agent 协作、桌面自动化。

## What Changes

### P0：零风险清理

* 删除 `server/` 根下 5 个调试残留文件

* `server/scripts/` 一次性脚本归档至 `server/scripts/archive/`（保留 package.json / start-with-gateway.mjs 等仍被引用项）

* `flutter-app-ui/`、`private-agent-ui-optimized/` 归档至 `docs/design-drafts/`

### P1：实验性子系统默认关闭（立降 LLM 成本）

* **BREAKING**（仅对依赖实验特性的开发者）：新增统一 env 开关，默认关闭，不影响主链路任何功能：

  * `BRAIN_DMN_ENABLED`（默认 0）：关闭空闲反事实模拟（default-mode-network.onIdle 触发的 LLM 模拟）

  * `BRAIN_EVOLUTION_ENABLED`（默认 0）：EvolutionCortex 四子系统总开关（统一收编现有 `BRAIN_SELF_DRIVEN_EVOLUTION_ENABLED`、`AGENT_EVOLUTION_LOOP_ENABLED` 旧变量）

  * `EXTERNAL_TECH_SCANNER_ENABLED`（默认 0）：每日技术扫描 LLM 评估

  * `BENCHMARK_SELF_ASSESSMENT_ENABLED`（默认 0）：每周自评

  * `AGENT_WORLD_SOCIAL_ENABLED`（默认 0）：world-free-market / world-music / world-social / a2a-outsourcing 的路由注册与工具注入，保留 identity/pairing

* 所有开关关闭路径需优雅降级（装配跳过、无报错），开启后行为与现状一致

### P2：记忆链路 LLM 调用收敛

* 基于现有 `llm-token-audit` 输出审计单轮 turn 路径 LLM 调用点数量与用途

* 对 turn 路径上的低价值调用点降频：session epitome 提取改为每 N 轮（默认 5）或会话边界触发；association synthesizer 仅在闲时（非用户等待路径）执行

* 保持既有硬约束：召回确定性截断、query 只用用户原文、场景门控不变

### P3：C 端生活管家能力强化（可达性基础）

* fast 模式 TOOL\_CATEGORY\_MAPPINGS 强化生活域关键词召回（支付/外卖/天气/热搜/晨报/提醒/记账）

* prompt 能力清单显式呈现生活管家能力（让模型知道"我能帮你付钱、点外卖、盯热搜"）

* 晨报内容升级：天气+日程+笔记+兴趣热搜命中四源聚合（复用现有服务，不新建系统）

### P4：生活管家场景扩展（功能扩展主线，差异化核心）

设计原则：**不新建系统，把散落的真实能力编排成场景闭环**。每个场景 = 触发器（定时/事件）→ 编排（复用现有 service）→ 主动触达（proactivity-hub speak/act/advise 三模式，受 frequency-governor 频控）。

* **场景A 生活节律**：晨报（已有，P3 升级四源）+ 晚间 digest 落地"今日回顾+明日预告"（明日日程+天气预警）+ 恶劣天气/预警联动 proactivity 主动提醒（"明天暴雨，出门带伞，你 9 点还有牙医预约"）

* **场景B 消费管家闭环**：支付/外卖/记账类工具执行成功 → hook-bus 事件 → finance-deep 账本自动入账（免手动记账）→ 月度分类预算超支主动提醒 → 月度消费报告（LLM 单次总结）

* **场景C 人情关系管家**：relationship-graph + friend-service 增加"重要日子"（生日/纪念日）字段与每日扫描 → 晨报新增"近期重要日子"块 → 当天 proactivity 提醒 + 祝福语草稿（LLM 单次生成，用户可一键发送/改写）

* **场景D 管家任务闭环**：session-epitome 提取的 openLoops/commitments 与 intelligent-reminder / agent-task-store 打通——对话中的承诺经用户确认后落为定时任务 → 到点 proactivity speak 主动触发 → 若任务可由工具完成（如查账、下单提醒）则以 act/advise 模式给出执行建议

* **场景E 健康关怀**：health-fitness 数据 + 节律提醒（喝水/睡觉/运动，intelligent-reminder 承载）+ 健康数据对话问答（"我这周跑了几次步"）

全部场景受 frequency-governor 统一频控（避免打扰），用户可对任一场景说"别再提醒我这个"产生负反馈（复用记忆反馈通道）。

### P5：度量验证
- token audit 前后对比（关闭实验子系统后单 actor 每日 token 消耗降幅）
- 启动装配跳过项日志确认、全量测试回归
- 五个场景端到端验收（模拟触发器→触达链路）

## Impact

- Affected specs: `build-adaptive-tool-intelligence-system`（无冲突，本变更不动工具路由核心）
- Affected code:
  - `server/src/bootstrap/create-app-services.ts`（开关接线主战场）
  - `server/src/brain/default-mode-network.ts`、`evolution-cortex.ts`、`self-driven-evolution-cortex.ts`（开关读取）
  - `server/src/services/external-tech-scanner.ts`、`benchmark-self-assessment.ts`（开关）
  - `agent-world/` 与 `server/src/routes/http/index.ts`、`ws/connection.ts`、`skills/builtin/agent-world-identity-skills.ts`（社交域 flag 分支）
  - `server/src/services/session-epitome.ts`、`memory-association-synthesizer.ts`（降频）
  - `server/src/agent/task-router.ts`、`prompt-builder.ts`（生活域召回与能力清单）
  - 场景扩展（P4）：`services/hooks/hook-bus.ts`（工具执行事件）、`finance-deep-service.ts`（自动入账/预算）、`daily-digest-service.ts`（晚报）、`relationship-graph-service.ts` + `friend-service.ts`（重要日子）、`intelligent-reminder/` + `agent-task-store.ts`（任务闭环）、`health-fitness-service.ts`、`proactivity/`（触发器与频控）
  - `server/.env.example`（新开关文档化）
  - 删除/归档：server 根垃圾文件、scripts 一次性脚本、UI 设计稿目录

## ADDED Requirements

### Requirement: 实验性子系统默认关闭且可无损开启

系统 SHALL 为 DMN 空闲模拟、EvolutionCortex 自进化管线、每日技术扫描、每周 benchmark 自评、agent-world 社交域提供独立 env 开关，默认全部关闭；关闭时主对话链路、记忆链路、生活服务能力零功能损失；开启时行为与现状完全一致。

#### Scenario: 默认配置启动

* **WHEN** 使用默认 env（不设任何新开关）启动 server

* **THEN** DMN/自进化/技术扫描/自评定时器不创建，agent-world 仅注册 identity 能力，启动日志明确列出被跳过的子系统

#### Scenario: 显式开启

* **WHEN** 设置 `BRAIN_EVOLUTION_ENABLED=1` 等任一开关

* **THEN** 对应子系统装配并运行，行为与变更前一致

### Requirement: 单轮 LLM 调用点收敛

系统 SHALL 在默认配置下，单轮用户消息触发的非主链路 LLM 调用（摘要/提取/联想类）不超过 2 次；session epitome 提取按 N 轮间隔触发；association synthesizer 不在用户等待路径执行。

#### Scenario: 日常闲聊轮

* **WHEN** 用户发送普通闲聊消息

* **THEN** token audit 中该轮仅出现主对话 LLM 调用（+至多 1 次低频提取类调用），无滚动摘要/联想合成调用

### Requirement: 生活管家能力显式可达

系统 SHALL 保证支付、美团、天气、热搜、晨报、提醒、记账类工具在 fast 与 complex 两种模式下均可被可靠召回（关键词映射或 forced routing），且 system prompt 能力清单包含生活管家能力描述。

#### Scenario: 生活服务请求

* **WHEN** 用户说"帮我点份麦当劳"或"今天天气怎么样"

* **THEN** fast 模式直接路由到对应工具（不落入纯闲聊分支），complex 模式 PLAN 阶段候选含该工具

### Requirement: 瘦身不破坏调用链
系统 SHALL 保证所有删除/归档操作后：`npm run build --workspace=server` 通过、全量测试回归通过、无模块引用归档路径导致的编译错误。

#### Scenario: 清理后构建
- **WHEN** 执行 P0 清理后构建
- **THEN** tsc 零错误，测试全绿

### Requirement: 生活管家场景闭环（场景A 生活节律）
系统 SHALL 提供早晚双节律触达：晨报（天气+日程+笔记+兴趣热搜四源）在用户偏好时间送达；晚间 digest 汇总当日要点并预告明日日程与天气预警；恶劣天气/预警事件经 proactivity-hub 主动提醒且关联用户当日日程。

#### Scenario: 恶劣天气联动
- **WHEN** 次日天气预报出现暴雨/高温预警且用户当日有日程
- **THEN** proactivity 主动发出一条合并提醒（天气+受影响日程），而非两条割裂消息

#### Scenario: 晚间 digest
- **WHEN** 到达用户偏好的晚间时间
- **THEN** 生成"今日回顾+明日预告"并送达，内容来自当日 journal/账本/明日日程聚合

### Requirement: 消费管家闭环（场景B）
系统 SHALL 在支付/外卖/记账类工具执行成功后通过 hook-bus 发布事件，finance-deep 自动入账；月度分类预算超支时主动提醒；月度消费报告仅用单次 LLM 总结生成。

#### Scenario: 免手动记账
- **WHEN** 用户通过 agent 完成一次支付或外卖下单
- **THEN** 账本自动新增对应记录（金额/分类/时间），无需用户二次录入

#### Scenario: 预算超支提醒
- **WHEN** 某月某分类支出超过预设预算阈值
- **THEN** proactivity 主动提醒一次（受频控），并给出剩余天数建议

### Requirement: 人情关系管家（场景C）
系统 SHALL 支持关系人"重要日子"（生日/纪念日）记录与每日扫描：晨报展示近期重要日子，当天主动提醒并可生成祝福语草稿（单次 LLM，用户可改写后发送）。

#### Scenario: 生日提醒
- **WHEN** 某关系人今天生日
- **THEN** proactivity 主动提醒，附一条贴合关系与历史交往的祝福草稿，用户确认后可发送

### Requirement: 管家任务闭环（场景D）
系统 SHALL 将对话中的 openLoops/commitments（经用户确认）落为 intelligent-reminder 定时任务；到点经 proactivity speak 主动触发；任务若可由工具代执行则以 act/advise 模式给出执行建议。

#### Scenario: 对话承诺落任务
- **WHEN** 用户说"明天 9 点提醒我去取快递"并确认
- **THEN** 生成定时任务，次日 9 点 agent 主动提起；若上下文中有可执行工具则附执行建议

### Requirement: 健康关怀（场景E）
系统 SHALL 支持健康/运动数据的记录与对话问答，节律类提醒（喝水/睡觉/运动）由 intelligent-reminder 承载并受频控。

#### Scenario: 健康问答
- **WHEN** 用户问"我这周跑了几次步"
- **THEN** 从 health-fitness 数据给出确定性统计回答（不依赖 LLM 编造数字）

### Requirement: 场景触达统一频控与负反馈
系统 SHALL 让全部场景主动触达经 frequency-governor 统一频控；用户表达"别再提醒我这个"类负反馈后，同类触达被抑制（复用记忆反馈通道持久化）。

#### Scenario: 负反馈抑制
- **WHEN** 用户对某类提醒回复"别再提醒我这个"
- **THEN** 该类提醒后续不再触发，其余场景不受影响

## MODIFIED Requirements

### Requirement: agent-world 集成方式

原状：agent-world 全量硬接线（社交/集市/音乐/a2a 工具全部注入）。修改后：默认仅装配 identity/pairing 最小集（保证 server↔world 身份注册与配对功能可用），社交经济域工具与路由按 `AGENT_WORLD_SOCIAL_ENABLED` 开关注入。

## REMOVED Requirements

### Requirement: 调试残留文件

**Reason**: `server/_repro.*`、`_mc.out`、`_mfp.out` 等为一次性调试输出，无引用。
**Migration**: 直接删除，无迁移需要。
