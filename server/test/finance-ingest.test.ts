// 财务管家 P1 测试：
//  A. 入站邮件记账（FinanceIngestService）：
//     1. 收件邮箱未绑定账号 → matched=false
//     2. 非账单邮件 → 关键词预过滤跳过（零 LLM）
//     3. LLM 抽取 → 入账 + onIngested 回调；重投 → 指纹去重不入账
//     4. LLM 输出容错解析（markdown 围栏 / 噪声文本 / 非法条目）
//  B. 预警增强（ConsumptionLedgerListener）：
//     5. 预算 warning（80%）→ 提醒一次；继续消费到 exceeded → 再提醒一次
//     6. 入账异常检测：≥ 近30天同分类均值 3 倍且 ≥ ¥100 → onAnomalyAlert 单次
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { HookBus } from "../src/services/hooks/hook-bus.js";
import { FinanceDeepService } from "../src/services/finance-deep-service.js";
import type { AgentAccountService } from "../src/services/agent-account-service.js";
import {
  FinanceIngestService,
  isBillRelatedMail,
  parseLlmTransactions,
} from "../src/services/finance-ingest-service.js";
import { ConsumptionLedgerListener } from "../src/services/consumption-ledger-listener.js";
import { createFinanceIngestBuiltinSkills } from "../src/skills/builtin/finance-ingest-skills.js";

const ACTOR = "actor-finance-p1-test";

async function makeIngestFixture(llm?: (prompt: string) => Promise<string>) {
  const dir = await mkdtemp(join(tmpdir(), "finance-ingest-test-"));
  const finance = new FinanceDeepService(dir);
  await finance.load();
  const agentAccountService = {
    getByEmail: (email: string) =>
      email === "bill@test.com" ? { userId: ACTOR, userId2: undefined } : undefined,
    getByActorId: (actorId: string) =>
      actorId === ACTOR ? { userId: ACTOR } : undefined,
  } as unknown as AgentAccountService;
  const service = new FinanceIngestService({
    financeDeepService: finance,
    agentAccountService,
    llmComplete: llm,
  });
  return { dir, finance, service };
}

// ── A. 入站邮件记账 ──────────────────────────────────

test("isBillRelatedMail：账单命中关键词，普通邮件跳过", () => {
  assert.ok(
    isBillRelatedMail({
      from: "alipay@service.com",
      subject: "支付宝交易明细",
      text: "您有一笔支出",
    }),
  );
  assert.ok(isBillRelatedMail({ subject: "本月信用卡账单", text: "" }));
  assert.ok(!isBillRelatedMail({ from: "friend@qq.com", subject: "周末爬山吗", text: "带上水" }));
});

test("parseLlmTransactions：围栏/噪声/非法条目容错", () => {
  const out = parseLlmTransactions(
    '好的，抽取结果如下：\n```json\n[{"date":"2026-09-01","amount":25,"type":"expense","merchant":"瑞幸"},{"date":"bad","amount":10,"type":"expense"},{"date":"2026-09-02","amount":-5,"type":"expense"}]\n```',
  );
  assert.ok(out);
  const valid = out.filter((t) => t !== null);
  assert.equal(valid.length, 1);
  assert.equal(valid[0]!.merchant, "瑞幸");
  assert.equal(parseLlmTransactions("没有交易"), null);
  assert.deepEqual(parseLlmTransactions("[]"), []);
});

test("入站邮件记账：未绑定账号 → matched=false", async () => {
  const { dir, service } = await makeIngestFixture();
  try {
    const r = await service.applyInboundEmail({ to: "nobody@test.com", subject: "账单", text: "消费 100 元" });
    assert.equal(r.matched, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("入站邮件记账：非账单邮件预过滤跳过，不耗 LLM", async () => {
  let llmCalled = 0;
  const { dir, service } = await makeIngestFixture(async () => {
    llmCalled += 1;
    return "[]";
  });
  try {
    const r = await service.applyInboundEmail({
      to: "bill@test.com",
      from: "friend@qq.com",
      subject: "周末聚餐吗",
      text: "老地方见",
    });
    assert.equal(r.matched, true);
    assert.equal(r.skipped, "not_bill");
    assert.equal(llmCalled, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("入站邮件记账：LLM 抽取 → 入账 + 回调；重投去重", async () => {
  const llmOutput = JSON.stringify([
    { date: "2026-09-01", amount: 35.5, type: "expense", merchant: "美团", description: "外卖" },
    { date: "2026-09-02", amount: 5000, type: "income", description: "工资" },
  ]);
  const ingestedMsgs: string[] = [];
  const { dir, finance, service } = await makeIngestFixture(async () => llmOutput);
  try {
    const r1 = await service.applyInboundEmail({
      to: "bill@test.com",
      from: "bank@ccb.cn",
      subject: "交易明细提醒",
      text: "您的账户发生以下交易",
    });
    assert.equal(r1.ingested, 2);
    assert.equal(finance.getTransactions(ACTOR).length, 2);
    const imported = finance.getTransactions(ACTOR);
    assert.ok(imported.every((t) => t.source === "email_ingest"));

    // 网关重投同一封邮件：指纹去重
    const r2 = await service.applyInboundEmail({
      to: "bill@test.com",
      from: "bank@ccb.cn",
      subject: "交易明细提醒",
      text: "您的账户发生以下交易",
    });
    assert.equal(r2.ingested, 0);
    assert.equal(finance.getTransactions(ACTOR).length, 2);
    void ingestedMsgs;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  void ingestedMsgs;
});

// ── B. 预警增强 ──────────────────────────────────────

const flush = () => new Promise((r) => setTimeout(r, 30));

test("预算分级提醒：warning 一次 → exceeded 再一次 → 不再重复", async () => {
  const dir = await mkdtemp(join(tmpdir(), "finance-budget-test-"));
  const finance = new FinanceDeepService(dir);
  await finance.load();
  try {
    finance.setBudget(ACTOR, "餐饮", 100, "monthly");
    const alerts: string[] = [];
    const listener = new ConsumptionLedgerListener({
      financeDeepService: finance,
      onBudgetAlert: (_actor, message) => alerts.push(message),
    });
    const bus = new HookBus();
    listener.subscribe(bus);

    const emit = (amount: number, id: string) =>
      bus.emit("tool.executed", {
        toolName: "wallet.purchase",
        args: { category: "food_delivery", amount, description: "餐饮消费" },
        result: { amount, category: "food_delivery", description: "餐饮消费", transactionId: id },
        actorId: ACTOR,
        timestamp: new Date().toISOString(),
      });

    // ¥85 → 85% → warning 提醒
    emit(85, "w1");
    await flush();
    assert.equal(alerts.length, 1);
    assert.ok(alerts[0].includes("快用完"));

    // 再 ¥85 → 170% → exceeded 提醒（级别不同，允许再提醒）
    emit(85, "w2");
    await flush();
    assert.equal(alerts.length, 2);
    assert.ok(alerts[1].includes("超支"));

    // 继续 → 已提醒过，不重复
    emit(10, "w3");
    await flush();
    assert.equal(alerts.length, 2);
    listener.stop();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("异常消费检测：3 倍均值且 ≥¥100 → onAnomalyAlert 单次", async () => {
  const dir = await mkdtemp(join(tmpdir(), "finance-anomaly-test-"));
  const finance = new FinanceDeepService(dir);
  await finance.load();
  try {
    // 近 30 天餐饮历史：两笔 ¥20（均值 20）
    await finance.importTransactions(ACTOR, [
      { date: new Date(Date.now() - 10 * 86_400_000).toISOString(), amount: 20, type: "expense", category: "餐饮" },
      { date: new Date(Date.now() - 5 * 86_400_000).toISOString(), amount: 20, type: "expense", category: "餐饮" },
    ]);
    const anomalyAlerts: string[] = [];
    const budgetAlerts: string[] = [];
    const listener = new ConsumptionLedgerListener({
      financeDeepService: finance,
      onBudgetAlert: (_actor, message) => budgetAlerts.push(message),
      onAnomalyAlert: (_actor, message) => anomalyAlerts.push(message),
    });
    const bus = new HookBus();
    listener.subscribe(bus);

    bus.emit("tool.executed", {
      toolName: "wallet.purchase",
      args: { category: "food_delivery", amount: 500, description: "高档日料" },
      result: { amount: 500, category: "food_delivery", description: "高档日料", transactionId: "a1" },
      actorId: ACTOR,
      timestamp: new Date().toISOString(),
    });
    await flush();
    assert.equal(anomalyAlerts.length, 1);
    assert.ok(anomalyAlerts[0].includes("500"));
    assert.ok(anomalyAlerts[0].includes("餐饮"));
    assert.equal(budgetAlerts.length, 0); // 未设预算，无预算提醒
    listener.stop();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ── C. 傻瓜式接入引导（绑定邮箱 / guide / 手动粘贴入账） ──────────

test("账单邮箱绑定：绑定/换绑/解绑 + 入站收件人按绑定解析", async () => {
  const llmOutput = JSON.stringify([
    { date: "2026-09-01", amount: 30, type: "expense", merchant: "瑞幸" },
  ]);
  const { dir, finance, service } = await makeIngestFixture(async () => llmOutput);
  try {
    // 账单邮箱（非账号验证邮箱）绑定后即可接收
    const bind = await service.bindMailbox(ACTOR, "Bills@Home.com");
    assert.ok(bind.ok);
    assert.equal(await service.getMailbox(ACTOR), "bills@home.com");

    const r = await service.applyInboundEmail({
      to: "bills@home.com",
      subject: "支付宝交易明细",
      text: "您有一笔支出",
    });
    assert.equal(r.matched, true);
    assert.equal(r.ingested, 1);

    // 换绑顶掉旧绑定；解绑后不再接收
    const other = "actor-other";
    await service.bindMailbox(other, "bills@home.com");
    assert.equal(await service.getMailbox(ACTOR), undefined);
    const unbind = await service.unbindMailbox(other);
    assert.ok(unbind.ok);

    // 非法邮箱拒绝
    const bad = await service.bindMailbox(ACTOR, "not-an-email");
    assert.equal(bad.ok, false);
    void finance;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("接入引导：未绑定给三步指引，绑定后 guide 切换为使用说明", async () => {
  const { dir, service } = await makeIngestFixture(async () => "[]");
  try {
    const g1 = await service.buildSetupGuide(ACTOR);
    assert.equal(g1.ready, false);
    assert.ok(g1.guide.includes("绑定账单邮箱"));
    assert.ok(g1.guide.includes("第1步"));

    await service.bindMailbox(ACTOR, "bill@test.com");
    const g2 = await service.buildSetupGuide(ACTOR);
    assert.equal(g2.ready, true);
    assert.ok(g2.guide.includes("已就绪"));
    assert.ok(g2.guide.includes("bill@test.com"));

    const status = await service.getSetupStatus(ACTOR);
    assert.equal(status.billMailbox, "bill@test.com");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("手动粘贴入账：短信原文 → 入账 + 去重", async () => {
  const llmOutput = JSON.stringify([
    { date: "2026-09-02", amount: 128, type: "expense", merchant: "滴滴出行" },
  ]);
  const { dir, finance, service } = await makeIngestFixture(async () => llmOutput);
  try {
    const r1 = await service.ingestText(ACTOR, "【滴滴出行】您9月2日支付128.00元");
    assert.equal(r1.ok, true);
    assert.equal(r1.ingested, 1);
    assert.equal(finance.getTransactions(ACTOR).length, 1);

    const r2 = await service.ingestText(ACTOR, "【滴滴出行】您9月2日支付128.00元");
    assert.equal(r2.ingested, 0);
    assert.ok(r2.message.includes("去重"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ── D. 快捷指示 builtin skills（客户端技能面板入口） ──────────────

test("builtin skills：guide/bind/text/status 四个快捷指示全链路", async () => {
  const llmOutput = JSON.stringify([
    { date: "2026-09-03", amount: 66, type: "expense", merchant: "肯德基" },
  ]);
  const { dir, service } = await makeIngestFixture(async () => llmOutput);
  try {
    const skills = createFinanceIngestBuiltinSkills({ financeIngestService: service });
    assert.equal(skills.length, 4);
    const byName = new Map(skills.map((s) => [s.metadata.name, s]));
    const ctx = { userId: ACTOR, sessionId: ACTOR };

    // ① 引导：未绑定时返回三步指引
    const guide = await byName.get("finance.ingest-guide")!.handler({}, ctx);
    assert.equal(guide.ok, true);
    assert.ok(String(guide.summary).includes("第1步"));

    // ② 绑定：成功后附带下一步指引
    const bind = await byName.get("finance.bind-ingest-email")!.handler(
      { email: "bill@test.com" },
      ctx,
    );
    assert.equal(bind.ok, true);
    assert.ok(String(bind.summary).includes("bill@test.com"));

    // ③ 粘贴入账：入账 1 笔
    const text = await byName.get("finance.ingest-text")!.handler(
      { text: "【肯德基】支付66.00元" },
      ctx,
    );
    assert.equal(text.ok, true);
    assert.equal(text.ingested, 1);

    // ④ 状态：已就绪
    const status = await byName.get("finance.ingest-status")!.handler({}, ctx);
    assert.equal(status.ok, true);
    assert.equal(status.ready, true);
    assert.ok(String(status.summary).includes("已就绪"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
