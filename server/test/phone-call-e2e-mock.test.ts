import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ServerEventType } from "../src/protocol.js";
import { AuditService } from "../src/services/audit-service.js";
import { InboxService } from "../src/services/inbox-service.js";
import { PhoneBridgeCoordinator } from "../src/services/phone-bridge-coordinator.js";
import { PhoneCallCoordinator } from "../src/services/phone-call-coordinator.js";
import { buildReplyBlocks } from "../src/services/reply-envelope.js";
import type { WsConnectionRegistry } from "../src/services/ws-connection-registry.js";
import { buildPhoneCallModule } from "../src/tools/capability-modules/phone-call/index.js";
import { ToolRegistry } from "../src/tools/tool-registry.js";

/**
 * 电话代办「mock 端到端」：只在最外层 mock（LLM 与 WS 传输），其余全用真实组件——
 *
 *   [LLM(模拟)] → ToolRegistry.execute(phone_call.*) → PhoneCallCoordinator
 *     → PhoneBridgeCoordinator(真实) → WS 帧(捕获) → [安卓手机(模拟): 全屏确认后
 *        按 jobId 回执 phone.bridge.result] → 状态机推进 → finish
 *     → InboxService(真实落盘 data/inbox) + AuditService(真实写审计) + 确认卡经
 *       buildReplyBlocks(真实) 拆块 → 客户端按钮 payload 原样回传。
 *
 * 验证目标：生产装配方式（真实桥/真实收件箱/真实渲染管线）下整条链路跑得通，
 * 且明文号码只在「手机端」出现，其余出口全部脱敏。
 */

const ACTOR = "e2e-user-1";
const PLAIN_NUMBER = "13812345678";
const MASKED = "138****5678";

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

test("mock E2E：帮用户预约餐厅（真实桥 + 真实收件箱 + 真实渲染管线）", async () => {
  const root = await mkdtemp(join(tmpdir(), "phone-call-e2e-"));
  const inboxDir = join(root, "inbox");
  const auditFile = join(root, "audit.log");

  // ── 模拟安卓手机端：接收 phone.bridge.invoke，30ms 后（模拟全屏确认）按 jobId 回执 ──
  const phoneReceived: Array<{ action: string; params: Record<string, unknown> }> = [];
  const phoneBridge = new PhoneBridgeCoordinator();
  const mockPhoneSocket = {
    readyState: 1,
    sent: [] as string[],
    send(data: string) {
      this.sent.push(data);
      const frame = JSON.parse(data) as {
        type: string;
        payload: { jobId: string; action: string; params: Record<string, unknown> };
      };
      if (frame.type === ServerEventType.PhoneBridgeInvoke) {
        phoneReceived.push({ action: frame.payload.action, params: frame.payload.params });
        // 手机端「全屏确认 → 拨出」后回执（与 DialConfirmActivity 同语义）
        setTimeout(() => {
          phoneBridge.completeFromSocket(ACTOR, mockPhoneSocket, frame.payload.jobId, {
            ok: true,
            state: "dialing",
          });
        }, 30);
      }
    },
  };
  phoneBridge.bindExecutor(ACTOR, mockPhoneSocket);

  // ── 真实落盘组件 ──
  const clientFrames: string[] = []; // 模拟聊天 WS 下发给客户端的帧
  const inboxService = new InboxService({
    rootDir: inboxDir,
    wsRegistry: {
      trySend: (_actorId: string, data: string) => {
        clientFrames.push(data);
        return true;
      },
    } as unknown as WsConnectionRegistry,
  });
  const auditService = new AuditService(auditFile);

  // ── 生产同款装配：coordinator 桥接真实 PhoneBridgeCoordinator ──
  // 注：注入固定白天时钟——真实时钟可能落在静默时段（22:00-08:00）内导致 prepare 被拒
  const coordinator = new PhoneCallCoordinator({
    bridge: {
      hasExecutor: (actorId) => phoneBridge.hasExecutor(actorId),
      invoke: (actorId, action, params, timeoutMs) =>
        phoneBridge.invoke(actorId, action, params, timeoutMs),
    },
    pushPort: {
      trySend: (actorId, data) => {
        clientFrames.push(data);
        return true;
      },
    },
    audit: auditService,
    inbox: { send: (input) => inboxService.send(input) },
    dataDir: join(root, "phone-call"),
    env: {},
    config: { enabled: true },
    now: () => new Date("2026-09-18T10:00:00"),
  });

  // 能力模块按生产方式注册（enabled → 6 个工具可见）
  const registry = new ToolRegistry();
  const mod = buildPhoneCallModule({ phoneCallCoordinator: coordinator });
  mod.register(registry);
  const toolNames = registry.list().filter((n) => n.startsWith("phone_call."));
  assert.equal(toolNames.length, 6);
  console.log(`\n[1] 工具已注册：${toolNames.join(", ")}`);

  const ctx = {
    sessionId: ACTOR,
    phoneBridgeOnline: phoneBridge.hasExecutor(ACTOR),
    chatUserMessageId: "msg-e2e-1",
  };

  // ── 轮 1：LLM 调 prepare，回复中嵌入确认卡 ──
  const prepared = await registry.execute("phone_call.prepare", {
    number: PLAIN_NUMBER,
    contactName: "海底捞望京店",
    goal: "预订周六晚 7 点 4 人桌",
    facts: { 人数: "4", 时间: "周六 19:00", 忌口: "无" },
    mustAsk: ["是否有包间", "是否需要押金"],
  }, ctx);
  assert.equal(prepared.ok, true);
  const callId = String((prepared.result as Record<string, unknown>).callId);
  const cardMarker = String((prepared.result as Record<string, unknown>).cardMarker);
  assert.equal((prepared.result as Record<string, unknown>).numberMasked, MASKED);
  console.log(`[2] prepare 成功 callId=${callId}，确认卡已生成（号码脱敏 ${MASKED}）`);

  // 确认卡经真实 reply-envelope 拆块 → 客户端可渲染的按钮（actions + payload.callId）
  const blocks = buildReplyBlocks(`好的，这就为你生成拨号确认。\n\n${cardMarker}\n\n请点击卡片上的按钮确认。`);
  assert.ok(blocks, "replyBlocks 应下发");
  const cardBlock = blocks!.find((b) => b.type === "card") as { type: "card"; card: Record<string, unknown> };
  assert.ok(cardBlock, "确认卡应被拆为 card 块");
  const actions = cardBlock.card.actions as Array<{ id: string; payload: Record<string, unknown> }>;
  assert.equal(actions[0].id, "phone_call_confirm");
  assert.equal(actions[0].payload.callId, callId);
  console.log(`[3] buildReplyBlocks 拆块成功：确认按钮 actions=${actions.map((a) => a.id).join("/")}`);

  // ── 负例：用户未点击前 start 被确认门硬拒，手机端零触达 ──
  // 注意 execute 包装层的 ok 只表示 handler 正常返回；coordinator 的诚实失败在内层 result.ok
  const early = await registry.execute("phone_call.start", { callId }, ctx);
  const earlyInner = early.result as Record<string, unknown>;
  assert.equal(earlyInner.ok, false, "确认门拒绝（内层结果）");
  assert.match(String(earlyInner.reason), /尚未确认/);
  assert.equal(phoneReceived.length, 0, "未确认不得触达手机");
  console.log("[4] 确认门生效：未点击确认时 start 被拒，手机端零触达");

  // ── 用户点击确认卡（客户端回传 chat.user_action → connection.ts 原点调用）──
  coordinator.observeCardAction(ACTOR, {
    cardId: String(cardBlock.card.cardId),
    actionId: actions[0].id,
    payload: actions[0].payload,
  });

  // ── 轮 2：LLM 调 start → 真实桥下发 → 模拟手机 30ms 后回执 ──
  const started = await registry.execute("phone_call.start", { callId }, ctx);
  assert.equal(started.ok, true);
  const startResult = started.result as Record<string, unknown>;
  assert.equal(startResult.state, "active");
  assert.equal(startResult.dialState, "dialing");
  assert.equal(phoneReceived.length, 1);
  assert.equal(phoneReceived[0].action, "dial");
  assert.equal(phoneReceived[0].params.number, PLAIN_NUMBER, "手机端收到明文号码（真实拨号所需）");
  assert.equal(phoneReceived[0].params.mode, "direct");
  console.log(`[5] start 拨出成功：手机端收到明文号码 ${PLAIN_NUMBER}（mode=direct），状态=${startResult.state}`);

  // 状态推送下发给客户端
  const statusFrames = clientFrames
    .map((f) => JSON.parse(f) as { type: string; payload: Record<string, unknown> })
    .filter((f) => f.type === "phone_call.status_update");
  assert.ok(statusFrames.length >= 2, "应有 dialing + active 两次状态推送");
  console.log(`[6] 状态推送：${statusFrames.map((f) => f.payload.state).join(" → ")}`);

  // ── 用户挂断并告知结果：轮 3 LLM 调 finish 回填 ──
  const finished = await registry.execute("phone_call.finish", {
    callId,
    outcome: "booked",
    detail: "商家接受预订，大堂 4 人桌",
    appointmentTime: "2026-09-19 19:00",
    bookingRef: "A1024",
    followUps: ["提前 2 小时电话确认"],
  }, ctx);
  assert.equal(finished.ok, true);
  const finishResult = finished.result as Record<string, unknown>;
  assert.equal(finishResult.state, "summarized");
  assert.match(String(finishResult.resultSummary), /预约成功/);
  assert.match(String(finishResult.resultSummary), /A1024/);
  assert.ok(!String(finishResult.resultSummary).includes(PLAIN_NUMBER), "结果摘要脱敏");
  console.log("[7] finish 回填成功：会话归档 + 收件箱回执已投递");

  // ── 收件箱必达：真实落盘可查（离线也能拉到）──
  const inboxRaw = JSON.parse(
    await readFile(join(inboxDir, `${ACTOR}.json`), "utf8"),
  ) as Array<{ messageId: string; title: string; body: string; kind: string }>;
  const receipt = inboxRaw.find((m) => m.messageId === `phone_call_${callId}`);
  assert.ok(receipt, "收件箱应有通话回执");
  assert.match(receipt!.title, /通话回执/);
  assert.match(receipt!.body, /A1024/);
  assert.ok(!receipt!.body.includes(PLAIN_NUMBER), "收件箱正文脱敏");
  console.log(`[8] 收件箱落盘验证：${receipt!.title}（kind=${receipt!.kind}，正文已脱敏）`);

  // ── 审计：真实写入且只含脱敏号码 ──
  const auditRaw = await readFile(auditFile, "utf8");
  const auditLines = auditRaw.trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
  const phoneAudit = auditLines.filter((e) => e.category === "phone_call");
  const auditActions = phoneAudit.map((e) => e.action);
  for (const step of ["prepare", "confirm", "start", "dial_ok", "finish"]) {
    assert.ok(auditActions.includes(step), `审计缺 ${step}，实际: ${auditActions.join(",")}`);
  }
  assert.ok(!auditRaw.includes(PLAIN_NUMBER), "审计日志不得出现明文号码");
  console.log(`[9] 审计验证：${auditActions.join(" → ")}（全链路，号码脱敏）`);

  // ── 会话归档 ──
  const sessionRaw = JSON.parse(
    await readFile(join(root, "phone-call", "sessions", `${callId}.json`), "utf8"),
  ) as Record<string, unknown>;
  assert.equal(sessionRaw.state, "summarized");
  assert.equal(sessionRaw.outcome, "booked");
  assert.equal(sessionRaw.bookingRef, "A1024");
  console.log("[10] 会话归档验证：state=summarized, outcome=booked ✓");
});

test("mock E2E（负路径）：手机端全屏确认被拒 → 会话如实收口 cancelled，不产生收件箱回执", async () => {
  const root = await mkdtemp(join(tmpdir(), "phone-call-e2e-neg-"));
  const phoneBridge = new PhoneBridgeCoordinator();
  const phoneReceived: string[] = [];
  const mockPhoneSocket = {
    readyState: 1,
    send(data: string) {
      const frame = JSON.parse(data) as {
        type: string;
        payload: { jobId: string };
      };
      if (frame.type === ServerEventType.PhoneBridgeInvoke) {
        phoneReceived.push(frame.payload.jobId);
        // 用户在手机全屏确认弹窗上点了「拒绝」（超时同样回 cancelled）
        setTimeout(() => {
          phoneBridge.completeFromSocket(ACTOR, mockPhoneSocket, frame.payload.jobId, {
            ok: true,
            state: "cancelled",
          });
        }, 20);
      }
    },
  };
  phoneBridge.bindExecutor(ACTOR, mockPhoneSocket);

  const inboxService = new InboxService({ rootDir: join(root, "inbox"), wsRegistry: null });
  const coordinator = new PhoneCallCoordinator({
    bridge: {
      hasExecutor: (actorId) => phoneBridge.hasExecutor(actorId),
      invoke: (actorId, action, params, timeoutMs) =>
        phoneBridge.invoke(actorId, action, params, timeoutMs),
    },
    pushPort: { trySend: () => true },
    inbox: { send: (input) => inboxService.send(input) },
    dataDir: join(root, "phone-call"),
    env: {},
    config: { enabled: true },
    now: () => new Date("2026-09-18T10:00:00"),
  });

  const prepared = await coordinator.prepare(ACTOR, { number: "13900002222", goal: "订座" });
  const callId = String(prepared.callId);
  coordinator.observeCardAction(ACTOR, {
    cardId: `phone_call_${callId}`,
    actionId: "phone_call_confirm",
    payload: { callId },
  });

  const started = await coordinator.start(ACTOR, callId, {
    phoneBridgeOnline: true,
    chatUserMessageId: "m-neg-1",
  });
  assert.equal(started.ok, false);
  assert.match(String(started.error), /手机端确认被取消/);
  const status = await coordinator.status(ACTOR, callId);
  assert.equal(status.state, "cancelled");

  // 取消路径不产生任何收件箱回执
  let inboxEmpty = true;
  try {
    const raw = await readFile(join(root, "inbox", `${ACTOR}.json`), "utf8");
    inboxEmpty = (JSON.parse(raw) as unknown[]).length === 0;
  } catch {
    inboxEmpty = true; // 文件不存在 = 空
  }
  assert.ok(inboxEmpty, "取消路径不得投递收件箱回执");
  console.log("[负路径] 手机端拒绝 → cancelled，无收件箱回执 ✓");
});
