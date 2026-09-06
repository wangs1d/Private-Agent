import test from "node:test";
import assert from "node:assert/strict";

import { assembleLayeredSections, GLOBAL_MEMORY_RULE } from "../src/agent/prompt-assembler.js";
import { buildToneGuidance, defaultEmotionState } from "../src/services/user-personalization/emotion-tone.js";
import { RuntimeKernel } from "../src/agent/runtime-kernel.js";
import type { AgentPromptMemoryContext } from "../src/external-model/types.js";

function chatMemory(overrides: Partial<AgentPromptMemoryContext> = {}): AgentPromptMemoryContext {
  return {
    modeRoleGuidance: "你现在是对话里那个\"人\"本人。",
    replyStyleMode: "chat",
    toneGuidance: "本轮长度控制：以短回复为主。",
    ...overrides,
  };
}

function replyGuideOf(memory: AgentPromptMemoryContext): string {
  const { dynamicContext } = assembleLayeredSections(memory);
  const guide = dynamicContext.find((block) => block.startsWith("【回复指南】"));
  assert.ok(guide, "【回复指南】 block must be present");
  return guide;
}

test("chat 模式【回复指南】注入基准行：平调短句 + 语感镜像 + 两个反极性", () => {
  const guide = replyGuideOf(chatMemory());
  assert.equal(guide.includes("基准：平调、直接、有事说事"), true);
  assert.equal(guide.includes("语感跟着对方走"), true);
  assert.equal(guide.includes("不客服腔、不瞎热情"), true);
  assert.equal(guide.includes("模式："), true);
  assert.equal(guide.includes("语气："), true);
});

test("task 模式【回复指南】不含聊天基准行——后台任务交付不受短句约束", () => {
  const guide = replyGuideOf(chatMemory({ replyStyleMode: "task" }));
  assert.equal(guide.includes("基准：平调"), false);
  assert.equal(guide.includes("语感跟着对方走"), false);
  // 模式人格与语气/关系行保留（任务交付仍感知用户情绪与关系边界）
  assert.equal(guide.includes("模式："), true);
  assert.equal(guide.includes("语气："), true);
});

test("replyStyleMode 缺省按 chat 处理（向后兼容）", () => {
  const { replyStyleMode: _omit, ...legacy } = chatMemory();
  const guide = replyGuideOf(legacy as AgentPromptMemoryContext);
  assert.equal(guide.includes("基准：平调"), true);
});

test("buildToneGuidance 默认路径静默：balanced + 中性情绪不产出重复基准的行", () => {
  const state = defaultEmotionState(); // balanced, recent=[]
  assert.equal(buildToneGuidance(state), "");
});

test("buildToneGuidance 偏离默认时给出方向行，且不再输出情绪轨迹元信息", () => {
  const formal = defaultEmotionState();
  formal.preferredTone = "formal";
  const formalGuide = buildToneGuidance(formal);
  assert.equal(formalGuide.includes("保持正式"), true);

  const low = defaultEmotionState();
  low.recent = ["negative", "negative"];
  const lowGuide = buildToneGuidance(low);
  assert.equal(lowGuide.includes("语气放柔"), true);
  assert.equal(lowGuide.includes("情绪轨迹"), false);
});

test("minimal 模式保留 replyStyleMode，buildSessionSystem 不再携带风格指针行", () => {
  const kernel = new RuntimeKernel();
  kernel.update({ enabled: true, promptMode: "minimal" });

  const memory = chatMemory({ memorySummary: "Has two meetings today." });
  const plan = kernel.planTurn("在吗", memory);
  const sanitized = kernel.sanitizePromptMemory(memory, plan);

  assert.equal(sanitized?.replyStyleMode, "chat");
  assert.equal(sanitized?.modeRoleGuidance, memory.modeRoleGuidance);

  const sessionSystem = kernel.buildSessionSystem() ?? "";
  assert.equal(sessionSystem.includes("a close friend"), true);
  assert.equal(sessionSystem.includes("Reply style follows"), false);
});
