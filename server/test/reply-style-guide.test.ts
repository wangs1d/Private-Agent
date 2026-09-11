import test from "node:test";
import assert from "node:assert/strict";

import {
  assembleLayeredSections,
  GLOBAL_MEMORY_RULE,
} from "../src/agent/prompt-assembler.js";
import {
  buildToneGuidance,
  defaultEmotionState,
} from "../src/services/user-personalization/emotion-tone.js";
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

function sectionsOf(memory: AgentPromptMemoryContext) {
  return assembleLayeredSections(memory);
}

test("chat 模式注入【说话方式·管家底色】+【说话方式·伙伴面】（调子菜单 few-shot + 禁句）", () => {
  const { stablePrefix, dynamicContext } = sectionsOf(chatMemory());
  const base = stablePrefix.find((b) => b.startsWith("【说话方式·管家底色】"));
  const companion = stablePrefix.find((b) => b.startsWith("【说话方式·伙伴面】"));
  assert.ok(base, "管家底色块必须注入");
  assert.ok(companion, "伙伴面块必须注入");
  // 底色：私人管家定位 + 称呼礼仪（指定称呼优先 + 允许起小名 + 不连名带姓）
  assert.equal(base.includes("私人管家"), true);
  assert.equal(base.includes("先给结论再给理由"), true);
  assert.equal(base.includes("自然长出一个小名"), true);
  assert.equal(base.includes("不连名带姓直呼大名"), true);
  // 伙伴面：调子菜单 few-shot、收放开关、破功禁句
  assert.equal(companion.includes("调子菜单"), true);
  assert.equal(companion.includes("沉稳简洁"), true);
  assert.equal(companion.includes("坦诚"), true);
  assert.equal(companion.includes("幽默俏皮"), true);
  assert.equal(companion.includes("调侃损友"), true);
  assert.equal(companion.includes("抬杠"), true);
  assert.equal(companion.includes("嘲讽阴阳"), true);
  assert.equal(companion.includes("暗示"), true);
  assert.equal(companion.includes("收放开关"), true);
  assert.equal(companion.includes("破功禁句"), true);
  // 动态层只承载每轮适配小节
  const guide = dynamicContext.find((b) => b.startsWith("【本轮说话适配】"));
  assert.ok(guide, "【本轮说话适配】 block must be present");
  assert.equal(guide.includes("模式："), true);
  assert.equal(guide.includes("语气："), true);
});

test("task 模式不注入伙伴面（交付不受闲聊调子约束），管家底色保留", () => {
  const { stablePrefix, dynamicContext } = sectionsOf(chatMemory({ replyStyleMode: "task" }));
  assert.equal(
    stablePrefix.some((b) => b.startsWith("【说话方式·伙伴面】")),
    false,
    "task 轮不得注入伙伴面",
  );
  const base = stablePrefix.find((b) => b.startsWith("【说话方式·管家底色】"));
  assert.ok(base, "管家底色全模式注入");
  // 模式人格与语气行保留（任务交付仍感知用户情绪与关系边界）
  const guide = dynamicContext.find((b) => b.startsWith("【本轮说话适配】"));
  assert.ok(guide);
  assert.equal(guide.includes("模式："), true);
  assert.equal(guide.includes("语气："), true);
});

test("replyStyleMode 缺省按 chat 处理（向后兼容，注入伙伴面）", () => {
  const { replyStyleMode: _omit, ...legacy } = chatMemory();
  const { stablePrefix } = sectionsOf(legacy as AgentPromptMemoryContext);
  assert.equal(
    stablePrefix.some((b) => b.startsWith("【说话方式·伙伴面】")),
    true,
  );
});

test("适配小节全空时不再输出空壳【本轮说话适配】块", () => {
  const { dynamicContext } = sectionsOf({ replyStyleMode: "chat" });
  assert.equal(
    dynamicContext.some((b) => b.startsWith("【本轮说话适配】")),
    false,
  );
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

assert.ok(GLOBAL_MEMORY_RULE.length > 0);
