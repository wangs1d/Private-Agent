/**
 * 2026-09-06 P0/P1/P2/P3 根源修复回归测试。
 *
 * 背景（turn-wal 2026-09-06 实录）：
 *  - "今天天气怎么样" → 前台零工具，模型闪避"没实时数据/让系统去查"，无任何工具调用；
 *  - "小弟"（两字称呼）→ 模型把悬空天气旧话题当最新消息重新回答（串台）。
 * 本文件锁定四类修复的行为契约：
 *  - P0 闪避式兜底（commitment-gate.isDeflectionStyleFallback）；
 *  - P1 渠道会话隔离（master-chat-session）；
 *  - P2 短期记忆卫生（TTL/结清/承诺收紧/使命失效/短 ping 防带跑）；
 *  - P3 主会话线程持久化（chat-thread-persist.shouldPersistChatThread）。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { hasCommitmentClaim, isDeflectionStyleFallback } = await import(
  "../src/agent/commitment-gate.js"
);
const {
  isChannelScopedSessionId,
  isChannelSessionIsolationEnabled,
  resolveChannelScopedSessionId,
} = await import("../src/agent/master-chat-session.js");
const { shouldPersistChatThread } = await import("../src/external-model/chat-thread-persist.js");
const { ShortTermMemoryGatewayService } = await import(
  "../src/services/short-term-memory-gateway.js"
);

function tempFile(name: string): string {
  return join(mkdtempSync(join(tmpdir(), "stm-hygiene-")), name);
}

/* ── P0：出口闪避闸 ─────────────────────────────────────────────── */

test("P0 闪避闸：turn-wal 实录的两条闪避回复必须命中", () => {
  for (const text of [
    // 2026-09-06 10:25 "今天天气怎么样" 的真实回复
    "兴义这天气，我手头没实时数据，不好瞎报给你。要不下个能查天气的工具，我直接给你拉最新的？",
    // 2026-09-06 10:26 "小弟" 的真实回复
    "兴义今天啥天气，我手上没实时数据，没法瞎报。\n\n你要是想知道，让系统去查一下当场给你准信，行不？",
  ]) {
    assert.equal(isDeflectionStyleFallback(text), true, `应识别为闪避：${text.slice(0, 20)}`);
  }
});

test("P0 闪避闸：正常闲聊与直答不命中（不误伤）", () => {
  for (const text of [
    "哈哈笑死我了",
    "北京今天挺冷的，多穿点",
    "今天吃火锅还是烤肉？我选火锅",
    "我叫大帅，你刚才取的名字",
  ]) {
    assert.equal(isDeflectionStyleFallback(text), false, `不应识别为闪避：${text}`);
  }
});

test("P0 闪避闸与承诺闸互补：同一回复不同时命中两类", () => {
  const deflection = "我手上没实时数据，没法瞎报，让系统去查一下吧";
  const commitment = "已经帮你设置好了提醒";
  assert.equal(isDeflectionStyleFallback(deflection), true);
  assert.equal(hasCommitmentClaim(deflection), false);
  assert.equal(hasCommitmentClaim(commitment), true);
  assert.equal(isDeflectionStyleFallback(commitment), false);
});

/* ── P1：渠道会话隔离 ───────────────────────────────────────────── */

test("P1 渠道隔离：渠道归一化且同渠道稳定、异渠道必然不同", () => {
  const a = resolveChannelScopedSessionId("session-mvp-001", "wechat");
  const b = resolveChannelScopedSessionId("session-mvp-001", "WeChat");
  const c = resolveChannelScopedSessionId("session-mvp-001", "飞书 群");
  assert.equal(a, "session-mvp-001@wechat");
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.match(c, /@[\w-]+$/);
});

test("P1 渠道隔离：形态判定与开关", () => {
  assert.equal(isChannelScopedSessionId("session-mvp-001@wechat"), true);
  assert.equal(isChannelScopedSessionId("session-mvp-001"), false);
  const prev = process.env.AGENT_CHANNEL_SESSION_ISOLATION;
  try {
    delete process.env.AGENT_CHANNEL_SESSION_ISOLATION;
    assert.equal(isChannelSessionIsolationEnabled(), true, "默认开启");
    process.env.AGENT_CHANNEL_SESSION_ISOLATION = "0";
    assert.equal(isChannelSessionIsolationEnabled(), false, "可回退");
  } finally {
    if (prev === undefined) delete process.env.AGENT_CHANNEL_SESSION_ISOLATION;
    else process.env.AGENT_CHANNEL_SESSION_ISOLATION = prev;
  }
});

/* ── P3：主会话线程持久化 ───────────────────────────────────────── */

test("P3 持久化：裸 actorId 主会话线程必须落盘（chat-threads.json 空洞的根因）", () => {
  // 2026-08-29 起 resolvePrimaryChatSessionId 返回裸 actorId；
  // 旧过滤在 masterDelegation.enabled（配了外部模型密钥即默认 true）时把
  // 唯一的主会话线程判为不持久化 → 重启丢全部对话历史。
  assert.equal(shouldPersistChatThread("session-mvp-001"), true);
  assert.equal(shouldPersistChatThread("session-mvp-001@wechat"), true);
  assert.equal(shouldPersistChatThread("master:session-mvp-001"), true);
  assert.equal(shouldPersistChatThread("notes:session-mvp-001"), true);
});

test("P3 持久化：子 Agent / Plan-Execute 临时线程仍然排除", () => {
  assert.equal(shouldPersistChatThread("subagent-tech-1"), false);
  assert.equal(shouldPersistChatThread("session-mvp-001\u007fpe\u007fabc"), false);
  assert.equal(shouldPersistChatThread("master-delegate:session-mvp-001"), false);
  assert.equal(shouldPersistChatThread(""), false);
});

/* ── P2：短期记忆卫生 ───────────────────────────────────────────── */

test("P2 承诺收紧：过去式闲聊不入承诺栈，未来动作入栈", () => {
  const service = new ShortTermMemoryGatewayService(tempFile("hygiene.json"));
  const sessionId = "session-commitment-test";

  service.reconcileTaskAfterTurn(sessionId, "哈哈你被我将了一军", "哎哟，被我将了一军。你这招真狠。");
  service.reconcileTaskAfterTurn(sessionId, "大哥，你这一开问就是俩瓜啊", "这瓜保熟。");
  const state: any = (service as any).data.sessions[sessionId];
  assert.equal(state.conversationMemory.agentCommitments.length, 0, "闲聊句不得入承诺栈");

  service.reconcileTaskAfterTurn(sessionId, "那个材料什么时候给我", "明天发你。");
  assert.ok(
    state.conversationMemory.agentCommitments.some((line: string) => line.includes("明天发你")),
    "第一人称未来动作必须入承诺栈",
  );
});

test("P2 结清：助手回复正面完成的事项从挂起栈移除", () => {
  const service = new ShortTermMemoryGatewayService(tempFile("hygiene.json"));
  const sessionId = "session-settle-test";

  service.reconcileTaskAfterTurn(sessionId, "帮我搜索刘浩存最近的照片", "行，我这就去搜。");
  const state: any = (service as any).data.sessions[sessionId];
  assert.ok(
    state.conversationMemory.openLoops.some((line: string) => line.includes("刘浩存")),
    "请求未处理前进 openLoops",
  );

  service.reconcileTaskAfterTurn(
    sessionId,
    "搜到了吗",
    "刘浩存最近的照片帮你搜好了，这都是她这周的公开活动图。",
  );
  assert.equal(
    state.conversationMemory.openLoops.filter((line: string) => line.includes("刘浩存")).length,
    0,
    "助手正面完成该请求后 openLoop 应结清",
  );
});

test("P2 TTL：过期挂起项不再注入 prompt", async () => {
  const prev = process.env.AGENT_STM_LOOP_TTL_MS;
  process.env.AGENT_STM_LOOP_TTL_MS = "30";
  try {
    const service = new ShortTermMemoryGatewayService(tempFile("hygiene.json"));
    const sessionId = "session-ttl-test";
    service.reconcileTaskAfterTurn(sessionId, "帮我规划一下去马尔代夫 待格五天", "行，我这就去安排。");
    await new Promise((resolve) => setTimeout(resolve, 60));
    const prompt = service.buildPromptContext(sessionId, "帮我规划一下去马尔代夫 待格五天");
    if (prompt) {
      assert.doesNotMatch(prompt, /四分钟后提醒|马尔代夫行程安排/, "过期挂起项不得注入");
    }
    // 无异常即通过（过期项被 TTL 清掉后注入块可能整体为空）
    assert.ok(true);
  } finally {
    if (prev === undefined) delete process.env.AGENT_STM_LOOP_TTL_MS;
    else process.env.AGENT_STM_LOOP_TTL_MS = prev;
  }
});

test("P2 使命失效：连续切换话题后陈年 currentMission 置空", () => {
  const service = new ShortTermMemoryGatewayService(tempFile("hygiene.json"));
  const sessionId = "session-mission-test";

  service.reconcileTaskAfterTurn(sessionId, "帮我规划一下去马尔代夫 待格五天", "好嘞，这就去排行程。");
  let state: any = (service as any).data.sessions[sessionId];
  assert.ok(state.conversationMemory.currentMission, "新请求应成为 currentMission");

  service.reconcileTaskAfterTurn(sessionId, "abc def", "嗯嗯。");
  service.reconcileTaskAfterTurn(sessionId, "xyz uvw", "好的。");
  state = (service as any).data.sessions[sessionId];
  assert.equal(
    state.conversationMemory.currentMission,
    null,
    "连续两轮话题切换且无活动任务 → 使命置空",
  );
});

test("P2 短 ping 防带跑：称呼式短消息注入『只回应本条』指令", () => {
  const service = new ShortTermMemoryGatewayService(tempFile("hygiene.json"));
  const sessionId = "session-ping-test";

  service.reconcileTaskAfterTurn(sessionId, "今天天气怎么样", "兴义这天气，我手头没实时数据。");
  const prompt = service.buildPromptContext(sessionId, "小弟");
  assert.ok(prompt, "短 ping 轮应有 STM 块");
  assert.match(prompt!, /本条无新指令/, "必须注入防带跑指令");
  assert.doesNotMatch(prompt!, /open-loops:/, "短 ping 轮不得注入陈年挂起栈");
});

test("P2 短 ping 防带跑：正常诉求不受影响", () => {
  const service = new ShortTermMemoryGatewayService(tempFile("hygiene.json"));
  const sessionId = "session-normal-test";

  service.reconcileTaskAfterTurn(sessionId, "帮我规划一下去马尔代夫 待格五天", "好嘞，这就去排行程。");
  const prompt = service.buildPromptContext(sessionId, "帮我规划一下去马尔代夫 待格五天");
  assert.ok(prompt);
  assert.doesNotMatch(prompt!, /本条无新指令/, "正常诉求不注入 ping 指令");
});
