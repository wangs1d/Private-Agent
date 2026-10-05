/**
 * 屏幕状态条件化单测（主动感知扩展：不只学「几点」，还学「什么状态下」）：
 *   1. ScreenFocusSensor：强勿扰分类（开会/游戏/写代码…）→ 按小时去重的弱负观察；
 *      普通状态（聊天/浏览/闲置）不产出；分析窗口之外不产出
 *   2. ReceptivityDimensionModel：screen_busy 拉低对应小时接受度、attempts 口径不变
 *   3. 采样链健康：引擎 health() 记录采集/错误计数，声明应有产出的传感器
 *      连续 N 轮零观察 → stalled 红点（0 样本空转不再无人知晓）
 */
import assert from "node:assert/strict";
import test from "node:test";

import { ScreenFocusSensor } from "../src/rhythm/sensors/screen-focus-sensor.js";
import { ReceptivityDimensionModel } from "../src/rhythm/dimensions/receptivity-model.js";
import { LifeRhythmEngine } from "../src/rhythm/engine.js";
import { RhythmProfileStore } from "../src/rhythm/profile-store.js";
import type { Signal } from "../src/proactivity/sensors/types.js";
import type { RhythmObservation, RhythmSensor } from "../src/rhythm/types.js";

const HOUR = 3_600_000;

function screenSignal(kind: string, atMs: number): Signal {
  return {
    stream: "screen",
    at: atMs,
    fingerprint: `screen:${kind}:${atMs}`,
    salience: "low",
    delta: `前台应用切换 → ${kind}`,
    payload: { kind },
  };
}

test("ScreenFocusSensor：强勿扰分类按小时去重，普通状态与窗外信号不产出", () => {
  const base = Date.parse("2026-10-05T02:00:00.000Z"); // 10:00 北京时间
  const now = base + 6 * HOUR;
  const signals: Signal[] = [
    screenSignal("meeting", base + 0.5 * HOUR),
    screenSignal("meeting", base + 0.8 * HOUR), // 同小时同分类 → 去重
    screenSignal("game", base + 2 * HOUR),
    screenSignal("game", base + 3.5 * HOUR), // 不同小时 → 两条
    screenSignal("coding", base + 4 * HOUR),
    screenSignal("chat", base + 4.2 * HOUR), // 普通状态不产出
    screenSignal("browsing", base + 4.4 * HOUR),
    screenSignal("idle", base + 4.6 * HOUR),
    screenSignal("meeting", base - 2 * HOUR), // since 窗口之前不产出
  ];
  const sensor = new ScreenFocusSensor(() => signals, () => new Date(now));
  const observations = sensor.collect("actor-1", new Date(base));
  assert.equal(observations.length, 4, "meeting×1 + game×2 + coding×1");
  assert.ok(observations.every((o) => o.kind === "screen_busy" && o.value === 0));
  assert.ok(observations.every((o) => o.dimension === "receptivity"));
});

test("ReceptivityDimensionModel：screen_busy 弱负拉低对应小时，attempts 口径不变", () => {
  const model = new ReceptivityDimensionModel();
  const at = new Date(Date.parse("2026-10-05T02:30:00.000Z")); // 10:30 北京 → hour 10
  const prev = { byHour: new Array<number>(24).fill(0.8), byWeekday: new Array<number>(7).fill(0.8), attempts: 5 };
  const obs: RhythmObservation[] = [
    { dimension: "receptivity", at: at.toISOString(), value: 0, kind: "screen_busy", source: "screen-focus" },
  ];
  const next = model.ingest(prev, obs, { now: at });
  assert.ok(next.byHour[10]! < 0.8, "开会时段接受度被拉低");
  assert.equal(next.byHour[11]!, 0.8, "相邻小时不受影响");
  assert.equal(next.attempts, 5, "屏幕观察不计入触达 attempts（置信度口径不变）");
  // 静态守卫：连续两次同小时观察持续拉低但不穿透 0
  const again = model.ingest(next, obs, { now: at });
  assert.ok(again.byHour[10]! < next.byHour[10]! && again.byHour[10]! > 0);
});

function fixedSensor(id: string, opts: { error?: boolean; observations?: number; expects?: boolean }): RhythmSensor {
  return {
    id,
    dimensions: ["focus"],
    ...(opts.expects !== undefined ? { expectsObservations: opts.expects } : {}),
    collect() {
      if (opts.error) throw new Error("boom");
      return Array.from({ length: opts.observations ?? 0 }, (_, i) => ({
        dimension: "focus" as const,
        at: new Date(Date.now() - i * HOUR).toISOString(),
        value: 1,
        kind: "desktop_active",
        source: id,
      }));
    },
  };
}

async function withEngine(sensors: RhythmSensor[], runs: number): Promise<LifeRhythmEngine> {
  const dir = await (await import("node:fs/promises")).mkdtemp(
    (await import("node:path")).join((await import("node:os")).tmpdir(), "rhythm-health-"),
  );
  const store = new RhythmProfileStore(dir);
  const engine = new LifeRhythmEngine({ profileStore: store });
  for (const s of sensors) engine.registerSensor(s);
  for (let i = 0; i < runs; i++) {
    await engine.runAnalysis("actor-h", { now: new Date(Date.now() + i * HOUR) });
  }
  return engine;
}

test("采样链健康：错误与零观察计数入账，stalled 红点按声明与阈值判定", async () => {
  const engine = await withEngine(
    [
      fixedSensor("ok-sensor", { observations: 2, expects: true }),
      fixedSensor("broken-sensor", { error: true, expects: true }),
      fixedSensor("stalled-sensor", { observations: 0, expects: true }),
      fixedSensor("optional-idle-sensor", { observations: 0, expects: false }),
    ],
    3,
  );
  const health = engine.health();
  assert.equal(health.analysisRunCount, 3);
  assert.ok(health.enabled);
  const byId = new Map(health.sensors.map((s) => [s.sensorId, s]));
  assert.equal(byId.get("ok-sensor")!.stalled, false);
  assert.equal(byId.get("ok-sensor")!.observationCount, 6);
  assert.equal(byId.get("broken-sensor")!.errorCount, 3);
  assert.equal(byId.get("broken-sensor")!.lastError, "boom");
  assert.equal(byId.get("stalled-sensor")!.stalled, true, "3 轮零观察且应有产出 → 红点");
  assert.equal(byId.get("optional-idle-sensor")!.stalled, false, "天然常空的传感器不误报");
});

test("采样链健康：阈值前（<3 轮）不轻易打 stalled", async () => {
  const engine = await withEngine([fixedSensor("young-sensor", { observations: 0, expects: true })], 2);
  assert.equal(engine.health().sensors[0]!.stalled, false);
});
