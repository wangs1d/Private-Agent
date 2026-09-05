import assert from "node:assert/strict";
import test from "node:test";

import {
  createLlmRollingRecapSummarizer,
  extractSummarizableText,
  parseRecapLinesFromLlmOutput,
} from "../src/services/conversation-rolling-summarizer.js";
import { ChatThreadStore, buildMessageTimestampPrefix } from "../src/external-model/chat-thread-store.js";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";

// ── LLM 输出解析 ─────────────────────────────────────────────

test("parseRecapLinesFromLlmOutput: 兼容 `- 内容` 格式并去重限长限条数", () => {
  const output = [
    "- 用户偏好素食",
    "- 用户下周要出差",
    "- 用户偏好素食", // 重复
    "",
    "用户养了一只猫", // 无前缀
    "- 用户在学吉他",
    "- 这是非常长的一行内容，用来验证超过 120 字时的截断逻辑，aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  ].join("\n");

  const lines = parseRecapLinesFromLlmOutput(output, 3, 120);
  assert.deepEqual(lines, [
    "用户偏好素食",
    "用户下周要出差",
    "用户养了一只猫",
  ]);
  // 限制到 3 条，重复被去重
  assert.equal(lines.length, 3);
});

test("parseRecapLinesFromLlmOutput: 跳过代码块围栏", () => {
  const output = ["```", "- 用户偏好素食", "```"].join("\n");
  const lines = parseRecapLinesFromLlmOutput(output);
  assert.deepEqual(lines, ["用户偏好素食"]);
});

test("parseRecapLinesFromLlmOutput: 空输出返回空数组", () => {
  assert.deepEqual(parseRecapLinesFromLlmOutput(""), []);
  assert.deepEqual(parseRecapLinesFromLlmOutput("   \n  "), []);
});

// ── 文本提取 ─────────────────────────────────────────────────

test("extractSummarizableText: 跳过 tool 消息、空内容、recap 自身，剥离时间戳前缀", () => {
  const ts = buildMessageTimestampPrefix(new Date());
  const user = {
    role: "user",
    content: `${ts}\n用户问天气`,
  } as ChatCompletionMessageParam;
  assert.equal(extractSummarizableText(user), "user: 用户问天气");

  assert.equal(extractSummarizableText({ role: "tool", content: "结果" } as ChatCompletionMessageParam), "");
  assert.equal(extractSummarizableText({ role: "user", content: "" } as ChatCompletionMessageParam), "");
  assert.equal(
    extractSummarizableText({ role: "assistant", content: "[session-recap]\n..." } as ChatCompletionMessageParam),
    "",
  );
  // 纯时间戳无内容
  assert.equal(
    extractSummarizableText({ role: "user", content: `${ts}\n  ` } as ChatCompletionMessageParam),
    "",
  );
});

// ── 工厂 ─────────────────────────────────────────────────────

test("createLlmRollingRecapSummarizer: 无 API key 返回 null（仅保留已有 recap 行）", () => {
  const prev = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  try {
    assert.equal(createLlmRollingRecapSummarizer(), null);
  } finally {
    if (prev != null) process.env.OPENAI_API_KEY = prev;
  }
});

test("createLlmRollingRecapSummarizer: 有 API key 返回可调用函数", () => {
  const prev = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "sk-test";
  try {
    const fn = createLlmRollingRecapSummarizer();
    assert.equal(typeof fn, "function");
  } finally {
    if (prev != null) process.env.OPENAI_API_KEY = prev;
  }
});

// ── ChatThreadStore 增强回写 ─────────────────────────────────

function makeTsMsg(role: "user" | "assistant", date: Date, text: string): ChatCompletionMessageParam {
  return { role, content: `${buildMessageTimestampPrefix(date)}\n${text}` } as ChatCompletionMessageParam;
}

/**
 * 构造一个触发「近期窗口折叠」的跨天 thread（2026-09-05 新裁剪策略）：
 * 前天/昨天 4 条 + 今天 16 条 = body 20 > 窗口12+折叠批6 → 最旧 8 条折叠进 recap
 * （前天×2 + 昨天×2 + 今天前 4 条被折叠）。
 */
function buildCrossDayThread(): ChatCompletionMessageParam[] {
  const now = new Date();
  const dayAgo = new Date(now.getTime() - 86_400_000);
  const twoDaysAgo = new Date(now.getTime() - 2 * 86_400_000);
  const msgs: ChatCompletionMessageParam[] = [
    { role: "system", content: "sys" },
    makeTsMsg("user", twoDaysAgo, "前天我计划去爬山"),
    makeTsMsg("assistant", twoDaysAgo, "好的，已记住"),
    makeTsMsg("user", dayAgo, "昨天帮我查天气"),
    makeTsMsg("assistant", dayAgo, "昨天晴"),
  ];
  for (let i = 1; i <= 16; i++) {
    msgs.push(makeTsMsg("user", now, `今天的事 ${i}`));
  }
  return msgs;
}

/** 通过 thread(sessionId) 把数组登记进 store.history，模拟真实调用链（trimThread 回写依赖 history）。 */
function registeredThread(store: ChatThreadStore, sessionId: string): ChatCompletionMessageParam[] {
  const msgs = store.thread(sessionId, "");
  msgs.length = 0;
  msgs.push(...buildCrossDayThread());
  return msgs;
}

test("ChatThreadStore: LLM 增强完成后插入/回写 recap 消息", async () => {
  const store = new ChatThreadStore(null);
  let enhanced: string[] | null = null;
  store.setRecapSummarizer(async (ctx) => {
    enhanced = ctx.droppedMessages.map((m) => extractSummarizableText(m)).filter(Boolean);
    return ["用户前天计划爬山（LLM增强）", "用户昨天查过天气（LLM增强）"];
  });

  const msgs = registeredThread(store, "session-a");
  store.trimThread(msgs, undefined, "session-a");

  // 同步路径：折叠发生时立即用被丢弃消息原文生成兜底 recap（占位，防摘要器缺失断层）
  const sys = msgs[0];
  const syncRecap = msgs.find((m) => typeof m.content === "string" && m.content.includes("[session-recap]"));
  assert.ok(sys && sys.role === "system");
  assert.ok(syncRecap, "折叠发生时同步应生成兜底 recap（原文占位）");
  assert.ok(
    typeof syncRecap?.content === "string" && syncRecap.content.includes("爬山"),
    "兜底 recap 应包含被折叠的原文行",
  );

  // 异步增强完成：等待微任务
  await new Promise((r) => setTimeout(r, 10));
  assert.ok(enhanced && enhanced.length > 0, "summarizer 应收到被丢弃的历史消息");
  assert.ok(enhanced!.some((l) => l.includes("爬山")), "丢弃消息应包含前天的对话");

  const recapAfter = msgs.find((m) => typeof m.content === "string" && m.content.includes("[session-recap]"));
  assert.ok(recapAfter, "增强完成后应回写 recap 消息");
  assert.ok(
    typeof recapAfter?.content === "string" && recapAfter.content.includes("LLM增强"),
    "LLM 摘要应写入 recap 消息",
  );
});

test("ChatThreadStore: seq 防覆盖——期间有新 trim 时丢弃旧增强结果", async () => {
  const store = new ChatThreadStore(null);
  // 第一次调用返回受控 deferred（模拟慢 LLM），第二次立即返回
  let resolveFirst: (lines: string[]) => void = () => {};
  const firstCall = new Promise<string[]>((r) => {
    resolveFirst = r;
  });
  let callCount = 0;
  store.setRecapSummarizer(async () => {
    callCount += 1;
    if (callCount === 1) return firstCall; // 第一次慢
    return ["第二版增强"]; // 第二次快
  });

  const msgs = registeredThread(store, "session-b");
  store.trimThread(msgs, undefined, "session-b"); // 触发第一次增强（慢）

  // 期间又产生新消息并再次 trim → 超过「窗口12+折叠批6」再次触发折叠/增强（快）。
  // 首次折叠后剩 12 条，需再推 ≥7 条才会再次超过阈值。
  const now2 = new Date();
  for (let i = 1; i <= 8; i++) {
    msgs.push(makeTsMsg("user", now2, `第二批消息 ${i}`));
  }
  store.trimThread(msgs, undefined, "session-b");

  // 等待第二次增强完成并回写
  await new Promise((r) => setTimeout(r, 20));
  const recapAfterSecond = msgs.find(
    (m) => typeof m.content === "string" && m.content.includes("[session-recap]"),
  );
  assert.ok(
    typeof recapAfterSecond?.content === "string" && recapAfterSecond.content.includes("第二版增强"),
    "第二次增强应回写",
  );

  // 现在放行第一次增强（慢的那个）——seq 已过期，必须被丢弃，不得覆盖第二版
  resolveFirst(["第一版增强"]);
  await new Promise((r) => setTimeout(r, 20));
  const recapFinal = msgs.find(
    (m) => typeof m.content === "string" && m.content.includes("[session-recap]"),
  );
  assert.ok(
    typeof recapFinal?.content === "string" && recapFinal.content.includes("第二版增强"),
    "旧增强结果（第一版）不得覆盖新增强结果",
  );
  assert.ok(
    !(typeof recapFinal?.content === "string" && recapFinal.content.includes("第一版增强")),
    "第一版增强应被丢弃",
  );
});

test("ChatThreadStore: summarizer 返回 null 时保留已有 recap 行", async () => {
  const store = new ChatThreadStore(null);
  store.setRecapSummarizer(async () => null); // 降级
  const msgs = registeredThread(store, "session-c");
  // 注入已有 recap 消息（模拟历史压缩），验证降级时保留
  msgs.splice(1, 0, {
    role: "assistant",
    content: "[session-recap]\nEarlier conversation recap:\n- [昨天] 用户查过天气",
  } as ChatCompletionMessageParam);

  store.trimThread(msgs, undefined, "session-c");
  await new Promise((r) => setTimeout(r, 10));

  const recap = msgs.find((m) => typeof m.content === "string" && m.content.includes("[session-recap]"));
  assert.ok(recap, "降级时保留已有 recap 行");
  assert.ok(
    typeof recap!.content === "string" && recap!.content.includes("查过天气"),
    "已有 recap 行内容应保留",
  );
});

test("ChatThreadStore: 未注入 summarizer 时保留已有 recap 行且不生成新摘要", () => {
  const store = new ChatThreadStore(null);
  const msgs = registeredThread(store, "session-d");
  msgs.splice(1, 0, {
    role: "assistant",
    content: "[session-recap]\nEarlier conversation recap:\n- [昨天] 用户出差",
  } as ChatCompletionMessageParam);
  store.trimThread(msgs, undefined, "session-d");
  const recap = msgs.find((m) => typeof m.content === "string" && m.content.includes("[session-recap]"));
  assert.ok(recap, "无 summarizer 时保留已有 recap 行");
  assert.ok(
    typeof recap!.content === "string" && recap!.content.includes("出差"),
    "已有 recap 行内容应保留",
  );
});

test("ChatThreadStore: LLM 增强后 recap 回写且位于 system 之后", async () => {
  const store = new ChatThreadStore(null);
  store.setRecapSummarizer(async () => ["用户前天计划爬山（LLM摘要）"]);
  const msgs = registeredThread(store, "session-e"); // 首次折叠，无已有 recap 行
  store.trimThread(msgs, undefined, "session-e");

  // 同步阶段已生成原文占位 recap，且位于 system 之后
  const before = msgs.find((m) => typeof m.content === "string" && m.content.includes("[session-recap]"));
  assert.ok(before, "同步阶段应有兜底 recap");
  assert.equal(msgs.indexOf(before!), 1, "recap 应在 system 之后");

  await new Promise((r) => setTimeout(r, 20));
  const after = msgs.find((m) => typeof m.content === "string" && m.content.includes("[session-recap]"));
  assert.ok(after, "LLM 增强完成后应保留 recap 消息");
  assert.ok(
    typeof after!.content === "string" && after!.content.includes("LLM摘要"),
    "recap 应更新为 LLM 摘要内容",
  );
  assert.equal(msgs.indexOf(after!), 1, "recap 应保持在 system 之后");
});
