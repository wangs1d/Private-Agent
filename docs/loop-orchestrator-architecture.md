# Loop Orchestrator 架构设计

> 目标：在现有三种 agent 执行循环（React / Plan-Execute / State-Machine）之上建立统一的编排层，解决四个痛点——终止时机不智能、多种 loop 状态不共享、工具失败后不会换策略、复杂任务跑偏不收敛——同时保持模块化与可插拔，作为可被另一个项目复用的适配层。
>
> 本文档为三阶段实施蓝图，所有引用的现有签名均来自真实代码（带文件行号）。

---

## 1. 背景与现状

### 1.1 现有三种 loop（真实签名）

| Loop | 入口签名 | 主循环 | 终止条件 |
|---|---|---|---|
| React 工具环 | `streamCompletionWithTools(client, model, messages, onDelta, ctx, options?): Promise<string>` ([openai-compatible-tool-loop.ts#L1690](file:///e:/ws-project/Private-Agent/server/src/external-model/openai-compatible-tool-loop.ts#L1690)) | `for (round=0; round<maxRounds; round++)` ([L1755](file:///e:/ws-project/Private-Agent/server/src/external-model/openai-compatible-tool-loop.ts#L1755)) | `finishReason !== "tool_calls"` 或达 maxRounds（动态 2–12，[analyzeTaskComplexity L253](file:///e:/ws-project/Private-Agent/server/src/external-model/openai-compatible-tool-loop.ts#L253)） |
| Plan-Execute | `runPlanExecuteLoop(args: RunPlanExecuteLoopArgs): Promise<PlanExecuteLoopResult>` ([plan-execute-loop.ts#L190](file:///e:/ws-project/Private-Agent/server/src/agent/plan-execute-loop.ts#L190)) | plan 一次 + execute 一次（无显式 round 循环） | 两次 `streamCompletion` 自然结束 |
| State-Machine | `AgentTaskOrchestrator.runLoop(taskId, options): Promise<void>`（private, [agent-task-orchestrator.ts#L143](file:///e:/ws-project/Private-Agent/server/src/services/agent-task-orchestrator.ts#L143)） | `while (!signal.aborted)` ([L152](file:///e:/ws-project/Private-Agent/server/src/services/agent-task-orchestrator.ts#L152)) | `status ∈ {done,failed,paused,awaiting_approval}` 或 `currentRound >= maxRounds(30)` |

### 1.2 装配与路由现状

- 路由：`routeLlmExecution(text, config, opts): RouteDecision`（[task-router.ts#L131](file:///e:/ws-project/Private-Agent/server/src/agent/task-router.ts#L131)），返回 `{ mode: LlmExecutionMode, reasons }`，6 种 mode（`fast_chat | master_only | master_delegate | plan_execute | direct_llm | state_machine`）。**纯正则启发式，无 LLM 参与**。
- 分发：`handleUserMessage`（[agent-core.ts#L440](file:///e:/ws-project/Private-Agent/server/src/services/agent-core.ts#L440)）按 `route.mode` 三分支：`state_machine` → `AgentTaskOrchestrator.createAndRun`（[L518](file:///e:/ws-project/Private-Agent/server/src/services/agent-core.ts#L518)）；`master_*` → `MasterAgentCoordinator.orchestrateTask`（[L586](file:///e:/ws-project/Private-Agent/server/src/services/agent-core.ts#L586)）；其余 → `runStandardLlmPath`（[L622](file:///e:/ws-project/Private-Agent/server/src/services/agent-core.ts#L622)），其中 `plan_execute` 调 `runPlanExecuteLoop`（[L950](file:///e:/ws-project/Private-Agent/server/src/services/agent-core.ts#L950)），其他进 `streamCompletionWithTools`。

### 1.3 四个痛点的根因

四个痛点本质是同一根因的四种表现：**在多种 loop 之上缺少一个统一的控制层**。

| 痛点 | 现状根因 |
|---|---|
| 终止时机不智能 | maxRounds 是静态/启发式（[L253](file:///e:/ws-project/Private-Agent/server/src/external-model/openai-compatible-tool-loop.ts#L253)），无"目标达成即停""无进展即停"的结构化信号 |
| 多 loop 状态不共享 | 三个 loop 各持自己的 messages/history，切换 mode 时 `TaskHistoryEntry`（[agent-task-types.ts#L57](file:///e:/ws-project/Private-Agent/server/src/services/agent-task-types.ts#L57)）不互通，Hermes 画像、Jarvis 反思也不回流 |
| 工具失败不换策略 | 失败处理靠 prompt 引导（`buildToolFailureReminder` [L416](file:///e:/ws-project/Private-Agent/server/src/external-model/openai-compatible-tool-loop.ts#L416) 目前只覆盖 `desktop.open`），无确定性 fallback 链 |
| 跑偏不收敛 | plan-execute 的自检重试在 2026-05 被有意删除（[plan-execute-loop.ts#L5 注释](file:///e:/ws-project/Private-Agent/server/src/agent/plan-execute-loop.ts#L5)），`verifyReflection`/`exhaustedRetries` 成死字段；react 无中途 plan 校准 |

### 1.4 关键约束（来自真实代码）

- 工具元数据**分散在 5 处**，无统一结构：分类在 `TOOL_CATEGORY_MAPPINGS`（[L1409](file:///e:/ws-project/Private-Agent/server/src/external-model/openai-compatible-tool-loop.ts#L1409)）、超时在 `resolveToolExecutionTimeoutMs`（[L184](file:///e:/ws-project/Private-Agent/server/src/external-model/openai-compatible-tool-loop.ts#L184)）、状态机白名单在 `STATE_MACHINE_TOOL_ALLOWLIST`（[agent-task-orchestrator.ts#L62](file:///e:/ws-project/Private-Agent/server/src/services/agent-task-orchestrator.ts#L62)）。`ToolRegistry.register(name, handler)`（[tool-registry.ts#L76](file:///e:/ws-project/Private-Agent/server/src/tools/tool-registry.ts#L76)）只存 name→handler，无 category/retry 字段。
- `HermesEvolutionLoopService` 已有 namespace 级成功率统计 `toolNamespaceOutcomes`（[hermes-evolution-loop-service.ts#L159](file:///e:/ws-project/Private-Agent/server/src/services/hermes-evolution-loop-service.ts#L159)），是 RecoveryPolicy 的现成输入信号。
- `JarvisReflector` 反思的是主动消息决策，**不接入工具 loop**，但其"规则匹配 + confidence + 提升为 rule"模式（[reflector.ts#L170](file:///e:/ws-project/Private-Agent/server/src/services/jarvis/reflector.ts#L170)）可借鉴。
- 项目存在 `server/src/agent/task-context.ts`，新共享上下文需与之区分命名（见 §3.1）。

---

## 2. 设计目标与原则

1. **可插拔**：四个策略（终止/恢复/进展/升级）均为接口，默认实现可替换。
2. **适配层定位**：编排层只做控制流，不重写工具执行；现有 loop 包成 strategy 后内部逻辑尽量不动，便于回退。
3. **成本中性或净降**：用结构化控制替代"靠 LLM 试错"，避免无脑增加 LLM 调用（详见 §6）。
4. **渐进可回退**：每个阶段在 `agent-core` 后挂 feature flag，开关回到旧路径。
5. **复用现有信号**：优先复用 `ToolLoopAfterBatchInfo`、`HermesProfile`、`TOOL_CATEGORY_MAPPINGS`，而非新建并行数据源。

---

## 3. 总体架构

```
┌──────────────────────────────────────────────────────────┐
│                     AgentCore.handleUserMessage           │
│        (替换 routeLlmExecution 启发式 → 编排器入口)         │
├──────────────────────────────────────────────────────────┤
│                    LoopOrchestrator                        │
│   选 loop / 跑 loop / 评估 / 升级 / 终止 —— 单一控制流       │
├──────────┬──────────┬───────────┬─────────────────────────┤
│ Termination│ Recovery │ Progress  │ Escalation             │
│  Policy    │  Policy  │  Tracker  │   Policy               │
├──────────┴──────────┴───────────┴─────────────────────────┤
│                SharedTaskContext (单一对象)                 │
│  goal / plan / progress / toolHistory / failures / budget  │
├──────────────────────────────────────────────────────────┤
│              LoopStrategy 接口（统一抽象）                   │
│  ├─ ReactLoopStrategy       包装 streamCompletionWithTools │
│  ├─ PlanExecuteLoopStrategy 包装 runPlanExecuteLoop        │
│  └─ StateMachineStrategy    包装 AgentTaskOrchestrator     │
├──────────────────────────────────────────────────────────┤
│   现有底层：ExternalChatProvider / ToolRegistry / Hermes    │
└──────────────────────────────────────────────────────────┘
```

---

## 3.1 SharedTaskContext

跨 loop 流转的单一上下文，命名 `SharedTaskContext`（区别于已有的 `agent/task-context.ts`，后者是 turn 级 prompt 上下文）。

```typescript
// 新文件：server/src/agent/loop/shared-task-context.ts

export interface SharedTaskContext {
  taskId: string;
  actorId: string;
  sessionId: string;
  goal: string;

  plan: TaskExecutionPlan | null;          // 复用 plan-execute-loop.ts L24 的类型
  progress: ProgressState;
  toolHistory: ToolCallRecord[];           // 跨 loop 统一
  failures: FailureRecord[];               // RecoveryPolicy 输入
  reflections: ReflectionEntry[];          // 跨 loop 累积
  budget: BudgetTracker;

  currentLoop: LlmExecutionMode;           // 当前所在 loop
  loopSwitches: LoopSwitchEvent[];         // 升级/切换历史
}

export interface ProgressState {
  completedSteps: string[];
  currentStep: string | null;
  remainingSteps: string[];
  lastProgressRound: number;               // 用于无进展检测
  consecutiveFailures: number;
  consecutiveNoProgress: number;           // 连续 N 轮无新进展
}

export interface ToolCallRecord {
  round: number;
  loop: LlmExecutionMode;
  name: string;
  args: Record<string, unknown>;
  ok: boolean;
  resultSummary: string;                   // 压缩后，避免上下文膨胀
  durationMs: number;
  error?: string;
  timestamp: number;
}

export interface FailureRecord {
  toolName: string;
  category: string;                        // 取自 TOOL_CATEGORY_MAPPINGS
  args: Record<string, unknown>;
  error: string;
  attempts: number;                        // 同工具+相似参数的连续失败次数
  timestamp: number;
}

export interface ReflectionEntry {
  loop: LlmExecutionMode;
  round: number;
  body: string;
  confidence: number;                      // 借鉴 JarvisReflector [L170]
}

export interface BudgetTracker {
  maxRounds: number;
  roundsUsed: number;
  maxModelCalls: number;
  modelCallsUsed: number;
  maxDurationMs: number;
  startedAt: number;
}

export interface LoopSwitchEvent {
  from: LlmExecutionMode;
  to: LlmExecutionMode;
  reason: string;
  atRound: number;
  timestamp: number;
}
```

**设计要点**：
- `ToolCallRecord.resultSummary` 只存压缩后摘要（复用 `compactToolOutputForLlm` 思路），防止历史膨胀。
- `failures` 按 `(toolName, argsHash)` 聚合 `attempts`，供 RecoveryPolicy 判断"同一 selector 调用超过 2 次"（呼应状态机 prompt [agent-task-orchestrator.ts#L405](file:///e:/ws-project/Private-Agent/server/src/services/agent-task-orchestrator.ts#L405)）。
- `budget` 把现在散落的 `maxRounds`（30/12/动态）统一收口。

---

## 3.2 LoopStrategy 接口

把三个现有 loop 收敛到统一接口后面。内部实现不改逻辑，只做参数适配与结果归一化。

```typescript
// 新文件：server/src/agent/loop/loop-strategy.ts

export interface LoopStrategy {
  readonly mode: LlmExecutionMode;
  /** 编排器在选 loop 时问一句：你能在当前 ctx 下接着跑吗 */
  canHandle(ctx: SharedTaskContext): boolean;
  /** 跑一轮（受 budget 与 signal 约束），返回归一化结果 */
  run(ctx: SharedTaskContext, params: LoopRunParams): Promise<LoopRunResult>;
}

export interface LoopRunParams {
  messages: ChatCompletionMessageParam[];   // 复用 openai 类型
  tools: ChatCompletionTool[];
  toolCtx: ChatToolExecutionContext;        // 复用 external-model/types.ts L156
  onDelta?: StreamDeltaHandler;             // 复用 types.ts L7
  onProgress?: (event: TaskProgressEvent) => void;
  signal?: AbortSignal;
}

export interface LoopRunResult {
  finalText: string;
  finished: boolean;                        // true=目标达成
  finishReason: "done" | "max_rounds" | "failure" | "aborted" | "needs_escalation";
  toolCalls: ToolCallRecord[];              // 本轮新增（已合并进 ctx.toolHistory）
  modelCalls: number;
  reflections?: string[];
}
```

### 三个 Strategy 的包装方式

**ReactLoopStrategy**（包装 [streamCompletionWithTools](file:///e:/ws-project/Private-Agent/server/src/external-model/openai-compatible-tool-loop.ts#L1690)）：
- `run` 内部把 `ctx` 转成 `messages` + `options.maxRounds = min(ctx.budget.maxRounds - ctx.budget.roundsUsed, 动态值)`。
- 通过 `onAfterToolBatch` 回调把 `ToolLoopAfterBatchInfo`（[types.ts#L87](file:///e:/ws-project/Private-Agent/server/src/external-model/types.ts#L87)）同步进 `ctx.toolHistory` 与 `ctx.failures`。
- 返回 `finished = finishReason === "stop"`。

**PlanExecuteLoopStrategy**（包装 [runPlanExecuteLoop](file:///e:/ws-project/Private-Agent/server/src/agent/plan-execute-loop.ts#L190)）：
- 复用其 plan 阶段产出 `TaskExecutionPlan`，写入 `ctx.plan`。
- **P2 阶段重新激活 `verifyReflection` / `exhaustedRetries` 死字段**（[plan-execute-loop.ts#L40](file:///e:/ws-project/Private-Agent/server/src/agent/plan-execute-loop.ts#L40)）：execute 后调 ProgressTracker，未达成则回 `needs_escalation` 或重 plan。

**StateMachineStrategy**（包装 [AgentTaskOrchestrator.runLoop](file:///e:/ws-project/Private-Agent/server/src/services/agent-task-orchestrator.ts#L143)）：
- 把 `runLoop` 的 private 限制打破：新增 `public runOnceForOrchestrator(taskId, opts)` 方法跑单轮，编排器在外层控制 while。
- `AgentTask`（[agent-task-types.ts#L92](file:///e:/ws-project/Private-Agent/server/src/services/agent-task-types.ts#L92)）的 `history` 字段与 `ctx.toolHistory` 做双向同步。

---

## 3.3 四个可插拔策略

```typescript
// 新文件：server/src/agent/loop/policies.ts

export interface TerminationPolicy {
  shouldTerminate(ctx: SharedTaskContext): TerminationDecision;
}
export interface TerminationDecision {
  terminate: boolean;
  reason: "goal_met" | "no_progress" | "budget_exhausted"
        | "max_consecutive_failures" | "aborted";
  hint?: string;                           // 注入给 LLM 的收尾提示
}

export interface RecoveryPolicy {
  onFailure(ctx: SharedTaskContext, failure: FailureRecord): RecoveryAction;
}
export interface RecoveryAction {
  type: "retry" | "switch_tool" | "switch_args" | "escalate" | "give_up";
  alternativeTool?: string;                // switch_tool 时，从 TOOL_CATEGORY_MAPPINGS 同类里选
  alternativeArgs?: Record<string, unknown>;
  injectHint?: string;                     // 替代/增强 buildToolFailureReminder [L416]
  escalateTo?: LlmExecutionMode;
}

export interface ProgressTracker {
  assess(ctx: SharedTaskContext): ProgressAssessment;
}
export interface ProgressAssessment {
  onTrack: boolean;
  progressScore: number;                   // 0..1
  deviation?: string;
  recommendation: "continue" | "replan" | "escalate";
}

export interface EscalationPolicy {
  shouldEscalate(ctx: SharedTaskContext, lastResult: LoopRunResult): EscalationDecision;
}
export interface EscalationDecision {
  escalate: boolean;
  to?: LlmExecutionMode;
  reason: string;
}
```

---

## 3.4 LoopOrchestrator

```typescript
// 新文件：server/src/agent/loop/loop-orchestrator.ts

export class LoopOrchestrator {
  constructor(
    private strategies: Map<LlmExecutionMode, LoopStrategy>,
    private termination: TerminationPolicy,
    private recovery: RecoveryPolicy,
    private progress: ProgressTracker,
    private escalation: EscalationPolicy,
  ) {}

  async run(seed: TaskSeed, initialMode: LlmExecutionMode): Promise<OrchestratorResult> {
    const ctx = createSharedTaskContext(seed);
    let mode = initialMode;

    while (true) {
      // 1. 终止检查（每轮前）
      const term = this.termination.shouldTerminate(ctx);
      if (term.terminate) return this.finalize(ctx, term);

      // 2. 选 strategy（含升级后的切换）
      const strategy = this.strategies.get(mode);
      if (!strategy || !strategy.canHandle(ctx)) {
        return this.finalize(ctx, { terminate: true, reason: "no_strategy" as any });
      }

      // 3. 跑一轮
      const result = await strategy.run(ctx, this.buildParams(ctx));

      // 4. 失败恢复（确定性 fallback，不调 LLM）
      const recentFailures = result.toolCalls.filter(t => !t.ok);
      for (const f of recentFailures) {
        const action = this.recovery.onFailure(ctx, this.toFailureRecord(f));
        if (action.injectHint) ctx.reflections.push(/* ... */);
        if (action.type === "escalate" || action.type === "give_up") break;
      }

      // 5. 进展评估 + 升级决策
      const assess = this.progress.assess(ctx);
      const esc = this.escalation.shouldEscalate(ctx, result);
      if (esc.escalate && this.canEscalate(mode, esc.to!)) {
        ctx.loopSwitches.push({ from: mode, to: esc.to!, reason: esc.reason, ... });
        mode = esc.to!;
        continue;
      }
      if (assess.recommendation === "replan" && strategy.mode === "plan_execute") {
        // 触发 plan 重生成
      }

      // 6. 预算耗尽兜底
      if (ctx.budget.roundsUsed >= ctx.budget.maxRounds) {
        return this.finalize(ctx, { terminate: true, reason: "budget_exhausted" });
      }
    }
  }
}
```

---

## 4. 状态流转

```
                    ┌─────────────────────────────┐
                    │  handleUserMessage          │
                    │  (initialMode 由轻量路由选定) │
                    └──────────────┬──────────────┘
                                   ▼
        ┌──────────────────────────────────────────────────┐
        │  LoopOrchestrator.run                             │
        │                                                    │
        │  ┌─────────┐    ┌──────────┐    ┌─────────────┐  │
        │  │终止检查?│───▶│ 跑 Strategy│───▶│ 失败恢复     │  │
        │  └─────────┘    └──────────┘    │ (确定性)     │  │
        │       │              │           └──────┬──────┘  │
        │       │是            │                   ▼         │
        │       ▼              │           ┌─────────────┐  │
        │   ┌────────┐         │           │ 进展评估     │  │
        │   │finalize│         │           │ + 升级决策   │  │
        │   └────────┘         │           └──────┬──────┘  │
        │                      │                  │         │
        │                      │<─────────────────┘         │
        │                      ▼                            │
        │              (升级则切 mode，continue)             │
        └──────────────────────────────────────────────────┘
```

**升级路径**（单向，避免回环抖动）：
`fast_chat / direct_llm (react)` → `plan_execute` → `state_machine`
- react 连续 ≥2 轮无进展或同类工具失败 ≥2 次 → 升级到 plan_execute
- plan_execute 重 plan 后仍不收敛 → 升级到 state_machine（最强闭环）

---

## 5. 三阶段实施

### Phase 1 — 地基（解决：状态共享 + 终止智能）

**交付物**：
1. `server/src/agent/loop/shared-task-context.ts` —— §3.1 全部类型
2. `server/src/agent/loop/loop-strategy.ts` —— §3.2 接口 + 三个 strategy 包装实现（**不改 loop 内部逻辑**，只加适配壳）
3. `server/src/agent/loop/policies.ts` —— 四个策略接口
4. `DefaultTerminationPolicy` 实现：
   - `goal_met`：复用状态机 `parseLlmOutput`（[agent-task-orchestrator.ts#L464](file:///e:/ws-project/Private-Agent/server/src/services/agent-task-orchestrator.ts#L464)）的"任务完成"正则，泛化到所有 loop
   - `no_progress`：`consecutiveNoProgress >= 3` 触发（连续 3 轮 `toolHistory` 无新成功 + 无新 step 完成）
   - `budget_exhausted`：统一预算
   - `max_consecutive_failures`：`consecutiveFailures >= 4`
5. `LoopOrchestrator` 骨架（§3.4），但只接入 `termination`，其余策略给 no-op 默认实现
6. `agent-core.ts` 加 feature flag `AGENT_LOOP_ORCHESTRATOR=1`：开启时走编排器，关闭时保持现有 `routeLlmExecution` 三分支路径

**集成点**：
- [agent-core.ts#L440](file:///e:/ws-project/Private-Agent/server/src/services/agent-core.ts#L440) 路由调用处加分支
- [agent-core.ts#L839](file:///e:/ws-project/Private-Agent/server/src/services/agent-core.ts#L839) `onToolLoopAfterBatch` 回调改为同步进 `ctx.toolHistory`
- 现有 `analyzeTaskComplexity`（[L253](file:///e:/ws-project/Private-Agent/server/src/external-model/openai-compatible-tool-loop.ts#L253)）的 maxRounds 作为 `budget.maxRounds` 初值

**验收**：
- 开启 flag 后，三类任务（简单对话 / 单工具查询 / 多工具桌面）行为与旧路径等价或更优（更早终止）
- 关闭 flag 完全回退，零行为变化
- 单元测试：`DefaultTerminationPolicy` 各 reason 触发条件

**风险**：低。纯重构 + 增量，loop 内部不动。

---

### Phase 2 — 恢复（解决：工具失败不换策略）

**交付物**：
1. **工具元数据层** `server/src/agent/loop/tool-metadata.ts`：
   - 把分散的 `TOOL_CATEGORY_MAPPINGS`（[L1409](file:///e:/ws-project/Private-Agent/server/src/external-model/openai-compatible-tool-loop.ts#L1409)）、`resolveToolExecutionTimeoutMs`（[L184](file:///e:/ws-project/Private-Agent/server/src/external-model/openai-compatible-tool-loop.ts#L184)）、`STATE_MACHINE_TOOL_ALLOWLIST`（[L62](file:///e:/ws-project/Private-Agent/server/src/services/agent-task-orchestrator.ts#L62)）收敛成单一 `ToolMetadata` 表
   - 新增 `alternatives: string[]` 字段，声明同类替代（如 `desktop.open` → `[desktop.run_preset:find_app, desktop.run_shell]`）
   - 接入 Hermes `toolNamespaceOutcomes`（[L159](file:///e:/ws-project/Private-Agent/server/src/services/hermes-evolution-loop-service.ts#L159)）作为优先级信号：namespace 失败率高时优先换工具
2. `DefaultRecoveryPolicy` 实现，确定性 fallback 链：
   ```
   onFailure(failure):
     if failure.attempts < 2:  return { type:"retry" }            // 同工具重试（参数可能由 LLM 调整）
     alts = metadata[failure.toolName].alternatives
     if alts.length:          return { type:"switch_tool", alternativeTool: pick(alts), injectHint }
     if failure.category 有他工具: return { type:"switch_tool", ... }
     return { type:"escalate", escalateTo:"plan_execute" }        // 升级让更强 loop 接管
   ```
3. **替换 `buildToolFailureReminder`**（[L416](file:///e:/ws-project/Private-Agent/server/src/external-model/openai-compatible-tool-loop.ts#L416)）：从硬编码 `desktop.open` 单例，改为由 RecoveryPolicy 生成 `injectHint`，覆盖所有有 alternatives 的工具
4. **重新激活 plan-execute 反思**：`PlanExecuteLoopStrategy` execute 后调 `ProgressTracker`（P3 提供，P2 先用简化版），未达 `successCriteria` 则填 `verifyReflection`、置 `exhaustedRetries`（[plan-execute-loop.ts#L40](file:///e:/ws-project/Private-Agent/server/src/agent/plan-execute-loop.ts#L40)），决定重 plan 或升级。**清除死字段**。
5. 编排器接入 `recovery`（替换 P1 的 no-op）

**集成点**：
- [openai-compatible-tool-loop.ts#L2119](file:///e:/ws-project/Private-Agent/server/src/external-model/openai-compatible-tool-loop.ts#L2119) 注入点：`failureReminder` 改调 `recoveryPolicy.onFailure(...).injectHint`
- [tool-registry.ts#L76](file:///e:/ws-project/Private-Agent/server/src/tools/tool-registry.ts#L76) `register` 扩展可选 metadata 参数（向后兼容）

**验收**：
- `desktop.open` 失败时不再靠 prompt 让 LLM 悟，确定性尝试 `find_app` → `run_shell`
- 同一 selector 连续 2 次失败后自动换策略（呼应 [agent-task-orchestrator.ts#L405](file:///e:/ws-project/Private-Agent/server/src/services/agent-task-orchestrator.ts#L405) 的 prompt 规则，但改为结构化）
- 死字段 `exhaustedRetries`/`verifyReflection` 被真正使用或删除

**风险**：中。需为每个有 alternative 的工具定义替代关系，初期可只覆盖高频失败工具（desktop/web/shopping）。

---

### Phase 3 — 编排（解决：跑偏不收敛 + 动态编排）

**交付物**：
1. `DefaultProgressTracker`（LLM 辅助，但**低频**）：
   - 每 K 轮（K=3，可配）调一次小模型评估 `progressScore` 与 `deviation`
   - 输入：`ctx.goal` + `ctx.plan` + `completedSteps` + 最近 toolHistory 摘要
   - 输出：`recommendation ∈ {continue, replan, escalate}`
   - 成本控制：用便宜模型（如现有的 Kimi provider），且只在 `consecutiveNoProgress >= 2` 时才触发，避免每轮都调
2. `DefaultEscalationPolicy`：
   - `consecutiveNoProgress >= 3` 且当前 react → 升级 plan_execute
   - plan_execute 重 plan 后仍 `progressScore < 0.3` → 升级 state_machine
   - 单向升级，记录 `loopSwitches`
3. **路由层升级**：保留 `routeLlmExecution` 作为 initialMode 选择，但**移除其"一次性定终身"语义**——编排器可在任务中途升级 mode。最终可考虑用小模型替代正则启发式做 initialMode 决策（可选，不在本阶段必做）
4. **跨 loop 经验回流**：把 `ctx.failures` 与升级事件写入 Hermes（扩展现有 `onToolBatch` [L153](file:///e:/ws-project/Private-Agent/server/src/services/hermes-evolution-loop-service.ts#L153)），让 RecoveryPolicy 的 alternatives 优先级跨任务学习

**集成点**：
- 编排器接入 `progress` + `escalation`（替换 P1/P2 的默认实现）
- [task-router.ts#L131](file:///e:/ws-project/Private-Agent/server/src/agent/task-router.ts#L131) route 结果降级为 initialMode 建议而非最终决策

**验收**：
- 复杂多步任务跑偏时能自动 re-plan 或升级到 state_machine 收敛
- 升级事件在 `loopSwitches` 可观测，不出现 react↔plan_execute 抖动回环
- Hermes 画像能影响后续任务的 RecoveryPolicy 优先级

**风险**：高。真正改变行为，需充分灰度。ProgressTracker 的 LLM 调用需严格控频，否则成本失控。

---

## 6. 成本分析

| 阶段 | 新增 LLM 调用 | 成本影响 |
|---|---|---|
| P1 终止策略 | 0（纯规则） | **净降**：智能终止省掉空转轮次 |
| P2 恢复策略 | 0（确定性 fallback） | **净降**：替代现在 LLM 靠 prompt 反复试错 |
| P3 进展评估 | 低频小模型（每 3 轮一次，仅无进展时） | 小幅上升，但用便宜模型 + 控频，且换来收敛避免的浪费轮次 |

**与 2026-05 简化的关系**：当时砍自检重试为省 50% LLM 调用。本方案不是把反思加回去，而是用**更便宜的结构化控制**（P1/P2 零 LLM）替代它，只有 P3 引入少量小模型调用，且只在真正卡住时触发。

---

## 7. 风险与缓解

| 风险 | 缓解 |
|---|---|
| P1 重构导致工作流回归 | feature flag + 灰度；loop 内部不改，只加壳；可逐 mode 开启 |
| SharedTaskContext 膨胀拖慢 | `ToolCallRecord.resultSummary` 只存压缩摘要；`failures`/`reflections` 设上限（如各 50 条） |
| RecoveryPolicy 替代关系定义不全 | 初期只覆盖高频失败工具（desktop/web/shopping），其余 fallthrough 到原 prompt 路径 |
| P3 升级回环抖动 | 升级单向；`loopSwitches` 记录；同方向最多升 2 级 |
| ProgressTracker 成本失控 | 仅 `consecutiveNoProgress >= 2` 触发；用便宜模型；K 轮一次 |
| 死字段清理破坏调用方 | P2 中 `exhaustedRetries`/`verifyReflection` 要么真用要么删，二选一，不悬空 |

---

## 8. 文件清单（新增）

```
server/src/agent/loop/
├── shared-task-context.ts     # §3.1 类型
├── loop-strategy.ts           # §3.2 接口 + React/PlanExecute/StateMachine 三个 strategy
├── policies.ts                # §3.3 四个策略接口
├── loop-orchestrator.ts       # §3.4 编排器
├── tool-metadata.ts           # §5 P2 元数据层
├── default-termination.ts     # P1
├── default-recovery.ts        # P2
├── default-progress.ts        # P3
└── default-escalation.ts      # P3
```

现有文件改动（均向后兼容，feature flag 保护）：
- `server/src/services/agent-core.ts` —— 编排器入口分支
- `server/src/external-model/openai-compatible-tool-loop.ts` —— `buildToolFailureReminder` 改由 RecoveryPolicy 驱动
- `server/src/agent/plan-execute-loop.ts` —— 死字段清理/激活
- `server/src/services/agent-task-orchestrator.ts` —— 暴露单轮入口
- `server/src/tools/tool-registry.ts` —— `register` 可选 metadata
- `server/src/services/hermes-evolution-loop-service.ts` —— 扩展回流接口

---

## 9. 里程碑建议

- **P1** 可独立交付并立即带来终止收益，是必须先做的地基。
- **P2** 在 P1 接口就绪后接入，解决最痛的"失败不换策略"。
- **P3** 视 P1/P2 效果决定是否继续，是真正改变行为的部分，需充分灰度。

每个阶段结束都应保留 feature flag 可回退到上一稳定状态。
