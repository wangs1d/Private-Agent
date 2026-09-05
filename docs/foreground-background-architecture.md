# 前后台架构（2026-09-05）

> 取代 fast/complex 双脑与对话面/任务面双面两代架构。核心契约：**前台纯对话、后台真办事、判错由出口兜底**——路由不需要一次判对。

## 总览

```
用户消息 ──► 前台（每轮恒 1 次 LLM，Flash，上下文零工具 schema）
              │  寒暄/观点/知识问答 → 直答
              │  要办事 → 回复文本内嵌 [dispatch:{"goal":"..."}] 标签
              │     （ack 与标签同体输出，服务端剥标签后送后台）
              ▼
        TaskHub 登记（毫秒级，前台不阻塞）→ 后台双通道执行
              │
              ├─ 快速通道（默认起步）：可见集 = 桥工具（tool_discover/tool_call），
              │   业务工具全部经 tool router（BM25 目录）按需召回并执行；
              │   上下文零业务 schema；Flash 档。适合看位置/搜照片/搜 web 等单点查证
              │
              ├─ 完整通道（升级路径）：快速通道产出道歉式/空 → planner（紧凑目录，
              │   零 schema）点名工具 → explicit 白名单注入计划工具 schema →
              │   预算波 plan-and-execute；Pro 档。适合多步/桌面/深度任务
              │
              └─ 兜底：planner 失败/为空 → delegate 能力束注入（保守路径不变）
              ▼
        完成后：结果以新 messageId 直推 wsRegistry（独立气泡，绕过 turn 的
        isStale 门控）+ 交换以「[后台任务]」标记显式并入对话 thread
```

## 关键机制

### 前台：[dispatch:...] 结构化标签（`src/agent/dispatch-tag.ts`）

- 前台 1 次 LLM 调用完成「回复 + 派发」：ack 文本与标签同体输出，取代工具调用的第二轮（结果回灌）。
- 服务端流式逐块剥离标签（`DispatchTagStreamFilter`，跨 chunk 截断的标签头 hold），用户可见文本零标签残留；`parseDispatchTags` 从完整文本解析派发请求（单轮上限 3）。
- 两种标签形态：`[dispatch:{"goal":"...","note":"..."}]`（推荐）与 `[dispatch:纯文本goal]`（容错）。

### 出口诚实闸（`src/agent/commitment-gate.ts`）

前台回复含「已办妥/这就去办」类承诺、但本轮无派发标签也无工具动作 → 自动用用户原句补派后台。这是「承诺-动作一致性」校验（话题无关），同时兜住模型空口承诺与标签格式失败——取代旧 L0.5 入口词法网。

### 后台：先轻后重的双通道（`agent-core.runStandardLlmPath`）

- 快速通道（`toolRecallOnly`）：`chatToolsBuiltin=[]` + 全量目录进 `chatToolsExtra`，`prepareToolsWithToolSearch` 自动把全量工具视为 deferred 并注入桥工具——模型 `tool_discover` 召回 → `tool_call` 执行，零业务 schema 注入。Flash 档、缓冲执行。
- 升级判定在派发方（`dispatchBackgroundTask`）：结果为道歉式/空 → 再跑一次完整通道（planner + Pro + 预算波，流式）。
- 完整通道 planner 只看紧凑目录（工具名 + 80 字描述，零 schema，`planTaskTools`）；执行以 `explicit` profile 注入计划工具 schema + 桥工具，全量工具集仅作 BM25 语料。

### 前后台接缝（`src/task-plane/task-hub.ts`）

TaskHub 是唯一接缝：任务状态机（running→done/failed）+ `activeSummary` 回灌下一轮前台上下文（"怎么样了"零 LLM 直答）+ replyAnchorId 归属。后台执行 ephemeral（不重复写 user 消息进 thread），完成后显式 `appendThreadTurn`。

## 调用与注入账

| 场景 | 前台 | 后台 | 合计 LLM 调用 |
|---|---|---|---|
| 闲聊/知识问答 | 1（零 schema） | 0 | 1 |
| 快查（价格/照片/位置） | 1（含标签） | 1（召回执行，Flash） | 2 |
| 复杂任务 | 1 | 1（升级探底）+ planner + N 波（Pro） | 2+N+1 |

## 开关与回退

| 环境变量 | 默认 | 作用 |
|---|---|---|
| `AGENT_FOREGROUND_DISPATCH` | 开 | `=0` 回退独立路由 LLM 判定（routeTurnByLlm，遗留灰度） |
| `AGENT_TASK_TOOL_PLANNER` | 开 | `=0` 完整通道跳过 planner，走 delegate 能力束注入 |

`task.dispatch` 工具（`src/tools/task-dispatch-tool.ts`）仍在 registry 注册，作为标签协议的备用原语（可被显式 pin 使用），前台主链路不再注入。

## 观测点

- `前台标签派发` / `诚实闸补派后台任务`：标签协议命中率与格式失败率。
- `快速通道未收尾，升级 plan-and-execute`：快速通道一次成功率（决定是否调 Flash 预算）。
- TaskHub 终态分布：后台任务 done/failed 比。
