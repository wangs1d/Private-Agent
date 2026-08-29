import test from "node:test";
import assert from "node:assert/strict";

import { shouldAllowBackgroundSubAgentTask } from "../src/agent/background-task-policy.js";

test("does not allow background task for ordinary info lookup", () => {
  const allowed = shouldAllowBackgroundSubAgentTask({
    userMessage: "帮我查一下今天 OpenAI 有什么新闻",
    taskDescription: "搜索 OpenAI 今天的新闻并给我总结一下",
    agentType: "info",
    explicitlyRequested: true,
  });
  assert.equal(allowed, false);
});

test("allows background task for explicit long-running monitoring", () => {
  const allowed = shouldAllowBackgroundSubAgentTask({
    userMessage: "你先在后台持续监控这只股票，有大波动再告诉我",
    taskDescription: "持续监控目标股票价格变化，轮询市场数据并在出现明显波动后回报",
    agentType: "info",
    explicitlyRequested: true,
  });
  assert.equal(allowed, true);
});

test("does not allow background task unless explicitly requested", () => {
  const allowed = shouldAllowBackgroundSubAgentTask({
    userMessage: "持续监控这个页面的价格变化",
    taskDescription: "持续监控页面价格变化并在降价后通知我",
    agentType: "tech",
    explicitlyRequested: false,
  });
  assert.equal(allowed, false);
});
