// 支付/收款通知 → 财务入账 端到端 mock 测试（微信 + 支付宝双通道打通验证）。
//
// 完整链路（与 bootstrap 装配一致）：
//   手机通知监听 → phone.msg.report（WS）→ MessageHub.ingestInbound
//   → onInbound 回调 → FinanceIngestService.handleInboundMessage
//   → platform 分路（alipay / wechat）→ 零 LLM 确定性解析 → 指纹去重 → 入账
//
// mock 边界：不起真 WS 服务、不发真通知——直接调用 MessageHub.ingestInbound
// （WS 处理器只是它的薄封装），断言账本落库结果。
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

import { MessageHubService } from "../src/services/message-hub-service.js";
import { FinanceDeepService } from "../src/services/finance-deep-service.js";
import { AgentAccountService } from "../src/services/agent-account-service.js";
import { FinanceIngestService } from "../src/services/finance-ingest-service.js";

const NOW = new Date(2026, 8, 18, 12, 30, 0); // 固定时钟：2026-09-18 12:30:00
const ACTOR = "user-e2e";

function makePipes() {
  const dir = mkdtempSync(join(tmpdir(), "pay-e2e-"));
  const financeDeepService = new FinanceDeepService(dir);
  const financeIngest = new FinanceIngestService({
    financeDeepService,
    agentAccountService: new AgentAccountService(),
    now: () => NOW,
  });
  // 必须显式传 dbPath：缺省会落到固定的 data/message-hub/message-hub.db（真实运行库）
  const messageHub = new MessageHubService(join(dir, "message-hub.json"), join(dir, "message-hub.db"));
  // 与 create-app-services.ts 完全一致的接线
  messageHub.onInbound = (input) => {
    void financeIngest.handleInboundMessage(input).catch(() => {});
  };
  return {
    dir,
    financeDeepService,
    financeIngest,
    messageHub,
    /** ingest 后等异步入账链路落地 */
    pump: () => new Promise<void>((r) => setTimeout(r, 30)),
    cleanup: () => {
      // Windows 下 better-sqlite3 句柄未释放时 rmSync 会 EPERM——尽力清理，
      // 失败留给进程退出后系统回收临时目录
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    },
  };
}

async function makePipesAsync() {
  const p = makePipes();
  await p.messageHub.load();
  return p;
}

function ledgerOf(financeDeepService: FinanceDeepService) {
  return financeDeepService.getTransactions(ACTOR, undefined, undefined, undefined, 1000);
}

test("支付宝支付通知：上报 → 入账（钱迹模式，零 LLM）", async () => {
  const p = await makePipesAsync();
  try {
    const result = await p.messageHub.ingestInbound({
      actorId: ACTOR,
      platform: "alipay",
      channelId: "支付宝",
      text: "你在【美团】付款成功，金额¥25.80",
      title: "支付成功",
      senderName: "支付宝",
      externalMessageId: "alipay-notify-1",
    });
    assert.equal(result.deduped, false, "首条不应被判重");
    await p.pump();

    const ledger = ledgerOf(p.financeDeepService);
    assert.equal(ledger.length, 1);
    assert.equal(ledger[0].amount, 25.8);
    assert.equal(ledger[0].type, "expense");
    assert.equal(ledger[0].merchant, "美团");
    assert.equal(ledger[0].source, "alipay_notice");
  } finally {
    p.cleanup();
  }
});

test("支付宝收款通知 → income；蚂蚁森林噪音 → 不入账", async () => {
  const p = await makePipesAsync();
  try {
    await p.messageHub.ingestInbound({
      actorId: ACTOR, platform: "alipay", channelId: "支付宝",
      text: "今天 09:15 收款成功 ¥88.00（收款码）",
      title: "收款到账", externalMessageId: "alipay-notify-2",
    });
    await p.messageHub.ingestInbound({
      actorId: ACTOR, platform: "alipay", channelId: "支付宝",
      text: "你的蚂蚁森林能量已成熟，快去收取 60g 绿色能量",
      title: "蚂蚁森林", externalMessageId: "alipay-notify-3",
    });
    await p.pump();

    const ledger = ledgerOf(p.financeDeepService);
    assert.equal(ledger.length, 1, "噪音不入账，只有收款一条");
    assert.equal(ledger[0].type, "income");
    assert.equal(ledger[0].amount, 88);
    assert.equal(ledger[0].date, "2026-09-18 09:15:00");
  } finally {
    p.cleanup();
  }
});

test("支付宝同一通知重投：MessageHub 外层幂等（externalMessageId）不再触发入账", async () => {
  const p = await makePipesAsync();
  try {
    const first = await p.messageHub.ingestInbound({
      actorId: ACTOR, platform: "alipay", channelId: "支付宝",
      text: "付款成功 ¥25.80", title: "支付成功",
      externalMessageId: "alipay-notify-repost",
    });
    await p.pump();
    const repost = await p.messageHub.ingestInbound({
      actorId: ACTOR, platform: "alipay", channelId: "支付宝",
      text: "付款成功 ¥25.80", title: "支付成功",
      externalMessageId: "alipay-notify-repost",
    });
    await p.pump();
    assert.equal(first.deduped, false);
    assert.equal(repost.deduped, true, "重投应在消息中心层被判重");
    assert.equal(ledgerOf(p.financeDeepService).length, 1);
  } finally {
    p.cleanup();
  }
});

test("微信支付通知（手机通知捕捉形态）→ 入账", async () => {
  const p = await makePipesAsync();
  try {
    await p.messageHub.ingestInbound({
      actorId: ACTOR, platform: "wechat", channelId: "微信支付",
      text: "微信支付成功：¥19.90",
      senderName: "微信支付", title: "微信支付",
      externalMessageId: "wx-notify-1",
    });
    await p.pump();

    const ledger = ledgerOf(p.financeDeepService);
    assert.equal(ledger.length, 1);
    assert.equal(ledger[0].amount, 19.9);
    assert.equal(ledger[0].type, "expense");
    assert.equal(ledger[0].source, "wechat_notice");
  } finally {
    p.cleanup();
  }
});

test("微信桥「微信支付」服务通知（bridge 形态）→ 入账", async () => {
  const p = await makePipesAsync();
  try {
    await p.messageHub.ingestInbound({
      actorId: ACTOR, platform: "wechat", channelId: "微信支付",
      text: "已支付人民币 45.00 元，商户：【盒马鲜生】",
      participantName: "微信支付", title: "微信支付",
      externalMessageId: "wx-bridge-1",
    });
    await p.pump();

    const ledger = ledgerOf(p.financeDeepService);
    assert.equal(ledger.length, 1);
    assert.equal(ledger[0].amount, 45);
    assert.equal(ledger[0].merchant, "盒马鲜生");
  } finally {
    p.cleanup();
  }
});

test("普通微信聊天提到「支付」字样 → 不误记账（联系人信号门禁）", async () => {
  const p = await makePipesAsync();
  try {
    await p.messageHub.ingestInbound({
      actorId: ACTOR, platform: "wechat", channelId: "张三",
      text: "我今天微信支付了 30 块买奶茶，你说贵不贵",
      senderName: "张三", title: "张三",
      externalMessageId: "wx-chat-1",
    });
    await p.pump();
    assert.equal(ledgerOf(p.financeDeepService).length, 0);
  } finally {
    p.cleanup();
  }
});

test("跨通道指纹去重：同一笔支付宝交易两种文本形态只记一次", async () => {
  const p = await makePipesAsync();
  try {
    // 通知文本 A 与 B 金额/时间/方向一致（显式时间保证指纹稳定），仅措辞不同
    await p.messageHub.ingestInbound({
      actorId: ACTOR, platform: "alipay", channelId: "支付宝",
      text: "今天 09:15 你在便利店付款成功 ¥6.50",
      title: "支付成功", externalMessageId: "alipay-form-a",
    });
    await p.pump();
    await p.messageHub.ingestInbound({
      actorId: ACTOR, platform: "alipay", channelId: "支付宝",
      text: "今天 09:15 便利店消费 ¥6.50 已完成",
      title: "交易完成", externalMessageId: "alipay-form-b",
    });
    await p.pump();

    const ledger = ledgerOf(p.financeDeepService);
    assert.equal(ledger.length, 1, "同日同额同向的指纹应命中去重");
  } finally {
    p.cleanup();
  }
});

test("静态门禁：WS 白名单与 Kotlin 通知白名单都含支付宝（防接线回退）", () => {
  // WS 处理器的 reportablePlatforms 白名单（server 源码级回归保护）
  const connectionSrc = readFileSync(
    resolve(import.meta.dirname ?? ".", "../src/ws/connection.ts"), "utf8",
  );
  assert.match(connectionSrc, /reportablePlatforms = new Set<string>\(\[[^\]]*"alipay"/);

  // Android 通知监听的包名白名单（客户端源码级回归保护）
  const kotlinSrc = readFileSync(
    resolve(
      import.meta.dirname ?? ".",
      "../../client/flutter_app/android/app/src/main/kotlin/com/example/private_ai_app/MessageCaptureListenerService.kt",
    ),
    "utf8",
  );
  assert.match(kotlinSrc, /com\.eg\.android\.AlipayGphone" to "alipay"/);
});
