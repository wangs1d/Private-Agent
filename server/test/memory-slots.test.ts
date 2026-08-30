import test from "node:test";
import assert from "node:assert/strict";

import { buildLayeredSystemPrompt, sliceMemoryEntriesToPromptContext } from "../src/agent/prompt-builder.js";
import { AgentMemorySyncService } from "../src/services/agent-memory-sync-service.js";

test("appendMemorySummaryLine populates structured memory slots", async () => {
  const service = new AgentMemorySyncService("test-agent-memory-sync.json");

  service.appendMemorySummaryLine("actor-1", "user prefers concise answers");
  service.appendMemorySummaryLine("actor-1", "I will continue following up on this fix");
  service.appendMemorySummaryLine("actor-1", "my project is a Flutter chat context repair");

  await new Promise((resolve) => setTimeout(resolve, 20));

  const { entries } = service.getSnapshot("actor-1", [
    "memory_preferences",
    "memory_commitments",
    "memory_facts",
    "session_recap",
  ]);

  assert.match(String(entries.memory_preferences ?? ""), /concise answers/);
  assert.match(String(entries.memory_commitments ?? ""), /continue following up/);
  assert.match(String(entries.memory_facts ?? ""), /Flutter chat context repair/);
  assert.match(String(entries.session_recap ?? ""), /concise answers|continue following up|Flutter chat context repair/);
});

test("sliceMemoryEntriesToPromptContext exposes structured slots to prompt builder", () => {
  const memory = sliceMemoryEntriesToPromptContext({
    memory_preferences: "[2026-07-14T00:00:00Z] [topic:chat] user prefers concise answers",
    memory_facts: "[2026-07-14T00:00:00Z] [topic:project] user is working on a Flutter project",
    memory_commitments: "[2026-07-14T00:00:00Z] [topic:project] agent will continue repairing context retention",
    memory_open_loops: "[2026-07-14T00:00:00Z] [topic:project] need to verify behavior after 100 messages",
    session_recap: "[2026-07-14T00:00:00Z] [topic:recap] recently focused on fixing chat memory",
  });

  const prompt = buildLayeredSystemPrompt("base", memory);
  assert.match(prompt, /【用户档案】/);
  assert.match(prompt, /偏好：/);
  assert.match(prompt, /事实：/);
  assert.match(prompt, /待兑现承诺/);
  assert.match(prompt, /未完成事项/);
  assert.match(prompt, /会话回顾/);
});

test("reconcileStructuredMemoryAfterTurn only clears resolved commitments and loops", async () => {
  const service = new AgentMemorySyncService("test-agent-memory-sync.json");
  service.appendMemorySummaryLine("actor-2", "I will continue following up on the context fix");
  service.appendMemorySummaryLine("actor-2", "todo: verify continuity after 100 messages");
  service.appendMemorySummaryLine("actor-2", "todo: prepare regression notes for memory rollout");

  await new Promise((resolve) => setTimeout(resolve, 20));

  service.reconcileStructuredMemoryAfterTurn(
    "actor-2",
    "done: the context fix and 100 message continuity verification are finished",
    "fixed and resolved the context retention issue",
  );
  await new Promise((resolve) => setTimeout(resolve, 20));

  const { entries } = service.getSnapshot("actor-2", [
    "memory_commitments",
    "memory_open_loops",
    "session_recap",
  ]);
  const commitments = String(entries.memory_commitments ?? "");
  const openLoops = String(entries.memory_open_loops ?? "");
  const recap = String(entries.session_recap ?? "");

  assert.equal(commitments, "");
  assert.doesNotMatch(openLoops, /100 messages/);
  assert.match(openLoops, /memory rollout/);
  assert.doesNotMatch(recap, /100 messages|context fix/);
  assert.match(recap, /memory rollout/);
});

test("latest preference replaces older preference for the same subject", async () => {
  const service = new AgentMemorySyncService("test-agent-memory-sync.json");

  service.appendMemorySummaryLine("actor-3", "user prefers concise answers");
  service.appendMemorySummaryLine("actor-3", "user dislikes concise answers");

  await new Promise((resolve) => setTimeout(resolve, 20));

  const { entries } = service.getSnapshot("actor-3", ["memory_preferences"]);
  const preferences = String(entries.memory_preferences ?? "");

  assert.doesNotMatch(preferences, /prefers concise answers/);
  assert.match(preferences, /dislikes concise answers/);
});

test("latest fact replaces older fact for the same slot", async () => {
  const service = new AgentMemorySyncService("test-agent-memory-sync.json");

  service.appendMemorySummaryLine("actor-4", "I live in Shanghai");
  service.appendMemorySummaryLine("actor-4", "I live in Beijing");

  await new Promise((resolve) => setTimeout(resolve, 20));

  const { entries } = service.getSnapshot("actor-4", ["memory_facts"]);
  const facts = String(entries.memory_facts ?? "");

  assert.doesNotMatch(facts, /live in Shanghai/);
  assert.match(facts, /live in Beijing/);
});

test("current mission can be updated and cleared", async () => {
  const service = new AgentMemorySyncService("test-agent-memory-sync.json");

  service.setCurrentMission("actor-5", "continue fixing memory continuity across long chats");
  await new Promise((resolve) => setTimeout(resolve, 20));

  let snapshot = service.getSnapshot("actor-5", ["memory_current_mission"]);
  assert.match(String(snapshot.entries.memory_current_mission ?? ""), /memory continuity across long chats/);

  service.setCurrentMission("actor-5", null);
  await new Promise((resolve) => setTimeout(resolve, 20));

  snapshot = service.getSnapshot("actor-5", ["memory_current_mission"]);
  assert.equal(String(snapshot.entries.memory_current_mission ?? ""), "");
});
