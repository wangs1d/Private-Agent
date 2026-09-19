// 生理周期关怀服务测试（period-care：经期记录 / 周期预测 / 临近提醒 / 加密存储）：
//  1. 记录开始/结束 + 预测（中位数周期、置信度、区间）
//  2. 临近提醒：到点触发一次、同日去重、未到点不触发
//  3. 同日重复记录开始 → 合并补全而非重复建条
//  4. 持久化：AES-256-GCM 加密落盘 + 重新加载还原；purge 清除
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { PeriodCareService } from "../src/services/period-care-service.js";

async function makeService(opts?: {
  now?: () => Date;
  proposals?: unknown[];
}) {
  const dir = await mkdtemp(join(tmpdir(), "period-care-test-"));
  const proposals = opts?.proposals ?? [];
  const service = new PeriodCareService({
    dataDir: dir,
    getPipeline: () => ({
      submitProposal: (p: unknown) => {
        proposals.push(p);
        return { verdict: "delivered" };
      },
    }),
    ...(opts?.now ? { now: opts.now } : {}),
  });
  return { dir, service, proposals };
}

test("周期预测：中位数周期 + 置信度 + 预测区间", async () => {
  const now = () => new Date(2026, 8, 20, 10, 0, 0); // 本地 2026-09-20 10:00
  const { service } = await makeService({ now });

  await service.logPeriodStart("u1", { date: "2026-06-03" });
  await service.logPeriodStart("u1", { date: "2026-07-01" });
  await service.logPeriodStart("u1", { date: "2026-07-29" });
  await service.logPeriodStart("u1", { date: "2026-08-26" });
  await service.logPeriodEnd("u1", { date: "2026-08-30" });

  const status = service.getStatus("u1");
  assert.equal(status.hasData, true);
  assert.equal(status.inPeriod, false);
  assert.equal(status.cycleDay, 26); // 08-26 起 09-20 为第 26 天
  assert.equal(status.latestCycleLengthDays, 28);
  assert.equal(status.averageCycleLengthDays, 28);
  assert.equal(status.confidence, "medium"); // 3 个样本
  assert.equal(status.predictedNextStart, "2026-09-23");
  assert.equal(status.daysUntilPredictedStart, 3);
  assert.ok(status.predictedRangeDays != null && status.predictedRangeDays >= 1);
  assert.match(status.disclaimer, /非医学结论/);
});

test("临近提醒：到点触发一次、同日去重、未到提醒时刻不触发", async () => {
  const clock = { current: new Date(2026, 8, 21, 8, 0, 0) }; // 本地 2026-09-21 08:00
  const { service, proposals } = await makeService({ now: () => clock.current });

  await service.logPeriodStart("u1", { date: "2026-07-01" });
  await service.logPeriodStart("u1", { date: "2026-07-29" });
  await service.logPeriodStart("u1", { date: "2026-08-26" });
  // 3 个 28 天样本 → 预测下次开始 2026-09-23，默认提前 2 天 → 提醒日 09-21

  // 08:00：提醒日命中但未到提醒时刻（默认 9 点）→ 不发
  assert.equal(await service.runDue(clock.current), 0);
  assert.equal(proposals.length, 0);

  // 10:00：到点 → 发一条
  clock.current = new Date(2026, 8, 21, 10, 0, 0);
  assert.equal(await service.runDue(clock.current), 1);
  assert.equal(proposals.length, 1);
  const p = proposals[0] as { kind: string; tier: string; dedupKey: string; directText: string };
  assert.equal(p.kind, "period_care");
  assert.equal(p.tier, "must");
  assert.ok(p.directText.length > 0);
  assert.match(p.dedupKey, /2026-09-21$/);

  // 同日再扫 → 去重不发
  clock.current = new Date(2026, 8, 21, 11, 0, 0);
  assert.equal(await service.runDue(clock.current), 0);
  assert.equal(proposals.length, 1);
});

test("同日重复记录经期开始 → 合并补全", async () => {
  const { service } = await makeService();
  await service.logPeriodStart("u1", { date: "2026-09-19" });
  const second = await service.logPeriodStart("u1", {
    date: "2026-09-19",
    flow: "heavy",
    pain: 7,
    symptoms: ["cramps"],
  });
  assert.equal(second.merged, true);
  assert.equal(second.cycle.flow, "heavy");
  assert.equal(second.cycle.pain, 7);
  const history = service.getHistory("u1");
  assert.equal(history.length, 1);
});

test("加密持久化：重新加载还原，文件非明文；purge 清除", async () => {
  const { dir, service } = await makeService();
  await service.logPeriodStart("u1", { date: "2026-09-01", note: "私密备注" });
  await service.flush();

  const raw = await readFile(join(dir, "u1.json"), "utf8");
  assert.ok(!raw.startsWith("{"), "落盘内容必须是密文而非 JSON 明文");
  assert.ok(!raw.includes("私密备注"));

  const reloaded = new PeriodCareService({ dataDir: dir, getPipeline: () => null });
  await reloaded.load();
  assert.equal(reloaded.getStatus("u1").hasData, true);
  assert.equal(reloaded.getHistory("u1")[0]?.note, "私密备注");

  await reloaded.purge("u1");
  const afterPurge = new PeriodCareService({ dataDir: dir, getPipeline: () => null });
  await afterPurge.load();
  assert.equal(afterPurge.getStatus("u1").hasData, false);

  await rm(dir, { recursive: true, force: true });
});
