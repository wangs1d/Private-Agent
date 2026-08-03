# BrainCenter 类人化决策架构 —— 收尾计划（Step 7-9）

## 摘要

前序工作已完成 Step 1-6：
- 新建 `server/src/brain/rule-router.ts`（规则路由器，7 级优先级匹配）
- 新建 `server/src/brain/action-executor.ts`（统一动作执行层，含安全检查 + 日志）
- 新建 `server/src/brain/decision-hub.ts`（决策中心协调层，统一被动/主动认知能力）
- 修改 `server/src/brain/brain-stem.ts`（事件驱动 + 注意力调度，含 `AttentionFocus`/`BrainStemEventName`/`setAttentionFocus`/`registerEventTrigger`/`triggerEvent`/`adjustSampleRateByAttention`/`getStats`）
- 修改 `server/src/brain/cerebellum.ts`（动态犹豫期 + 动态打断抑制，基于 `SignalImportance` 计算，含 `computeHesitation`/`computeSuppressWindow`/`lastSpeakImportance`/`dynamicHesitateCount`/`dynamicSuppressCount`）
- 修改 `server/src/brain/brain-center.ts`（cognize 阶段 2 优先调用 `decisionHub.decidePassive`，回退到 `cognitiveEngine`，含 `setDecisionHub`/`getDecisionHub`）
- 修改 `server/src/bootstrap/create-app-services.ts`（行 1890-1921 装配 `RuleRouter`/`ActionExecutor`/`DecisionHub`，注入 `LimbicCortex`/`MemoryCortex`/`AwarenessCortex`/`CapabilityCortex`，调用 `brainCenter.setDecisionHub(decisionHub)`）

**关键缺口**：`create-app-services.ts` 行 216-218 已 import `RuleRouter, ActionExecutor, DecisionHub`，但 `server/src/brain/index.ts` 当前只导出原 11 个分区类，**未导出这 3 个新模块**——这会导致 `tsc` 编译失败（`Module has no exported member 'RuleRouter'`），整个服务器无法启动。

**剩余工作**：
- Step 7：更新 `index.ts` 导出新模块（关键编译缺口）
- Step 8：创建端到端测试脚本，覆盖 8 类场景
- Step 9：tsc 验证 + 运行测试 + 反馈结果

---

## 当前状态分析

### Step 7 缺口确认

**当前 `server/src/brain/index.ts`**（共 15 行，缺 3 个导出）：

```typescript
export * from "./types.js";
export { BrainCenter } from "./brain-center.js";
export { CapabilityCortex } from "./capability-cortex.js";
export { AwarenessCortex } from "./awareness-cortex.js";
export { ProactionCortex, type EndToEndDecisionMaker, type EndToEndDecisionContext, type MemoryCortexLike } from "./proaction-cortex.js";
export { EvolutionCortex } from "./evolution-cortex.js";
export { SensoryCortex } from "./sensory-cortex.js";
export { MemoryCortex } from "./memory-cortex.js";
export { SynapseBus } from "./synapse-bus.js";
export { LimbicCortex } from "./limbic-cortex.js";
export { PlannerCortex } from "./planner-cortex.js";
export { BrainStem } from "./brain-stem.js";
export { Cerebellum } from "./cerebellum.js";
```

**需补充**：
```typescript
export { RuleRouter, type RuleRouteDecision } from "./rule-router.js";
export { ActionExecutor, type ActionLogEntry, type ActionResult, type ToolRegistryLike, type LimbicCortexLike as ActionExecutorLimbicLike } from "./action-executor.js";
export { DecisionHub, type PassiveDecisionResult, type SharedContext, type MemoryCortexLike as DecisionHubMemoryLike, type AwarenessCortexLike as DecisionHubAwarenessLike, type CapabilityCortexLike as DecisionHubCapabilityLike } from "./decision-hub.js";
```

### 测试脚本参考

`server/scripts/stress-should-delegate.ts` 是同类参考：纯规则模块（PlannerCortex.shouldDelegate）的压力测试，通过 `npx tsx scripts/xxx.ts` 运行，无需启动服务器。本次测试脚本采用相同模式。

---

## 实施步骤

### Step 7：更新 `server/src/brain/index.ts` 导出新模块

**文件**：[server/src/brain/index.ts](file:///e:/ws-project/Private-Agent/server/src/brain/index.ts)

**改动**：在文件末尾（Cerebellum 导出后）追加 3 行导出。

```typescript
// Step 6 扩展：类人化决策架构新模块（规则驱动 + 统一动作 + 决策协调）
export { RuleRouter, type RuleRouteDecision } from "./rule-router.js";
export { ActionExecutor, type ActionLogEntry, type ActionResult } from "./action-executor.js";
export { DecisionHub, type PassiveDecisionResult, type SharedContext } from "./decision-hub.js";
```

**风险**：与 `proaction-cortex.ts` 已导出的 `MemoryCortexLike` 同名冲突 → 不导出 `decision-hub.ts` 内部的 `*Like` 接口（仅 module 内部使用），只导出主类和外部测试需要的类型。

### Step 8：创建端到端测试脚本

**文件**：新建 `server/scripts/test-decision-hub-e2e.ts`

**目标**：覆盖 8 类场景，输出对比表 + 通过率统计，反馈给用户。

**测试架构**（不启动服务器，纯单元/集成测试）：

```typescript
import { performance } from "node:perf_hooks";
import { RuleRouter } from "../src/brain/rule-router.js";
import { ActionExecutor } from "../src/brain/action-executor.js";
import { DecisionHub } from "../src/brain/decision-hub.js";
import { BrainStem, type AttentionFocus } from "../src/brain/brain-stem.js";
import { Cerebellum } from "../src/brain/cerebellum.js";
import type { BrainDecision, BrainSignalInput } from "../src/brain/types.js";
```

**8 类测试场景**：

| # | 场景 | 测试对象 | 输入 | 期望 | 验证点 |
|---|------|---------|------|------|--------|
| 1 | 闲聊路由 | RuleRouter | "你好"、"在吗"、"今天怎么样" | mode=direct_llm, conf=0.9, system=system1 | 命中 chitchat 规则 |
| 2 | 简单工具路由 | RuleRouter | "今天天气"、"现在几点"、"明天日历" | mode=direct_llm, conf=0.85, needsToolLoop=true | 命中 simple_tool 规则 |
| 3 | 复杂任务委派 | RuleRouter | "帮我调研GLM5.2"、"写个Python脚本"、"截屏操作电脑" | mode=master_delegate, conf=0.8, agentType=tech/info | 命中 delegate_multi_step 规则 |
| 4 | 紧急事务 | RuleRouter + DecisionHub | "转账500给张三"、"帮我付款" | mode=master_delegate, conf=0.95, action=safety_check | 命中 urgent 规则 + safety_check action 触发 |
| 5 | DecisionHub 端到端 | DecisionHub | 各类用户消息 + mock 上下文 | 完整 PassiveDecisionResult {route, response, memoryWrites, action, needsToolLoop, confidence} | response 始终为空、memoryWrites 含 episodic 记忆、紧急事务触发 action |
| 6 | BrainStem 注意力调度 | BrainStem | setAttentionFocus("waiting_delivery") | 采样率从 45s → 30s | getStats() 反映 attentionChangeCount + 采样率变化 |
| 7 | Cerebellum 动态犹豫期 | Cerebellum | 不同 importance 信号（critical/high/medium/low） | hesitateMs 落入对应区间 | critical 0.3-0.8s / high 0.8-2s / medium 1.5-3.5s / low 3-6s |
| 8 | Cerebellum 打断抑制 | Cerebellum | 先 schedule(critical) → interrupt → schedule again | suppressMs 落入对应区间，defer 队列被清空 | critical 5s / high 30s / medium 60s / low 120s |

**辅助 mock**：

```typescript
// mock ToolRegistry
const mockToolRegistry = {
  execute: async (name, args) => {
    if (name === "safety_check") return { ok: true, result: { checked: true } };
    return { ok: true, result: { echoed: name } };
  },
};

// mock LimbicCortex（让安全检查通过，紧急事务验证 action 路径）
const mockLimbic = {
  checkSafety: (action) => ({ allowed: true, severity: "allowed", reason: "test_pass", tool: action.tool, args: action.args, checkedAt: new Date().toISOString() }),
};

// mock Memory/Awareness/Capability（DecisionHub 测试用）
const mockMemory = {
  remember: async () => {},
  recall: async () => ({ items: [] }),
};
const mockAwareness = {
  observe: () => ({ activity: "idle", kind: "desktop", occurredAt: new Date().toISOString() }),
};
const mockCapability = {
  snapshot: () => [],
  introspect: () => [],
};
```

**测试输出格式**：

```
=== BrainCenter 类人化决策架构 端到端测试 ===

【场景 1: 闲聊路由】
  ✓ "你好" → mode=direct_llm, conf=0.90, rule=chitchat:你好
  ✓ "在吗" → mode=direct_llm, conf=0.50, rule=no_match:default_direct_llm  ⚠️ 未命中闲聊关键词（在吗不在白名单）
  ...

【场景 4: 紧急事务】
  ✓ "转账500给张三" → mode=master_delegate, conf=0.95, action=safety_check
  ...

=== 测试结果 ===
通过: 18/20 (90%)
失败: 2
  - [场景1] "在吗" 未命中闲聊白名单（建议加入 CHITCHAT_KEYWORDS）
  - [场景3] "帮我调研GLM5.2" 步骤数不足（建议补充 ACTION_VERBS）

性能：
  RuleRouter.route 平均耗时: 0.05ms
  DecisionHub.decidePassive 平均耗时: 1.2ms
  Cerebellum.computeHesitation 平均耗时: 0.01ms
```

**测试脚本结构**：

```typescript
// 1. 全局测试结果收集
const results: Array<{ scenario: string; case: string; passed: boolean; expected: string; actual: string; note?: string }> = [];

// 2. 辅助断言函数
function assert(scenario, caseName, expected, actual, passed, note?) { ... }

// 3. 8 个测试场景函数
async function testScenario1_chitchat() { ... }
async function testScenario2_simpleTool() { ... }
async function testScenario3_delegate() { ... }
async function testScenario4_urgent() { ... }
async function testScenario5_decisionHub() { ... }
async function testScenario6_brainStemAttention() { ... }
async function testScenario7_cerebellumHesitate() { ... }
async function testScenario8_cerebellumInterrupt() { ... }

// 4. 主函数：运行所有场景 + 输出统计
async function main() {
  await testScenario1_chitchat();
  ...
  printSummary();
}

main().catch(console.error);
```

**验证点（对应"反馈给用户"内容）**：
1. 路由准确率（与期望路由的匹配度）
2. cognize 产出完整性（response/memoryWrites/action/confidence 全部有值）
3. 动态计算正确性（不同 importance 对应不同 hesitateMs/suppressMs）
4. 注意力调度生效（不同 focus 对应不同采样率）
5. 性能指标（RuleRouter/DecisionHub/Cerebellum 平均耗时）

### Step 9：tsc 编译验证 + 运行测试 + 反馈结果

**编译验证**：

```bash
cd server && npx tsc --noEmit
```

预期：0 错误。若出错，根据错误信息修复（最可能的错误：`index.ts` 未导出导致 `create-app-services.ts` import 失败）。

**运行测试**：

```bash
cd server && npx tsx scripts/test-decision-hub-e2e.ts
```

预期：通过率 ≥ 90%。失败 case 反馈给用户决定是否调整规则词典。

**反馈内容**（最终响应给用户）：
- 8 类场景的测试结果（通过率）
- 路由准确率
- 与改造前的对比（cognize 极简版 vs 端到端版）
- 规则命中分析（哪些规则命中、哪些没命中、建议补充的关键词）
- 性能指标（cognize 耗时、规则匹配耗时）
- BrainStem 事件触发 + 注意力调度验证
- Cerebellum 动态犹豫期 + 打断抑制验证

---

## 假设与决策

### 假设
1. **Step 1-6 实现已正确**：通过 Read 已确认 rule-router.ts/action-executor.ts/decision-hub.ts 内容完整；brain-stem.ts/cerebellum.ts/brain-center.ts/create-app-services.ts 修改已落地。
2. **测试不依赖完整服务器**：RuleRouter/ActionExecutor/DecisionHub/Cerebellum 可独立实例化；BrainStem 需 mock 依赖（Hub/Sensory/Personalization）。
3. **mock 接口与实际接口兼容**：通过 `as unknown as XxxLike` 绕过严格类型检查，仅测试核心逻辑。

### 决策
1. **不导出 `*Like` 接口**：`decision-hub.ts` 内部的 `MemoryCortexLike`/`AwarenessCortexLike`/`CapabilityCortexLike` 与 `proaction-cortex.ts` 已导出的 `MemoryCortexLike` 同名，避免冲突只导出主类和外部测试需要的类型。
2. **测试用 mock 而非真实服务**：避免启动完整服务器的复杂性（DB/Redis/外部 API 依赖），聚焦验证决策逻辑正确性。
3. **Cerebellum 测试用 setTimeout mock**：通过 `jest.useFakeTimers` 模式不可用（非 jest），改用直接调用 `computeHesitation`/`computeSuppressWindow` 的私有方法验证（通过 `as any` 访问），或通过 schedule/interrupt 公开 API 间接验证。
4. **测试脚本包含修复建议**：若某些 case 未命中规则（如"在吗"不在 CHITCHAT_KEYWORDS），测试输出建议补充，由用户决定是否调整。

### 不做的事
- 不修改 Step 1-6 已完成的实现代码（除非 tsc 报错或测试发现 bug）
- 不修改 `brain-stem.ts`/`cerebellum.ts`/`brain-center.ts`/`create-app-services.ts` 的现有逻辑
- 不启动完整服务器测试（避免外部依赖）
- 不补充 Step 1-6 计划外的功能（如事件触发订阅源注册、PlannerCortex.executeWithToolExecutor 改委托 ActionExecutor——这些是后续优化项，本次只验证已实现的 3 模块 + 2 修改）

---

## 验证步骤

### 编译验证（Step 9.1）
```bash
cd server && npx tsc --noEmit 2>&1 | head -50
```
预期：0 errors。

### 测试运行（Step 9.2）
```bash
cd server && npx tsx scripts/test-decision-hub-e2e.ts
```
预期输出：8 类场景测试结果 + 通过率统计 + 性能指标。

### 反馈给用户（Step 9.3）
整理测试输出，反馈：
1. 编译是否通过
2. 8 类场景通过率
3. 关键 bug 修复（如有）
4. 规则词典补充建议（如有）
5. 性能数据
6. 类人化效果对比（cognize 极简版 vs 端到端版）

---

## 文件清单

### 修改文件
- [server/src/brain/index.ts](file:///e:/ws-project/Private-Agent/server/src/brain/index.ts) — 追加 3 个新模块导出（Step 7）

### 新建文件
- `server/scripts/test-decision-hub-e2e.ts` — 端到端测试脚本（Step 8）

### 不修改文件
- Step 1-6 已完成的所有文件（rule-router.ts/action-executor.ts/decision-hub.ts/brain-stem.ts/cerebellum.ts/brain-center.ts/create-app-services.ts）
- 现有 11 个分区类的实现
- HTTP 路由 / brain.* 工具 / agent-core 接入点

---

## 预期收益

1. **编译缺口闭合**：Step 7 修复后 `tsc` 通过，服务器可启动
2. **端到端可验证**：8 类场景量化验证类人化效果
3. **反馈给用户**：测试结果输出 + 规则命中率分析 + 性能数据
4. **规则词典优化建议**：未命中 case 提供补充建议
5. **类人化效果对比**：cognize 极简版（只产 {mode, rationale}）vs 端到端版（产 {route, response, memoryWrites, action, needsToolLoop, confidence, confidenceReason}）
