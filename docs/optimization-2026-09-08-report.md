# 前后台协作优化：前后对比报告（2026-09-08）

## 总览

| 维度 | 改造前 | 改造后 | 收益 |
|---|---|---|---|
| 后台任务升级 | 无差别整轮重跑（planner + 全量 schema + 工具全部重执行），fast 段成果全部沉没 | 分级升级：段1 已执行过工具 → 保留桥召回（免 planner/免 schema）+ 工具轨迹带入升级段，相同调用 60s TTL 缓存复用 | 升级路径省 1 次 planner 调用（≤8s）+ 全量 schema 注入 + 工具重复执行 |
| 后台任务流式 | 段1 静默执行，升级段才出第一条可见输出 | 段1 即流式（pushDelta），升级段延续同一 messageId，pushDone 以完整文本收尾 | 感知 TTFT 从"整段执行完"降到"首 token" |
| 重型工具并行 | worker 池每类型 **1** 个 Worker + FIFO（信号量放行 2 个也在 worker 层排队） | 按需扩容并行池（每类型默认 **2**，`WORKER_POOL_SIZE_CODE/IMAGE` 可调，上限 8） | 多任务并行时 code.run/image.generate 吞吐上限 ×2 |
| 具身域互斥 | desktop./browser./phone. **无任何闸**，多后台任务并行必然互踩同一台机器 | desktop./agent_browser./browser./phone./embodiment. **同域全局单飞**（共享信号量，跨工具名互斥） | 正确性修复：并行不再互踩 |
| 后台并发上限 | 无限并行（无闸），`MAX_PARALLEL_SUB_AGENTS=3` 是死配置 | `backgroundTaskLimiter` 全局信号量（默认 4，`AGENT_BG_TASK_MAX_PARALLEL`） | 防止并行任务同时打满 LLM provider 限流 |
| replan 前缀缓存 | 合并折叠消息每次 replan 重写 → 命中上限锁死在 base，**不随波次增长** | 逐链独立折叠、内容冻结（append-only）→ 命中**随波次累积增长** | 实测 replan 阶段全价重付字节 **-13%**（4 波基准），波数越多优势越大 |
| 任务面工具结果预算 | 与前台同一套（search_web 7000 字等） | task_plane 阶段统一 ×0.6（`AGENT_TASK_TOOL_BUDGET_SCALE` 可调） | 典型多工具波回灌 17500→10500 字（**-40%**，约 9.8K→5.9K token/波） |
| token 度量 | 纯字符估算（×0.75），工具循环混在 `main_chat`，`main_chat_tools` 声明后从未写入，无 task_plane 可见性 | API 真实 usage（prompt/completion/cached tokens）+ stage 打标：`main_chat_tools` / `task_plane_fast` / `task_plane_complex`，估算与真实分列聚合落盘 | 一周内可拿到真实消耗分布，后续优化有验收依据 |
| B3 能力束裁剪 | — | **已由现架构实现**（`toolCapabilities` → resolve-chat-tools delegate profile 按能力裁剪工具族），核实无需改动 | — |
| B6 旁路合并 | — | **已由现架构实现**（mood/话题分析已合并进路由 L1 调用），核实无需改动 | — |

## 实测数字

### B2 replan 前缀缓存（scripts/bench-fold-prefix.ts，可复现）

真实的新旧折叠逻辑（旧 = git HEAD 版复刻）跑同一 5 波任务（system+历史 1.9KB base，5 个工具链）：

```
旧(合并折叠,每次重写)                     新(逐链冻结,append-only)
wave2: 命中 1.9KB (45%)                  wave2: 命中 1.9KB (45%)
wave3: 命中 1.9KB (50%)                  wave3: 命中 2.1KB (55%)
wave4: 命中 1.9KB (46%)                  wave4: 命中 2.3KB (56%)
wave5: 命中 1.9KB (45%)                  wave5: 命中 2.5KB (60%)
合计全价重付 8.5 KB                      合计全价重付 7.4 KB（-13%）
```

关键差异：旧逻辑的命中上限**锁死**在 base（合并折叠消息每波重写，把前缀打碎在同一位置）；新逻辑的命中**单调增长**（每条冻结的折叠消息永久加入可命中前缀）。基准里 base 只占 1.9KB，生产环境 base 是 8-15K token 的 system+动态上下文——base 本来就稳定，收益集中在折叠段，且随工具结果数量、波数增长。

### B4 任务面预算缩放（确定性换算，×0.6）

| 工具 | 前 | 后 |
|---|---|---|
| search_web | 7000 字 | 4200 字 |
| deep_search | 6000 字 | 3600 字 |
| fetch_web | 4500 字 | 2700 字 |
| agent_browser.extract_text | 5000 字 | 3000 字 |
| info.search | 5000 字 | 3000 字 |

典型"search_web + deep_search + fetch_web"并行波：17500 字 → 10500 字（按 0.75 token/字估算 ≈ 13.1K → 7.9K token，**-40%**/波）。前台对话面不变。

## 测试结果

- 全量套件：**1411 tests，1406 通过，4 失败，1 skipped**（52s）。
- 4 个失败均为存量问题，与本次改动无关（逐一定性）：habit-loop ×2（HEAD 代码默认 `auto`，测试期望 `confirm_each`）；ChatThreadStore recap 漂移回归（针对工作区未提交的记忆改动）；runtime-link（引用不存在的 `src/runtime/link/ws-runtime-client.js`）。
- 新增 8 个测试全部通过：
  - `test/optimization-2026-09-08.test.ts`：B2 折叠冻结（含"跨波次逐字节一致"断言）、B1 真实 usage 聚合/落盘/task_plane stage、A3 具身域单飞（抓出并修复了按工具名建闸导致跨工具不互斥的 bug）、A3 名单外零开销、A3 后台并发闸；
  - `test/message-batch-processor-queueing.test.ts`：A1 同 session 排队证据 + 跨 session 不受影响。
- `tsc -p tsconfig.json --noEmit` 干净（顺手修掉一个 HEAD 上的存量类型错误：`settleInterruptedTurn` 漏传必填的 `trajCap`）。

## 需要注意的取舍

1. 段1 流式后若触发升级，道歉式文本会短暂流出、随后被 pushDone 完整文本替换——多数任务 fast_ok 不受影响。
2. B2 逐链折叠比合并折叠每条多一行标题（~30 字/条），落在可命中前缀区，净收益为正。
3. 后台并发闸默认 4：排队期间 TaskHub 进度行显示"等待并行执行槽位"，用户可感知。

## 后续观察指标（B1 打通后）

- `data/llm-token-audit.ndjson` 按 stage 的真实 token 分布（重点看 `task_plane_fast` vs `task_plane_complex` 占比、升级率）；
- 工具循环内 `[prefix-cache] hitRate` 日志（改造前基线 vs 改造后）；
- `recordFastChannelOutcome` 的 fast_ok/upgraded_ok 比率（A2 后升级路径成本已降，比率本身不变）。
