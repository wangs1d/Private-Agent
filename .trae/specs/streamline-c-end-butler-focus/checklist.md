# Checklist

> 实际落地形态说明（P1）：最终为 2 个独立 env 开关（`BRAIN_EVOLUTION_ENABLED` 兼容两个旧变量、`AGENT_WORLD_SOCIAL_ENABLED`）；tech-scanner / benchmark 自评收编进 BRAIN_EVOLUTION 总开关（tasks.md Task 6 允许的分支）；DMN 模块（纯规则零 LLM 的实验组件）按项目"禁止死代码"规则整体真实删除。以下按实际形态勾选。

## P0 清理
- [x] server 根下 5 个调试残留文件（_mc.out / _mfp.out / _repro.out / _repro.out.json / _repro.ts）已删除，且全仓库无引用
- [x] server/scripts 一次性脚本已归档至 archive/（35 个），package.json / docs / README / tsconfig.scripts.json 无断链引用
- [x] flutter-app-ui 与 private-agent-ui-optimized 已归档至 docs/design-drafts/，PROJECT_MAP.md 路径说明已更新

## P1 开关化
- [x] 默认 env 启动时，EvolutionCortex / 技术扫描 / benchmark 自评 / agent-world 社交域定时器与装配均不创建，启动日志输出 [skip] 条目（EvolutionCortex、AgentWorld social domain 两处）
- [x] BRAIN_EVOLUTION_ENABLED 与 AGENT_WORLD_SOCIAL_ENABLED 两开关开启验证，行为与变更前一致；运行时 node 直跑 dist 验证通过
- [x] 旧变量 BRAIN_SELF_DRIVEN_EVOLUTION_ENABLED、AGENT_EVOLUTION_LOOP_ENABLED 设 1 时仍等效开启（向后兼容，node 验证通过）
- [x] agent-world identity/pairing 能力不受 AGENT_WORLD_SOCIAL_ENABLED 影响（filterSocialChatTools 29→4，保留 identity/pairing/room 最小集）
- [x] server/.env.example 已包含新开关说明（含收编与 DMN 删除说明）
- [x] DMN（default-mode-network.ts）已整体移除，全仓库无残留引用（含 brain-stem 注册点）

## P2 记忆收敛
- [x] 单轮 LLM 调用点审计表已输出（主对话 91.1%、proactive 5.6%、memory 写决策 2.5%，记忆旁路合计 <1%），写入 implementation-summary.md
- [x] session epitome 按 N 轮间隔触发（SESSION_EPITOME_EVERY_N_TURNS 默认 5），新会话边界兜底批量提取，跨会话待办不丢失（6 个新测试用例）
- [x] association synthesizer 确认已在 fire-and-forget 异步路径（recall 侧 void then、写入侧 45s 节流），不在用户等待路径
- [x] 记忆硬约束未回退：确定性截断、query 只用用户原文、场景门控、窗口指示词短路、STM/journal 去重（只读未动）
- [x] 审计澄清：rolling-summarizer 条件触发 ~0%、mood-inference 0.1%，实际旁路消耗远低于 2 次上限

## P3 生活域强化
- [x] fast 模式生活域关键词（支付/外卖/热搜/晨报/记账/提醒）命中正确路由（web/wallet/calendar/shopping_order 分类，含 hot_rankings 工具补入修复）
- [x] system prompt 能力清单包含生活管家能力描述（LIFE_STEWARD_SYSTEM_SUFFIX，prefix cache 友好）
- [x] 晨报聚合含天气+日程+笔记+兴趣热搜命中四源（interestHits 可选块，无命中省略）
- [x] "帮我点份麦当劳"类请求经 shopping_order 分类关键词（麦当劳/点餐/奶茶等）召回，不落入纯闲聊分支

## P4 生活管家场景扩展
- [x] 场景A：EveningDigestScheduler 晚间 digest"今日回顾+明日预告"（EVENING_DIGEST_HOUR 默认 21）+ 恶劣天气预警与当日日程合并主动提醒（weather_alert kind）
- [x] 场景B：tool.executed 事件（hook-bus）→ ConsumptionLedgerListener 自动入账（node 冒烟验证 wallet.purchase ¥35.5 → food_delivery→餐饮映射）；预算超支单次提醒；月度报告单次 LLM
- [x] 场景C：care.set/get/delete_important_date 三工具对话录入（LLM schema 已补齐接入 getBuiltinAgentChatTools）；晨报含近期重要日子块；当天提醒附祝福草稿（单次 LLM、可改写）
- [x] 场景D：epitome 待办注入 prompt 附转提醒提议；到点提醒经 onReminderFiredToProactivity 晚绑定走 proactivity speak；agent.tasks.list 任务状态可查询
- [x] 场景E：health.query 确定性统计（count/days/sum/mean/mean_daily，不编造数字）；care.rhythm_reminder 节律模板默认关闭、用户开启
- [x] 五场景主动触达经 frequency-governor 频控（weather_alert 即时/30min、life_reminder 4h、monthly_report 每日 1 次）
- [x] 用户负反馈经 proactivity.feedback 工具 + 抑制存储（suppression store）持久抑制该 kind，其余场景不受影响

## P5 验证
- [x] npm run build --workspace=server 零错误（含 agent-world）
- [x] 全量测试回归：329/327 通过（基线 284/286 → 新增 43 个全过，仅 2 个已知预存失败 conversation-rolling-summarizer，零新增失败）
- [x] 默认 env 冒烟（node 直跑 dist 纯逻辑层 5/5 PASS）：开关默认值、旧变量兼容、社交过滤、EveningDigestScheduler 生命周期、消费入账链路
- [x] token 结论：实验性子系统 stage（self_evolution/other/interest_watch）0 条，全部 28 处 setInterval 无实验子系统独立定时器；结论写入 implementation-summary.md「P5：最终验证」章节
