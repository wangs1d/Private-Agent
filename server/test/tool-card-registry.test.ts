/**
 * tool-card-registry 单元测试：结构异常/空数据/已含标记时的确定性回退。
 * 端到端行为（LLM 纯叙述 + toolResult → 直出卡）由 reply-format-golden 覆盖。
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  buildToolCard,
  tryAttachToolResultCard,
} from "../src/services/tool-card-registry.js";

test("weather: full fields → weather card payload", () => {
  const p = buildToolCard("weather.get_local", {
    summary: "明天晴转多云",
    weatherText: "晴转多云",
    todayRangeC: "18–26",
    humidityPct: 62,
    windKmh: 8,
    peakRainPct: 10,
    clothingAdvice: "带薄外套",
    locationLabel: "上海",
  });
  assert.ok(p);
  assert.equal(p.cardType, "weather");
  assert.equal(p.title, "明天晴转多云");
  assert.equal(p.items.length, 5);
  assert.equal(p.footer, "带薄外套");
});

test("weather: missing weather fields → null（回退文本路由）", () => {
  assert.equal(buildToolCard("weather.get_local", { ok: true }), null);
  assert.equal(buildToolCard("weather.get_local", { weatherText: "" }), null);
});

test("wallet: balance → wallet card；缺余额 → null", () => {
  const p = buildToolCard("wallet.get_balance", { balance: 1000, currency: "CNY" });
  assert.ok(p);
  assert.equal(p.cardType, "wallet");
  assert.equal(p.items[0]?.text, "1000 CNY");
  assert.equal(buildToolCard("wallet.get_balance", { balance: "很多" }), null);
});

test("calendar: tasks → schedule card，时间截取格式化（跨时区稳定）", () => {
  const p = buildToolCard("calendar.list_tasks", {
    count: 2,
    tasks: [
      { title: "牙医复诊", nextRunAt: "2026-09-10T09:30:00" },
      { title: "给妈妈打电话", nextRunAt: "2026-09-11T20:00:00" },
    ],
  });
  assert.ok(p);
  assert.equal(p.cardType, "schedule");
  assert.deepEqual(p.items.map((i) => i.text), [
    "09-10 09:30 牙医复诊",
    "09-11 20:00 给妈妈打电话",
  ]);
});

test("calendar: 空 tasks → null", () => {
  assert.equal(buildToolCard("calendar.list_tasks", { tasks: [] }), null);
  assert.equal(buildToolCard("calendar.list_tasks", {}), null);
});

test("unregistered tool → null", () => {
  assert.equal(buildToolCard("notes.save", { ok: true }), null);
  assert.equal(buildToolCard("", { ok: true }), null);
});

test("tryAttach: 前导正文 + 卡标记；异常输入 → null", () => {
  const out = tryAttachToolResultCard("查好了。", "wallet.get_balance", {
    balance: 42,
    currency: "CNY",
  });
  assert.ok(out);
  assert.ok(out.startsWith("查好了。"));
  assert.ok(out.includes("[AGENT_RESULT_CARD_START]"));

  assert.equal(tryAttachToolResultCard("x", "notes.save", { ok: true }), null);
  assert.equal(tryAttachToolResultCard("x", "wallet.get_balance", undefined), null);
  assert.equal(tryAttachToolResultCard("x", "wallet.get_balance", "not-object"), null);
  assert.equal(
    tryAttachToolResultCard("x", "weather.get_local", { ok: true }),
    null,
    "builder 建卡失败（字段缺失）→ null 回退",
  );
});

test("tryAttach: 正文已含结构化标记 → null（防双重包裹）", () => {
  const marked = "前导。[AGENT_RESULT_CARD_START]\n{}\n[AGENT_RESULT_CARD_END]";
  assert.equal(
    tryAttachToolResultCard(marked, "wallet.get_balance", { balance: 1 }),
    null,
  );
});
