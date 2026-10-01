import test from "node:test";
import assert from "node:assert/strict";

import { RuntimeKernel } from "../src/agent/runtime-kernel.js";
import { resolveChatToolPlanForStream } from "../src/external-model/resolve-chat-tools.js";
import type { AgentPromptMemoryContext } from "../src/external-model/types.js";

const SAMPLE_MEMORY: AgentPromptMemoryContext = {
  persona: "private butler",
  values: "safe and helpful",
  abilities: "search and scheduling",
  toneGuidance: "brief",
  relationshipGuidance: "warm",
  taskContext: "Handle the current user request only.",
  userProfile: "Prefers conclusion first.",
  narrativeRecall: "The user has been tracking AI news recently.",
  memorySummary: "Has two meetings today.",
  memoryCurrentMission: "Check news and today's schedule.",
  currentTime: "2026-07-18 20:00:00",
};

test("dynamic mode strips stable prompt fields and keeps dynamic ones", () => {
  const kernel = new RuntimeKernel();
  kernel.update({ enabled: true, promptMode: "dynamic" });

  const plan = kernel.planTurn("today ai news and my schedule", SAMPLE_MEMORY);
  const sanitized = kernel.sanitizePromptMemory(SAMPLE_MEMORY, plan);

  assert.equal(plan.promptMode, "dynamic");
  assert.equal(plan.toolExposureProfile, "scoped");
  assert.deepEqual(plan.pinnedToolNames, [
    "calendar.list_tasks",
    "calendar.create_task",
    "calendar.create_from_text",
    "search_web",
    "search_images",
    "search_videos",
    "fetch_web",
  ]);
  assert.equal(sanitized?.persona, undefined);
  assert.equal(sanitized?.values, undefined);
  assert.equal(sanitized?.abilities, undefined);
  assert.equal(sanitized?.toneGuidance, undefined);
  assert.equal(sanitized?.taskContext?.includes("Handle the current user request only."), true);
  assert.equal(sanitized?.narrativeRecall, SAMPLE_MEMORY.narrativeRecall);
  assert.equal(sanitized?.memorySummary, SAMPLE_MEMORY.memorySummary);
});

test("conversation_only mode collapses prompt memory to a micro prompt", () => {
  const kernel = new RuntimeKernel();
  kernel.update({ enabled: true, promptMode: "conversation_only" });

  const plan = kernel.planTurn("today ai news and my schedule", SAMPLE_MEMORY);
  const sanitized = kernel.sanitizePromptMemory(SAMPLE_MEMORY, plan);

  assert.equal(plan.promptMode, "conversation_only");
  assert.deepEqual(Object.keys(sanitized ?? {}), ["taskContext"]);
  assert.equal(sanitized?.taskContext?.includes("Runtime Kernel"), true);
});

test("scoped tool exposure keeps only the pinned tool suite", () => {
  const kernel = new RuntimeKernel();
  kernel.update({ enabled: true, promptMode: "dynamic" });

  const plan = kernel.planTurn("today ai news and my schedule", SAMPLE_MEMORY);
  const resolved = resolveChatToolPlanForStream("today ai news and my schedule", {
    toolExposureProfile: plan.toolExposureProfile,
    pinnedToolNames: plan.pinnedToolNames,
    agentAccessMode: "sandbox",
    desktopBridgeOnline: false,
    phoneBridgeOnline: false,
  });
  const names = resolved.visibleTools
    .map((tool) => (tool.type === "function" ? tool.function?.name ?? "" : ""))
    .filter(Boolean)
    .sort();

  assert.deepEqual(names, [
    "calendar.create_from_text",
    "calendar.create_task",
    "calendar.list_tasks",
    "fetch_web",
    "search_images",
    "search_videos",
    "search_web",
  ]);
});

test("high-risk tools are blocked by runtime safety policy", () => {
  const kernel = new RuntimeKernel();
  kernel.update({ enabled: true });

  // 与 AgentTaskSafety 强制同口径（2026-09 重构）：理由文案统一走 HIGH_RISK_TOOL_REASON
  assert.deepEqual(kernel.checkToolAction("shopping.order.place"), {
    allowed: false,
    reason: "资金支付或对外发送类动作需要用户确认后才能执行。",
  });
  assert.deepEqual(kernel.checkToolAction("search_web"), { allowed: true });
});

test("read-only tools in high-risk families pass the gate (2026-09-28 root fix)", () => {
  const kernel = new RuntimeKernel();
  // 2026-09-28 前这些被 includes("payment"/"transfer"/"wallet") 子串规则误拦，
  // trajectories 实证 social.get_feed 被拦 6 次、wallet 查询 4 次
  assert.deepEqual(kernel.checkToolAction("wallet.get_balance"), { allowed: true });
  assert.deepEqual(kernel.checkToolAction("wallet.get_transactions"), { allowed: true });
  assert.deepEqual(kernel.checkToolAction("payment.query_order"), { allowed: true });
  assert.deepEqual(kernel.checkToolAction("payment.list_methods"), { allowed: true });
  assert.deepEqual(kernel.checkToolAction("social.get_feed"), { allowed: true });
  assert.deepEqual(kernel.checkToolAction("social.search_posts"), { allowed: true });
  // 写/外发动作照旧拦
  assert.equal(kernel.checkToolAction("social.post").allowed, false);
  assert.equal(kernel.checkToolAction("wallet.transfer").allowed, false);
});
