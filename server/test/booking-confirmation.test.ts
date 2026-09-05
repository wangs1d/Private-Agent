/**
 * 方案 A 单测：booking-confirmation（两阶段确认 token 存储）。
 *
 * 覆盖：mint/consume 正常往返、一次性消费、TTL 过期（注入时钟）、
 * actor/action/domain 不匹配拒绝、缺 token。
 */

import assert from "node:assert/strict";
import test from "node:test";

import { BookingConfirmationStore } from "../src/services/booking/booking-confirmation.js";

function makeStore(ttlMs = 300_000): { store: BookingConfirmationStore; setNow: (ms: number) => void } {
  let nowMs = Date.parse("2026-09-04T10:00:00Z");
  const store = new BookingConfirmationStore({ ttlMs, now: () => nowMs });
  return { store, setNow: (ms) => (nowMs = ms) };
}

const baseInput = {
  actorId: "user-1",
  domain: "ride" as const,
  provider: "simulated",
  action: "book" as const,
  draft: null,
  summary: "即将预订「网约车」经济型（模拟估价 ¥45）",
  amountCny: 45,
};

test("booking-confirmation - mint/consume 正常往返", () => {
  const { store } = makeStore();
  const pending = store.mint(baseInput);
  assert.ok(pending.token);
  assert.equal(pending.amountCny, 45);
  assert.equal(pending.expiresAt - Date.parse("2026-09-04T10:00:00Z"), 300_000);

  const consumed = store.consume(pending.token, { actorId: "user-1", action: "book", domain: "ride" });
  assert.equal(consumed.ok, true);
  if (consumed.ok) {
    assert.equal(consumed.pending.summary, baseInput.summary);
  }
});

test("booking-confirmation - token 一次性消费", () => {
  const { store } = makeStore();
  const pending = store.mint(baseInput);
  const first = store.consume(pending.token, { actorId: "user-1", action: "book", domain: "ride" });
  assert.equal(first.ok, true);
  const second = store.consume(pending.token, { actorId: "user-1", action: "book", domain: "ride" });
  assert.equal(second.ok, false);
  if (!second.ok) {
    assert.match(second.error, /无效或已被使用/);
    assert.equal(second.retryable, true);
  }
});

test("booking-confirmation - TTL 过期（注入时钟）", () => {
  const { store, setNow } = makeStore(300_000);
  const pending = store.mint(baseInput);
  setNow(Date.parse("2026-09-04T10:00:00Z") + 300_001);
  const consumed = store.consume(pending.token, { actorId: "user-1", action: "book", domain: "ride" });
  assert.equal(consumed.ok, false);
  if (!consumed.ok) {
    assert.match(consumed.error, /过期/);
    assert.equal(consumed.retryable, true);
  }
});

test("booking-confirmation - actor 不匹配拒绝", () => {
  const { store } = makeStore();
  const pending = store.mint(baseInput);
  const consumed = store.consume(pending.token, { actorId: "user-2", action: "book", domain: "ride" });
  assert.equal(consumed.ok, false);
  if (!consumed.ok) {
    assert.match(consumed.error, /不匹配/);
  }
  // 拒绝后 token 仍在（未消费）
  const retry = store.consume(pending.token, { actorId: "user-1", action: "book", domain: "ride" });
  assert.equal(retry.ok, true);
});

test("booking-confirmation - action/domain 不匹配拒绝", () => {
  const { store } = makeStore();
  const pending = store.mint(baseInput);
  const consumed = store.consume(pending.token, { actorId: "user-1", action: "cancel", domain: "ride" });
  assert.equal(consumed.ok, false);
});

test("booking-confirmation - 空 token 直接拒绝", () => {
  const { store } = makeStore();
  const consumed = store.consume("", { actorId: "user-1", action: "book", domain: "ride" });
  assert.equal(consumed.ok, false);
});
