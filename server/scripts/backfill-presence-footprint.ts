/**
 * 在场足迹一次性回填（可重复执行，幂等）。
 *
 * 在场足迹是新增的作息观察源，但打点从现在才开始累积——要凑够 3 个有效夜得等
 * 三天。本脚本把 agent **历史上已经观察到**的在场证据回灌进足迹存储，让作息
 * 个性化当天就能生效。
 *
 * 数据来源（都是 agent 自己记录的「用户在场」事件）：
 *   1. data/habit-loop/observations.json —— 工具执行观察 {actorId, tool, at}
 *   2. data/life-signals.json           —— 生活信号 {actorId, occurredAt}
 *
 * 测试/夹具 actor（e2e-、gui-、bench-、anonymous 等）会被跳过，避免污染画像。
 *
 * 用法：node --import tsx scripts/backfill-presence-footprint.ts
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  initPresenceFootprintStore,
  type PresenceFootprintStore,
} from "../src/rhythm/presence-footprint-store.js";

/** 测试/夹具 actor 特征：命中即跳过 */
const TEST_ACTOR_PATTERN =
  /(^anonymous$|^gui-|^bench|^probe|^smoke|^profile-|^session-mvp|^diag|^debug|^reg-|^devremote|^incognito|e2e|test|mock|demo|^xiaoyu|^link-smoke|^wire-debug|^final-smoke)/i;

type RawEvent = { actorId: string; at: number };

function readHabitLoop(file: string): RawEvent[] {
  if (!existsSync(file)) return [];
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as {
      observations?: Array<{ actorId?: string; tool?: string; at?: number }>;
    };
    return (parsed.observations ?? [])
      .filter((o): o is { actorId: string; tool: string; at: number } =>
        typeof o?.actorId === "string" && Number.isFinite(o?.at),
      )
      .map((o) => ({ actorId: o.actorId, at: o.at }));
  } catch {
    return [];
  }
}

function readLifeSignals(file: string): RawEvent[] {
  if (!existsSync(file)) return [];
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as {
      history?: Record<string, Array<{ actorId?: string; occurredAt?: string; at?: string }>>;
    };
    const out: RawEvent[] = [];
    for (const list of Object.values(parsed.history ?? {})) {
      for (const s of list ?? []) {
        const t = Date.parse(s?.occurredAt ?? s?.at ?? "");
        if (Number.isFinite(t) && typeof s?.actorId === "string") {
          out.push({ actorId: s.actorId, at: t });
        }
      }
    }
    return out;
  } catch {
    return [];
  }
}

function backfill(store: PresenceFootprintStore): void {
  const cwd = process.cwd();
  const events = [
    ...readHabitLoop(join(cwd, "data", "habit-loop", "observations.json")),
    ...readLifeSignals(join(cwd, "data", "life-signals.json")),
  ];

  const kept: RawEvent[] = [];
  const skipped = new Set<string>();
  for (const e of events) {
    if (!e.actorId || TEST_ACTOR_PATTERN.test(e.actorId)) {
      skipped.add(e.actorId);
      continue;
    }
    kept.push(e);
  }

  for (const e of kept) store.record(e.actorId, e.at);
  store.flush();

  console.log(
    `[backfill-presence] 事件总数=${events.length} 采用=${kept.length} 跳过测试actor=${skipped.size}`,
  );

  const actorIds = new Set(kept.map((e) => e.actorId));
  for (const actorId of [...actorIds].sort()) {
    const days = store.listDays(actorId);
    const w = store.deriveSleepWindow(actorId, { lookbackDays: 30 });
    const fmt = (h: number | null): string =>
      h == null
        ? "—"
        : `${String(Math.floor(h)).padStart(2, "0")}:${String(Math.round(((h % 1) * 60)) % 60).padStart(2, "0")}`;
    console.log(
      `  ${actorId}: ${days.length} 天足迹 | 有效夜=${w.nightCount} | 入睡=${fmt(w.sleepStartHour)} | 起床=${fmt(w.wakeHour)}`,
    );
    for (const d of days) {
      const hours = d.activeHours
        .map((c, h) => (c > 0 ? String(h).padStart(2, "0") : null))
        .filter(Boolean)
        .join(",");
      console.log(`      ${d.date} (${d.total}次): ${hours}`);
    }
  }
}

const store = initPresenceFootprintStore();
backfill(store);
console.log("[backfill-presence] 完成");
