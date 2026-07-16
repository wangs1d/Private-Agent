# 主动决策闭环修复计划

## Summary

当前 BrainCenter 的主动决策链路存在两处断裂，导致 Agent 丧失自发性：
1. **信号→决策断裂**：AwarenessCortex 订阅了 LifeSignalHub 的信号，但 `onActivityChange` 无外部订阅者，活动变化不会触发 `brainCenter.decide()`
2. **决策→执行断裂**：`decide()` 返回 `BrainDecision { outcome: "speak" }` 后，没有任何代码消费它去发送消息或调用工具

修复后形成完整闭环：`LifeSignal → AwarenessCortex 活动变化 → ProactionCortex 决策 → LLM 话术生成 → SynapseBus.sendToUser 投递 → WS 推送/语音/电话`

## Current State Analysis

### 已有的真实组件（可直接复用）

| 组件 | 位置 | 状态 |
|------|------|------|
| LifeSignalHub | create-app-services.ts:250 | ✅ 真实信号源，已注入 AwarenessCortex |
| AwarenessCortex | awareness-cortex.ts:110 | ✅ 订阅 LifeSignalHub，handleSignal→commitState→notifyChange，但 notifyChange 的 listeners 为空 |
| ProactionCortex | proaction-cortex.ts:123 | ✅ decide() 评分逻辑完整，但返回的 BrainDecision 无消费者 |
| ProactiveOutboundMessageService | create-app-services.ts:949 | ✅ sendToClient 闭包已实现 WS+voice+phone_call 三通道投递 |
| ExternalChatProvider | proactive-agent-center.ts:232 | ✅ streamCompletion 可生成 LLM 话术 |
| SynapseBus.sendToUser | synapse-bus.ts:298 | ✅ WS + MessageHub 离线降级 |
| AnticipationEngineService | anticipation-engine-service.ts | ✅ 评估信号生成 AnticipationCandidate（含 suggestedAction） |

### 两处断裂点

**断裂 1**：AwarenessCortex.notifyChange() → ??? → BrainCenter.decide()
- `onActivityChange(cb)` 方法存在但零外部调用方
- 需要在 create-app-services.ts 中注册一个回调，把活动变化转化为 BrainSignalInput 并调用 brainCenter.decide()

**断裂 2**：BrainDecision { outcome: "speak" } → ??? → 发送消息
- decide() 只返回评分和 outcome，message 字段永远 undefined
- 注释说"由调用方后续处理"，但调用方未实现
- 需要在 decide() 返回 outcome="speak" 后：调 LLM 生成话术 → 通过 outbound.send 或 synapseBus.sendToUser 投递

## Proposed Changes

### Task 1: 连接 AwarenessCortex → BrainCenter.decide（修复断裂 1）

**文件**：`server/src/bootstrap/create-app-services.ts`

**What**：在 BrainCenter 装配块中，注册一个 `onActivityChange` 回调，把活动状态变化转化为 `BrainSignalInput` 并调用 `brainCenter.decide()`。

**Why**：当前 LifeSignal 到达 AwarenessCortex 后，活动变化通知无人接收，ProactionCortex 的 decide() 永远不被自动触发。

**How**：
在 `brainCenter.registerAwareness(awarenessCortex)` 之后（create-app-services.ts:1061），新增：
```typescript
// 连接 AwarenessCortex → ProactionCortex：活动变化自动触发决策
awarenessCortex.onActivityChange((state) => {
  // 把 UserActivityState 转化为 BrainSignalInput
  const signal: BrainSignalInput = {
    actorId: state.actorId,
    kind: state.activity === "just_off_work" ? "task_completed" 
        : state.activity === "going_out" ? "task_completed"
        : state.activity === "idle" ? "mood_shift"
        : "task_completed",
    importance: state.activity === "just_off_work" ? "high" 
              : state.activity === "going_out" ? "high"
              : "medium",
    metadata: {
      activity: state.activity,
      confidence: state.confidence,
      // 从 awareness 获取的上下文
      mood: state.mood,
    },
    timestamp: state.detectedAt,
  };
  
  // 异步触发决策，不阻塞 awareness 的信号处理
  void brainCenter.decide(signal).then((decision) => {
    if (decision.outcome === "speak") {
      // 委托给主动消息执行器（Task 2 实现）
      void executeProactiveDecision(decision, state).catch((err) => {
        console.log(`[BrainCenter] 主动决策执行失败: ${err}`);
      });
    }
  }).catch((err) => {
    console.log(`[BrainCenter] decide 失败: ${err}`);
  });
});
```

**Decision**：`executeProactiveDecision` 函数在 Task 2 中实现。信号 kind 的映射基于 UserActivityKind 的实际值。

### Task 2: 实现 executeProactiveDecision（修复断裂 2）

**文件**：`server/src/bootstrap/create-app-services.ts`（在装配块附近定义闭包函数）

**What**：实现一个 `executeProactiveDecision(decision, activityState)` 函数，当 decision.outcome === "speak" 时：
1. 调 LLM 生成话术（基于活动状态 + 决策上下文）
2. 通过 SynapseBus.sendToUser 投递消息（WS + 离线降级）

**Why**：当前 decide() 返回的 BrainDecision.message 永远 undefined，没有任何代码根据 outcome=speak 去发送消息。

**How**：
```typescript
// 在 create-app-services.ts 装配块内定义（闭包可访问 externalChat / synapseBus / awarenessCortex）
async function executeProactiveDecision(
  decision: BrainDecision,
  activityState: UserActivityState,
): Promise<void> {
  // 1. 构造 LLM prompt（基于活动状态 + 决策上下文）
  const activityDesc = `${activityState.activity}（置信度 ${activityState.confidence}）`;
  const prompt = buildProactivePrompt(activityState, decision);
  
  // 2. 调 LLM 生成话术
  let message = "";
  if (externalChat) {
    try {
      await externalChat.streamCompletion(
        `proactive:${activityState.actorId}:${Date.now()}`,
        { text: prompt },
        (delta) => { message += delta; },
        undefined,
        {
          ephemeralTurn: true,
          disableThinking: true,
          maxThreadMessages: 1,
          systemPromptOverride: PROACTIVE_SYSTEM_PROMPT,
        },
      );
    } catch (err) {
      console.log(`[BrainCenter] LLM 话术生成失败，使用模板兜底: ${err}`);
      message = buildFallbackMessage(activityState);
    }
  } else {
    message = buildFallbackMessage(activityState);
  }
  
  // 3. 去除 SILENT 标记
  if (message.trim().toUpperCase() === "SILENT" || !message.trim()) {
    console.log(`[BrainCenter] LLM 判定静默，不发送`);
    return;
  }
  
  // 4. 通过 SynapseBus.sendToUser 投递（WS + MessageHub 离线降级）
  await synapseBus.sendToUser(activityState.actorId, {
    type: "agent.proactive_message",
    payload: {
      title: "Agent 主动联系",
      text: message.trim(),
      channel: decision.channel ?? "websocket",
      reason: decision.rationale,
    },
  });
  console.log(`[BrainCenter] 主动消息已发送给 ${activityState.actorId}: ${message.slice(0, 50)}...`);
}
```

**LLM System Prompt**（常量定义在文件顶部或装配块内）：
```typescript
const PROACTIVE_SYSTEM_PROMPT = `你是用户的私人助理 Agent。你刚刚通过感知系统察觉到用户的状态变化。

请基于以下信息，决定是否主动联系用户：
- 如果你认为不需要打扰用户，只回复 "SILENT"
- 如果你认为应该主动关心/帮助用户，回复一句话（不超过 50 字），语气自然、温暖、像朋友

回复格式：要么 "SILENT"，要么一句话话术。不要解释你的决定。`;
```

**模板兜底**（LLM 不可用时）：
```typescript
function buildFallbackMessage(state: UserActivityState): string {
  switch (state.activity) {
    case "just_off_work": return "下班啦？今天辛苦了，要不要聊聊今天的安排？";
    case "going_out": return "要出门吗？需要我帮你查查路线或者规划一下吗？";
    case "idle": return "在吗？有什么我可以帮忙的吗？";
    case "busy": return ""; // 忙碌时不打扰
    case "sleeping": return ""; // 睡眠时不打扰
    default: return "";
  }
}
```

**Prompt 构造**：
```typescript
function buildProactivePrompt(state: UserActivityState, decision: BrainDecision): string {
  return `用户当前状态：${state.activity}
状态置信度：${state.confidence}
检测时间：${state.detectedAt}
决策评分：value=${decision.valueScore}, disturb=${decision.disturbScore}

${state.mood ? `用户情绪：${state.mood}` : ""}

请决定是否主动联系用户。`;
}
```

### Task 3: 主动调用工具能力（扩展）

**文件**：`server/src/bootstrap/create-app-services.ts`

**What**：在 `executeProactiveDecision` 中，当活动状态是 `going_out` 时，除了发消息外，还可以主动调用工具（如查天气、规划路线）。

**Why**：用户说"主动为用户规划提建议"——不仅仅是发消息，还要主动做事。

**How**：
在 `executeProactiveDecision` 中，message 发送后，根据 activityState.activity 做额外的工具调用：

```typescript
// going_out 时主动规划
if (activityState.activity === "going_out" && externalChat) {
  try {
    // 让 LLM 生成建议（基于记忆中的用户偏好）
    const suggestionPrompt = `用户要出门了。基于你对用户的了解，给出 2-3 个建议（如查天气、推荐路线、提醒带伞等）。简洁回复。`;
    let suggestion = "";
    await externalChat.streamCompletion(
      `proactive:suggest:${activityState.actorId}:${Date.now()}`,
      { text: suggestionPrompt },
      (delta) => { suggestion += delta; },
      undefined,
      { ephemeralTurn: true, disableThinking: true, maxThreadMessages: 1 },
    );
    if (suggestion.trim() && suggestion.trim().toUpperCase() !== "SILENT") {
      await synapseBus.sendToUser(activityState.actorId, {
        type: "agent.proactive_suggestion",
        payload: { text: suggestion.trim(), channel: "websocket" },
      });
    }
  } catch (err) {
    console.log(`[BrainCenter] 建议生成失败: ${err}`);
  }
}
```

**Decision**：不做真正的工具调用（如 search_weather），只让 LLM 生成建议文本。真正的工具调用需要构造 ToolContext，依赖链太深，留作后续。

### Task 4: 测试验证

**文件**：无（手动测试）

**What**：测试 Agent 在各种感官场景下的自发性。

**How**：
1. 启动 server（BRAIN_CENTER_ENABLED=1, BRAIN_NEURO_ENABLED=1, BRAIN_PROACTION_LEGACY=0）
2. 通过 HTTP 路由模拟信号：
   - `POST /brain/proactive/test` 传不同 signal，观察 decision.outcome
   - `POST /brain/synapse/fire` 触发事件
3. 通过 LifeSignalHub 注入信号（如果有测试路由）
4. 观察 server 日志中是否有：
   - `[AwarenessCortex] handleSignal` 
   - `[BrainCenter] 主动消息已发送`
   - `[SynapseBus] fire: sensory.listen`
5. 验证 WS 连接是否收到主动消息

## Assumptions & Decisions

1. **信号→决策映射**：UserActivityState.activity 到 BrainSignalInput.kind 的映射是启发式的，后续可优化
2. **LLM 话术生成**：复用 ProactiveAgentCenter 的 streamCompletion 调用方式，但用独立的 system prompt
3. **投递走 SynapseBus**：而不是直接调 proactiveOutbound.send，因为 SynapseBus 有 MessageHub 离线降级
4. **不做真实工具调用**：只让 LLM 生成建议文本，真正的工具调用留作后续
5. **模板兜底**：LLM 不可用时用写死的中文模板
6. **不改动 ProactionCortex**：保持 decide() 纯决策，执行逻辑在外部闭包中
7. **shadow 模式不执行**：当 decision.outcome === "shadow" 时不发送消息（legacy 兼容）

## Verification Steps

1. `npx tsc --noEmit` 零错误
2. 启动 server，注入 LifeSignal，观察日志中 AwarenessCortex → BrainCenter.decide → executeProactiveDecision 链路
3. WS 连接的客户端应收到 `agent.proactive_message` 消息
4. `going_out` 场景应收到 `agent.proactive_suggestion` 建议
5. LLM 不可用时走模板兜底
6. `BRAIN_PROACTION_LEGACY=1` 时走旧路径，新逻辑不执行

## Implementation Order

1. Task 2（executeProactiveDecision 函数 + LLM 话术 + 模板兜底）— 核心执行器
2. Task 1（AwarenessCortex → decide 连接）— 依赖 Task 2 的 executeProactiveDecision
3. Task 3（going_out 建议扩展）— 在 Task 2 基础上扩展
4. Task 4（测试验证）
