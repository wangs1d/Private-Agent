// 方案 B：沉默日志单测——留痕 / 反问检索（时间窗+关键词+actor）/ 持久化恢复
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { SilenceLog } from "../src/proactivity/silence-log.js";

const NOW = Date.parse("2026-09-04T12:00:00Z");

function entry(overrides: Partial<Parameters<SilenceLog["record"]>[0]> = {}) {
  return {
    at: NOW,
    actorId: "user-a",
    kind: "preference_change_noted",
    title: "偏好更新：饮食",
    scope: "proposal" as const,
    netUtility: -0.1,
    riskScore: 0,
    valueScore: 0.2,
    reason: "net_utility_negative(value=0.2, interruption=0.3, riskDrag=0)",
    ...overrides,
  };
}

test("silence-log: 记录与 recent 倒序返回", () => {
  const log = new SilenceLog();
  log.record(entry({ at: NOW - 2000, title: "第一条" }));
  log.record(entry({ at: NOW - 1000, title: "第二条" }));
  const recent = log.recent(10);
  assert.equal(log.size(), 2);
  assert.equal(recent[0].title, "第二条", "时间倒序");
});

test("silence-log: 反问检索——关键词命中 kind/title/reason（不区分大小写）", () => {
  const log = new SilenceLog();
  log.record(entry({ kind: "life_reminder", title: "体检提醒", reason: "risk_drag(0.15)" }));
  log.record(entry({ kind: "preference_change_noted", title: "偏好更新：饮食", reason: "net_utility_negative" }));
  assert.equal(log.search({ keyword: "体检" }).length, 1);
  assert.equal(log.search({ keyword: "NET_UTILITY" }).length, 1, "reason 命中且大小写不敏感");
  assert.equal(log.search({ keyword: "不存在的词" }).length, 0);
  assert.equal(log.search({ kind: "life_reminder" }).length, 1);
});

test("silence-log: 反问检索——时间窗（上周）与 actor 过滤", () => {
  const log = new SilenceLog();
  const weekAgo = NOW - 8 * 24 * 60 * 60 * 1000;
  log.record(entry({ at: NOW - 24 * 60 * 60 * 1000, title: "昨天沉默的" }));
  log.record(entry({ at: weekAgo, title: "上周更早的" }));
  log.record(entry({ at: NOW - 1000, actorId: "user-b", title: "别人的" }));
  const lastWeek = log.search({ actorId: "user-a", sinceMs: NOW - 7 * 24 * 60 * 60 * 1000 });
  assert.equal(lastWeek.length, 1);
  assert.equal(lastWeek[0].title, "昨天沉默的");
  assert.equal(log.search({ actorId: "user-b" }).length, 1);
  assert.equal(log.search({ sinceMs: NOW - 7 * 24 * 60 * 60 * 1000 }).length, 2, "跨 actor 的时间窗命中两条");
});

test("silence-log: 容量上限淘汰最旧", () => {
  const log = new SilenceLog(undefined, 3);
  for (let i = 0; i < 5; i++) log.record(entry({ at: NOW + i, title: `#${i}` }));
  assert.equal(log.size(), 3);
  assert.equal(log.recent()[0].title, "#4");
  assert.equal(log.search({ keyword: "#0" }).length, 0, "最旧的已被淘汰");
});

test("silence-log: 同 dedupKey 24h 窗口内去重（扫描重提交不累积同因重复）", () => {
  const log = new SilenceLog();
  assert.equal(log.record(entry({ dedupKey: "k1", at: NOW })), true);
  assert.equal(log.record(entry({ dedupKey: "k1", at: NOW + 3600_000 })), false, "窗口内同键跳过");
  assert.equal(log.size(), 1);
  assert.equal(log.record(entry({ dedupKey: "k2", at: NOW + 3600_000 })), true, "不同键正常记录");
  assert.equal(log.size(), 2);
  assert.equal(log.record(entry({ dedupKey: "k1", at: NOW + 25 * 60 * 60 * 1000 })), true, "超窗后可再记");
  assert.equal(log.size(), 3);
});

test("silence-log: 无 dedupKey 的记录不去重（hub act 级每次都留痕）", () => {
  const log = new SilenceLog();
  log.record(entry({ at: NOW, title: "a" }));
  log.record(entry({ at: NOW + 1, title: "b" }));
  assert.equal(log.size(), 2);
});

test("silence-log: 落盘与重启恢复（沉默决策跨进程可反问）", () => {
  const dir = mkdtempSync(join(tmpdir(), "silence-log-"));
  try {
    const path = join(dir, "silence-log.json");
    const log = new SilenceLog(path);
    log.record(entry({ title: "跨重启的沉默", dedupKey: "k1" }));
    const restored = new SilenceLog(path);
    assert.equal(restored.size(), 1);
    const hit = restored.search({ keyword: "跨重启" });
    assert.equal(hit.length, 1);
    assert.equal(hit[0].dedupKey, "k1");
    assert.equal(hit[0].netUtility, -0.1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
