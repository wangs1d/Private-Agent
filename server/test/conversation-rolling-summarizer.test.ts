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
 * 构造一个触发近期窗口折叠的 thread（2026-09-05 策略）：
 * body > RECENT_WINDOW_MESSAGES(12) + RECAP_BATCH_MESSAGES(6) 才会折叠最旧一批进 recap。
 */
function buildFoldingThread(pairCount = 12): ChatCompletionMessageParam[] {
  const msgs: ChatCompletionMessageParam[] = [{ role: "system", content: "sys" }];
  const base = Date.now() - 3 * 86_400_000;
  for (let i = 0; i < pairCount; i++) {
    const at = new Date(base + i * 60_000);
    msgs.push(makeTsMsg("user", at, `第${i}轮用户消息`));
    msgs.push(makeTsMsg("assistant", at, `第${i}轮助手回复`));
  }
  return msgs;
}

/** 通过 thread(sessionId) 把数组登记进 store.history，模拟真实调用链（trimThread 回写依赖 history）。 */
function registeredThread(store: ChatThreadStore, sessionId: string): ChatCompletionMessageParam[] {
  const msgs = store.thread(sessionId, "");
  msgs.length = 0;
  msgs.push(...buildFoldingThread());
  return msgs;
}

test("ChatThreadStore: 折叠触发后同步兜底 recap + LLM 增强回写", async () => {
  const store = new ChatThreadStore(null);
  let enhanced: string[] | null = null;
  store.setRecapSummarizer(async (ctx) => {
    enhanced = ctx.droppedMessages.map((m) => extractSummarizableText(m)).filter(Boolean);
    return ["[3天前] 用户前天计划爬山（LLM增强）"];
  });

  const msgs = registeredThread(store, "session-a");
  store.trimThread(msgs, undefined, "session-a");

  // 同步路径：被折叠消息先生成原文兜底 recap（占位，防增强缺失时断层）
  const sys = msgs[0];
  const syncRecap = msgs.find((m) => typeof m.content === "string" && m.content.includes("[session-recap]"));
  assert.ok(sys && sys.role === "system");
  assert.ok(syncRecap, "折叠触发时应同步生成兜底 recap");
  assert.ok(
    typeof syncRecap?.content === "string" && syncRecap.content.includes("第0轮用户消息"),
    "兜底 recap 应包含被折叠消息原文",
  );

  // 异步增强完成：等待微任务
  await new Promise((r) => setTimeout(r, 10));
  assert.ok(enhanced && enhanced.length > 0, "summarizer 应收到被丢弃的历史消息");
  assert.ok(enhanced!.some((l) => l.includes("第0轮")), "丢弃消息应包含最旧的对话");

  const recapAfter = msgs.find((m) => typeof m.content === "string" && m.content.includes("[session-recap]"));
  assert.ok(recapAfter, "增强完成后应保留 recap 消息");
  assert.ok(
    typeof recapAfter?.content === "string" && recapAfter.content.includes("LLM增强"),
    "LLM 新行应写入 recap 消息",
  );
});

test("ChatThreadStore: 增量合并——已有 recap 行原文保留，不被 LLM 重写覆盖（漂移回归）", async () => {
  const store = new ChatThreadStore(null);
  store.setRecapSummarizer(async () => ["[今天] 用户要求晚上七点半提醒开线上会议（LLM改写）"]);

  const msgs = registeredThread(store, "session-drift");
  // 注入上一轮已生成的 recap 行（原文事实：七点）
  msgs.splice(1, 0, {
    role: "assistant",
    content:
      "[session-recap]\nEarlier conversation recap:\n- [今天] 用户要求晚上七点提醒开线上会议",
  } as ChatCompletionMessageParam);

  store.trimThread(msgs, undefined, "session-drift");
  await new Promise((r) => setTimeout(r, 10));

  const recap = msgs.find((m) => typeof m.content === "string" && m.content.includes("[session-recap]"));
  assert.ok(recap && typeof recap.content === "string");
  // 已有行必须原文保留——即使 LLM 返回了改写版
  assert.ok(
    recap.content.includes("用户要求晚上七点提醒开线上会议"),
    "已有 recap 行应原文保留，不被 LLM 重写漂移",
  );
  // LLM 新行增量并入
  assert.ok(recap.content.includes("七点半提醒开线上会议（LLM改写）"), "LLM 新行应增量并入");
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

  // 期间又产生一批新历史消息并再次 trim → 触发第二次增强（快）
  const older = new Date(Date.now() - 4 * 86_400_000);
  for (let i = 0; i < 7; i++) {
    msgs.push(makeTsMsg("user", older, `追加第${i}轮用户消息`));
    msgs.push(makeTsMsg("assistant", older, `追加第${i}轮助手回复`));
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

test("ChatThreadStore: 无已有 recap 行时 LLM 增强完成后插入到 system 之后", async () => {
  const store = new ChatThreadStore(null);
  store.setRecapSummarizer(async () => ["[3天前] 用户前天计划爬山（LLM摘要）"]);
  // 无已有 recap 的折叠线程：同步先生成兜底 recap，LLM 完成后原位更新
  const msgs = registeredThread(store, "session-e");
  store.trimThread(msgs, undefined, "session-e");

  const syncRecap = msgs.find((m) => typeof m.content === "string" && m.content.includes("[session-recap]"));
  assert.ok(syncRecap, "折叠时应有同步兜底 recap");

  await new Promise((r) => setTimeout(r, 20));
  const after = msgs.find((m) => typeof m.content === "string" && m.content.includes("[session-recap]"));
  assert.ok(after, "LLM 增强完成后应保留 recap 消息");
  assert.ok(
    typeof after!.content === "string" && after!.content.includes("LLM摘要"),
    "增强后的 recap 应包含 LLM 摘要内容",
  );
  assert.equal(msgs.indexOf(after!), 1, "recap 应保持在 system 之后");
});
