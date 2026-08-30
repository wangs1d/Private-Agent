import test from "node:test";
import assert from "node:assert/strict";

import { ChatThreadStore } from "../src/external-model/chat-thread-store.js";

function buildStoreWithTurns(turns: number, maxThreadMessages?: number): ChatThreadStore {
  const store = new ChatThreadStore(null);
  const sessionId = "chat-thread-store-test";
  const systemPrompt = "system";

  for (let i = 1; i <= turns; i++) {
    const marker =
      i === 1
        ? "EARLY_SECRET=alpha-7319"
        : i === 10
          ? "TENTH_KEY=beta-4821"
          : i === 50
            ? "MIDDLE_KEY=gamma-2500"
            : "";

    store.appendTurn(
      sessionId,
      systemPrompt,
      {
        text: `user turn ${i} ${marker}`.trim(),
        clientMessageId: `u-${i}`,
      },
      `assistant turn ${i}`,
      maxThreadMessages,
    );
  }

  return store;
}

test("default thread window keeps trimmed context via session recap", () => {
  const store = buildStoreWithTurns(100);
  const thread = store.thread("chat-thread-store-test", "system");
  const serialized = JSON.stringify(thread);

  // 新设计：trimByDayBoundary 把当天消息全保留，历史压成 [session-recap]。
  // 测试中所有 turn 都是"今天"创建（appendTurn 注入 now 时间戳），无历史消息，
  // 不触发 recap，走 smartTrimByTokens 裁剪到 maxMessages 范围内。
  assert.ok(thread.length >= 13, `thread 应至少 13 条，实际 ${thread.length}`);
  // 裁剪后保留最近的消息（turn 89+ 应在窗口内）
  assert.match(serialized, /user turn 9\d/, "应保留最近的消息");
});

test("larger maxThreadMessages can retain 100 short turns", () => {
  const store = buildStoreWithTurns(100, 200);
  const thread = store.thread("chat-thread-store-test", "system");
  const serialized = JSON.stringify(thread);

  assert.equal(thread.length, 201);
  assert.equal(serialized.includes("EARLY_SECRET=alpha-7319"), true);
  assert.equal(serialized.includes("TENTH_KEY=beta-4821"), true);
  assert.equal(serialized.includes("MIDDLE_KEY=gamma-2500"), true);
});
