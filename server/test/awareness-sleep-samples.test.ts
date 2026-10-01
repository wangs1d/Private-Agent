/**
 * AwarenessCortex 睡眠样本根修单测（2026-10-01 P1.5 rhythm 断供）。
 *
 * 断供三根因中的两个可单测：
 *   ① key 归一——样本按原始 actorId（a@b.com）写入，节律引擎按下划线
 *      归一形式（a_b.com）读取，错位即空。修复后两形式互通。
 *   ② 持久化——样本纯内存重启清零，永远凑不齐 3 晚阈值。修复后落盘可恢复
 *      （含进行中 sleeping 会话起点，重启接续计时）。
 * （根因③夜间定时器由真链验证：interval 行为不适合单测。）
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AwarenessCortex } from "../src/brain/awareness-cortex.js";

const HOUR = 60 * 60_000;

/** 走真实 trackSleepWindow 状态转移开一场 ≥30min 的睡眠并收样 */
function trackOneNight(cortex: AwarenessCortex, actorId: string): void {
  const anyCortex = cortex as unknown as {
    trackSleepWindow: (
      actorId: string,
      prev: string | undefined,
      next: string,
    ) => void;
    ongoingSleepSession: Map<string, number>;
    sleepKey: (actorId: string) => string;
  };
  // 进入 sleeping（记会话起点），再把起点拨回 7 小时前模拟整夜
  anyCortex.trackSleepWindow(actorId, "idle", "sleeping");
  const key = AwarenessCortex["sleepKey"](actorId);
  anyCortex.ongoingSleepSession.set(key, Date.now() - 7 * HOUR);
  // 离开 sleeping：关会话写样本
  anyCortex.trackSleepWindow(actorId, "sleeping", "idle");
}

test("key 归一：原始 id（@）写入与归一 id（_）读取互通", () => {
  const cortex = new AwarenessCortex();
  trackOneNight(cortex, "2378709729@qq.com");
  // rhythm 引擎侧按归一形式读
  const samples = cortex.getRecentSleepWindowSamples("2378709729_qq.com");
  assert.equal(samples.length, 1);
  assert.ok(samples[0]!.date);
  // 学习窗口（≥3 样本才生效）两侧同源
  for (let i = 0; i < 3; i++) trackOneNight(cortex, "2378709729@qq.com");
  const learned = cortex.getLearnedSleepWindow("2378709729_qq.com");
  assert.ok(learned, "归一形式可读学习窗口");
  assert.ok((learned?.sampleCount ?? 0) >= 3);
});

test("持久化：flush 落盘、新实例恢复样本与进行中会话", async () => {
  const dir = await mkdtemp(join(tmpdir(), "awareness-sleep-"));
  try {
    const c1 = new AwarenessCortex();
    c1.setPersistPath(dir);
    trackOneNight(c1, "a@b.com");
    // 再造一场进行中的睡眠会话（未醒）
    (c1 as unknown as { trackSleepWindow: Function }).trackSleepWindow("a@b.com", "idle", "sleeping");
    c1.flushSleepSamples();

    const raw = JSON.parse(await readFile(join(dir, "awareness-sleep-samples.json"), "utf8"));
    assert.ok(raw.actors["a_b.com"], "落盘 key 为归一形式");
    assert.equal(raw.actors["a_b.com"].samples.length, 1);
    assert.ok(typeof raw.actors["a_b.com"].ongoingSince === "number");

    // 新实例同目录恢复
    const c2 = new AwarenessCortex();
    c2.setPersistPath(dir);
    assert.equal(c2.getRecentSleepWindowSamples("a@b.com").length, 1, "原始形式可读恢复样本");
    const ongoing = (c2 as unknown as { ongoingSleepSession: Map<string, number> }).ongoingSleepSession;
    assert.ok(ongoing.has("a_b.com"), "进行中会话起点已恢复");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("短于 30 分钟的会话不入样（防噪声阈值回归）", () => {
  const cortex = new AwarenessCortex();
  const anyCortex = cortex as unknown as {
    trackSleepWindow: Function;
    ongoingSleepSession: Map<string, number>;
  };
  anyCortex.trackSleepWindow("u@x.com", "idle", "sleeping");
  anyCortex.ongoingSleepSession.set("u_x.com", Date.now() - 10 * 60_000);
  anyCortex.trackSleepWindow("u@x.com", "sleeping", "idle");
  assert.equal(cortex.getRecentSleepWindowSamples("u_x.com").length, 0);
});
