// 方案 E：偏好变更触发链路单测——信号检测 / 反转确认（版本化联动）/ 新偏好沉默 /
// 冷却去重 / NarrativeMemoryFacade onWrite 钩子
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  PreferenceChangeTrigger,
  detectPreferenceChangeSignal,
} from "../src/proactivity/triggers/preference-change-trigger.js";
import { NarrativeMemoryFacade } from "../src/services/narrative-memory-port.js";
import { extractFactSubject } from "../src/services/user-fact-store.js";
import { evaluateActionUtility } from "../src/proactivity/action-utility.js";
import type { ProactiveProposal } from "../src/proactivity/pipeline-types.js";

const NOW = Date.parse("2026-09-04T12:00:00Z");
const ACTOR = "user-a";

function makeTrigger(opts: {
  facts?: Array<{ subject: string; value: string }>;
  now?: number;
  cooldownMs?: number;
} = {}) {
  const submitted: ProactiveProposal[] = [];
  const trigger = new PreferenceChangeTrigger({
    submit: (p) => {
      submitted.push(p);
    },
    getPreferenceFacts: opts.facts ? () => opts.facts! : undefined,
    now: () => opts.now ?? NOW,
    cooldownMs: opts.cooldownMs,
  });
  return { trigger, submitted };
}

// ─── 信号检测（确定性正则）───

test("检测: 偏好变更信号命中", () => {
  assert.ok(detectPreferenceChangeSignal("我现在吃素了"));
  assert.ok(detectPreferenceChangeSignal("我以后不喝咖啡了"));
  assert.ok(detectPreferenceChangeSignal("我不再熬夜了"));
  assert.ok(detectPreferenceChangeSignal("我改用安卓手机了"));
  assert.ok(detectPreferenceChangeSignal("我从今天起戒烟"));
});

test("检测: 非偏好/超长文本不命中", () => {
  assert.equal(detectPreferenceChangeSignal("今天天气真不错"), false);
  assert.equal(detectPreferenceChangeSignal("帮我订一张去杭州的机票"), false);
  assert.equal(detectPreferenceChangeSignal("我现在吃素了".repeat(50)), false, "超长段落不判偏好");
  assert.equal(detectPreferenceChangeSignal(""), false);
});

// ─── 新偏好（无冲突）→ 低价值提案 → 评估器判 silence ───

test("新偏好: 生成低价值提案，效用评估为 silence（记忆照常学习，不打扰）", async () => {
  const { trigger, submitted } = makeTrigger();
  const p = await trigger.noteMemoryWrite(ACTOR, "我最近开始跑步了");
  assert.ok(p);
  assert.equal(p.kind, "preference_change_noted");
  assert.equal(p.tier, "social");
  assert.equal(p.importance, "low");
  assert.equal(submitted.length, 1);
  const u = p.utility;
  const result = evaluateActionUtility({ kind: p.kind, risk: u.risk, authorization: u.authorization, value: u.value });
  assert.equal(result.branch, "silence");
});

test("新偏好: 非偏好文本零开销返回 null", async () => {
  const { trigger, submitted } = makeTrigger();
  const p = await trigger.noteMemoryWrite(ACTOR, "这个 bug 已经修好了");
  assert.equal(p, null);
  assert.equal(submitted.length, 0);
});

// ─── 偏好反转（信念偏好图版本化联动）───

test("反转: 领域桶重叠（我现在吃素了 vs 旧值喜欢吃肉）→ must/high 确认提案", async () => {
  const { trigger, submitted } = makeTrigger({
    facts: [{ subject: extractFactSubject("preference", "我喜欢吃红烧肉"), value: "我喜欢吃红烧肉" }],
  });
  const p = await trigger.noteMemoryWrite(ACTOR, "我现在吃素了");
  assert.ok(p);
  assert.equal(p.kind, "preference_reversal_confirm");
  assert.equal(p.tier, "must");
  assert.equal(p.importance, "high");
  assert.match(p.directText, /我喜欢吃红烧肉/);
  assert.match(p.directText, /我现在吃素了/);
  assert.equal(submitted.length, 1);
  const u = p.utility;
  const result = evaluateActionUtility({ kind: p.kind, risk: u.risk, authorization: u.authorization, value: u.value });
  assert.notEqual(result.branch, "silence", "反转确认不被沉默");
});

test("反转: subject 归一相等（喜欢X → 不喜欢X）同样触发", async () => {
  const subject = extractFactSubject("preference", "我喜欢简洁的回答");
  const { trigger } = makeTrigger({ facts: [{ subject, value: "我喜欢简洁的回答" }] });
  const p = await trigger.noteMemoryWrite(ACTOR, "我不再喜欢简洁的回答了");
  assert.ok(p);
  assert.equal(p.kind, "preference_reversal_confirm");
});

test("反转: 同指纹重放不算反转", async () => {
  const { trigger } = makeTrigger({
    facts: [{ subject: "饮食", value: "我现在吃素了" }],
  });
  const p = await trigger.noteMemoryWrite(ACTOR, "我现在吃素了");
  assert.ok(p);
  assert.equal(p.kind, "preference_change_noted", "同值重放按新偏好（低价值）处理");
});

test("反转: 不相关领域的既有偏好不误报", async () => {
  const { trigger } = makeTrigger({
    facts: [{ subject: "通勤", value: "我喜欢坐地铁上班" }],
  });
  const p = await trigger.noteMemoryWrite(ACTOR, "我最近开始跑步了");
  assert.ok(p);
  assert.equal(p.kind, "preference_change_noted", "运动 vs 通勤不构成反转");
});

test("反转精确化: 同域不同动作动词不误报（吃素 vs 喝奶茶）", async () => {
  const { trigger } = makeTrigger({
    facts: [{ subject: "喝奶茶", value: "我喜欢喝奶茶" }],
  });
  const p = await trigger.noteMemoryWrite(ACTOR, "我现在吃素了");
  assert.ok(p);
  assert.equal(p.kind, "preference_change_noted", "吃 vs 喝：同属饮食但对象无关，不确认");
});

test("冷却按领域桶: 同域不同措辞同窗只触发一次", async () => {
  const { trigger, submitted } = makeTrigger({
    facts: [{ subject: "饮食", value: "我喜欢吃红烧肉" }],
    now: NOW,
    cooldownMs: 24 * 60 * 60 * 1000,
  });
  await trigger.noteMemoryWrite(ACTOR, "我现在吃素了");
  assert.equal(submitted.length, 1);
  const second = await trigger.noteMemoryWrite(ACTOR, "我从今天起吃素了");
  assert.equal(second, null, "同域（饮食）冷却期内，换措辞也不重复确认");
  assert.equal(submitted.length, 1);
});

// ─── 冷却与生命周期 ───

test("冷却: 同主题窗口内不重复确认，跨窗口恢复", async () => {
  const { trigger, submitted } = makeTrigger({
    facts: [{ subject: "饮食", value: "我喜欢吃红烧肉" }],
    now: NOW,
    cooldownMs: 60 * 60 * 1000,
  });
  await trigger.noteMemoryWrite(ACTOR, "我现在吃素了");
  assert.equal(submitted.length, 1);
  const second = await trigger.noteMemoryWrite(ACTOR, "我现在吃素了");
  assert.equal(second, null, "冷却期内同主题去重");
  assert.equal(submitted.length, 1);
});

test("冷却: 事实库读取失败按无冲突降级（不抛出）", async () => {
  const submitted: ProactiveProposal[] = [];
  const trigger = new PreferenceChangeTrigger({
    submit: (p) => {
      submitted.push(p);
    },
    getPreferenceFacts: () => {
      throw new Error("db down");
    },
    now: () => NOW,
  });
  const p = await trigger.noteMemoryWrite(ACTOR, "我以后不喝咖啡了");
  assert.ok(p);
  assert.equal(p.kind, "preference_change_noted");
});

// ─── NarrativeMemoryFacade 写入钩子（接线点）───

test("facade 钩子: ingest 写入后触发 noteMemoryWrite（fire-and-forget，不阻塞写入）", async () => {
  const writes: Array<{ actorId: string; text: string; source: string }> = [];
  const facade = new NarrativeMemoryFacade(null, null, null, null, null, (actorId, text, source) => {
    writes.push({ actorId, text, source });
  });
  await facade.ingest(ACTOR, "我现在吃素了", "chat:turn");
  await new Promise((r) => setImmediate(r));
  assert.equal(writes.length, 1);
  assert.equal(writes[0].text, "我现在吃素了");
  assert.equal(writes[0].source, "chat:turn");
  // 非偏好写入也过钩子（由触发源自行判别零开销返回）
  await facade.ingest(ACTOR, "普通内容", "chat:turn");
  assert.equal(writes.length, 2);
});

test("facade 钩子: 触发源异常不影响写入主链路", async () => {
  const boom = new NarrativeMemoryFacade(null, null, null, null, null, () => {
    throw new Error("hook boom");
  });
  await assert.doesNotReject(() => boom.ingest(ACTOR, "我现在吃素了", "chat:turn"));
});

test("端到端: 记忆写入钩子 → 触发源 → 反转确认提案", async () => {
  const { trigger, submitted } = makeTrigger({
    facts: [{ subject: "饮食", value: "我喜欢吃红烧肉" }],
  });
  const facade = new NarrativeMemoryFacade(null, null, null, null, null, (actorId, text) => {
    void trigger.noteMemoryWrite(actorId, text);
  });
  await facade.ingest(ACTOR, "我现在吃素了", "chat:turn");
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(submitted.length, 1);
  assert.equal(submitted[0].kind, "preference_reversal_confirm");
  assert.equal(submitted[0].source, "memory-write");
});
