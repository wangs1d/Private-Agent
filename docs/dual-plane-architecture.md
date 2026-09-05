# 双面架构（Dual-Plane Architecture）— 2026-09-05 重构

## 一句话

路由不再回答"走哪个脑"，只回答"这轮的执行计划"（plane/capabilities/budget/tier）；
对话面零工具直答，任务面独占 tool router 并以 plan-and-execute 为唯一引擎，
两平面通过 TaskHub 衔接。

## 取代了什么

| 旧机制（已删除） | 问题 | 新机制 |
|---|---|---|
| fast/complex 二值车道 | fast=轻工具世界、complex=全量工具世界+独立线程，判错=静默失败 | 对话面(chat)/任务面(task)，任务面永远有全量工具 |
| cognize 词法路由覆盖 route.mode（P0 bug） | 路由层判 task 后被 rule-router 覆盖回 fast，任务面工具永不启用 | 执行模式只由路由决策决定，cognize.route 仅诊断 |
| fastLane 轻量工具子集 + escalate 哨兵 + 整轮重放 | 升级=删线程重跑（双倍延迟/token、人格断裂） | 出口自检 TurnOutcomeGate：轨迹内换路续波一次，预算耗尽如实收尾 |
| ReactLoopStrategy / LoopOrchestrator / DefaultEscalation | 每轮 LLM 进展评估烧 token；react 绕过规划 | 唯一引擎=工具循环（波内一次性规划+并行工具）；显式 plan 调用仅 AGENT_PLAN_EXECUTE_LOOP=1 时叠加 |
| task-router 15 张词表满天飞 | L0/veto 同轮最多算 3 遍词法 | 词法每轮 1 次；词表收缩为高精度短路+硬底线（只能升不能降） |

## 路由设计（根源化：零话题词表）

**原则：不再用话题关键词（价格/天气/新闻/媒体/时效…）预判"需不需要工具"。**
话题词表是打地鼠——每种新表达都要补词，漏补即静默失败。正确性改由三层共同保证：

1. **L0 高精度闲聊短路**（`task-router.isHighPrecisionChatText`）：只认锚定全文
   匹配的寒暄/口头禅（在吗/哈哈/好的/晚安…）。这类句子**结构上**不可能携带
   工具诉求，可安全零 LLM 成本直答。刻意不做长度+否定词的组合猜测。
2. **L1 语义意图分类**（唯一决策者）：一次小模型调用输出 `{intent, confidence}`，
   语义理解天然泛化到未出现过的表达（"比特币多少钱"无需价格词表）。
   路由 prompt 注入 TaskHub 活跃任务摘要 + 最近对话，短追问按话题语义挂接。
3. **纠错在执行出口，不在路由**：路由不需要一次判对——
   - 任务面：TurnOutcomeGate 事实核查（尝试过实质工具但零成功 → 换路续波一次；
     零尝试 + 道歉式风格 → 续波一次；预算耗尽如实收尾）；
   - 对话面：knowledge_qa 直答为道歉式 → 就地转任务面重跑。

**降级保守原则**：语义分类失败/超时/不可解析时，高精度闲聊之外一律落任务面
（错放对话面 = 零工具静默失败；错放任务面只是慢一点、预算封顶）。

## 路由表（intent-router.ts，唯一权威）

## 执行面

- 任务提交 = `launchComplexBackgroundTask` → TaskHub 登记（taskId/replyAnchorId/进度）→
  plan-and-execute（one-shot 引擎，波数 = TurnPlan.budget，封顶 4）。
- 结果即回复：任务完成 → 结果文本经 onAssistantDelta 流式回灌，作为本轮正式回复落库。
- 前台持续对话：任务不继承外层 signal；用户中途发新消息走新 turn，互不阻塞。
- "已开始"状态行在提交瞬间发出，盖住路由+装配+首次规划的无反馈窗口。
- 对话面误判的最后防线：直答为道歉式 ∧ 词法有信息/媒体诉求 → 就地转任务面重跑（极少触发）。

## Token 效率（相对旧架构的削减点）

1. 对话面 prompt 零工具 schema（旧 fast 车道每轮 ~30 个工具定义）。
2. 路由每轮恰好 1 次词法 + ≤1 次 L1 调用（缓存 5 分钟，同轮 WS/agent-core 复用）。
3. 删除 LoopOrchestrator 每轮 LLM 进展评估（replan 由 NEED_MORE_TOOLS 探测承担）。
4. 升级重放（整轮双倍 token）→ 换路续波（最多 +1 波）。
5. 轻预算任务（realtime/media）用 Flash 档模型，仅 write/multi-step 上 Pro。
6. 任务面波预算由 TurnPlan 决定（2/3），不再一律 4。

## 关键文件

- `agent/intent-router.ts` — 路由表（plane/capabilities/budget/tier）
- `agent/llm-task-router.ts` — L0/L1/L2 唯一决策入口
- `agent/task-router.ts` — 词法层 + RouteDecision（planFieldsForMode）
- `task-plane/task-hub.ts` — 任务记录/进度摘要/会话活跃任务（接缝）
- `services/agent-core.ts` — 对话面零工具分支 + 任务面单一引擎 + P0 修复点
- `external-model/openai-compatible-tool-loop.ts` — 统一出口自检（outcomeGateEnforced）
- `external-model/resolve-chat-tools.ts` — profile="none" 绝对零工具（含桌面 pin 豁免）

## 回归测试

- `test/turn-plane-routing.test.ts` — 黄金句：工具轮必落任务面、闲聊轮零成本、
  词法兜底、短追问继承、路由计费上限、档位分配
- `test/task-hub.test.ts` — 任务生命周期/摘要/会话隔离
- `test/turn-plane-token-efficiency.test.ts` — 零工具契约/自检不空转/预算封顶
- `test/tool-loop-exit-arbiter.test.ts` — 出口自检续波/预算保留/哨兵退役
- `test/intent-router.test.ts` / `test/llm-task-router-veto.test.ts` / `test/task-router.test.ts`
