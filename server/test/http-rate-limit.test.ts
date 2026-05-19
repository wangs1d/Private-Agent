import test from "node:test";
import assert from "node:assert/strict";

import { HttpRateLimitStore } from "../src/http-rate-limit/http-rate-limit.js";
import {
  buildOrderedPathRateLimitRules,
  resolvePathRateLimitRule,
} from "../src/http-rate-limit/path-rate-limit-rules.js";
import { parseEvalResult } from "../src/http-rate-limit/redis-rate-limit.js";

const defaultTier = {
  slidingWindowMs: 60_000,
  slidingMax: 600,
  bucketCapacity: 80,
  bucketRefillPerSecond: 40,
};

const chatRule = {
  id: "chat",
  prefix: "/chat",
  slidingWindowMs: 60_000,
  slidingMax: 10_000,
  bucketCapacity: 3,
  bucketRefillPerSecond: 1,
};

test("resolvePathRateLimitRule: longest prefix wins", () => {
  const ordered = buildOrderedPathRateLimitRules(defaultTier);
  assert.equal(resolvePathRateLimitRule("/protocol/unified/quota", ordered).id, "protocol_unified");
  assert.equal(resolvePathRateLimitRule("/chat/tools", ordered).id, "chat");
  assert.equal(resolvePathRateLimitRule("/tools", ordered).id, "tools");
  assert.equal(resolvePathRateLimitRule("/world/foo", ordered).id, "world");
  assert.equal(resolvePathRateLimitRule("/unknown/x", ordered).id, "default");
});

test("parseEvalResult maps Redis Lua return", () => {
  assert.deepEqual(parseEvalResult([1, 0, ""]), { ok: true });
  assert.deepEqual(parseEvalResult([0, 500, "sliding_window"]), {
    ok: false,
    retryAfterMs: 500,
    layer: "sliding_window",
  });
  assert.deepEqual(parseEvalResult([0, 100, "token_bucket"]), {
    ok: false,
    retryAfterMs: 100,
    layer: "token_bucket",
  });
});

test("HttpRateLimitStore: token bucket allows burst then throttles", () => {
  const store = new HttpRateLimitStore(10_000, 60_000);
  const t0 = 1_000_000;
  const key = "a::chat";
  assert.equal(store.tryConsume(key, chatRule, t0).ok, true);
  assert.equal(store.tryConsume(key, chatRule, t0).ok, true);
  assert.equal(store.tryConsume(key, chatRule, t0).ok, true);
  const r = store.tryConsume(key, chatRule, t0);
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.layer, "token_bucket");
});

test("HttpRateLimitStore: sliding window caps sustained traffic", () => {
  const rule = {
    id: "t",
    prefix: "",
    slidingWindowMs: 10_000,
    slidingMax: 2,
    bucketCapacity: 100,
    bucketRefillPerSecond: 100,
  };
  const store = new HttpRateLimitStore(10_000, 10_000);
  const t0 = 2_000_000;
  const key = "b::t";
  assert.equal(store.tryConsume(key, rule, t0).ok, true);
  assert.equal(store.tryConsume(key, rule, t0).ok, true);
  const r = store.tryConsume(key, rule, t0);
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.layer, "sliding_window");
});

test("HttpRateLimitStore: sliding window frees after window passes", () => {
  const rule = {
    id: "t",
    prefix: "",
    slidingWindowMs: 1000,
    slidingMax: 1,
    bucketCapacity: 10,
    bucketRefillPerSecond: 10,
  };
  const store = new HttpRateLimitStore(10_000, 10_000);
  const t0 = 5_000_000;
  const key = "c::t";
  assert.equal(store.tryConsume(key, rule, t0).ok, true);
  assert.equal(store.tryConsume(key, rule, t0).ok, false);
  assert.equal(store.tryConsume(key, rule, t0 + 1001).ok, true);
});
