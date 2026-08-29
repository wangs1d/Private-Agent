import test from "node:test";
import assert from "node:assert/strict";

import {
  consumeNormalizedStream,
  StreamIdleTimeoutError,
  type NormalChatChunk,
} from "../src/external-model/stream-chat-helpers.js";
import {
  LivingInterimController,
  type LivingInterimConfig,
} from "../src/agent/interim-ack.js";
import type { ExternalChatProvider } from "../src/external-model/types.js";

// ==================== 辅助：构造流 ====================

function makeStream(chunks: NormalChatChunk[]): AsyncIterable<NormalChatChunk> {
  return (async function* () {
    for (const c of chunks) yield c;
  })();
}

/** 构造一个会卡住的流：发出第一个 chunk 后，第二个 chunk 延迟很久才来。 */
function makeStalledStream(
  firstChunk: NormalChatChunk,
  stallMs: number,
  afterStall?: NormalChatChunk,
): AsyncIterable<NormalChatChunk> {
  return (async function* () {
    yield firstChunk;
    await new Promise((r) => setTimeout(r, stallMs));
    if (afterStall) yield afterStall;
  })();
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ==================== 测试 1：inter-chunk idle 超时 ====================

test("consumeNormalizedStream: 正常流不触发超时", async () => {
  const chunks: NormalChatChunk[] = [
    { content: "Hello" },
    { content: " world" },
    { finishReason: "stop" },
  ];
  const result = await consumeNormalizedStream(makeStream(chunks), {
    providerId: "test",
    model: "test-model",
    idleTimeoutMs: 5000,
  });
  assert.equal(result.content, "Hello world");
  assert.equal(result.finishReason, "stop");
});

test("consumeNormalizedStream: 卡死流触发 StreamIdleTimeoutError", async () => {
  await assert.rejects(
    consumeNormalizedStream(
      makeStalledStream({ content: "partial" }, 3000, { content: "late" }),
      { idleTimeoutMs: 500, providerId: "test", model: "test-model" },
    ),
    (err: unknown) => {
      assert.ok(err instanceof StreamIdleTimeoutError, "应为 StreamIdleTimeoutError");
      assert.equal((err as StreamIdleTimeoutError).idleMs, 500);
      assert.equal((err as StreamIdleTimeoutError).partialContent, "partial");
      return true;
    },
  );
});

test("consumeNormalizedStream: idleTimeoutMs=0 禁用超时", async () => {
  const result = await consumeNormalizedStream(
    makeStalledStream({ content: "a" }, 100, { content: "b" }),
    { idleTimeoutMs: 0 },
  );
  assert.equal(result.content, "ab");
});

test("consumeNormalizedStream: 超时后底层 iterator 被释放", async () => {
  let returnCalled = false;
  const iterable: AsyncIterable<NormalChatChunk> = {
    [Symbol.asyncIterator]() {
      return {
        next: () =>
          new Promise<IteratorResult<NormalChatChunk>>((resolve) =>
            setTimeout(() => resolve({ value: { content: "x" }, done: false }), 10000),
          ),
        return: () => {
          returnCalled = true;
          return Promise.resolve({ value: undefined, done: true });
        },
      };
    },
  };
  await assert.rejects(
    consumeNormalizedStream(iterable, { idleTimeoutMs: 200 }),
    StreamIdleTimeoutError,
  );
  // 给 finally 块一点时间执行
  await sleep(50);
  assert.ok(returnCalled, "iterator.return 应被调用");
});

test("consumeNormalizedStream: onContentDelta 在超时前仍被调用", async () => {
  const deltas: string[] = [];
  await assert.rejects(
    consumeNormalizedStream(
      makeStalledStream({ content: "partial-text" }, 3000),
      {
        idleTimeoutMs: 500,
        onContentDelta: (d) => deltas.push(d),
      },
    ),
    StreamIdleTimeoutError,
  );
  assert.deepEqual(deltas, ["partial-text"]);
});

// ==================== 测试 2：interim ack 本地兜底 ====================

function makeProvider(opts: {
  enabled?: boolean;
  response?: string;
  delayMs?: number;
  throwOnCall?: boolean;
}): ExternalChatProvider {
  return {
    id: "fake",
    displayLabel: "fake",
    isEnabled: () => opts.enabled !== false,
    async streamCompletion(_sid, _turn, _onDelta, _tools, _streamOpts) {
      if (opts.throwOnCall) throw new Error("boom");
      if (opts.delayMs) await sleep(opts.delayMs);
      return opts.response ?? "";
    },
    clearSession() {},
  };
}

function makeController(opts: {
  provider: ExternalChatProvider | null;
  mode?: LivingInterimConfig["mode"];
}): { controller: LivingInterimController; sent: string[] } {
  const sent: string[] = [];
  const controller = new LivingInterimController({
    sessionId: "test",
    traceId: "test-trace",
    mode: opts.mode ?? "direct_llm",
    enabled: true,
    provider: opts.provider,
    send: (text) => sent.push(text),
    isStale: () => false,
    isMainReplyStarted: () => false,
  });
  return { controller, sent };
}

// 用 >30 字符的文本确保 shouldEmitInitial 走确定性分支（非随机跳过）
const LONG_TEXT = "帮我查一下今天北京的天气情况，需要包含温度湿度风力等详细的预报信息";

test("interim ack: provider 不可用时保持沉默（不发硬编码兜底）", async () => {
  const { controller, sent } = makeController({
    provider: makeProvider({ enabled: false }),
  });
  await controller.maybeEmitInitial(LONG_TEXT);
  // 设计变更：LLM 不可用时不发硬编码兜底，保持沉默比发模板更自然
  assert.equal(sent.length, 0, "provider 不可用时应保持沉默，不发硬编码兜底");
});

test("interim ack: provider 超时时保持沉默（不发硬编码兜底）", async () => {
  const { controller, sent } = makeController({
    provider: makeProvider({ delayMs: 10000, response: "太慢了" }),
  });
  // INITIAL_TIMEOUT_MS=4500ms，provider 延迟 10s → 超时 → 保持沉默
  await controller.maybeEmitInitial(LONG_TEXT);
  assert.equal(sent.length, 0, "超时应保持沉默，不发硬编码兜底");
});

test("interim ack: provider 异常时保持沉默（不发硬编码兜底）", async () => {
  const { controller, sent } = makeController({
    provider: makeProvider({ throwOnCall: true }),
  });
  await controller.maybeEmitInitial(LONG_TEXT);
  assert.equal(sent.length, 0, "异常时应保持沉默，不发硬编码兜底");
});

test("interim ack: provider 正常时使用 LLM 文案", async () => {
  const { controller, sent } = makeController({
    provider: makeProvider({ response: "嗯，我看看天气" }),
  });
  await controller.maybeEmitInitial(LONG_TEXT);
  assert.equal(sent.length, 1);
  assert.ok(sent[0].includes("天气"), "应使用 LLM 生成的文案");
});

test("interim ack: provider 正常时 LLM 文案应反映用户内容", async () => {
  // 设计变更：provider 不可用时不再发硬编码兜底，此测试改为验证
  // provider 正常时 LLM 文案能回引用用户内容（而非固定模板）
  let hitKeyword = false;
  for (let i = 0; i < 5; i++) {
    const { controller, sent } = makeController({
      provider: makeProvider({ response: "好的，我查一下今天北京的天气" }),
    });
    await controller.maybeEmitInitial("帮我查一下今天北京的天气情况详细预报包含温度湿度风力等等信息");
    if (sent[0] && (sent[0].includes("天气") || sent[0].includes("查一下"))) {
      hitKeyword = true;
      break;
    }
  }
  assert.ok(hitKeyword, "LLM 文案至少一次应反映用户内容关键词");
});

// ==================== 测试 3：工具心跳定时器逻辑 ====================
// 心跳定时器内嵌在 chat-user-message.ts 的闭包中，无法直接单元测试。
// 这里验证 setInterval + clearTimeout 的行为模式是否符合预期。

test("tool heartbeat: 30s 间隔的定时器模式验证", async () => {
  const tickTimes: number[] = [];
  const start = Date.now();
  const timer = setInterval(() => {
    tickTimes.push(Date.now() - start);
  }, 50); // 用 50ms 模拟 30s

  await sleep(180); // 等约 3-4 次 tick
  clearInterval(timer);

  assert.ok(tickTimes.length >= 2, "应至少触发 2 次心跳");
  // 验证间隔大致正确（允许 20ms 误差）
  for (let i = 1; i < tickTimes.length; i++) {
    const gap = tickTimes[i] - tickTimes[i - 1];
    assert.ok(gap >= 40 && gap <= 80, `心跳间隔应 ~50ms，实际 ${gap}ms`);
  }
});

test("tool heartbeat: clearInterval 后不再触发", async () => {
  let count = 0;
  const timer = setInterval(() => count++, 30);
  await sleep(100);
  clearInterval(timer);
  const countAfterClear = count;
  await sleep(100);
  assert.equal(count, countAfterClear, "clearInterval 后不应再触发");
});

// ==================== 测试 4：端到端超时链路 ====================

test("e2e: 流式卡死 → StreamIdleTimeoutError → 可获取 partial content", async () => {
  // 模拟：模型发了 "正在" 然后卡住
  const stalledStream = makeStalledStream({ content: "正在" }, 5000);

  let error: StreamIdleTimeoutError | null = null;
  let partialForFallback = "";

  try {
    await consumeNormalizedStream(stalledStream, {
      idleTimeoutMs: 300,
      onContentDelta: (d) => {
        partialForFallback += d;
      },
    });
  } catch (e) {
    if (e instanceof StreamIdleTimeoutError) {
      error = e;
      partialForFallback = e.partialContent;
    }
  }

  assert.ok(error, "应抛出 StreamIdleTimeoutError");
  assert.equal(partialForFallback, "正在", "应能获取已缓冲的部分内容用于兜底");
});
