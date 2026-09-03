import assert from "node:assert/strict";
import { test, describe } from "node:test";

import {
  isOnlyTimestampFrames,
  stripAllTimestampFrameLines,
  stripLeadingTimestampFrames,
} from "../src/utils/timestamp-frame.js";
import {
  buildMessageTimestampPrefix,
  buildTimestampFreeLlmView,
  getChatThreadStore,
  tagUserMessageClientId,
} from "../src/external-model/chat-thread-store.js";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";

/** 2026-09-03 21:35:07 周四（与事故截图同时刻）。 */
const NOW = new Date(2026, 8, 3, 21, 35, 7);

describe("timestamp-frame 清洗原语", () => {
  test("剥标准格式前缀（存储格式，管道分隔）", () => {
    const prefix = buildMessageTimestampPrefix(
      new Date(2026, 8, 3, 21, 30, 0),
      NOW,
    );
    const text = `${prefix}\n王哥，这照片得用专门的图库搜。`;
    assert.equal(
      stripLeadingTimestampFrames(text),
      "王哥，这照片得用专门的图库搜。",
    );
  });

  test("剥模型复述的变体帧（]周X[now] 尾随记号）", () => {
    const text = "[ts:2026-09-03 21:35:07]周四[now]\n\n王哥，";
    assert.equal(stripLeadingTimestampFrames(text), "王哥，");
  });

  test("剥残缺帧（[ts 后断行丢冒号）——事故截图里的漏网形态", () => {
    const text = "[ts\n2026-09-03 21:35:07]周四[now]\n王哥，";
    assert.equal(stripLeadingTimestampFrames(text), "王哥，");
  });

  test("连续多帧开头全部剥掉", () => {
    const text =
      "[ts:2026-09-03 21:35:07]周四[now]\n[ts\n2026-09-03 21:35:07]周四[now]\n正文";
    assert.equal(stripLeadingTimestampFrames(text), "正文");
  });

  test("不含 [ts 的文本原样返回（不误伤正文）", () => {
    const text = "正常回复，带 [方括号] 与英文。";
    assert.equal(stripLeadingTimestampFrames(text), text);
    assert.equal(stripAllTimestampFrameLines(text), text);
  });

  test("整行帧删除：夹在正文中间的复述帧行被清掉", () => {
    const text =
      "王哥，\n[ts:2026-09-03 21:35:07]周四[now]\n这照片得用专门的图库搜。";
    assert.equal(
      stripAllTimestampFrameLines(text),
      "王哥，\n这照片得用专门的图库搜。",
    );
  });

  test("整行帧删除：残缺帧行同样清掉", () => {
    const text = "开头\n[ts\n2026-09-03 21:35:07]周四[now]\n结尾";
    assert.equal(stripAllTimestampFrameLines(text), "开头\n结尾");
  });

  test("行中间嵌帧的正文不动（只清整行帧，避免误伤）", () => {
    const text = "前缀 [ts:2026-09-03 21:35:07]周四[now] 后缀";
    assert.equal(stripAllTimestampFrameLines(text), text);
  });

  test("isOnlyTimestampFrames：整条即帧 → true；正文 → false", () => {
    assert.equal(isOnlyTimestampFrames("[ts:2026-09-03 21:35:07]周四[now]"), true);
    assert.equal(isOnlyTimestampFrames("[ts\n2026-09-03 21:35:07]周四[now]"), true);
    assert.equal(isOnlyTimestampFrames("  \n"), false);
    assert.equal(isOnlyTimestampFrames("王哥，"), false);
    assert.equal(
      isOnlyTimestampFrames("[ts:2026-09-03 21:35:07]周四[now] 王哥，"),
      false,
    );
  });
});

describe("buildTimestampFreeLlmView", () => {
  const user = (content: string): ChatCompletionMessageParam => ({
    role: "user",
    content,
  });
  const assistant = (content: string): ChatCompletionMessageParam => ({
    role: "assistant",
    content,
  });

  test("历史正文剥前缀，本轮 user 消息保留原对象（未剥时同引用）", () => {
    const p1 = `${buildMessageTimestampPrefix(new Date(2026, 8, 1, 20, 0, 0), NOW)}\n早上好`;
    const p2 = `${buildMessageTimestampPrefix(new Date(2026, 8, 3, 21, 35, 0), NOW)}\n帮我找图`;
    const msgs = [
      { role: "system", content: "sys" } as ChatCompletionMessageParam,
      user(p1),
      assistant(`${buildMessageTimestampPrefix(new Date(2026, 8, 1, 20, 1, 0), NOW)}\n早`),
      user(p2),
    ];
    const view = buildTimestampFreeLlmView(msgs, NOW).messages;

    const texts = view.map((m) => (typeof m.content === "string" ? m.content : ""));
    assert.ok(texts.every((t) => !t.includes("[ts:")), "视图里不应再有任何 [ts: 帧");
    assert.ok(texts.includes("早上好"));
    // 本轮 user 消息（最后一条）也必须剥掉前缀——它是最强的模仿源
    assert.equal(texts[texts.length - 1], "帮我找图");
  });

  test("时间轴 system 消息注入在最后一条 user 消息之前，且含绝对时间与角色", () => {
    const p1 = `${buildMessageTimestampPrefix(new Date(2026, 8, 1, 20, 0, 0), NOW)}\n早上好`;
    const pa = `${buildMessageTimestampPrefix(new Date(2026, 8, 1, 20, 1, 0), NOW)}\n早`;
    const p2 = `${buildMessageTimestampPrefix(new Date(2026, 8, 3, 21, 35, 0), NOW)}\n帮我找图`;
    const msgs = [user(p1), assistant(pa), user(p2)];
    const view = buildTimestampFreeLlmView(msgs, NOW).messages;

    const timelineIdx = view.findIndex(
      (m) => m.role === "system" && typeof m.content === "string" && m.content.includes("对话时间轴"),
    );
    const lastUserIdx = view.map((m) => m.role).lastIndexOf("user");
    assert.ok(timelineIdx > 0, "应注入时间轴 system 消息");
    assert.equal(timelineIdx, lastUserIdx - 1, "时间轴应在最后一条 user 之前");

    const timeline = view[timelineIdx].content as string;
    assert.ok(timeline.includes("2026-09-01 20:00:00 周二 用户"), timeline);
    assert.ok(timeline.includes("2026-09-01 20:01:00 周二 助手"), timeline);
    assert.ok(timeline.includes("2026-09-03 21:35:00 周四 用户"), timeline);
  });

  test("剥离产生的克隆透传 clientMessageId（编辑/删除定位不丢）", () => {
    const store = getChatThreadStore();
    const sessionId = `test-ts-view-${Date.now()}`;
    const msgs = store.thread(sessionId, "sys");
    const userMsg = {
      role: "user",
      content: "带标记的消息",
    } as ChatCompletionMessageParam;
    tagUserMessageClientId(userMsg, "client-msg-1");
    msgs.push(userMsg);

    const view = buildTimestampFreeLlmView(msgs, NOW).messages;
    // 无前缀 → 不克隆、同引用；有前缀 → 克隆也必须带同样的 clientMessageId
    assert.equal(view[view.length - 1], userMsg);

    userMsg.content = `[ts:2026-09-03 21:00:00|周四|just now]\n带标记的消息`;
    const view2 = buildTimestampFreeLlmView(msgs, NOW).messages;
    const cloned = view2[view2.length - 1];
    assert.notEqual(cloned, userMsg, "有前缀的消息应被克隆");
    assert.equal(
      (cloned.content as string).includes("带标记的消息"),
      true,
    );
    // 克隆必须能被 clientMessageId 反查（readUserMessageText 路径）
    assert.equal(store.readUserMessageText(sessionId, "client-msg-1"), "带标记的消息");
    store.clearSession(sessionId);
  });

  test("时间条目 <2（如 ephemeral 单轮）不注入时间轴，但仍剥前缀", () => {
    const p = `${buildMessageTimestampPrefix(new Date(2026, 8, 3, 21, 35, 0), NOW)}\n只有一句`;
    const view = buildTimestampFreeLlmView([user(p)], NOW).messages;
    assert.equal(view.length, 1);
    assert.equal(view[0].content, "只有一句");
  });

  test("视图克隆不污染线程原消息（存储层前缀保持原样）", () => {
    const p = `${buildMessageTimestampPrefix(new Date(2026, 8, 3, 21, 30, 0), NOW)}\n历史消息`;
    const msgs = [user(p), user("本轮")];
    buildTimestampFreeLlmView(msgs, NOW);
    assert.equal(
      msgs[0].content,
      p,
      "线程原消息对象必须保持字节级原样（prefix cache 冻结语义）",
    );
  });
});
