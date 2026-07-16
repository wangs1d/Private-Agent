# Brain 模块优化计划

## Summary

对 Brain Center 神经解剖架构做 11 项优化，覆盖：4 项核心架构闭环（子系统注册缺失、突触事件闭环、离线存储接口对齐）、3 项中优先级（错误处理一致性、recall 降级链修正、Promise.all 错误可观测）、4 项低优先级（环形缓冲、snapshot 完整性、HTTP 语义、端到端语音 TODO）。

## Current State Analysis

探索发现以下问题（按严重程度排序）：

| # | 优先级 | 问题 | 位置 |
|---|--------|------|------|
| 1 | 高 | LimbicCortex 的 registerTonePolicy/registerEmotionTone 未调用，applyTonePolicy 永远走透传兜底 | create-app-services.ts:1151-1155 |
| 2 | 高 | PlannerCortex 的 registerPlanExecuteLoop/registerMasterCoordinator 未调用，plan/execute/delegate 全走关键词兜底 | create-app-services.ts:1157-1160 |
| 3 | 高 | SynapseBus.subscribe() 零调用方，跨分区事件闭环未形成 | synapse-bus.ts:171-205 |
| 4 | 高 | registerMessageHub 注入的 MessageHubService.store 是 private 字段（非函数），离线存储降级永不触发 | create-app-services.ts:1144-1146 + synapse-bus.ts:307 |
| 5 | 中 | BrainCenter 9 个代理方法均无委托调用 try/catch，与 identifyGap 不一致 | brain-center.ts:301-450 |
| 6 | 中 | recall() 默认路径 agentic+narrative 是合并非降级，存在冗余调用 | memory-cortex.ts:413-423 |
| 7 | 中 | recallCrossDomain Promise.all 静默吞错 | memory-cortex.ts:507-511 |
| 8 | 低 | 环形缓冲实为 shift 数组，O(n) 搬移 | synapse-bus.ts:350-355 |
| 9 | 低 | snapshot 的 memory.recentItems 永远空、sensory.lastFrame 未填充 | brain-center.ts:461-462 |
| 10 | 低 | BRAIN_NEURO_ENABLED=0 时路由返回 200+error 而非 503 | routes/http/brain.ts |
| 11 | 低 | endToEndVoice 仍为简化实现（TODO） | sensory-cortex.ts:365 |

### 关键实现细节（来自探索）

- `assistant-tone-policy.ts` / `emotion-tone.ts` 是**函数模块**不是类，需包装为 `{ decide, apply }` / `{ detectEmotionFromText, buildToneGuidance }` 对象
- `plan-execute-loop.ts` 导出的是**函数** `runPlanExecuteLoop`，不是带 plan/execute/react 方法的类，需包装
- `MasterAgentCoordinator` 在 create-app-services.ts 中**未实例化**，真实方法是 `handleInvokeSubAgentTool(input, context)`，需包装为 `invokeSubAgent(subAgentType, task, opts)`
- `MessageHubService` 没有 `store` 方法，但有 `createOutbound(input)` 可用于离线存储
- `HookBus` 的 `subscribeType(type, handler)` 可用于按类型订阅，事件类型在 `hook-types.ts` 中已声明 12 种 brain 事件
- `SensoryCortex` / `MemoryCortex` 当前**不持有 SynapseBus 引用**，需新增 `registerSynapseBus` 方法

## Proposed Changes

### Task 1: 修复 LimbicCortex 子系统注册（高优先级 #1）

**文件**：`server/src/bootstrap/create-app-services.ts`、`server/src/brain/limbic-cortex.ts`

**What**：包装 `assistant-tone-policy.ts` 的函数为 `TonePolicyLike` 对象，注册到 LimbicCortex。

**Why**：当前 `applyTonePolicy` 永远走"原文本透传"兜底，情绪驱动的语气适配完全失效。

**How**：
1. 读取 `server/src/agent/assistant-tone-policy.ts`（或 glob 搜索 `**/assistant-tone*.ts`），确认导出的函数名
2. 在 create-app-services.ts 的 LimbicCortex 装配块中，构造包装对象：
   ```typescript
   const tonePolicyAdapter = {
     decide: (text: string, emotion: unknown) => detectAssistantToneMode(text, /* ... */),
     apply: (text: string, mood: unknown) => /* 调用 applyTonePolicy 函数 */,
   };
   limbicCortex.registerTonePolicy(tonePolicyAdapter);
   ```
3. 对 `emotion-tone.ts` 同理包装为 `EmotionToneLike` 对象并注册
4. 如果 `emotion-tone.ts` 的函数签名与 `EmotionToneLike` 差异大，可跳过 EmotionTone 注册（仅注册 TonePolicy），在计划中标注

**Decision**：EmotionTone 注册为可选——如果函数签名差异大，只做 TonePolicy。

### Task 2: 修复 PlannerCortex 子系统注册（高优先级 #2）

**文件**：`server/src/bootstrap/create-app-services.ts`

**What**：包装 `runPlanExecuteLoop` 函数为 `PlanExecuteLoopLike` 对象；包装 `MasterAgentCoordinator.handleInvokeSubAgentTool` 为 `MasterCoordinatorLike.invokeSubAgent`。

**Why**：当前 plan/execute/delegate 全走关键词兜底，无法接入真实规划能力。

**How**：
1. **PlanExecuteLoop 包装**：
   - `runPlanExecuteLoop` 是单次执行函数，包装为：
     ```typescript
     const planExecuteAdapter = {
       plan: async (goal: string, opts?: unknown) => runPlanExecuteLoop({ goal, ...opts }),
       execute: async (plan: unknown, opts?: unknown) => runPlanExecuteLoop({ plan, ...opts }),
       react: (observation: unknown) => observation,
     };
     plannerCortex.registerPlanExecuteLoop(planExecuteAdapter);
     ```
   - 注意：`runPlanExecuteLoop` 的真实参数 `RunPlanExecuteLoopArgs` 需要先读取确认，包装时做参数适配

2. **MasterAgentCoordinator 包装**：
   - 需要先确认 `MasterAgentCoordinator` 是否已在 create-app-services.ts 中实例化（探索报告说没有）
   - 如果未实例化：检查是否可通过 `agentCore` 访问（`agentCore.masterAgentCoordinator?`）
   - 如果不可访问：需要新增实例化 `new MasterAgentCoordinator(masterProvider, toolRegistry, promptContextBuilder)`
   - 包装为：
     ```typescript
     const masterCoordAdapter = {
       invokeSubAgent: async (subAgentType: string, task: unknown, opts?: unknown) => 
         masterAgentCoordinator.handleInvokeSubAgentTool(
           { subAgentType, task, ...opts },
           context,
         ),
     };
     plannerCortex.registerMasterCoordinator(masterCoordAdapter);
     ```
   - 注意：`handleInvokeSubAgentTool` 需要 `ToolContext`，包装时需构造合适的 context

**Decision**：如果 MasterAgentCoordinator 实例化依赖链太深（需要 masterProvider 等重依赖），可先只注册 PlanExecuteLoop，MasterCoordinator 标注为后续任务。

### Task 3: 建立突触事件闭环（高优先级 #3）

**文件**：`server/src/brain/sensory-cortex.ts`、`server/src/brain/memory-cortex.ts`、`server/src/brain/synapse-bus.ts`、`server/src/bootstrap/create-app-services.ts`

**What**：让各皮层在关键操作后 fire 事件，其他皮层 subscribe 订阅相关事件，形成神经闭环。

**Why**：当前 SynapseBus.subscribe() 零调用方，事件能 fire 出去但无人消费，跨分区事件驱动闭环未形成。

**How**：
1. **新增 registerSynapseBus 方法**：
   - 在 `SensoryCortex` 新增 `private synapseBus: SynapseBusLike | null = null` + `registerSynapseBus(svc)` 方法
   - 在 `MemoryCortex` 同理新增
   - 定义最小接口 `SynapseBusLike { fire(type, data, opts?): SynapseEnvelope }`

2. **在关键操作后 fire 事件**：
   - `SensoryCortex.listen` 成功返回前（sensory-cortex.ts:186）fire `sensory.listen` `{ text, confidence, language }`
   - `SensoryCortex.look` 成功返回前（sensory-cortex.ts:258）fire `sensory.look` `{ description, width, height }`（不含 base64）
   - `SensoryCortex.speak` 成功返回前 fire `sensory.speak` `{ channel, delivered, format }`
   - `MemoryCortex.remember` 长期记忆写入成功后 fire `memory.remember` `{ actorId, kind, domain }`
   - `MemoryCortex.recall` 入口 fire `memory.recall` `{ actorId, query, domain }`（携带结果摘要）
   - `MemoryCortex.consolidate` 成功后 fire `memory.consolidate` `{ actorIds, stats }`

3. **建立订阅关系**：
   - `MemoryCortex` 在 `registerSynapseBus` 时自动订阅 `sensory.listen` 事件 → 自动 remember 感知到的用户语音
   - `LimbicCortex` 注册时订阅 `sensory.listen` / `sensory.look` → 更新情绪状态
   - 订阅回调中用 try/catch 包裹，避免异常传播

4. **装配**：在 create-app-services.ts 中 `brainCenter.registerSynapse(synapseBus)` 后，额外调用：
   ```typescript
   sensoryCortex.registerSynapseBus(synapseBus);
   memoryCortex.registerSynapseBus(synapseBus);
   ```

**Decision**：只建立 2-3 个关键订阅（sensory→memory 自动记忆、sensory→limbic 情绪更新），不做全量互联，避免过度工程化。

### Task 4: 修复 MessageHub 离线存储接口对齐（高优先级 #4）

**文件**：`server/src/brain/synapse-bus.ts`、`server/src/bootstrap/create-app-services.ts`

**What**：修改 `MessageHubLike` 接口，改用 `MessageHubService.createOutbound` 替代不存在的 `store` 方法。

**Why**：当前 `MessageHubService.store` 是 private 字段非函数，`sendToUser` 的离线存储降级路径永不触发，WS 推送失败时消息直接丢失。

**How**：
1. 修改 `synapse-bus.ts` 的 `MessageHubLike` 接口：
   ```typescript
   interface MessageHubLike {
     createOutbound(input: { actorId: string; conversationId?: string; text: string; platform?: string }): Promise<unknown>;
   }
   ```
2. 修改 `sendToUser` 中的离线存储调用（synapse-bus.ts:307 附近）：
   - 从 `typeof this.messageHub.store === "function"` 改为 `typeof this.messageHub.createOutbound === "function"`
   - 调用 `await this.messageHub.createOutbound({ actorId, text: typeof payload === "string" ? payload : JSON.stringify(payload) })`
3. 移除 create-app-services.ts:1144-1146 的 `as unknown as` 强制断言，直接传 `messageHubService`

### Task 5: BrainCenter 代理方法加 try/catch（中优先级 #5）

**文件**：`server/src/brain/brain-center.ts`

**What**：为 9 个代理方法的委托调用加 try/catch，与 `identifyGap` 保持一致。

**Why**：底层皮层抛非预期异常时会穿透 BrainCenter 传播到 HTTP 路由层，破坏"优雅降级"承诺。

**How**：对每个代理方法（listen/look/speak/remember/recall/fire/checkSafety/plan/routeSystem）的 `this.<cortex>.<method>()` 调用包裹 try/catch，catch 中返回与"皮层缺失"相同的降级默认值 + `console.log("[BrainCenter] <method> 调用失败: ${err}")`。

### Task 6: 修正 recall() 降级链（中优先级 #6）

**文件**：`server/src/brain/memory-cortex.ts`

**What**：把默认路径的 agentic + narrative 从"合并"改为"降级"——agentic 有结果就不调 narrative。

**Why**：当前即使 agentic 返回充足结果，narrative 仍会被调用，浪费一次召回。

**How**：修改 memory-cortex.ts:413-423，改为：
```typescript
let mergedItems: MemoryRecallItem[] = [];
if (this.agentic) {
  try {
    const agenticResult = await this.agentic.recall(...);
    mergedItems = agenticResult.items ?? [];
  } catch (err) { ... }
}
if (mergedItems.length === 0 && this.narrative) {
  try {
    const narrativeResult = await this.narrative.buildNarrativeRecall(...);
    mergedItems = narrativeResult.items ?? [];
  } catch (err) { ... }
}
// kvSummary 降级保持不变
```

### Task 7: recallCrossDomain 错误可观测（中优先级 #7）

**文件**：`server/src/brain/memory-cortex.ts`

**What**：把 `Promise.all` 中的 `.catch(() => null)` 改为带日志的 catch。

**Why**：当前召回失败完全静默吞掉，不可观测。

**How**：
```typescript
const results = await Promise.all(
  domains.map((d) =>
    this.recall(actorId, query, { domain: d }).catch((err) => {
      console.log(`[MemoryCortex] recallCrossDomain domain=${d} 失败: ${err}`);
      return null;
    }),
  ),
);
```

### Task 8: 优化环形缓冲实现（低优先级 #8）

**文件**：`server/src/brain/synapse-bus.ts`

**What**：把 `Array.push + shift` 改为 head/tail 指针的真正环形缓冲。

**Why**：`shift()` 是 O(n)，高频突触消息场景每条消息触发 100 次元素搬移。

**How**：实现简单的固定长度环形缓冲类 `RingBuffer<T>`，用 `head`/`tail` 指针 + 固定长度数组。或者简化方案：用 `Array` + `if (length > max) splice(0, 1)` 仍然是 O(n) 但避免 shift 的额外开销。考虑到 max=100 影响有限，**Decision**：用简单方案——如果性能不是瓶颈，可只改注释说明"实为动态数组，非真正环形缓冲"，或用 `splice(0, length - max)` 批量裁剪。实际优化价值低，优先做其他项。

### Task 9: 完善 snapshot 字段填充（低优先级 #9）

**文件**：`server/src/brain/brain-center.ts`

**What**：填充 `snapshot().memory.recentItems` 和 `snapshot().sensory.lastFrame`。

**Why**：当前 `memory.recentItems` 永远是空数组，`sensory.lastFrame` 从未填充，快照信息不完整。

**How**：
1. 给 `MemoryCortex` 新增 `getRecentRecalls(actorId, limit)` 方法（返回最近 recall 的结果摘要）
2. 给 `SensoryCortex` 新增 `getLastFrame()` 方法（返回最近一次 buildSensoryFrame 的结果）
3. 在 `brain-center.ts` 的 `snapshot()` 中调用这些方法填充字段
4. 注意 null 守卫

**Decision**：如果新增方法改动较大，可简化为：`memory.recentItems` 填 `[]`（保持现状但类型标注为"暂未填充"），`sensory.lastFrame` 填 `undefined`（已经是）。即此项可跳过或仅改注释。

### Task 10: HTTP 路由语义修正（低优先级 #10）

**文件**：`server/src/routes/http/brain.ts`

**What**：当 BrainCenter 的代理方法返回带 `error` 字段的结果时，HTTP 路由返回 503 而非 200。

**Why**：`BRAIN_NEURO_ENABLED=0` 时调用方误以为操作成功。

**How**：在每个路由 handler 中检查 `result.error`，有则 `reply.code(503).send({ ok: false, error: result.error })`。

### Task 11: endToEndVoice TODO 标注（低优先级 #11）

**文件**：`server/src/brain/sensory-cortex.ts`

**What**：保留 TODO 注释，不做实现（真正的端到端全双工语音是后续大特性）。

**Why**：当前简化实现可用，全双工语音 LLM 需要流式 ASR + 流式 LLM + 流式 TTS 的深度集成。

**How**：不改代码，仅确认 TODO 存在。**Decision**：此项实际无需改动。

## Assumptions & Decisions

1. **EmotionTone 注册为可选**：如果 `emotion-tone.ts` 函数签名与 `EmotionToneLike` 差异大，只做 TonePolicy
2. **MasterCoordinator 视依赖深度决定**：如果实例化 MasterAgentCoordinator 依赖链太深，先只注册 PlanExecuteLoop
3. **突触事件闭环只做 2-3 个关键订阅**：sensory→memory 自动记忆、sensory→limbic 情绪更新，不做全量互联
4. **环形缓冲优化优先级最低**：max=100 影响有限，可只改注释或用简单方案
5. **snapshot 字段填充可简化**：如果新增 getRecentRecalls/getLastFrame 改动大，可跳过
6. **endToEndVoice 无需改动**：确认 TODO 存在即可

## Verification Steps

1. `npx tsc --noEmit` 零错误
2. `BRAIN_NEURO_ENABLED=0` 降级：5 个新分区不实例化，旧 4 皮层行为不变，HTTP 返回 503
3. `BRAIN_NEURO_ENABLED=1`：9 分区全部注册，突触事件闭环 fire+subscribe 生效
4. 离线存储：WS 推送失败时 `messageHubService.createOutbound` 被调用
5. recall 降级链：agentic 有结果时不调 narrative
6. 错误可观测：recallCrossDomain 失败有日志
7. 代理方法异常：底层抛异常时 BrainCenter 返回降级默认值不崩溃

## Implementation Order

1. Task 4（MessageHub 接口对齐）— 独立，简单
2. Task 5（代理方法 try/catch）— 独立，机械
3. Task 6+7（recall 降级链 + 错误可观测）— 同文件，合并
4. Task 8（环形缓冲）— 独立，低优先级
5. Task 10（HTTP 503 语义）— 独立，简单
6. Task 1（LimbicCortex 子系统）— 需读取函数模块
7. Task 2（PlannerCortex 子系统）— 需确认 MasterAgentCoordinator 依赖
8. Task 3（突触事件闭环）— 依赖 Task 1-2 完成后的皮层注册
9. Task 9（snapshot 填充）— 可选
10. Task 11（endToEndVoice TODO）— 无需改动
