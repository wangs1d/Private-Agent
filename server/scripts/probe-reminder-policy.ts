/**
 * 分级提醒策略真链探针：沙箱真实装配（createAppServices）→ HTTP 真创建 →
 * 验证「不同提醒任务按 时间/重要程度/地点 动态生成不同提前节奏」全链路。
 *
 * 场景：
 *   1. 截图场景：周六上午十点看牙医（提前数天创建）→ 前晚备忘+起床闹钟+出发预留 三段
 *   2. 用户显式说「提前30分钟」→ 显式优先，策略不介入
 *   3. 改期（PATCH）→ 计划按新时间重算
 *   4. 琐事（提醒我睡觉，trivia）→ 不分级（保持现状）
 *   5. 真触发：把三段任务 nextRunAt 回拨后 runSchedulerTick → 三段按各自脚本文案真实推送
 *
 * 运行：npx tsx scripts/probe-reminder-policy.ts（无需 LLM key，全部走程序层确定性路径）
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const sandbox = mkdtempSync(join(tmpdir(), "pa-probe-reminder-policy-"));
mkdirSync(join(sandbox, "data", "proactivity"), { recursive: true });
process.chdir(sandbox);
// 预写睡眠样本（ AwarenessCortex 恢复链）：模拟 agent 已了解该用户作息=夜猫子（1:30 睡 / 9:30 起）
const sleepDay = new Date();
sleepDay.setUTCDate(sleepDay.getUTCDate() - 1);
const dayKey = (offset: number): string => {
  const d = new Date(sleepDay);
  d.setUTCDate(d.getUTCDate() - offset);
  return d.toISOString().slice(0, 10);
};
writeFileSync(
  join(sandbox, "data", "proactivity", "awareness-sleep-samples.json"),
  JSON.stringify({
    version: 1,
    actors: {
      "policy-probe-owl": {
        samples: [0, 1, 2, 3].map((i) => ({ date: dayKey(i), startHour: 1.5, endHour: 9.5 })),
      },
    },
  }),
);
// 预写在场足迹（agent 自己观察到的在线时段——作息的被动推断源）：
// 连续 4 晚 22–23 点仍在用、凌晨 0 点收工，次日 9 点又出现
// → 推导：入睡 = 24(次日0点槽右端)+0.5 = 01:30；起床 = 9−0.5 = 08:30
mkdirSync(join(sandbox, "data", "rhythm"), { recursive: true });
const localDateStr = (offsetDays: number): string => {
  const d = new Date();
  d.setDate(d.getDate() - offsetDays);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const observedDays: Record<string, { activeHours: number[]; firstHour: number; lastHour: number; total: number }> = {};
for (let i = 7; i >= 0; i--) {
  const date = localDateStr(i);
  const hours = (7 - i) % 2 === 0 ? [22, 23] : [0, 9]; // 交替：夜间段 / 次日凌晨+早晨
  const activeHours = new Array<number>(24).fill(0);
  for (const h of hours) activeHours[h] = 1;
  observedDays[date] = { activeHours, firstHour: hours[0]!, lastHour: hours[hours.length - 1]!, total: hours.length };
}
writeFileSync(
  join(sandbox, "data", "rhythm", "presence-footprint.json"),
  JSON.stringify({
    version: 1,
    actors: { "policy-probe-observed": { days: observedDays } },
  }),
);
process.env.PROACTIVITY_QUIET_START = "0";
process.env.PROACTIVITY_QUIET_END = "0";
const log = (label: string, value: unknown): void =>
  console.log(`[probe-policy] ${label}: ${JSON.stringify(value)}`);

const { createAppServices } = await import("../src/bootstrap/create-app-services.js");
const services = await createAppServices();
await services.app.listen({ port: 3107, host: "127.0.0.1" });
log("服务端已监听", 3107);

const BASE = "http://127.0.0.1:3107";
const SESSION = "policy-probe-session";

/** 下一个周六 10:00（北京时间） */
function nextSaturdayTenAm(): string {
  const now = new Date();
  const day = now.getDay(); // 6=周六
  const delta = (6 - day + 7) % 7 || 7;
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + delta, 10, 0, 0);
  return d.toISOString();
}

/** N 天后的本地某整点（探针用固定墙钟锚点，避免「+7h」之类相对偏移撞上时区/时刻漂移） */
function localAt(daysAhead: number, hour: number): string {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() + daysAhead, hour, 0, 0).toISOString();
}

async function postTask(body: Record<string, unknown>, sessionId = SESSION) {
  const res = await fetch(`${BASE}/schedule/tasks`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId, kind: "reminder", recurrence: "none", timezone: "Asia/Shanghai", ...body }),
  });
  return (await res.json()) as { ok: boolean; task?: Record<string, any>; message?: string };
}

let failures = 0;
function check(label: string, cond: boolean, detail?: unknown): void {
  if (cond) {
    console.log(`[probe-policy] ✅ ${label}`);
  } else {
    failures += 1;
    console.log(`[probe-policy] ❌ ${label}${detail !== undefined ? ` → ${JSON.stringify(detail)}` : ""}`);
  }
}

// ── 1. 截图场景：周六上午十点看牙医 ─────────────────────────────────
const dentist = await postTask({
  title: "看牙医",
  description: "周六上午十点去看牙医，带就诊卡",
  reminderMessage: "该去看牙医啦，记得带就诊卡",
  runAt: nextSaturdayTenAm(),
});
check("牙医日程创建成功", dentist.ok === true && !!dentist.task, dentist.message);
const dentistTask = dentist.task!;
log("牙医 remindBeforeMinutes", dentistTask.remindBeforeMinutes);
log("牙医 remindPlan.summary", dentistTask.reminderPolicy);
log(
  "牙医分段",
  (dentistTask.preReminders ?? []).map((p: any) => `${p.label}@-${p.offsetMinutes}min: ${p.message}`),
);
check("三段动态计划（前晚备忘/起床闹钟/该出门了）", JSON.stringify(dentistTask.remindBeforeMinutes) === "[780,120,60]", dentistTask.remindBeforeMinutes);
check("策略指纹 high/mid", dentistTask.reminderPolicy === "high/mid", dentistTask.reminderPolicy);

// ── 1b. 作息画像贯通：夜猫子（1:30睡/9:30起）的睡前备忘贴入睡点，不照搬 21:00 ──
const owl = await postTask(
  {
    title: "复查",
    description: "下周六上午十点去医院复查视力",
    reminderMessage: "该去复查啦",
    runAt: localAt(7, 10), // 7 天后 10:00（本地；该会话的夜猫子画像已预写进沙箱）
  },
  "policy-probe-owl",
);
const owlTask = owl.task!;
log("夜猫子分段", (owlTask.preReminders ?? []).map((p: any) => `${p.label}@-${p.offsetMinutes}min: ${p.message}`));
check("夜猫子睡前备忘贴入睡点（00:30 → 偏移 570）", JSON.stringify((owlTask.preReminders ?? []).find((p: any) => p.stage === "night_before")?.offsetMinutes) === "570", owlTask.remindBeforeMinutes);
check("夜猫子睡前文案如实告知睡眠预算", /按你平时约1:30入睡，到闹钟只睡得约6个半小时/.test((owlTask.preReminders ?? []).find((p: any) => p.stage === "night_before")?.message ?? ""));

// ── 1c. 冷启动：用户自述作息（无任何被动睡眠样本）也能生效 ──────────────
const ROUTINE_SESSION = "policy-probe-routine";
const routinePut = (await (
  await fetch(`${BASE}/api/schedule/sleep-routine`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId: ROUTINE_SESSION, sleepStartHour: 1.5, wakeHour: 8 }),
  })
).json()) as { ok: boolean; routine?: Record<string, any> };
check("显式作息写入成功（source=explicit）", routinePut.ok === true && routinePut.routine?.source === "explicit", routinePut.routine);
const routineTextPut = (await (
  await fetch(`${BASE}/api/schedule/sleep-routine`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId: "policy-probe-routine-text", text: "我一般1点半睡，早上8点起" }),
  })
).json()) as { ok: boolean; routine?: Record<string, any> };
check("原文解析写入成功（1:30/8:00）", routineTextPut.ok === true && routineTextPut.routine?.sleepStartHour === 1.5 && routineTextPut.routine?.wakeHour === 8, routineTextPut.routine);

const routineTask = await postTask(
  {
    title: "复查",
    description: "三天后上午十点去医院复查视力",
    reminderMessage: "该去复查啦",
    runAt: localAt(3, 10),
  },
  ROUTINE_SESSION,
);
const rtTask = routineTask.task!;
log("自述作息分段", (rtTask.preReminders ?? []).map((p: any) => `${p.label}@-${p.offsetMinutes}min`));
check("自述作息 → 三段个性化（570/120/60，不照搬 21:00 的 780）", JSON.stringify(rtTask.remindBeforeMinutes) === "[570,120,60]", rtTask.remindBeforeMinutes);
check("自述作息 → 睡前文案如实告知睡眠预算", /按你平时约1:30入睡，到闹钟只睡得约6个半小时/.test((rtTask.preReminders ?? []).find((p: any) => p.stage === "night_before")?.message ?? ""));
const routineDel = (await (
  await fetch(`${BASE}/api/schedule/sleep-routine?sessionId=${encodeURIComponent(ROUTINE_SESSION)}`, { method: "DELETE" })
).json()) as { ok: boolean; cleared?: boolean };
check("作息可清除（回默认）", routineDel.ok === true && routineDel.cleared === true, routineDel);

// ── 1d. 被动观察：agent 观察「用户何时在线」推出的作息（零文本抽取） ──────
const observedTask = await postTask(
  {
    title: "复查",
    description: "三天后上午十点去医院复查视力",
    reminderMessage: "该去复查啦",
    runAt: localAt(3, 10),
  },
  "policy-probe-observed",
);
const obTask = observedTask.task!;
log("被动观察分段", (obTask.preReminders ?? []).map((p: any) => `${p.label}@-${p.offsetMinutes}min`));
check("被动观察 → 三段计划（不走默认 780）", (obTask.remindBeforeMinutes ?? []).length === 3 && JSON.stringify(obTask.remindBeforeMinutes) !== "[780,120,60]", obTask.remindBeforeMinutes);
check("被动观察 → 睡前备忘贴推导入睡点（01:30 → 偏移 570）", JSON.stringify((obTask.preReminders ?? []).find((p: any) => p.stage === "night_before")?.offsetMinutes) === "570", obTask.remindBeforeMinutes);
check("被动观察 → 睡前文案如实告知睡眠预算", /按你平时约1:30入睡/.test((obTask.preReminders ?? []).find((p: any) => p.stage === "night_before")?.message ?? ""));

// 设置页要如实告知用户「作息是哪来的、观察了几晚」，接口须同时给出 observed
const routineGet = (await (
  await fetch(`${BASE}/api/schedule/sleep-routine?sessionId=policy-probe-observed`)
).json()) as { ok: boolean; routine?: unknown; observed?: Record<string, any> };
log("设置页作息接口 observed", routineGet.observed);
check("设置页接口返回被动观察结果（入睡 01:30 / 4 个有效夜）", routineGet.ok === true && routineGet.observed?.sleepStartHour === 1.5 && routineGet.observed?.nightCount === 4, routineGet.observed);
check("设置页接口标记观察已足够（enoughNights=true）", routineGet.observed?.enoughNights === true, routineGet.observed);
check("未设置显式作息时 routine 为空", routineGet.routine == null, routineGet.routine);

// ── 2. 显式提前量优先 ──────────────────────────────────────────────
const draftRes = (await (
  await fetch(`${BASE}/chat/schedule-draft`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId: SESSION, text: "明天上午十点提前30分钟提醒我去看牙医" }),
  })
).json()) as { matched: boolean; draft?: Record<string, any> };
check("自然语言解析命中（规则路径，零 LLM）", draftRes.matched === true);
check("用户显式提前量被解析 [30]", JSON.stringify(draftRes.draft?.remindBeforeMinutes) === "[30]", draftRes.draft?.remindBeforeMinutes);
const explicit = await postTask({
  title: "看牙医",
  description: draftRes.draft!.description,
  reminderMessage: "该去看牙医啦，记得带就诊卡",
  runAt: draftRes.draft!.runAt,
  remindBeforeMinutes: draftRes.draft!.remindBeforeMinutes,
});
check("显式提前量任务创建成功", explicit.ok === true && !!explicit.task, explicit.message);
check("显式提前量任务不生成策略脚本", explicit.task?.preReminders === undefined && JSON.stringify(explicit.task?.remindBeforeMinutes) === "[30]", {
  offsets: explicit.task?.remindBeforeMinutes,
  plan: explicit.task?.preReminders,
});

// ── 3. 改期重算 ────────────────────────────────────────────────────
const movedRes = (await (
  await fetch(`${BASE}/schedule/tasks/${dentistTask.taskId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ runAt: localAt(5, 15) }), // 改到 5 天后 15:00（本地，下午）
  })
).json()) as { ok: boolean; task?: Record<string, any> };
const moved = movedRes.task!;
log("改期后分段", (moved.preReminders ?? []).map((p: any) => p.label));
check("改期到下午 → 起床闹钟段消失，计划重算", JSON.stringify(moved.remindBeforeMinutes) === "[1080,60]", moved.remindBeforeMinutes);

// ── 4. 琐事不分级（截图第二条「半小时后提醒我睡觉」同类） ────────────
const trivia = await postTask({
  category: "trivia",
  description: "提醒我睡觉",
  reminderMessage: "该睡觉啦",
  runAt: new Date(Date.now() + 2 * 3600_000).toISOString(),
});
check("trivia 琐事保持现状（无提前量/无脚本）", trivia.task?.remindBeforeMinutes === undefined && trivia.task?.preReminders === undefined);

// ── 5. 真触发：回拨 nextRunAt 后驱动真实调度 tick ───────────────────
// （改期后的牙医任务偏移 1080/60 触发窗已过；用新建的三段任务验证推送链）
const fireTask = await postTask({
  title: "看牙医",
  description: "周三上午十点去口腔医院复查",
  reminderMessage: "该去复查啦",
  runAt: localAt(3, 10), // 3 天后上午 10:00（本地）
});
const store = (services.scheduleTaskService as unknown as { byTaskId: Map<string, any> }).byTaskId;
const stored = store.get(fireTask.task!.taskId);
check("复查任务三段计划", JSON.stringify(stored?.remindBeforeMinutes) === "[780,120,60]", stored?.remindBeforeMinutes);
if (stored) {
  stored.nextRunAt = new Date(Date.now() + 50 * 60_000).toISOString(); // 回拨：三段触发窗全部命中
  await services.scheduleTaskService.runSchedulerTick();
  await new Promise((r) => setTimeout(r, 200));
  // firePreReminders 以新对象落回 map：判定必须重新取，不能用 tick 前的引用
  const afterTick = store.get(fireTask.task!.taskId);
  check("真实 tick 推送三段（firedPreReminderOffsets 落库）", JSON.stringify([...(afterTick?.firedPreReminderOffsets ?? [])].sort((a, b) => b - a)) === "[780,120,60]", afterTick?.firedPreReminderOffsets);
  await services.scheduleTaskService.runSchedulerTick();
  check("重复 tick 不重复推送", store.get(fireTask.task!.taskId)?.firedPreReminderOffsets?.length === 3, afterTick?.firedPreReminderOffsets);
}

// ── 清理 ──────────────────────────────────────────────────────────
try {
  await services.app.close();
} catch {
  /* ignore */
}
console.log(`[probe-policy] 完成：${failures === 0 ? "全部通过 ✅" : `${failures} 项失败 ❌`}`);
process.exit(failures === 0 ? 0 : 1);
