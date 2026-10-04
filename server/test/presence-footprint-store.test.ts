import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  PresenceFootprintStore,
  deriveSleepFromFootprints,
  localDayKey,
  type DailyFootprint,
} from "../src/rhythm/presence-footprint-store.js";

/** 构造一天的足迹：hours 为活跃小时槽 */
function day(date: string, hours: number[]): DailyFootprint {
  const activeHours = new Array<number>(24).fill(0);
  for (const h of hours) activeHours[h] = (activeHours[h] ?? 0) + 1;
  const total = hours.length;
  return {
    date,
    activeHours,
    firstHour: hours.length ? Math.min(...hours) : null,
    lastHour: hours.length ? Math.max(...hours) : null,
    total,
  };
}

test("deriveSleepFromFootprints：连续 3 晚 23 点收工 → 入睡 00:30、起床 07:30", () => {
  const days = [
    day("2026-10-01", [9, 14, 23]),
    day("2026-10-02", [8, 15, 23]),
    day("2026-10-03", [8, 14, 23]),
    day("2026-10-04", [8]),
  ];
  const r = deriveSleepFromFootprints(days);
  // 入睡 = 最后活跃槽右端(24) + 0.5h 缓冲 = 24.5 → 00:30
  assert.equal(r.sleepStartHour, 0.5);
  // 起床 = 次日首个 04:00–11:00 活跃槽(8) − 0.5h = 07:30
  assert.equal(r.wakeHour, 7.5);
  assert.equal(r.nightCount, 3);
});

test("deriveSleepFromFootprints：凌晨 2 点仍在线 → 入睡点跟着推晚", () => {
  const days = [
    day("2026-10-01", [16, 23]),
    day("2026-10-02", [1, 2, 10]), // 次日凌晨 1、2 点仍在线
    day("2026-10-03", [16, 23]),
    day("2026-10-04", [1, 2, 10]),
    day("2026-10-05", [16, 23]),
    day("2026-10-06", [1, 2, 10]),
  ];
  const r = deriveSleepFromFootprints(days);
  // 10-01 夜：次日凌晨 2 点最后在线 → 2+24=26，右端 27 + 0.5 = 27.5 → 03:30
  assert.equal(r.sleepStartHour, 3.5);
  // 起床：次日 10 点首次在线 → 09:30
  assert.equal(r.wakeHour, 9.5);
});

test("deriveSleepFromFootprints：有效夜不足 3 → 不产出（宁缺勿错）", () => {
  const days = [day("2026-10-01", [9, 23]), day("2026-10-02", [8])];
  const r = deriveSleepFromFootprints(days);
  assert.equal(r.sleepStartHour, null);
  assert.equal(r.wakeHour, null);
  assert.equal(r.nightCount, 1);
});

test("deriveSleepFromFootprints：白天就断线的一天不算入睡证据", () => {
  // 每天最晚只到 19 点（<21 证据下限），即便有 5 天也推不出入睡
  const days = [
    day("2026-10-01", [9, 19]),
    day("2026-10-02", [9, 19]),
    day("2026-10-03", [9, 19]),
    day("2026-10-04", [9, 19]),
  ];
  const r = deriveSleepFromFootprints(days);
  assert.equal(r.sleepStartHour, null);
  assert.equal(r.nightCount, 0);
});

test("deriveSleepFromFootprints：下午才开电脑不算起床证据", () => {
  // 每天首次在线都在 16 点（>11 起床证据上限）→ 起床点推不出
  const days = [
    day("2026-10-01", [16, 23]),
    day("2026-10-02", [16, 23]),
    day("2026-10-03", [16, 23]),
    day("2026-10-04", [16, 23]),
  ];
  const r = deriveSleepFromFootprints(days);
  assert.ok(r.sleepStartHour != null, "入睡应可推出");
  assert.equal(r.wakeHour, null, "起床不应从下午首在线推出");
});

test("deriveSleepFromFootprints：入睡取中位数，单夜异常不主导", () => {
  const days = [
    day("2026-10-01", [23]),
    day("2026-10-02", [23]),
    day("2026-10-03", [23]),
    day("2026-10-04", [23]),
    day("2026-10-05", [23]),
    day("2026-10-06", [3]), // 只熬了一夜到凌晨 3 点
  ];
  const r = deriveSleepFromFootprints(days);
  // 5 夜 00:30（24.5）+ 1 夜 04:30（28.5）→ 中位数 24.5 → 00:30
  assert.equal(r.sleepStartHour, 0.5);
});

test("PresenceFootprintStore：打点按本地日聚合，可持久化并重载", () => {
  const dir = mkdtempSync(join(tmpdir(), "presence-"));
  const file = join(dir, "footprint.json");
  const store = new PresenceFootprintStore(file);
  store.load();

  store.record("u1", new Date(2026, 9, 1, 23, 30));
  store.record("u1", new Date(2026, 9, 1, 23, 45));
  store.record("u1", new Date(2026, 9, 2, 8, 15));
  store.flush();

  const raw = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(raw.actors.u1.days["2026-10-01"].activeHours[23], 2);
  assert.equal(raw.actors.u1.days["2026-10-02"].activeHours[8], 1);

  const reloaded = new PresenceFootprintStore(file);
  reloaded.load();
  assert.equal(reloaded.recentDays("u1", 14).length, 2);
  assert.equal(reloaded.hasAny("u1"), true);
  assert.equal(reloaded.hasAny("u2"), false);
});

test("PresenceFootprintStore：真实作息形状可推出（夜猫子）", () => {
  const dir = mkdtempSync(join(tmpdir(), "presence-"));
  const store = new PresenceFootprintStore(join(dir, "footprint.json"));
  store.load();
  // 连续 3 晚：晚间 23 点用 agent，凌晨 1–2 点还在用，次日 9 点又出现
  for (let i = 0; i < 3; i++) {
    const d = 1 + i * 2;
    store.record("night-owl", new Date(2026, 9, d, 23, 20));
    store.record("night-owl", new Date(2026, 9, d + 1, 1, 40));
    store.record("night-owl", new Date(2026, 9, d + 1, 2, 5));
    store.record("night-owl", new Date(2026, 9, d + 1, 9, 10));
  }
  const r = store.deriveSleepWindow("night-owl", { lookbackDays: 14 });
  // 最后活跃槽 2 → 2+24=26，右端 27 + 0.5 = 27.5 → 03:30
  assert.equal(r.sleepStartHour, 3.5);
  assert.equal(r.wakeHour, 8.5);
  assert.equal(r.nightCount, 3);
});

test("localDayKey：按本地日切分", () => {
  assert.equal(localDayKey(new Date(2026, 9, 4, 1, 30)), "2026-10-04");
  assert.equal(localDayKey(new Date(2026, 9, 4, 23, 59)), "2026-10-04");
});
