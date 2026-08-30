import test from "node:test";
import assert from "node:assert/strict";

import { ChatThreadStore, trimPreservingToolPairs } from "../src/external-model/chat-thread-store.js";

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

// ---- pin 回填（滑动窗口驱逐 → 优先级驱逐）----

test("trimPreservingToolPairs: 显式记忆轮被 pin 保留，驱逐发生在最旧的非 pin 组", () => {
  const msgs: Array<{ role: string; content: string }> = [];
  // 早期用户显式记忆轮（pin 目标）
  msgs.push({ role: "user", content: "请记住我的部署密钥是 PIN_TOKEN_XYZ" });
  // 20 条新闲聊（填充窗口）
  for (let i = 1; i <= 20; i++) {
    msgs.push({ role: "user", content: `filler question ${i}` });
    msgs.push({ role: "assistant", content: `ack ${i}` });
  }

  // 预算 11：尾部贪心装 11 条（index 10..20），pin 组（1 条）需要驱逐最旧已选组腾位
  const { kept, dropped } = trimPreservingToolPairs(
    msgs as never[],
    11,
  );
  const serialized = JSON.stringify(kept);
  assert.ok(serialized.includes("PIN_TOKEN_XYZ"), "显式记忆轮应被 pin 保留");
  assert.ok(dropped.length > 0, "应发生驱逐");
  // 被驱逐的是最旧的已选非 pin 组（index 10），而非 pin 组本身或最近尾部
  assert.ok(!serialized.includes("filler question 10"), "最旧已选非 pin 组应被驱逐腾位");
  assert.ok(serialized.includes("filler question 20"), "最近尾部应完整保留");
  // 时序保持：保留消息按原顺序
  const indexes = kept.map((m) => msgs.indexOf(m as never));
  assert.deepEqual(indexes, [...indexes].sort((a, b) => a - b));
  // 预算不超
  assert.ok(kept.length <= 11, `kept 应 ≤ maxMessages，实际 ${kept.length}`);
});

test("trimPreservingToolPairs: 无 pin 时保持原尾部截断行为", () => {
  const msgs: Array<{ role: string; content: string }> = [];
  for (let i = 1; i <= 10; i++) {
    msgs.push({ role: "user", content: `plain user ${i}` });
    msgs.push({ role: "assistant", content: `plain ack ${i}` });
  }
  const { kept, dropped } = trimPreservingToolPairs(msgs as never[], 8);
  assert.equal(kept.length, 8);
  assert.equal(dropped.length, 12);
  const serialized = JSON.stringify(kept);
  assert.ok(serialized.includes("plain user 10"), "最近内容保留");
  assert.ok(!serialized.includes("plain user 1 "), "最旧内容被截断");
});

// ---- 条内压缩防过度压缩护栏 ----

import { compressAssistantTextForWindow } from "../src/external-model/chat-thread-store.js";

function padText(prefix: string, totalChars: number): string {
  let t = prefix;
  const filler = "这是一个普通的陈述句。";
  while (t.length < totalChars) t += filler;
  return t.slice(0, totalChars);
}

test("compressAssistantTextForWindow: 句子边界对齐 + 标记前缀 + 幂等兼容", () => {
  // 头窗口在句中截断 → 应回退到上一个句末标点
  const headSentence = "开头结论句子，说明处理结果。";
  const text = padText(headSentence + "后面这半句没有标点结尾会被回退掉", 600)
    + "中段填充内容，" .repeat(40)
    + "结尾句子完整收束。补充的尾巴内容没有标点也无所谓";
  const result = compressAssistantTextForWindow(text, 200);
  assert.ok(result, "超长文本应被压缩");
  assert.ok(result!.startsWith("[已压缩·"), "应带压缩标记（幂等检查依赖此前缀）");
  assert.ok(result!.includes(" … "), "应保留头尾结构");
  // 头段应以句末标点收束（边界对齐生效）
  const headPart = result!.split(" … ")[0]!;
  assert.ok(/[。！？!?…]$/.test(headPart.replace(/^\[已压缩·\d+字符→\d+\]\s*/, "")), `头段应对齐句末标点，实际尾字符: ${headPart.slice(-4)}`);
  assert.ok(result!.length < text.length, "压缩应有收益");
});

test("compressAssistantTextForWindow: 短文本/无收益时不压缩", () => {
  assert.equal(compressAssistantTextForWindow("短文本", 800), null, "不超阈值不压缩");
  // maxChars < 200 直接拒绝（防误配过度压缩）
  assert.equal(compressAssistantTextForWindow(padText("内容。", 500), 100), null);
});

test("compressOversizedAssistantMessages: 承诺轮与代码块消息不压缩，普通长回复压缩", () => {
  const store = new ChatThreadStore(null);
  const compress = (store as unknown as {
    compressOversizedAssistantMessages: (msgs: never[], maxChars: number) => void;
  }).compressOversizedAssistantMessages.bind(store);

  const commitment = padText("我会帮你每天早上八点提醒你喝水，这是承诺内容的一部分。", 1200);
  const codeMsg = "这是你要的代码：\n```js\n" + padText("const x = 1;", 1200) + "\n```";
  const ordinary = padText("这是一段普通的超长分析陈述。", 1200);
  const shortAck = "好的。";

  const msgs: Array<{ role: string; content: string }> = [
    { role: "system", content: "sys" },
    { role: "assistant", content: commitment },
    { role: "assistant", content: codeMsg },
    { role: "assistant", content: ordinary },
    { role: "user", content: "追问" },
    { role: "assistant", content: shortAck },
    { role: "user", content: "再问" },
    { role: "assistant", content: shortAck },
  ];
  compress(msgs as never[], 800);

  assert.ok(msgs[1]!.content === commitment, "承诺/结论轮不应被压缩");
  assert.ok(msgs[2]!.content === codeMsg, "含代码围栏的消息不应被压缩");
  assert.ok(String(msgs[3]!.content).startsWith("[已压缩·"), "普通超长回复应被压缩");
  // 最近 2 轮（preserveRecentTurns=2 → 末 4 条）全量保留：末尾短消息天然不受影响
  assert.ok(msgs[7]!.content === shortAck);
});

test("compressOversizedAssistantMessages: 最近 N 轮全量保留，幂等不二次压缩", () => {
  const store = new ChatThreadStore(null);
  const compress = (store as unknown as {
    compressOversizedAssistantMessages: (msgs: never[], maxChars: number) => void;
  }).compressOversizedAssistantMessages.bind(store);

  const long = padText("普通长回复内容。", 1200);
  const msgs: Array<{ role: string; content: string }> = [
    { role: "system", content: "sys" },
    { role: "assistant", content: long },
    { role: "user", content: "u2" },
    { role: "assistant", content: long },
    { role: "user", content: "u3" },
    { role: "assistant", content: long },
    { role: "user", content: "u4" },
    { role: "assistant", content: long },
  ];
  // msgs.length=8, recentStart = 8 - 2*2 = 4 → 压缩范围 index 1..3（老轮），
  // 最近 2 轮 = 末 4 条（index 4..7）全量保留
  compress(msgs as never[], 800);
  assert.ok(String(msgs[1]!.content).startsWith("[已压缩·"), "老轮应被压缩");
  assert.ok(String(msgs[3]!.content).startsWith("[已压缩·"), "老轮应被压缩（recentStart 之前）");
  assert.ok(msgs[5]!.content === long && msgs[7]!.content === long, "最近轮全量保留");

  // 幂等：再跑一遍不再变化
  const snapshot = JSON.stringify(msgs);
  compress(msgs as never[], 800);
  assert.equal(JSON.stringify(msgs), snapshot, "已压缩内容不应二次压缩");
});
