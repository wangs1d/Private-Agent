import test from "node:test";
import assert from "node:assert/strict";
import { createStreamMetaSentenceFilter } from "../src/external-model/stream-chat-helpers.js";

test("createStreamMetaSentenceFilter drops sentences that contain multiple meta terms", () => {
  const feed = createStreamMetaSentenceFilter();
  // 流式模拟：分两批喂入，前一句含元术语、后一句正常
  const out1 = feed("上一轮转入规划任务，执行脑已接手处理中。");
  assert.equal(out1, "", "整段元描述句应被丢弃");
  const out2 = feed("好的，那你什么时候出发？");
  assert.equal(out2, "好的，那你什么时候出发？", "正常句子应原样输出");
});

test("createStreamMetaSentenceFilter keeps sentences that incidentally contain a single meta term", () => {
  const feed = createStreamMetaSentenceFilter();
  const out = feed("转交给我来办，机票价格查到了，1200元。");
  assert.equal(
    out,
    "转交给我来办，机票价格查到了，1200元。",
    "仅含 1 个元术语不算元描述整句，应保留",
  );
});

test("createStreamMetaSentenceFilter buffers when sentence has no terminator yet", () => {
  const feed = createStreamMetaSentenceFilter();
  const mid = feed("上一轮转入规划任务，执");
  assert.equal(mid, "", "无句末标点应继续累积，不输出");
  const tail = feed("行脑已接手处理中。");
  assert.equal(tail, "", "整句命中元描述，最终丢弃");
});

test("createStreamMetaSentenceFilter handles mixed normal + meta sentences", () => {
  const feed = createStreamMetaSentenceFilter();
  const out = feed(
    "巴厘岛是印尼比较经典的玩法。" + "上一轮转入规划任务，执行脑已接手处理中。" + "你想哪天出发？",
  );
  assert.equal(
    out,
    "巴厘岛是印尼比较经典的玩法。你想哪天出发？",
    "正常句保留、元描述整句丢弃",
  );
});
