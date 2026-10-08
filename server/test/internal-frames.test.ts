/**
 * 线程内部帧契约回归（2026-10-08 手机端事故气泡）。
 *
 * 锁定契约：
 *   1. 内部帧整条 → 剥离后为空（调用方据此不下发气泡）
 *   2. 围栏整块 / 围栏半截标签 → 删净，不留 source=tool:x 字样
 *   3. 内部帧 + 正常正文混排 → 只剥帧，正文一字不动
 *   4. 正常正文（含方括号文案）不受影响
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  hasInternalFrameTag,
  isInternalFrameText,
  stripInternalFrames,
} from "../src/external-model/internal-frames.js";

test("逐字复读的中断占位帧（含围栏原文）整条判为内部帧并剥净", () => {
  const leaked =
    "[上一轮回复中断：最终回复未生成完整。期间已调用工具 weather.getLocal（共 1 次），" +
    "收到结果：[不可信内容围栏 source=tool:weather.getLocal]\n兴义 26℃\n[/不可信内容围栏]。" +
    "这些动作可能已实际生效——引用本事项前先查证实际状态，" +
    "不要把它当作用户重复请求或未处理的悬空事项重新提起。]";
  assert.equal(isInternalFrameText(leaked), true);
  assert.equal(stripInternalFrames(leaked), "");
});

test("围栏整块与其半截标签都被删净", () => {
  const block =
    "我查了一下：\n[不可信内容围栏 source=tool:weather.getLocal]\n今天晴 26℃\n[/不可信内容围栏]\n要带伞吗？";
  const out = stripInternalFrames(block);
  assert.equal(out.includes("不可信内容围栏"), false);
  assert.equal(out.includes("source=tool:"), false);
  assert.ok(out.includes("我查了一下"));
  assert.ok(out.includes("要带伞吗"));

  const dangling = "[不可信内容围栏 source=tool:search_web]\n好嘞";
  const out2 = stripInternalFrames(dangling);
  assert.equal(out2.includes("不可信内容围栏"), false);
  assert.ok(out2.includes("好嘞"));
});

test("单行内部帧整行删除，正文保留", () => {
  const mixed =
    "[后台任务记录] 目标：查天气\n结果：26℃\n\n好的，我帮你看了下天气。";
  const out = stripInternalFrames(mixed);
  assert.equal(out.includes("后台任务记录"), false);
  assert.ok(out.includes("好的，我帮你看了下天气"));
});

test("开头连续帧剥离后保留其后正文", () => {
  const out = stripInternalFrames("[session-recap] Earlier conversation recap:\n正常回复在这");
  assert.ok(!out.includes("session-recap"));
  assert.ok(out.includes("正常回复在这"));
});

test("正常正文（含方括号表达）不受影响", () => {
  const normal = "已查到 3 家火锅店：[评分 4.8] 黔味老灶、[人均 ¥78] 巷子口。";
  assert.equal(stripInternalFrames(normal).trim(), normal);
  assert.equal(isInternalFrameText(normal), false);
  assert.equal(hasInternalFrameTag(normal), false);
});

test("空串与纯空白安全", () => {
  assert.equal(stripInternalFrames(""), "");
  assert.equal(stripInternalFrames("   \n\n "), "");
  assert.equal(isInternalFrameText(""), false);
});

/* ------------------------------------------------------------------ *
 * XML 形态 <system-reminder>（2026-10-08 上游 harness 注入复读事故）  *
 * 三种实测形态都取自 chat-threads.json 的真实落盘原文                  *
 * ------------------------------------------------------------------ */

const REMINDER_EN =
  'A reminder that the "session-recap" is the recap of earlier conversation. ' +
  'You MUST NOT respond to or reference the "session-recap" in your final response.';

test("闭合块整体删除，正文保留（天气轮真实形态）", () => {
  const leaked =
    `<system-reminder>\n${REMINDER_EN}\n</system-reminder>\n\n` +
    "好的，我立刻查兴义明天的天气。明天兴义是大晴天。";
  const out = stripInternalFrames(leaked);
  assert.equal(out.includes("system-reminder"), false);
  assert.equal(out.includes("session-recap"), false);
  assert.ok(out.includes("好的，我立刻查兴义明天的天气"));
});

test("未闭合块吞英文提醒行、保留中文正文（闹钟轮真实形态）", () => {
  const leaked =
    `<system-reminder>\n${REMINDER_EN}\n起床闹钟已给你设好，明早 8 点准时叫你，睡个好觉。`;
  const out = stripInternalFrames(leaked);
  assert.equal(out.includes("system-reminder"), false);
  assert.equal(out.includes("MUST NOT"), false);
  assert.ok(out.includes("起床闹钟已给你设好，明早 8 点准时叫你，睡个好觉。"));
});

test("纯英文未闭合块（无正文）剥完为空（泄漏轮真实形态）", () => {
  const leaked = `<system-reminder>\n${REMINDER_EN}`;
  assert.equal(stripInternalFrames(leaked), "");
});

test("中间出现的 XML 块也剥，前后正文都保留", () => {
  const leaked =
    `开头\n<system-reminder>\n${REMINDER_EN}\n</system-reminder>\n结尾`;
  const out = stripInternalFrames(leaked);
  assert.equal(out.includes("system-reminder"), false);
  assert.ok(out.includes("开头"));
  assert.ok(out.includes("结尾"));
});

test("正常正文含尖括号/英文不受影响", () => {
  const normal = "用 <b> 加粗，或者 <br> 换行都行，注意看温度 >25℃ 的日子。";
  assert.equal(stripInternalFrames(normal).trim(), normal);
});

test("流式半截探测：识别 <system-reminder> 的真前缀，放过普通文本", async () => {
  const { systemReminderPartialTailLen } = await import(
    "../src/external-model/internal-frames.js"
  );
  assert.ok(systemReminderPartialTailLen("<system-") > 0);
  assert.ok(systemReminderPartialTailLen("正文<sys") > 0);
  assert.ok(systemReminderPartialTailLen("<system-reminder>") === 0); // 完整标签已到，交给整串剥
  assert.ok(systemReminderPartialTailLen("<") === 0); // 单字符不扣，防误吞正文
  assert.ok(systemReminderPartialTailLen("今天天气不错") === 0);
});

test("端到端：thread 折叠出的中断占位帧不再夹带围栏原文", async () => {
  const { foldCompletedToolChains } = await import(
    "../src/external-model/chat-thread-store.js"
  );
  const msgs = [
    { role: "system", content: "sys" },
    {
      role: "assistant",
      content: "",
      tool_calls: [
        { id: "c1", type: "function", function: { name: "weather.getLocal", arguments: "{}" } },
      ],
    },
    {
      role: "tool",
      tool_call_id: "c1",
      content:
        "[不可信内容围栏 source=tool:weather.getLocal]\n兴义 26℃ 晴\n[/不可信内容围栏]",
    },
  ] as never[];
  const changed = foldCompletedToolChains(msgs);
  assert.equal(changed, true);
  // 折叠后只剩一条 assistant 占位帧（system + 占位）
  const assistant = (msgs as Array<{ role: string; content?: unknown }>).filter(
    (m) => m.role === "assistant",
  );
  assert.equal(assistant.length, 1);
  const text = String(assistant[0]?.content ?? "");
  assert.ok(text.includes("上一轮回复中断"));
  // 契约核心：围栏原文（含 source=tool:）不得出现在占位帧里
  assert.equal(text.includes("不可信内容围栏"), false);
  assert.equal(text.includes("source=tool:"), false);
  // 工具事实仍在（天气数据本身，不是围栏头）
  assert.ok(text.includes("兴义 26℃ 晴"));
  // 且携带禁复述约束
  assert.ok(text.includes("禁止"));
});
