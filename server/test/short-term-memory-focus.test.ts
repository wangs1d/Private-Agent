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

