# Fast-Complex 判定与交接架构优化设计（高保真）

> 目标：保留「快慢双轨 = 类人分工」的总体形态，把优化落在两个环节——**判定**（fast 单次判定难度，并产出要交给 complex 的任务规范）与**交接**（complex 单次收敛跑完，结果交回 fast 口语化说）。同时解决真实对话中工具召回出错/卡住，并减少冗余 LLM 调用与 token 消耗。
>
> 本文档为设计蓝图，所有引用签名来自真实代码（带文件路径）。

---

## 1. 背景与定位澄清

### 1.1 类人双轨 = 职责分工，不是简单快慢

节点型沟通方式接近人类分工，应保留：

| 角色 | 职责 | 对应现实现象 |
|---|---|---|
| **fast（说）** | 即时回应、寒暄、口语化表达、（高置信简单问题的）一次作答 | "我先应你一句" |
| **complex（办）** | 检索、调用工具/skill/MCP、多步任务，产出**结果** | "我去查/去办，办完回来告诉你" |

关键判断：**不必每轮都让 complex 和 fast 各自完整跑一遍再句级去重**。只有 fast 判出需要 external 能力的任务，才并行 complex；把"complex 该干什么"在 fast 就讲清楚，complex 收敛跑一次即可。

### 1.2 现状的四类问题（真实根因）

1. **判定缺「难度」环节**：路由靠纯正则启发式（[task-router.ts#L211](file:///e:/ws-project/Private-Agent/server/src/agent/task-router.ts#L211) `routeLlmExecution`），fast 拿到"需外部信息"类请求仍先凭印象作答，再靠 [needsExternalInfoUpgrade](file:///e:/ws-project/Private-Agent/server/src/services/agent-core.ts#L1504) 事后升级——**fast 那轮 token 白烧**。
2. **complex 讲任务不明确**：`startParallelLiveComplex` 把**用户原始文本**直接丢给 `orchestrateTask`（[agent-core.ts#L1420](file:///e:/ws-project/Private-Agent/server/src/services/agent-core.ts#L1420)），complex 需自行重判目标 → 进 loop 易空转/重发 prompt。
3. **工具召回依赖外部线，易错易卡**：延迟召回走 `tool_discover` + Python stdio worker / FastAPI（[tool-router-adapter.ts#L166](file:///e:/ws-project/Private-Agent/server/src/tools/tool-search/tool-router-adapter.ts#L166)`ensureWorker`），Python runtime 缺失、worker 生命周期异常都会让 await 卡死或抛错；`resolveChatToolPlanForStream` 里 Fast 也经常没走到小工具集短路，套用 Complex 重型合并链（[resolve-chat-tools.ts#L339](file:///e:/ws-project/Private-Agent/server/src/external-model/resolve-chat-tools.ts#L339)）。
4. **token 冗余**：每条并行 turn 至少 fast+complex 两次主 LLM + 可能的 loop 多轮 + `tool_discover` 往返 + 能力清单重复注入。

---

## 2. 设计原则

1. **单 commit 决策**：每轮 turn 在决策层定死走哪条路，不在运行中途反复升级/降级。
2. **fast 一次性判定 + 产出交接规范**：不新增独立"难度分类器"LLM 调用，难度判定搭 fast 同一次回复的便车，附一份隐藏的结构化字段。
3. **complex 单次收敛**：complex 拿到**封闭的任务规范**（目标 + 期望产出 + 约束 + 工具提示 + budget），一次执行、一次总结，避免开放 loop 空转。
4. **职责切分**：complex 只"办"出事实/结构化结果，fast 只"说"（口语化续接，保留句级去重防复读）。
5. **工具召回进程内化**：单一进程内工具索引为默认召回，外部 tool-router 仅作可选 rerank，**加超时 + 静默跳过，永不阻塞**。
6. **渐进可回退**：每阶段 feature flag 挂 agent-core 后，开关回旧路径。

---

## 3. 目标总体架构

```
用户消息 text
   │
   ▼
① 轻量规则预判 (零成本，现有 routeLlmExecution 保留)
   ├─ 强信号命中(桌面自动化/电话/订阅下单等) → 直接 committed complex
   └─ 其余 → fast lane
   │
   ▼
② fast 单次运行 (streamCompletion，fast 模型)
   · 回复正文（垫词/即时回应）
   · 隐藏结构化字段 FastVerdict：
       { need_complex: bool
         , difficulty: "simple"|"needs_external"|"multi_step"
         , task_spec?: { goal, expected_output, constraints, tool_hints, budget } }
   · 正文流式推给用户；FastVerdict 剥离不推
   │
   │ need_complex && task_spec ?
   ▼
③ 并行 complex（orchestrateTask，complex 模型）
   · 输入 = fast.task_spec（封闭规范），不是原始用户文本
   · 单次执行 + 单次总结收敛
   · 外部队列工具召回：进程内索引优先 + 超时兜底
   │
   ▼
④ 交接回 fast（synthesizeFastContinuation）
   · 句级去重 → 口语化续接 → 追加进对话（沿用现有防线）
```

---

## 4. 关键机制一：fast 单次判定 + 交接规范（FastVerdict）

### 4.1 现状
- 判定分散：正则启发式（task-router）+ 事后 `needsExternalInfoUpgrade`。
- complex 收到原始用户文本，无任务规范。

### 4.2 设计

在 fast 的回复 prompt 中要求其同时产出一个**隐藏结构化块** `FastVerdict`，格式 JSON，置于回复末尾、由特殊标记包裹（如 `<<<verdict:...>>>`），服务端流式解析取出后剥离，**不推给用户**：

```json
{
  "need_complex": true,
  "difficulty": "needs_external",
  "task_spec": {
    "goal": "查询2026年奥斯卡最佳影片及导演",
    "expected_output": "影片名+导演+一句话获奖说明，事实为准",
    "constraints": "无",
    "tool_hints": ["web.search"],
    "budget": { "max_tool_rounds": 2, "max_llm_calls": 3 }
  }
}
```

要点：
- **零额外 LLM 调用**：难度判定搭快车道同一次回复的便车，同一轮 token 完成"判定 + 垫词 + 交接规范"三件事。
- **解析失败即视为 need_complex=false**，回退现有 fast 路径，不阻塞。
- 判定优先级：`difficulty ∈ {simple → 全答收工；needs_external/multi_step → 并行 complex}`，取代现有事后升级的尴尬。

落地映射：
- 解析器：`agent-core.handleUserMessage` 内、`parallelLiveRaw` 触发放置处（约 [agent-core.ts#L910](file:///e:/ws-project/Private-Agent/server/src/services/agent-core.ts#L910)）之前，新增 `parseFastVerdict(replyText)`。
- `isFastMode`（[agent-core.ts#L1393](file:///e:/ws-project/Private-Agent/server/src/services/agent-core.ts#L1393)）判定后新增决策钩子，复用 `startParallelLiveComplex` 入口但改传 `task_spec`。

---

## 5. 关键机制二：complex 单次收敛

### 5.1 现状
- complex 经 `orchestrateTask` 进 [loop-orchestrator](file:///e:/ws-project/Private-Agent/server/src/agent/loop/loop-orchestrator.ts#L83)，React/PlanExecute 按 maxRounds 循环，易多轮 LLM + 重发 prompt。

### 5.2 设计
给 complex 一个**封闭任务规范** `task_spec`，并设置**硬收敛预算**：
- 单次执行：只按 `expected_output` 完成目标，工具执行成功即进入总结；不再让 LLM 开放式重判目标。
- `budget.max_tool_rounds / max_llm_calls` 用于在有界轮数内收敛；未完成也返回部分结果 + `status:"partial"`，交给 fast 如实转述，**绝不无限循环**。
- 工具检索用进程内索引取 schema 于工具**真正被调用时**（lazy），避免 big 清单 + `tool_discover` 双重体积。

落地映射：
- `startParallelLiveComplex`（[agent-core.ts#L1420](file:///e:/ws-project/Private-Agent/server/src/services/agent-core.ts#L1420)）改把 `fast.task_spec` 作为 `orchestrateTask` 的输入。
- loop budget 读取 `task_spec.budget`，在 [loop-orchestrator.ts#L83](file:///e:/ws-project/Private-Agent/server/src/agent/loop/loop-orchestrator.ts#L83) 入口绑定。

---

## 6. 关键机制三：交接（complex 结果 → fast 口语化续接）

沿用并收敛现有实现，不再改动去重算法：
- [synthesizeFastContinuation](file:///e:/ws-project/Private-Agent/server/src/services/agent-core.ts#L1553)：先 `stripSentencesAlreadySaid` 句级去重 → fast 用口语自然续接，不机械报"后台研究结果"。
- [completeParallelLiveContinuation](file:///e:/ws-project/Private-Agent/server/src/services/agent-core.ts#L1445)：写入 thread + 二次流式防线。
- 新增：把 `task_spec.expected_output` 一并交给续接，让 fast 只补"结果向"表述，避免复述任务过程；`status:"partial"` 时 fast 如实说明已完成/未完成部分。

---

## 7. 工具召回：进程内化 + 外部兜底

针对"召回出错/卡住"，两条线：

**A. 默认 = 进程内工具索引（零外部依赖）**
- 启动时用现有 capability-modules / skills / mcp 建**单一工具清单索引**（BM25 + 分类映射，microsecond 级，复用 `selectRelevantTools` 已逻辑）。
- Fast：内联只暴露 top 相关工具（已有策略），需要更多时用进程内检索，**不走 tool_discover 往返**。
- Complex：确定性检索候选 → 取 schema，无额外 LLM 往返。

**B. 外部 tool-router 仅作可选 rerank，且永不阻塞**
- 调用统一加**超时**（如 150ms）+ 失败即跳过，返回进程内结果。
- 修正 `ensureWorker` 无超时的卡死路径（[tool-router-adapter.ts#L166](file:///e:/ws-project/Private-Agent/server/src/tools/tool-search/tool-router-adapter.ts#L166)）。

---

## 8. Token 与响应优化点

| 现状 | 优化后 |
|---|---|
| fast 凭印象作答 + 事后升级 complex（两轮主 LLM 浪费） | fast 单次判定便附带交接规范，需外部即尽早 commit complex |
| complex 拿到原始文本自行重判目标，loop 多轮 | complex 拿封闭 `task_spec`，有界收敛，单次总结 |
| 能力清单/工具 schema 大体积 + `tool_discover` 往返 | 进程内检索 + schema 按需（lazy）取 |
| 每次并行都是 fast+complex 双主 LLM | 快车道判 `simple` 时不再启动 complex，省一整套主 LLM |

---

## 9. 落地阶段与回退

全阶段挂在 `agent-core.handleUserMessage`，feature flag 逐段开启：

- **阶段 1**：FastVerdict 结构化判定 + 解析器（新函数，默认关闭，开启后替换 `needsExternalInfoUpgrade` 局部）。
- **阶段 2**：complex 输入改 `task_spec` + loop budget 收敛（默认复用旧输入，开关切换）。
- **阶段 3**：工具召回进程内化 + 外部超时兜底（默认保留外部，逐步切进程内优先）。

每阶段提供对应测试：`test-fast-complex-handoff.ts` 扩展用例（FastVerdict 解析成功/失败回退、task_spec 传递、单次收敛、partial 交接）。

---

## 10. 风险与对策

| 风险 | 对策 |
|---|---|
| FastVerdict 解析不稳定导致误判 | 解析失败默认 need_complex=false；高副作用意图（下单/支付/执行）仍走现有显式拦截，不进 fast 判定 |
| complex 单次收敛结果不完整 | `status:"partial"` 如实回 fast 转述；budget 内可多一轮但设上限 |
| 进程内索引召回精度下降 | 阶段 3 保留外部 rerank 开关，A/B 观察后决定默认 |
| 判定回归（简单问题被误判 complex） | 用 `difficulty:"simple"`+预算侧漏判定 + 最小成本测试集监控 |