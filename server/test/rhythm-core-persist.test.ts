/**
 * RhythmCore 状态落盘单测（2026-10-01 P1）：连续工作计时/学习基线跨重启保留。
 * 断供根因：开发机 tsx watch 常态重启 → workStartAt 内存清零 → 过劳 3h 阈值
 * 永不可达 → 过劳干预对真实用户零触发。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { RhythmCore } from "../src/body/rhythm-core.js";
import { BodyBus } from "../src/body/body-bus.js";

async function makeCore(dir?: string): Promise<RhythmCore> {
  return new RhythmCore({ bodyBus: new BodyBus() }, dir);
}

test("落盘→新实例恢复：workStartAt / lateNightCount / 学习基线都在", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rhythm-core-"));
  try {
    const c1 = await makeCore(dir);
    const now = new Date("2026-10-01T15:00:00");
    // 喂两次活跃（10:00 起工作，15:00 仍连续）→ workStartAt=10 点段
    const anyCore = c1 as unknown as {
      noteActivity: (a: string, s: string, n: Date) => void;
      actors: Map<string, { workStartAt: number | null; lateNightCount: number }>;
      learned: Map<string, unknown>;
    };
    anyCore.noteActivity("u@qq.com", "conversation", new Date("2026-10-01T10:00:00"));
    anyCore.noteActivity("u@qq.com", "conversation", now);
    const before = anyCore.actors.get("u@qq.com")!;
    assert.ok(before.workStartAt);
    c1.flush();

    const c2 = await makeCore(dir);
    const after = (c2 as unknown as { actors: Map<string, { workStartAt: number | null }> }).actors.get("u@qq.com");
    assert.ok(after, "恢复出该用户状态");
    assert.equal(after!.workStartAt, before.workStartAt, "连续工作起点跨重启保留");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("重启后继续计时即可越过过劳阈值：跨重启连续工作时长累计", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rhythm-core-"));
  try {
    const c1 = await makeCore(dir);
    const any1 = c1 as unknown as { noteActivity: Function; actors: Map<string, { workStartAt: number | null }> };
    // 上午 9 点开始工作，9:30 最后一次活跃后重启
    any1.noteActivity("u@qq.com", "conversation", new Date("2026-10-01T09:00:00"));
    any1.noteActivity("u@qq.com", "conversation", new Date("2026-10-01T09:30:00"));
    c1.flush();
    const savedStart = any1.actors.get("u@qq.com")!.workStartAt!;

    const c2 = await makeCore(dir);
    const any2 = c2 as unknown as {
      noteActivity: Function;
      actors: Map<string, { workStartAt: number | null }>;
      learned: Map<string, { sessionLengthsMs: number[] }>;
    };
    // 重启后 13:00 继续活跃（间隔 3.5h > 30min 会重置——用 09:40 模拟快速重启）
    any2.noteActivity("u@qq.com", "conversation", new Date("2026-10-01T09:40:00"));
    assert.equal(
      any2.actors.get("u@qq.com")!.workStartAt,
      savedStart,
      "30 分钟内重启：工作段接续不重置（阈值累计不被清零）",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
