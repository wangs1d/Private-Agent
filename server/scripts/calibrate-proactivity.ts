/**
 * 周度校准脚本（calibrate-proactivity.ts）—— 用真实 outcome/事件数据回顾主动性参数。
 *
 * 背景：打断成本权重、分 kind 冷却、alert 档阈值此前全是手拍先验
 * （arbiter-v2.ts 注释里"上线两周后可用 outcome 数据回归校准"欠的账）。
 * 本脚本读 data/proactivity/ 的落盘数据，输出分 kind 表现 + 调参建议
 * （人工审阅后再改代码/env，不自动生效）。
 *
 * 运行：npx tsx scripts/calibrate-proactivity.ts [--days 14]
 * 输出：stdout 报告 + data/proactivity/calibration-report.json
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

type OutcomeRecord = { deliveryId: string; actorId: string; kind: string; channel: string; outcome: string; at: number };
type EventRecord = { at: number; kind: string; urgency: string; actorId: string; action: string; cost?: number; title?: string; verdict?: string };

const POSITIVE = new Set(["accepted", "replied", "snoozed"]);
const IMPRESSION = new Set(["viewed", "delivered"]);
const ROOT = join(process.cwd(), "data", "proactivity");

function readJson<T>(p: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(p, "utf8")) as T;
  } catch {
    return fallback;
  }
}

function readNdjson(p: string): Array<Record<string, unknown>> {
  try {
    return readFileSync(p, "utf8")
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as Record<string, unknown>);
  } catch {
    return [];
  }
}

const args = process.argv.slice(2);
const daysIdx = args.indexOf("--days");
const windowDays = daysIdx >= 0 ? Math.max(1, Number(args[daysIdx + 1]) || 14) : 14;
const now = Date.now();
const windowStart = now - windowDays * 24 * 3600_000;

const outcomes = readJson<OutcomeRecord[]>(join(ROOT, "outcomes.json"), []).filter((r) => r.at >= windowStart && r.outcome !== "delivered");
const events = readNdjson(join(ROOT, "events.ndjson")) as unknown as EventRecord[];
const eventsInWindow = events.filter((e) => e.at >= windowStart);

// ── 分 kind 接受率（viewed/delivered impression 不进分母） ──
const byKind = new Map<string, OutcomeRecord[]>();
for (const r of outcomes) {
  const list = byKind.get(r.kind) ?? [];
  list.push(r);
  byKind.set(r.kind, list);
}

type KindReport = {
  kind: string;
  samples: number;
  accepted: number;
  ignoredOrDismissed: number;
  acceptanceRate: number | null;
  suggestion: string;
};

const kindReports: KindReport[] = [];
for (const [kind, list] of byKind) {
  const latestByDelivery = new Map<string, OutcomeRecord>();
  for (const r of list) latestByDelivery.set(r.deliveryId, r);
  const records = [...latestByDelivery.values()];
  const positive = records.filter((r) => POSITIVE.has(r.outcome)).length;
  const negative = records.filter((r) => !POSITIVE.has(r.outcome) && !IMPRESSION.has(r.outcome)).length;
  const decided = positive + negative;
  const rate = decided >= 5 ? Math.round((positive / decided) * 1000) / 1000 : null;
  let suggestion = "样本不足（<5 条已决策），继续观察";
  if (rate !== null) {
    if (rate < 0.35) suggestion = `接受率偏低 → 建议该 kind 冷却 ×1.5（PROACTIVITY_COOLDOWN_${kind.toUpperCase()}）或降级 importance`;
    else if (rate > 0.7) suggestion = "接受率良好 → 冷却可 ×0.9 或尝试提高触达档位";
    else suggestion = "接受率健康，保持现状";
  }
  kindReports.push({ kind, samples: records.length, accepted: positive, ignoredOrDismissed: negative, acceptanceRate: rate, suggestion });
}
kindReports.sort((a, b) => b.samples - a.samples);

// ── 事件流健康度：各评估器 kind 是否在产出（五层架构是否空转） ──
const eventKinds = new Map<string, number>();
for (const e of eventsInWindow) eventKinds.set(e.kind, (eventKinds.get(e.kind) ?? 0) + 1);
const expectedFabricKinds = [
  "meeting_soon",
  "meeting_soon_early",
  "away_return",
  "work_marathon",
  "unread_burst",
  "sleep_boundary",
  "goal_ready",
  "morning_brief",
  "commitment_chain",
  "digest_beat",
];
const fabricHealth = expectedFabricKinds.map((k) => ({ kind: k, eventsInWindow: eventKinds.get(k) ?? 0 }));

// ── 仲裁成本分布（打断成本模型是否把消息都压到深夜/挂起） ──
const waitCount = eventsInWindow.filter((e) => e.action === "wait_for_pause").length;
const deliverCount = eventsInWindow.filter((e) => e.action === "deliver_now").length;
const costs = eventsInWindow.map((e) => e.cost).filter((c): c is number => typeof c === "number");

const report = {
  generatedAt: new Date().toISOString(),
  windowDays,
  kindReports,
  fabricHealth,
  arbiter: {
    deliverNow: deliverCount,
    waitForPause: waitCount,
    costP50: percentile(costs, 0.5),
    costP90: percentile(costs, 0.9),
    note: "wait 占比 > 70% 说明打断成本普遍偏高（阈值过严）；deliver 占比 > 80% 且接受率低说明阈值过松",
  },
};

function percentile(list: number[], p: number): number | null {
  if (list.length === 0) return null;
  const sorted = [...list].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * p));
  return sorted[idx];
}

const lines: string[] = [];
lines.push(`# 主动性校准报告（近 ${windowDays} 天，生成于 ${report.generatedAt}）`);
lines.push("");
lines.push("## 分 kind 表现与建议");
for (const k of kindReports) {
  lines.push(`- ${k.kind}: 样本 ${k.samples}，正反馈 ${k.accepted}，负反馈 ${k.ignoredOrDismissed}，接受率 ${k.acceptanceRate ?? "样本不足"} → ${k.suggestion}`);
}
if (kindReports.length === 0) lines.push("-（窗口内无 outcome 数据）");
lines.push("");
lines.push("## 五层架构事件健康度（0 = 该评估器从未产出，需排查接线/信号源）");
for (const f of fabricHealth) lines.push(`- ${f.kind}: ${f.eventsInWindow} 条`);
lines.push("");
lines.push(`## 仲裁分布：deliver_now=${deliverCount}，wait_for_pause=${waitCount}，cost p50=${report.arbiter.costP50 ?? "-"} p90=${report.arbiter.costP90 ?? "-"}`);

console.log(lines.join("\n"));
const outPath = join(ROOT, "calibration-report.json");
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify(report, null, 2));
console.log(`\n[calibrate] 报告已写入 ${outPath}${existsSync(outPath) ? "" : "（写入失败）"}`);
