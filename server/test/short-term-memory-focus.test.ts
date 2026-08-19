import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { ShortTermMemoryGatewayService } from "../src/services/short-term-memory-gateway.js";

function createService(): ShortTermMemoryGatewayService {
  const dir = mkdtempSync(join(tmpdir(), "stm-focus-"));
  return new ShortTermMemoryGatewayService(join(dir, "short-term-task-stack.json"));
}

test("keeps meta-debug fatigue turns away from an older business task", () => {
  const service = createService();
  const sessionId = "focus-meta-fatigue";

  service.activateTask(sessionId, "小米销量查询", "小米 SU7 最新月度销量和交付数据");
  service.reconcileTaskAfterTurn(
    sessionId,
    "为什么 agent 还是会串台，回复上次对话",
    "这是对话焦点归因错误，不是小米销量问题。",
  );

  const context = service.buildPromptContext(sessionId, "好累呀") ?? "";
  const recallQuery = service.buildRecallQuery(sessionId, "好累呀");

  assert.match(context, /recent-context/);
  assert.match(context, /串台|焦点|agent/i);
  assert.doesNotMatch(context, /current-focus: 小米销量查询/);
  assert.doesNotMatch(context, /focus-summary: 小米 SU7/);
  assert.doesNotMatch(recallQuery, /小米|SU7|销量|交付/);

  const state = service.getTaskState(sessionId);
  assert.equal(state.tasks.find((task) => task.title === "小米销量查询")?.status, "active");
});

test("keeps explicit task follow-up continuity", () => {
  const service = createService();
  const sessionId = "focus-task-followup";

  service.activateTask(sessionId, "小米销量查询", "小米 SU7 最新月度销量和交付数据");

  const context = service.buildPromptContext(sessionId, "继续查") ?? "";
  const recallQuery = service.buildRecallQuery(sessionId, "继续查");

  assert.match(context, /current-focus: 小米销量查询/);
  assert.match(context, /focus-summary: 小米 SU7/);
  assert.match(recallQuery, /小米|SU7|销量|交付/);
});

// ===== 串台根治：getTurnFocusKind 话题切换门控 =====

test("topic switch suppresses long-term recall (电影 vs 搬家串台场景)", () => {
  const service = createService();
  const sessionId = "gate-topic-switch";

  // 上一会话/话题是"搬家"，用户当前切到"电影"——真正的无关新话题
  service.activateTask(sessionId, "搬家", "帮我看搬家公司和搬家报价");
  service.reconcileTaskAfterTurn(sessionId, "帮我找搬家公司和报价", "为你整理了3家搬家公司报价。");

  const focusKind = service.getTurnFocusKind(sessionId, "咱们聊会儿电影吧");
  assert.equal(focusKind, "topic_switch", "电影话题与搬家任务无关，应判定为话题切换");

  // 话题切换时 buildRecallQuery 必须丢弃旧话题上下文，避免召回捞到"搬家"记忆
  const recallQuery = service.buildRecallQuery(sessionId, "咱们聊会儿电影吧");
  assert.doesNotMatch(recallQuery, /搬家|报价|公司/, "话题切换时召回 query 不应锚定旧话题");
});

test("follow-up keeps continuity and enriches recall (不受误杀)", () => {
  const service = createService();
  const sessionId = "gate-followup";

  service.activateTask(sessionId, "小米销量查询", "小米 SU7 最新月度销量和交付数据");

  // 延续性追问：继续/指代 → 必须 task_followup，召回不被抑制
  assert.equal(service.getTurnFocusKind(sessionId, "继续查"), "task_followup");
  assert.equal(service.getTurnFocusKind(sessionId, "那个销量数据是多少"), "task_followup");

  // 延续时召回 query 应带上当前任务锚点
  const recallQuery = service.buildRecallQuery(sessionId, "继续查");
  assert.match(recallQuery, /小米|SU7|销量|交付/);
});

test("casual topic switch away from a task drops task scoped memory", () => {
  const service = createService();
  const sessionId = "gate-casual-switch";

  service.activateTask(sessionId, "天气查询", "上海未来三天的天气");
  service.reconcileTaskAfterTurn(sessionId, "查下上海天气", "上海明后天多云转晴。");

  // 用户从"天气"切到无关闲聊（家具）→ topic_switch，任务 scoped 记忆不注入
  const focusKind = service.getTurnFocusKind(sessionId, "最近想买个沙发布置客厅");
  assert.equal(focusKind, "topic_switch");

  const context = service.buildPromptContext(sessionId, "最近想买个沙发布置客厅") ?? "";
  assert.doesNotMatch(context, /current-focus: 天气查询/);
  assert.doesNotMatch(context, /focus-summary: 上海/);
});

