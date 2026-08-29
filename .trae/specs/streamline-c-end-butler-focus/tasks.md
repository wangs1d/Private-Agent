# Tasks

> 实施顺序：P0 清理 → P1 开关化 → P2 记忆收敛 → P3 生活域强化 → P4 度量验证。P1 各开关相互独立可并行；P0 先行避免混淆。

## P0：零风险清理

- [x] Task 1：删除调试残留垃圾文件
  - [x] 删除 `server/_mc.out`、`server/_mfp.out`、`server/_repro.out`、`server/_repro.out.json`、`server/_repro.ts`
  - [x] Grep 确认仓库内无对这些文件的引用

- [x] Task 2：归档一次性验证脚本
  - [x] `server/scripts/` 下 test-* / verify-* / _dbg-* / bench-* / live-* / simulate-* / stress-* / mock-* / inspect-* / presence-* 移入 `server/scripts/archive/`
  - [x] 保留仍被 package.json、文档、CI 引用的脚本（start-with-gateway.mjs、funasr_server.py 等）
  - [x] Grep package.json / docs / README 确认无断链引用

- [x] Task 3：归档 UI 设计稿目录
  - [x] `flutter-app-ui/`、`private-agent-ui-optimized/` 移入 `docs/design-drafts/`
  - [x] 更新 `docs/PROJECT_MAP.md` 中对应条目的路径说明

## P1：实验性子系统默认关闭（可并行）

- [x] Task 4：DMN 空闲模拟开关
  - [x] `default-mode-network.ts` / `create-app-services.ts` 增加 `BRAIN_DMN_ENABLED`（默认 0）：关闭时 brain-stem 不注册 DMN、不触发 onIdle 模拟
  - [x] 开启时行为不变；关闭路径启动无报错

- [x] Task 5：EvolutionCortex 自进化总开关
  - [x] 增加 `BRAIN_EVOLUTION_ENABLED`（默认 0）作为 EvolutionCortex 四子系统（自学习/技能生成/晋升管道/进化循环）总开关
  - [x] 收编旧变量：`BRAIN_SELF_DRIVEN_EVOLUTION_ENABLED`、`AGENT_EVOLUTION_LOOP_ENABLED` 语义并入（设置旧变量=开启仍有效，避免破坏既有部署）
  - [x] 关闭时跳过装配与定时器（每日技术扫描、每周 benchmark 自评的定时器创建点一并受控）

- [x] Task 6：技术扫描与自评开关
  - [x] `EXTERNAL_TECH_SCANNER_ENABLED`（默认 0）：external-tech-scanner 每日扫描 + LLM 评估定时器
  - [x] `BENCHMARK_SELF_ASSESSMENT_ENABLED`（默认 0）：benchmark-self-assessment 每周自评定时器
  - [x] 或确认两者已被 Task 5 总开关覆盖，则仅需在装配处挂接同一开关并在 env.example 说明

- [x] Task 7：agent-world 社交域开关
  - [x] `AGENT_WORLD_SOCIAL_ENABLED`（默认 0）：关闭时 world-free-market / world-music / world-social / a2a-outsourcing / community-skill-store 的路由注册与 chat 工具注入跳过
  - [x] 保留 identity/pairing/registration 最小集（agent-world-identity-skills 等身份能力不受开关影响）
  - [x] `ws/connection.ts`、`routes/http/index.ts`、`openai-compatible-tool-loop.ts` 中 AGENT_WORLD_CHAT_TOOLS 注入点按开关分支
  - [x] 开启后全部恢复，回归现状

- [x] Task 8：env.example 文档化 + 启动日志
  - [x] `server/.env.example` 增加五个新开关注释（默认值、作用、旧变量兼容说明）
  - [x] 启动时对被跳过的子系统输出一行 `[skip] xxx disabled by ENV` 日志

## P2：记忆链路 LLM 调用收敛

- [x] Task 9：单轮 LLM 调用审计
  - [x] 梳理 turn 路径全部 LLM 调用点（主对话 / rolling summarizer / session epitome / association synthesizer / mood inference / initiative engine），列出触发条件表
  - [x] 用 `llm-token-audit` 数据（data/llm-token-audit.ndjson）统计各调用点占比，输出审计结论（写入 spec 目录 implementation-summary.md）

- [x] Task 10：低价值调用点降频
  - [x] session epitome：从每轮提取改为每 N 轮（env `SESSION_EPITOME_EVERY_N_TURNS`，默认 5）或会话边界（结束/超时）触发；会话最后一轮兜底提取，保证待办不丢
  - [x] association synthesizer：确认/改造为非用户等待路径执行（setImmediate / 后台队列），不在 recall 同步链上
  - [x] 既有硬约束不回退：确定性截断、query 只用原文、场景门控、窗口指示词短路

## P3：C 端生活管家能力强化

- [x] Task 11：生活域工具召回强化
  - [x] fast 模式 TOOL_CATEGORY_MAPPINGS 增加/核对生活域关键词：支付（付钱/买单/代付/缴费）、外卖（点餐/麦当劳/外卖/美团）、热搜（热搜/热点/榜）、晨报（简报/早报/早安）、记账（花了/记账/账单）、提醒（提醒我/别忘了）
  - [x] forced routing 核对：天气、搜索已强制，评估支付/外卖类是否需要同等强制或仅关键词映射（有副作用工具不强推，遵循只读 TTL 约束的精神）

- [x] Task 12：prompt 能力清单与晨报升级
  - [x] system prompt 能力清单显式列出生活管家能力（可付钱、可点外卖、可盯热搜、早晚简报），让模型主动提议而非等用户点名
  - [x] morning-briefing 聚合升级：天气+日程+笔记+当日兴趣热搜命中（复用 interest-watcher / hot-rankings 现有服务），不新建系统

## P4：生活管家场景扩展（功能扩展主线）

- [x] Task 15：场景A 生活节律（早晚双触达 + 天气预警联动）
  - [x] 晚间 digest：daily-digest-service 升级"今日回顾+明日预告"（当日 journal/账本要点 + 明日日程 + 次日天气预警），接入 briefing-delivery 送达链路
  - [x] 恶劣天气预警联动：weather 定时检查（或晨报生成时附带）→ 有预警且当日有日程时经 proactivity-hub 发一条合并提醒
  - [x] 触达均走 frequency-governor 频控

- [x] Task 16：场景B 消费管家闭环（自动入账 + 预算提醒）
  - [x] hook-bus 增加工具执行成功事件（payment/meituan/记账类工具名匹配）
  - [x] 事件消费者调 finance-deep 自动入账（金额/分类/来源工具/时间）
  - [x] 月度分类预算超支检测（记账时或每日扫描）→ proactivity 单次提醒
  - [x] 月度消费报告：单次 LLM 总结（确定性数据拼接为输入，避免编造）

- [x] Task 17：场景C 人情关系管家（重要日子）
  - [x] relationship-graph / friend-service 增加 importantDays 字段（生日/纪念日）+ 录入对话路径（"记一下小张生日 3 月 5 号"）
  - [x] 每日扫描（挂 morning-briefing 调度）：晨报新增"近期重要日子"块；当天命中 → proactivity 提醒
  - [x] 祝福语草稿：单次 LLM 生成（输入：关系标签+交往历史摘要），用户可改写后发送

- [x] Task 18：场景D 管家任务闭环（对话承诺 → 定时任务 → 主动触发）
  - [x] session-epitome 提取的 openLoops/commitments 在对话中经用户确认后写入 intelligent-reminder（确认话术由主对话 LLM 承担，不新增调用）
  - [x] 提醒到点 → proactivity speak 主动提起；上下文含可执行工具时附 act/advise 建议
  - [x] 与 agent-task-store 打通：任务状态可查询（"我还有什么待办"）

- [x] Task 19：场景E 健康关怀
  - [x] health-fitness 数据问答工具化（"这周跑了几次步"→ 确定性统计，不走 LLM 编造）
  - [x] 节律提醒（喝水/睡觉/运动）配置模板，intelligent-reminder 承载，默认关闭、用户主动开启

- [x] Task 20：场景触达统一频控与负反馈
  - [x] 五个场景的主动触达全部注册到 frequency-governor（kind 维度区分，冷却时间默认：预警类即时、提醒类 4h、报告类每日 1 次）
  - [x] 负反馈通道：用户说"别再提醒我这个"→ 主对话识别 → 持久化抑制该 kind（复用记忆反馈通道），其余场景不受影响

## P5：度量验证

- [x] Task 13：构建与测试回归
  - [x] `npm run build --workspace=server` 零错误（含 agent-world workspace）
  - [x] 全量测试回归通过（对齐基线 284/286，既有 2 个 conversation-rolling-summarizer 失败不算新增）
  - [x] 默认 env 启动 server 冒烟：主对话、天气工具调用、记忆召回、晨报接口正常
  - [x] 五个场景端到端验收：模拟触发（定时/事件）→ 编排 → proactivity 触达全链路可观察

- [x] Task 14：token 前后对比
  - [x] 默认配置下跑 `test-memory-50rounds` 类负载（或等价对话脚本），对比 data/llm-token-audit.ndjson 中周期性子系统调用消失情况
  - [x] 结论（token 降幅、跳过的子系统清单）写入 spec 目录 implementation-summary.md

# Task Dependencies

- Task 4/5/6/7 相互独立，可并行
- Task 8 依赖 Task 4-7 完成后统一文档化
- Task 9 先于 Task 10（审计结论决定降频对象）
- Task 11/12 独立于 P1/P2，可并行
- Task 15-20 相互独立可并行，但统一依赖 Task 20 的频控框架先行搭好（或与各场景同步开发）
- Task 13/14 依赖全部前置任务
