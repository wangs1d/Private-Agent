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

  assert.deepEqual(kernel.checkToolAction("shopping.order.place"), {
    allowed: false,
    reason: "High-risk financial or purchase action requires explicit confirmation before execution.",
  });
  assert.deepEqual(kernel.checkToolAction("search_web"), { allowed: true });
});
