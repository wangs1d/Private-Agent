// SpeechPolisher 单测：内容型场景的 LLM 主动回复 + 模板兜底 + 用量熔断。
// 全部用 mock chat provider（零外网、零真实 LLM）。
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SpeechPolisher } from "../src/proactivity/speech-polisher.js";
import type { ExternalChatProvider } from "../src/external-model/types.js";

function mockChat(reply: string | Error, delayMs = 0): ExternalChatProvider & { calls: number } {
  const state = { calls: 0 };
  const provider = {
    isEnabled: () => true,
    async streamCompletion(
      _sessionId: string,
      _input: { text: string },
      onDelta: (d: string) => void,
    ): Promise<void> {
      state.calls += 1;
      if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
      if (reply instanceof Error) throw reply;
      onDelta(reply);
    },
  } as unknown as ExternalChatProvider & { calls: number };
  Object.defineProperty(provider, "calls", { get: () => state.calls });
  return provider;
}

function makePolisher(chat: ExternalChatProvider | null, opts: { maxPerDay?: number; timeoutMs?: number } = {}) {
  if (opts.maxPerDay !== undefined) process.env.PROACTIVITY_MAX_PHRASE_PER_DAY = String(opts.maxPerDay);
  const polisher = new SpeechPolisher({
    chat: () => chat,
    dataPath: mkdtempSync(join(tmpdir(), "polisher-")),
    timeoutMs: opts.timeoutMs ?? 8_000,
  });
  delete process.env.PROACTIVITY_MAX_PHRASE_PER_DAY;
  return polisher;
}

const FALLBACK = "刚帮你盯着消息呢——有人发来「会议推迟」，要我帮你改日程吗？";

test("polish: LLM 正常生成 → 返回话术并审计", async () => {
  const chat = mockChat("李雷说会议推迟了，要我帮你把日历改到周四吗？");
  const polisher = makePolisher(chat);
  const out = await polisher.polish({
    kind: "message_watch",
    sessionId: "u1",
    facts: { sender: "李雷", excerpt: "会议推迟到周四", verb: "推迟" },
    fallback: FALLBACK,
  });
  assert.equal(chat.calls, 1);
  assert.ok(out.includes("李雷"), `LLM 话术含人名: ${out}`);
  assert.ok(!out.includes("机器腔"));
  assert.equal(polisher.stats().callsToday, 1);
  assert.equal(polisher.stats().enabled, true);
});

test("polish: LLM 失败/超时 → 模板兜底永不中断表达", async () => {
  const errChat = mockChat(new Error("provider down"));
  const polisher1 = makePolisher(errChat);
  assert.equal(await polisher1.polish({ kind: "message_watch", sessionId: "u1", facts: {}, fallback: FALLBACK }), FALLBACK);
  assert.ok(polisher1.stats().lastFallback?.startsWith("error:"), "失败原因留痕");

  const slowChat = mockChat("太慢了", 300);
  const polisher2 = makePolisher(slowChat, { timeoutMs: 50 });
  assert.equal(await polisher2.polish({ kind: "message_watch", sessionId: "u1", facts: {}, fallback: FALLBACK }), FALLBACK);
});

test("polish: 输出异常（SILENT/过长/多行）→ 兜底", async () => {
  for (const bad of ["SILENT", "x".repeat(150), "第一行\n第二行"]) {
    const polisher = makePolisher(mockChat(bad));
    const out = await polisher.polish({ kind: "unread_burst", sessionId: "u1", facts: {}, fallback: FALLBACK });
    assert.equal(out, FALLBACK, `异常输出应兜底: ${bad.slice(0, 10)}`);
  }
});

test("polish: 每日熔断——超 cap 后走模板且不再调 LLM", async () => {
  const chat = mockChat("好的短句");
  const polisher = makePolisher(chat, { maxPerDay: 2 });
  await polisher.polish({ kind: "message_watch", sessionId: "u1", facts: {}, fallback: FALLBACK });
  await polisher.polish({ kind: "message_watch", sessionId: "u1", facts: {}, fallback: FALLBACK });
  assert.equal(chat.calls, 2);
  const out = await polisher.polish({ kind: "message_watch", sessionId: "u1", facts: {}, fallback: FALLBACK });
  assert.equal(chat.calls, 2, "熔断后不再调用");
  assert.equal(out, FALLBACK);
  assert.equal(polisher.stats().enabled, false);
});

test("polish: kill switch 与无 provider 直接模板（零调用）", async () => {
  process.env.PROACTIVITY_PHRASE_LLM = "0";
  const chat = mockChat("不会走到这");
  const polisher = makePolisher(chat);
  assert.equal(await polisher.polish({ kind: "message_watch", sessionId: "u1", facts: {}, fallback: FALLBACK }), FALLBACK);
  assert.equal(chat.calls, 0);
  delete process.env.PROACTIVITY_PHRASE_LLM;

  const polisher2 = makePolisher(null);
  assert.equal(await polisher2.polish({ kind: "message_watch", sessionId: "u1", facts: {}, fallback: FALLBACK }), FALLBACK);
  assert.equal(polisher2.stats().enabled, false);
});
