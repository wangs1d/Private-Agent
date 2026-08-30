// InitiativeDecisionCache（负向决策缓存）单测：
// 指纹不变性（顺序无关）、跳过判定、TTL 过期、高显著豁免、滚动淘汰、actor 隔离。
import assert from "node:assert/strict";
import test from "node:test";

import { InitiativeDecisionCache } from "../src/proactivity/initiative-decision-cache.js";
import type { Observation } from "../src/proactivity/proactivity-types.js";

const ACTOR = "actor-1";

function obs(type: string, content: string, salience: Observation["salience"] = "low"): Observation {
  return { actorId: ACTOR, type, content, salience, observedAt: Date.now() };
}

test("指纹：同内容同指纹（顺序无关）；不同内容不同指纹", () => {
  const cache = new InitiativeDecisionCache();
  const a = [obs("conversation_turn", "用户说：在忙设计"), obs("user_activity", "用户活跃（来源：conversation）")];
  const b = [obs("user_activity", "用户活跃（来源：conversation）"), obs("conversation_turn", "用户说：在忙设计")];
  assert.equal(cache.fingerprintObservations(a), cache.fingerprintObservations(b));
  const c = [obs("conversation_turn", "用户说：在忙设计"), obs("user_activity", "用户活跃（来源：presence）")];
  assert.notEqual(cache.fingerprintObservations(a), cache.fingerprintObservations(c));
});

test("跳过判定：记录 none 后 TTL 内同指纹跳过；未记录/不同指纹不跳过", () => {
  const cache = new InitiativeDecisionCache({ ttlMs: 60 * 60 * 1000 });
  const observations = [obs("conversation_turn", "用户说：在忙设计")];
  const fp = cache.fingerprintObservations(observations);

  assert.equal(cache.shouldSkip(ACTOR, fp, false), false); // 未记录过

  cache.recordNone(ACTOR, fp);
  assert.equal(cache.shouldSkip(ACTOR, fp, false), true); // TTL 内命中

  const otherFp = cache.fingerprintObservations([obs("conversation_turn", "用户说：周末去爬山")]);
  assert.equal(cache.shouldSkip(ACTOR, otherFp, false), false); // 不同指纹不跳过
});

test("高显著豁免：high 显著观察永不跳过（重要事件必须真评估）", () => {
  const cache = new InitiativeDecisionCache({ ttlMs: 60 * 60 * 1000 });
  const fp = cache.fingerprintObservations([obs("conversation_turn", "用户说：在忙设计")]);
  cache.recordNone(ACTOR, fp);
  assert.equal(cache.shouldSkip(ACTOR, fp, false), true); // 低显著：命中跳过
  assert.equal(cache.shouldSkip(ACTOR, fp, true), false); // 高显著：豁免，仍走 LLM
});

test("TTL 过期：同指纹不再跳过（场景可能已变化）", () => {
  const cache = new InitiativeDecisionCache({ ttlMs: 50 });
  const fp = cache.fingerprintObservations([obs("conversation_turn", "用户说：在忙设计")]);
  cache.recordNone(ACTOR, fp);
  assert.equal(cache.shouldSkip(ACTOR, fp, false), true);
  // 等待 TTL 过期（50ms + 缓冲）
  return new Promise((resolve) => {
    setTimeout(() => {
      assert.equal(cache.shouldSkip(ACTOR, fp, false), false);
      resolve(null);
    }, 120);
  });
});

test("滚动淘汰：超过 maxEntries 淘汰最旧（防内存无限膨胀）", () => {
  const cache = new InitiativeDecisionCache({ ttlMs: 60 * 60 * 1000, maxEntries: 3 });
  const fps = ["指纹一", "指纹二", "指纹三", "指纹四"].map((tag) =>
    cache.fingerprintObservations([obs("conversation_turn", `用户说：${tag}`)]),
  );
  for (const fp of fps) cache.recordNone(ACTOR, fp);
  assert.equal(cache.size(ACTOR), 3); // 上限 3
  assert.equal(cache.shouldSkip(ACTOR, fps[0], false), false); // 最旧被淘汰
  assert.equal(cache.shouldSkip(ACTOR, fps[3], false), true); // 最新保留
});

test("actor 隔离：A 记录的 none 不影响 B", () => {
  const cache = new InitiativeDecisionCache({ ttlMs: 60 * 60 * 1000 });
  const fpA = cache.fingerprintObservations([obs("conversation_turn", "用户说：在忙设计")]);
  // 同一观察序列换个 actor 指纹内容相同（指纹只看 type+content），但缓存按 actor 分桶
  cache.recordNone("actor-a", fpA);
  assert.equal(cache.shouldSkip("actor-a", fpA, false), true);
  assert.equal(cache.shouldSkip("actor-b", fpA, false), false);
  assert.equal(cache.size("actor-b"), 0);
});
