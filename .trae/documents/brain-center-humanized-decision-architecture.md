# BrainCenter 类人化决策架构重组计划

## 摘要

用户提出"决策中心 + 主动行动 + 持续感知"大模块方案，希望主 Agent 真正像人一样决策、感知、主动。经探索发现：现有 BrainCenter 的 11 分区骨架已经实现了三大模块的雏形（决策中心=cognize+ProactionCortex、主动行动=executeProactiveDecision、持续感知=BrainStem），但存在三大瓶颈：
1. **cognize 退化为路由器**：只产出 `{mode, rationale}`，丢失了响应/记忆/动作/置信度，导致阶段 2.5/3 全部失效
2. **动作执行三处分散**：ProactionCortex.executeActions + executeProactiveDecision 的 LLM function calling + PlannerCortex.executeWithToolExecutor 互相割裂
3. **持续感知是定时器**：BrainStem 45s 固定轮询，缺少事件驱动和注意力调整

**核心约束**（用户明确）：cognize **不能用 prompt 驱动路由判断**，会导致主 agent 幻觉（之前正是因此被砍掉）。

**解决方案**：分层驱动——路由层走规则（不调 LLM），响应层保留 streamCompletion，记忆/动作/置信度规则化生成。在现有 BrainCenter 内重组，不推翻 11 分区结构。

---

## 当前状态分析

### 现有架构骨架（可保留）

| 模块 | 文件 | 现状 | 质量 |
|------|------|------|------|
| Cerebellum（小脑时序） | [cerebellum.ts](file:///e:/ws-project/Private-Agent/server/src/brain/cerebellum.ts) | defer 队列 + 2min reaper + 60s 打断抑制 | 良好，保留 |
| BrainStem（脑干感知） | [brain-stem.ts](file:///e:/ws-project/Private-Agent/server/src/brain/brain-stem.ts) | 45s 心跳 + 5 类检测 + 合成信号 | 良好，需扩展 |
| ProactionCortex 评分 | [proaction-cortex.ts](file:///e:/ws-project/Private-Agent/server/src/brain/proaction-cortex.ts#L350-L466) | value/disturb 双轨 + 人格阈值 | 良好，保留算法 |
| PlannerCortex.shouldDelegate | [planner-cortex.ts](file:///e:/ws-project/Private-Agent/server/src/brain/planner-cortex.ts#L892-L941) | 关键词规则委派判断 | 可用，需扩展为多类路由 |
| executeProactiveDecision | [create-app-services.ts](file:///e:/ws-project/Private-Agent/server/src/bootstrap/create-app-services.ts#L1282-L1478) | LLM function calling + 分段投递 + 记忆写入 | 良好，但与 ActionExecutor 重叠 |

### 三大瓶颈（必须修复）

#### 瓶颈 1：cognize 极简退化

**位置**：[create-app-services.ts:1813-1884](file:///e:/ws-project/Private-Agent/server/src/bootstrap/create-app-services.ts#L1813-L1884)

```typescript
// 当前实现：只用 LLM 判断是否委派子 Agent
const prompt = `你是路由决策器。只判断一件事：用户消息是否需要委派子 Agent 处理。...`;
// 只输出 {"mode", "rationale"}，丢失 response/memoryWrites/action/confidence
return { route, response: "", memoryWrites: [], needsToolLoop: true, rationale };
```

**连锁失效**：
- [brain-center.ts:554-583](file:///e:/ws-project/Private-Agent/server/src/brain/brain-center.ts#L554-L583) 阶段 2.5 低置信度升级永远不触发（confidence 永远 undefined）
- [brain-center.ts:609-617](file:///e:/ws-project/Private-Agent/server/src/brain/brain-center.ts#L609-L617) 记忆写入循环永远不执行（memoryWrites 永远空）
- [brain-center.ts:586-593](file:///e:/ws-project/Private-Agent/server/src/brain/brain-center.ts#L586-L593) action 安全检查永远走 no_action 分支
- [agent-core.ts:591-610](file:///e:/ws-project/Private-Agent/server/src/services/agent-core.ts#L591-L610) "cognize 直返响应"分支几乎永远不命中

#### 瓶颈 2：动作执行三处分散

| 路径 | 文件位置 | 触发 | 绕过小脑 |
|------|---------|------|---------|
| ProactionCortex.executeActions | [proaction-cortex.ts:436-444, 517-534](file:///e:/ws-project/Private-Agent/server/src/brain/proaction-cortex.ts#L436-L444) | 规则关键词匹配 | **是**（decide 阶段直接执行） |
| executeProactiveDecision LLM | [create-app-services.ts:1343-1361](file:///e:/ws-project/Private-Agent/server/src/bootstrap/create-app-services.ts#L1343-L1361) | LLM function calling | 否（小脑调度后） |
| PlannerCortex.executeWithToolExecutor | [planner-cortex.ts:766-822](file:///e:/ws-project/Private-Agent/server/src/brain/planner-cortex.ts#L766-L822) | plan_execute fallback | 否 |

**问题**：三处动作执行可能冲突（如出行信号：路径 1 立即创建日程，路径 2 LLM 也调 calendar.create_task），且日志分散、安全检查不一致。

#### 瓶颈 3：持续感知机械感

- [brain-stem.ts:161-183](file:///e:/ws-project/Private-Agent/server/src/brain/brain-stem.ts#L161-L183) 固定 45s 心跳（虽有动态采样率但本质是轮询）
- 缺少事件驱动机制（异常事件应触发即时扫描）
- 缺少注意力调度（如等快递时应频繁看手机，但当前无法调整焦点）
- [cerebellum.ts](file:///e:/ws-project/Private-Agent/server/src/brain/cerebellum.ts) 犹豫期是 0.8-2.5s 随机数，不基于信号重要性

---

## 设计方案：分层驱动 + 三大模块重组

### 核心原则

1. **路由层规则驱动**（不调 LLM）：扩展 PlannerCortex.shouldDelegate 为多类路由判断，输出 `{mode, confidence, reason}`
2. **响应层保留 streamCompletion**：cognize 不直接生成响应，避免幻觉（用户明确要求）
3. **记忆层规则化生成**：基于路由结果 + 用户消息 + 工具调用历史，规则化生成记忆条目
4. **动作层统一执行**：新建 ActionExecutor 合并三处动作执行，统一调度/日志/安全检查
5. **置信度规则计算**：路由匹配强度 + 历史相似度 + 工具能力覆盖度

### 三大模块对应关系

| 用户期望模块 | 实现方案 | 文件位置 |
|------------|---------|---------|
| **决策中心** | DecisionHub 协调 cognize（被动）+ decide（主动），共享认知能力 | 新建 `server/src/brain/decision-hub.ts` |
| **主动行动** | ActionExecutor 合并三处动作执行，支持规则触发 + LLM 决策 | 新建 `server/src/brain/action-executor.ts` |
| **持续感知** | BrainStem 扩展事件驱动 + 注意力调度器 | 修改 `server/src/brain/brain-stem.ts` |
| **时序协调** | Cerebellum 犹豫期动态计算 + 打断抑制窗口基于信号重要性 | 修改 `server/src/brain/cerebellum.ts` |

---

## 实施步骤

### Step 1：新建规则驱动的路由器（替代 LLM 路由判断）

**文件**：新建 `server/src/brain/rule-router.ts`

**职责**：扩展 PlannerCortex.shouldDelegate 为多类路由判断，输出完整路由决策，**不调 LLM**

**路由分类**：
- `direct_llm`：闲聊/简单问答/简单工具调用（天气/时钟/日历）→ 主 Agent 自处理 + 工具循环
- `master_delegate`：深度调研/写代码/桌面自动化/转账下单/写文案/复杂多步 → 委派子 Agent
- `master_only`：主 Agent 带工具先试，失败再升级（保留但当前与 direct_llm 合并）
- 紧急/敏感场景（转账/支付）→ master_delegate + confidence=0.95

**规则匹配维度**：
1. 关键词匹配（扩展现有 `DELEGATE_KEYWORDS`）
2. 信号类型映射（如 transaction_completed → financial 路由）
3. 工具能力覆盖度（CapabilityCortex.snapshot 检查是否有对应能力）
4. 历史模式匹配（最近 5 轮同类查询的路由历史）
5. 上下文信号（是否有追问指代词如"那个/它/前面那个"）

**输出**：
```typescript
interface RuleRouteDecision {
  mode: "direct_llm" | "master_delegate" | "master_only";
  confidence: number;       // 0-1，规则匹配强度
  reason: string;           // 规则命中说明
  matchedRules: string[];   // 命中的规则列表（用于调试）
  system: "system1" | "system2";
}
```

**置信度计算**：
- 命中明确关键词（如"转账"/"付款"）→ 0.95
- 命中委派倾向词 + 步骤数 > 3 → 0.8
- 命中闲聊关键词（"你好"/"在吗"）→ 0.9（direct_llm）
- 模糊匹配（部分关键词命中）→ 0.5-0.7
- 无匹配 → 0.5（默认 direct_llm）

**接入点**：
- BrainCenter.cognize 阶段 2 调用 `ruleRouter.route(query, context)` 替代当前 LLM 路由
- BrainCenter.routeSystem 兜底路径仍保留（ruleRouter 失败时降级）

### Step 2：新建统一 ActionExecutor

**文件**：新建 `server/src/brain/action-executor.ts`

**职责**：合并三处动作执行，统一调度/日志/安全检查

**动作类型**：
- `environment_control`：环境控制（关窗/调空调/创建日程），规则触发
- `tool_call`：工具调用（天气/搜索/日历），LLM 决策或规则触发
- `subagent_delegate`：子 Agent 委派，PlannerCortex 触发
- `notification`：消息推送，规则触发

**核心方法**：
```typescript
class ActionExecutor {
  // 统一执行入口
  async execute(actions: BrainDecisionAction[], opts: {
    actorId: string;
    source: "proaction" | "cognize" | "planner";
    signalKind?: string;
  }): Promise<ActionResult[]>

  // 安全检查（统一）
  private checkActionSafety(action: BrainDecisionAction): SafetyCheckResult

  // 执行日志（统一）
  private logAction(action: BrainDecisionAction, result: ActionResult): void
}
```

**接入点**：
- ProactionCortex.decide 阶段 3 调用 `actionExecutor.execute(actions, {source: "proaction"})` 替代直接 `executeActions`
- executeProactiveDecision 的 LLM function calling 通过 actionExecutor 调度
- PlannerCortex.executeWithToolExecutor 改为调用 actionExecutor

**BrainCenter 注入**：
- BrainCenter 持有 actionExecutor 实例
- ProactionCortex/PlannerCortex 通过 BrainCenter 获取引用

### Step 3：新建 DecisionHub 协调层（被动+主动统一决策）

**文件**：新建 `server/src/brain/decision-hub.ts`

**职责**：统一 cognize（被动）+ decide（主动）的协调层，共享认知能力

**核心方法**：
```typescript
class DecisionHub {
  // 统一决策入口
  async decide(input: DecisionInput): Promise<DecisionResult>
  // input 类型区分被动/主动：
  //   - 被动：用户消息触发
  //   - 主动：LifeSignal 触发

  // 共享认知能力
  private async gatherContext(actorId: string, query: string): Promise<SharedContext>
  // 召回记忆、用户状态、最近决策、能力快照

  private async persistMemory(actorId: string, decision: DecisionResult): Promise<void>
  // 统一记忆写入（对话记忆 + 主动话术记忆）
}
```

**与 BrainCenter 关系**：
- BrainCenter.cognize 内部委托给 DecisionHub.decide（被动路径）
- BrainCenter.decide 内部委托给 DecisionHub.decide（主动路径）
- DecisionHub 共享 SharedContext（记忆/状态/能力），避免 cognize 和 decide 各自独立召回

**共享认知能力**：
- 记忆召回：复用 MemoryCortex.recall，避免 cognize 和 ProactionCortex.recallRecentMemories 重复召回
- 用户状态感知：复用 AwarenessCortex.observe
- 最近决策上下文：复用 ProactionCortex.recentDecisions
- 能力快照：复用 CapabilityCortex.snapshot

### Step 4：BrainStem 扩展事件驱动 + 注意力调度

**文件**：修改 `server/src/brain/brain-stem.ts`

**新增能力**：

#### 4.1 事件订阅机制
```typescript
// 异常事件触发即时扫描（替代纯定时器）
registerEventTrigger(eventName: string, handler: () => void): void
// 订阅事件类型：
//   - transaction_completed（交易完成）
//   - mood_shift（情绪突变）
//   - desktop_app_focus_changed（应用切换）
//   - schedule_task_due（日程到期）
//   - user_idle_too_long（用户长时间空闲）
```

事件触发时立即调 `sweepActor(actorId)`，不等 45s 心跳。

#### 4.2 注意力调度器
```typescript
// 根据当前任务调整感知焦点
setAttentionFocus(actorId: string, focus: AttentionFocus): void
// AttentionFocus:
//   - waiting_delivery: 等快递 → 30s 采样
//   - waiting_message: 等消息 → 60s 采样
//   - in_meeting: 会议中 → 300s 采样（不打扰）
//   - default: 默认 → 45s 采样
```

注意力焦点由 ProactionCortex 决策时设置（如检测到用户说"等快递"→设为 waiting_delivery）。

#### 4.3 保留 45s 心跳作为 baseline
- 心跳扫描仍然运行，作为"无事件时的兜底感知"
- 事件触发时跳过下一次心跳（避免重复扫描）
- 注意力焦点覆盖心跳间隔（waiting_delivery 时心跳改为 30s）

### Step 5：Cerebellum 犹豫期动态计算

**文件**：修改 `server/src/brain/cerebellum.ts`

**改造点**：

#### 5.1 犹豫期基于信号重要性动态计算
```typescript
// 替代当前 HESITATE_MIN_MS / HESITATE_MAX_MS 固定随机
private computeHesitation(signal: BrainSignalInput): number {
  const importance = signal.importance ?? "medium";
  switch (importance) {
    case "critical": return 300 + Math.random() * 500;   // 0.3-0.8s（紧急立即说）
    case "high":     return 800 + Math.random() * 1200;  // 0.8-2.0s
    case "medium":   return 1500 + Math.random() * 2000; // 1.5-3.5s
    case "low":      return 3000 + Math.random() * 3000; // 3-6s（不重要多想想）
  }
}
```

#### 5.2 打断抑制窗口基于信号重要性
```typescript
// 替代当前 SUPPRESS_WINDOW_MS 固定 60s
private computeSuppressWindow(signal: BrainSignalInput): number {
  const importance = signal.importance ?? "medium";
  switch (importance) {
    case "critical": return 5_000;   // 5s（紧急情况短抑制，快速恢复主动）
    case "high":     return 30_000;  // 30s
    case "medium":   return 60_000;  // 60s（当前默认）
    case "low":      return 120_000; // 2min（不重要就多等会儿）
  }
}
```

#### 5.3 犹豫期二次校验
- 犹豫结束后不仅查抑制窗口，还查用户是否在说话（通过 SensoryCortex 监测）
- 若用户正在说话 → 延迟 1s 后再试（避免抢话）

### Step 6：cognize 端到端恢复

**文件**：修改 `server/src/brain/brain-center.ts` + `server/src/bootstrap/create-app-services.ts`

**改造点**：

#### 6.1 替换 CognitiveEngine 实现
- 删除 [create-app-services.ts:1813-1884](file:///e:/ws-project/Private-Agent/server/src/bootstrap/create-app-services.ts#L1813-L1884) 的 LLM 路由 prompt
- 新 CognitiveEngine 实现：
  ```typescript
  const cognitiveEngine: CognitiveEngine = {
    async cognize(input, ctx) {
      // 1. 规则路由（不调 LLM）
      const route = ruleRouter.route(input.text, ctx);
      
      // 2. 响应：保留空字符串（让 streamCompletion 生成，避免幻觉）
      const response = "";
      
      // 3. 记忆写入：规则化生成
      const memoryWrites = generateMemoryWrites(input, route, ctx);
      
      // 4. 动作：基于路由结果 + 信号类型规则触发
      const action = inferActionFromRoute(route, input);
      
      // 5. 置信度：规则计算
      const confidence = route.confidence;
      
      // 6. needsToolLoop：direct_llm 时 true（让主 Agent 走工具循环）
      const needsToolLoop = route.mode === "direct_llm" || route.mode === "master_only";
      
      return { route, response, memoryWrites, action, needsToolLoop, rationale: route.reason, confidence, confidenceReason: route.reason };
    }
  };
  ```

#### 6.2 恢复阶段 2.5/3 的有效性
- 阶段 2.5 低置信度升级：confidence 现在有真实值，< 0.4 时触发升级
- 阶段 3 记忆写入：memoryWrites 现在有真实条目，循环执行
- 阶段 3 动作安全检查：action 现在有真实动作，checkSafety 真实执行

#### 6.3 记忆写入规则化生成
```typescript
function generateMemoryWrites(input, route, ctx): MemoryItem[] {
  const writes: MemoryItem[] = [];
  
  // 路由 1：master_delegate → 写入"任务委派"记忆
  if (route.mode === "master_delegate") {
    writes.push({
      kind: "procedural",
      content: `委派子 Agent 处理：${input.text}`,
      tags: ["delegation", route.reason],
    });
  }
  
  // 路由 2：direct_llm + 检测到工具意图 → 写入"工具使用"记忆
  if (route.mode === "direct_llm" && detectToolIntent(input.text)) {
    writes.push({
      kind: "procedural",
      content: `用户请求工具辅助：${input.text}`,
      tags: ["tool_intent", detectToolIntent(input.text)],
    });
  }
  
  // 通用：写入对话上下文记忆
  writes.push({
    kind: "episodic",
    content: `用户问：${input.text}（路由：${route.mode}）`,
    tags: ["conversation", route.mode],
  });
  
  return writes;
}
```

### Step 7：BrainCenter 装配重组

**文件**：修改 `server/src/bootstrap/create-app-services.ts`

**装配顺序**：
1. 创建 RuleRouter
2. 创建 ActionExecutor
3. 创建 DecisionHub（注入 ruleRouter + actionExecutor）
4. BrainCenter.setDecisionHub(decisionHub)
5. ProactionCortex.setActionExecutor(actionExecutor)
6. PlannerCortex.setActionExecutor(actionExecutor)
7. BrainStem.registerEventTriggers(...)
8. BrainCenter.registerCognitiveEngine(newCognitiveEngine)

### Step 8：端到端测试场景

**文件**：新建 `server/scripts/test-decision-hub-e2e.ts`

**测试场景**（覆盖 8 类用例，每类 2-3 个 case）：

| # | 场景类型 | 测试输入 | 期望路由 | 期望动作 | 期望置信度 |
|---|---------|---------|---------|---------|-----------|
| 1 | 闲聊 | "你好"/"在吗"/"今天怎么样" | direct_llm | 无 | 0.9 |
| 2 | 简单工具 | "今天天气"/"现在几点"/"明天日历" | direct_llm + 工具循环 | 无 | 0.85 |
| 3 | 复杂任务 | "帮我调研GLM5.2"/"写个Python脚本"/"截屏操作电脑" | master_delegate | subagent_delegate | 0.85 |
| 4 | 紧急事务 | "转账500给张三"/"帮我付款" | master_delegate | subagent_delegate + safety_check | 0.95 |
| 5 | 持续感知 | 模拟 sustained_busy 信号 | silent/speak | BrainStem 检测 + ProactionCortex 决策 | - |
| 6 | 主动行动 | 模拟 late_night_active 信号 | speak | environment_control + 话术推送 | - |
| 7 | 犹豫与打断 | 用户开口时主动行动 defer 中 | silent | Cerebellum 取消执行 + 60s 抑制 | - |
| 8 | 注意力可调 | 检测"等快递"语义 | direct_llm | BrainStem.setAttentionFocus("waiting_delivery") | 0.8 |

**测试输出**：
- 每个场景的实际路由/动作/置信度
- 与期望的对比（通过/失败）
- 规则命中列表（用于调试）
- 性能指标（cognize 耗时、规则匹配耗时）

**反馈给用户的内容**：
- 8 类场景的测试结果（通过率）
- 路由准确率（与期望路由的匹配度）
- 与改造前的对比（cognize 极简版 vs 端到端版）
- 规则命中率分析（哪些规则命中、哪些没命中）
- 性能对比（cognize 耗时变化）

---

## 假设与决策

### 假设
1. **规则驱动路由能覆盖 80%+ 场景**：基于现有 PlannerCortex.shouldDelegate 的关键词匹配已能覆盖主要委派场景，扩展后应能覆盖更广
2. **ActionExecutor 统一后不损失性能**：动作执行本来就是异步的，统一调度层开销可忽略
3. **BrainStem 事件驱动订阅源已存在**：LifeSignalHub 已有 transaction_completed/mood_shift 等信号，BrainStem 订阅即可
4. **Cerebellum 犹豫期改造不破坏现有 defer 队列语义**：只是替换 `HESITATE_MIN_MS/MAX_MS` 的固定值为动态计算

### 决策
1. **不新建独立大模块**：在现有 BrainCenter 内重组，保留 11 分区文件结构（用户明确选择）
2. **路由层不走 LLM**：避免幻觉（用户明确约束），改用扩展的规则匹配
3. **响应层保留 streamCompletion**：cognize 不直接生成响应，避免幻觉（用户明确要求）
4. **记忆写入规则化生成**：基于路由结果 + 用户消息内容规则化生成，不让 LLM 自由发挥
5. **动作执行统一到 ActionExecutor**：解决三处分散问题，统一安全检查和日志
6. **BrainStem 保留 45s 心跳作为 baseline**：事件驱动作为补充，不替代心跳
7. **Cerebellum 犹豫期动态化**：基于信号重要性，critical 短犹豫、low 长犹豫
8. **端到端测试覆盖 8 类场景**：包括闲聊/工具/委派/紧急/感知/主动/打断/注意力

### 不做的事（明确范围）
- 不重写 11 分区的核心算法（value/disturb 评分、reaper 机制、defer 队列等保留）
- 不修改 chat 主流程（AgentCore.handleUserMessage 的接入点不变）
- 不修改 MasterAgentCoordinator 的子 Agent 委派实现
- 不修改 ToolRegistry 的工具执行机制
- 不修改 brain.* 工具的 schema 定义
- 不修改 HTTP 路由（保持现有 17 个）

---

## 验证步骤

### 编译验证
```bash
cd server && npx tsc --noEmit
```

### 单元验证
1. RuleRouter 单测：8 类输入的规则匹配正确性
2. ActionExecutor 单测：三类动作源的统一执行
3. DecisionHub 单测：被动/主动路径的共享上下文

### 端到端验证
运行 `server/scripts/test-decision-hub-e2e.ts`，验证 8 类场景：
1. 路由准确率 ≥ 90%（与期望路由匹配）
2. cognize 产出完整性（response/memoryWrites/action/confidence 全部有值）
3. 动作执行统一性（所有动作经过 ActionExecutor）
4. 犹豫期动态性（不同 importance 信号犹豫期不同）
5. 注意力调度生效（等快递场景 BrainStem 采样率提高）

### 集成验证
启动服务器，通过 WS 聊天验证：
1. 普通对话走 cognize → streamCompletion（无 LLM 路由调用）
2. 复杂任务走 cognize → master_delegate
3. LifeSignal 触发走 decide → scheduleProactive → executeProactiveDecision
4. 用户开口触发 interruptProactive（Cerebellum 打断）

### 回归验证
- BRAIN_CENTER_ENABLED=0 时降级路径仍可用
- BRAIN_NEURO_ENABLED=0 时 4 皮层模式仍可用
- 现有 17 个 HTTP 路由仍可用
- 现有 13 个 brain.* 工具仍可用

---

## 文件清单

### 新建文件
- `server/src/brain/rule-router.ts` — 规则驱动路由器
- `server/src/brain/action-executor.ts` — 统一动作执行层
- `server/src/brain/decision-hub.ts` — 决策中心协调层
- `server/scripts/test-decision-hub-e2e.ts` — 端到端测试

### 修改文件
- `server/src/brain/brain-center.ts` — cognize 阶段 2 改用 RuleRouter，集成 DecisionHub/ActionExecutor
- `server/src/brain/brain-stem.ts` — 新增事件订阅 + 注意力调度器
- `server/src/brain/cerebellum.ts` — 犹豫期/打断窗口动态计算
- `server/src/brain/proaction-cortex.ts` — executeActions 改委托 ActionExecutor
- `server/src/brain/planner-cortex.ts` — executeWithToolExecutor 改委托 ActionExecutor
- `server/src/brain/index.ts` — 导出新模块
- `server/src/brain/types.ts` — 新增类型定义
- `server/src/bootstrap/create-app-services.ts` — 装配新模块，替换 CognitiveEngine 实现

### 不修改文件
- `server/src/services/agent-core.ts` — 接入点不变
- `server/src/services/chat-turn-runner.ts` — 不引用 BrainCenter
- `server/src/routes/http/brain.ts` — HTTP 路由不变
- `server/src/tools/brain-tools.ts` — 工具 schema 不变
- `server/src/agent/master-*-delegate-tools.ts` — 子 Agent 委派不变

---

## 预期收益

1. **类人化决策**：被动+主动统一走 DecisionHub，共享认知能力，像人一样"用一个脑子想"
2. **无幻觉路由**：规则驱动替代 LLM 路由，避免之前的追问识别幻觉
3. **端到端认知恢复**：cognize 重新产出 {路由, 记忆, 动作, 置信度}，阶段 2.5/3 恢复有效
4. **动作统一执行**：三处分散合并为 ActionExecutor，统一调度/日志/安全检查
5. **感知拟人化**：BrainStem 事件驱动 + 注意力调度，不再纯定时器轮询
6. **犹豫拟人化**：基于信号重要性动态计算，critical 短犹豫、low 长犹豫
7. **可测试性**：8 类端到端场景覆盖，可量化验证类人化效果
