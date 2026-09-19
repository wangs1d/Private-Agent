// 安全守护服务测试（safety-guard：紧急联系人 / 一键 SOS / 借口来电 / 加密存储）：
//  1. 联系人增改：同号合并、首位自动主联系人、手机号脱敏、上限 5 位
//  2. SOS 未配置联系人：不代发 + 提醒用户直接拨 110
//  3. SOS 正常链路：主联系人优先、短信含定位链接与情况说明、失败联系人如实标注
//  4. 借口来电：未启用/未配手机号/正常三态
//  5. 加密持久化：联系人密文落盘 + 重新加载还原
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  SafetyGuardService,
  maskPhone,
  type SafetyGuardDeps,
} from "../src/services/safety-guard-service.js";

function makeDeps(dir: string, overrides: Partial<SafetyGuardDeps> = {}): SafetyGuardDeps {
  const proposals: unknown[] = [];
  const deps: SafetyGuardDeps = {
    dataDir: dir,
    sendSms: async () => ({ ok: true }),
    prepareCall: async (_actorId, input) => ({ ok: true, callId: "call_1", ...input }),
    isCallEnabled: () => true,
    requestLocation: async () => ({ latitude: 31.2304, longitude: 121.4737, city: "上海市" }),
    getPipeline: () => ({
      submitProposal: (p) => {
        proposals.push(p);
        return { verdict: "delivered" };
      },
    }),
    ...overrides,
  };
  (deps as SafetyGuardDeps & { proposals: unknown[] }).proposals = proposals;
  return deps;
}

async function makeService(overrides: Partial<SafetyGuardDeps> = {}) {
  const dir = await mkdtemp(join(tmpdir(), "safety-guard-test-"));
  const deps = makeDeps(dir, overrides);
  const service = new SafetyGuardService(deps);
  return { dir, service, proposals: (deps as SafetyGuardDeps & { proposals: unknown[] }).proposals };
}

test("maskPhone：中间四位脱敏", () => {
  assert.equal(maskPhone("13812345678"), "138****5678");
  assert.equal(maskPhone("12345"), "***");
});

test("联系人：同号合并、首位自动主联系人、列表脱敏、上限 5", async () => {
  const { dir, service } = await makeService();

  const first = await service.setContact("u1", { name: "妈妈", phone: "13812345678" });
  assert.equal(first.contact.isPrimary, true, "首位联系人自动成为主联系人");
  assert.equal(first.merged, false);

  const second = await service.setContact("u1", {
    name: "闺蜜",
    phone: "13987654321",
    relationship: "闺蜜",
  });
  assert.equal(second.contact.isPrimary, undefined);

  const merged = await service.setContact("u1", { name: "老妈", phone: "13812345678" });
  assert.equal(merged.merged, true, "同号自动合并为更新");
  assert.equal(merged.contact.name, "老妈");

  const list = service.listContacts("u1");
  assert.equal(list.length, 2);
  assert.equal(list[0].name, "老妈");
  assert.equal(list[0].phone, "138****5678");
  assert.ok(!list.some((c) => c.phone === "13812345678"), "列表不得出现明文手机号");

  // 上限 5
  for (let i = 0; i < 3; i += 1) {
    await service.setContact("u1", { name: `c${i}`, phone: `1300000000${i}` });
  }
  await assert.rejects(
    service.setContact("u1", { name: "第六位", phone: "13111111111" }),
    /最多 5 位/,
  );

  const removed = await service.removeContact("u1", second.contact.id);
  assert.equal(removed, true);
  assert.equal(service.listContacts("u1").length, 4);

  await rm(dir, { recursive: true, force: true });
});

test("SOS 未配置联系人：不代发 + 引导直接拨 110 + 全设备告警", async () => {
  const { service, proposals } = await makeService();
  const result = await service.triggerSos("u1", { reason: "测试" });
  assert.equal(result.ok, false);
  assert.equal(result.needsSetup, true);
  assert.ok(result.emergencyHint.includes("110"));
  const critical = proposals.find(
    (p) => (p as { kind: string }).kind === "safety_sos",
  ) as { importance: string } | undefined;
  assert.ok(critical, "应向用户设备发 critical 告警");
  assert.equal(critical.importance, "critical");
});

test("SOS 正常链路：主联系人优先、短信含定位、失败如实标注、历史留痕", async () => {
  const sent: Array<{ to: string; text: string }> = [];
  const { service, proposals } = await makeService({
    sendSms: async (p) => {
      sent.push(p);
      if (p.to === "13900000002") return { ok: false, error: "短信服务未配置" };
      return { ok: true };
    },
  });
  await service.setContact("u1", { name: "闺蜜", phone: "13900000002" });
  await service.setContact("u1", { name: "妈妈", phone: "13900000001", isPrimary: true });

  const result = await service.triggerSos("u1", { reason: "深夜打车偏航" });

  assert.equal(result.ok, true);
  assert.equal(result.dispatched, true);
  assert.equal(sent.length, 2);
  assert.equal(sent[0].to, "13900000001", "主联系人先发");
  assert.match(sent[0].text, /【紧急求助】/);
  assert.match(sent[0].text, /深夜打车偏航/);
  assert.match(sent[0].text, /uri\.amap\.com\/marker\?position=121\.4737,31\.2304/);
  assert.ok(result.location);
  assert.equal(result.notified.find((n) => n.name === "妈妈")?.ok, true);
  assert.equal(result.notified.find((n) => n.name === "闺蜜")?.ok, false);

  const critical = proposals.at(-1) as { importance: string; title: string };
  assert.equal(critical.importance, "critical");
  assert.match(critical.title, /已发出/);

  await rm((service as unknown as { deps: SafetyGuardDeps }).deps.dataDir, {
    recursive: true,
    force: true,
  });
});

test("借口来电：未启用 / 未配手机号 / 正常三态", async () => {
  const disabled = await makeService({ isCallEnabled: () => false });
  const r1 = await disabled.service.requestFakeCall("u1");
  assert.equal(r1.ok, false);
  assert.match(String(r1.setupHint), /PHONE_CALL_ENABLED/);
  await rm((disabled.service as unknown as { deps: SafetyGuardDeps }).deps.dataDir, {
    recursive: true,
    force: true,
  });

  const enabled = await makeService();
  const r2 = await enabled.service.requestFakeCall("u1");
  assert.equal(r2.ok, false);
  assert.equal(r2.needsSetup, true);

  await enabled.service.updateSettings("u1", { myMobileNumber: "13812345678" });
  const prepared: Array<Record<string, unknown>> = [];
  const withCall = await makeService({
    prepareCall: async (_actorId, input) => {
      prepared.push(input);
      return { ok: true, callId: "call_9" };
    },
  });
  await withCall.service.updateSettings("u1", { myMobileNumber: "13812345678" });
  const r3 = await withCall.service.requestFakeCall("u1", { goal: "脱身" });
  assert.equal(r3.ok, true);
  assert.equal(prepared.length, 1);
  assert.equal(prepared[0].number, "13812345678");
  assert.equal(prepared[0].contactName, "小助手");
  await rm((withCall.service as unknown as { deps: SafetyGuardDeps }).deps.dataDir, {
    recursive: true,
    force: true,
  });
});

test("加密持久化：联系人密文落盘 + 重新加载还原", async () => {
  const { dir, service } = await makeService();
  await service.setContact("u1", { name: "妈妈", phone: "13812345678" });
  await service.updateSettings("u1", { sosNote: "青霉素过敏" });
  await service.flush();

  const raw = await readFile(join(dir, "u1.json"), "utf8");
  assert.ok(!raw.includes("13812345678"), "手机号必须加密落盘");
  assert.ok(!raw.includes("青霉素过敏"));

  const reloaded = new SafetyGuardService(makeDeps(dir));
  await reloaded.load();
  const list = reloaded.listContacts("u1");
  assert.equal(list.length, 1);
  assert.equal(list[0].name, "妈妈");
  assert.equal(reloaded.getSettings("u1").sosNote, "青霉素过敏");

  await rm(dir, { recursive: true, force: true });
});
