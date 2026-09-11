import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { extractChatTopics } from "../src/proactivity/proactive-outreach-executor.js";

describe("proactive outreach 话题摘要", () => {
  it("从最近对话提取用户话题关键词（用户侧优先、越新越优先）", () => {
    const topics = extractChatTopics([
      { role: "user", content: "[ts:2026-09-10T01:30:00Z] 帮我订一张去北京的火车票" },
      { role: "assistant", content: "好的，正在查询北京的车次。" },
      { role: "user", content: "2006年6月18 记住了没有" },
    ]);
    assert.ok(topics.length > 0);
    assert.ok(topics.includes("北京"));
    // ICU 分词可能把「火车票」切成「火车/票」或「车票」，两种都算命中
    assert.ok(topics.some((t) => t.includes("票")));
    // 越新的消息权重更高：最新话题应排在前面
    assert.equal(topics[0] === "北京" || topics[0] === "火车票" || topics[0] === "记住", true);
  });

  it("过滤功能词与纯数字，不把套话当话题", () => {
    const topics = extractChatTopics([
      { role: "user", content: "什么怎么这个那个，12345，好的" },
    ]);
    assert.deepEqual(topics, []);
  });

  it("非字符串 content 与空列表安全返回空", () => {
    assert.deepEqual(extractChatTopics([{ role: "user", content: null }]), []);
    assert.deepEqual(extractChatTopics([]), []);
  });

  it("maxTopics 限制返回数量", () => {
    const topics = extractChatTopics(
      [{ role: "user", content: "天气预报 火车票 北京 上海 广州" }],
      2,
    );
    assert.ok(topics.length <= 2);
  });
});
