// 支付宝/微信账单导出文件确定性解析器测试。
//
// 覆盖：
//  A. detectBillStatementFormat：支付宝旧版/新版表头、微信表头（含 BOM + \r\n）、
//     表头兜底（说明头被裁掉）、unknown、空文本
//  B. 支付宝解析：说明头跳过、引号转义（字段内逗号/双引号）、金额（元）全角括号、
//     收/支列（收入/支出/不计收支）、状态过滤（交易成功入账；等待付款/退款成功跳过）、
//     交易号作幂等 id、GBK 字节解码与 latin1 乱码自动修复
//  C. 微信解析：¥ 前缀与千分位逗号金额、已存入零钱/对方已收钱按收入入账、
//     已全额退款跳过、中性交易（"/"）跳过、交易单号作幂等键（重复解析结果一致）
//  D. handlers.finance.import_transactions：识别微信账单真实入账，重复导入幂等去重
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import iconv from "iconv-lite";

import {
  decodeBillFileBytes,
  detectBillStatementFormat,
  parseBillStatement,
} from "../src/services/finance-bill-file-parser.js";
import { FinanceDeepService } from "../src/services/finance-deep-service.js";
import { createFinanceImportTransactionsHandler } from "../src/tools/capability-modules/finance-deep/handlers.js";

// ── 样例：支付宝旧版导出（GBK，说明头 + 「交易号」开头列名行） ──
// 行内含：引号转义的逗号字段、转义双引号、不计收支、等待付款、退款成功
const ALIPAY_OLD = [
  "支付宝交易记录明细查询",
  "账号:[demo@alipay.com]",
  "起始日期:[2024-06-01 00:00:00]    终止日期:[2024-06-30 23:59:59]",
  "---------------------------------[交易记录明细列表]---------------------------------",
  "交易号,商家订单号,交易创建时间,付款时间,最近修改时间,交易来源地,类型,交易对方,商品名称,金额（元）,收/支,交易状态,服务费（元）,成功与否,备注,",
  '2024060522001438391438598546,20240605023014523145,2024-06-05 12:30:00,2024-06-05 12:30:01,2024-06-05 12:30:01,深圳市,交易收款,张三伟,"早餐, 豆浆油条",12.50,收入,交易成功,0.00,成功,,',
  '2024060822001438391466887410,,2024-06-08 18:20:00,2024-06-08 18:20:02,2024-06-08 18:20:02,上海市,即时到账交易,盒马鲜生,"""盒马""鲜奶 950ml*2",45.80,支出,交易成功,0.00,成功,,',
  "2024061222001438391477003312,,2024-06-12 09:00:00,,2024-06-12 09:00:05,杭州市,转账,李四,房租押金,88.00,支出,等待付款,0.00,等待,,",
  "2024061522001438391488009911,,2024-06-15 20:10:00,2024-06-15 20:10:01,2024-06-16 10:00:00,北京市,退款,天猫超市,违规立减券,59.90,支出,退款成功,0.00,成功,,",
  "2024061822001438391499002210,,2024-06-18 08:00:00,,2024-06-18 08:00:02,杭州市,理财,余额宝-单次转入,,1000.00,不计收支,交易成功,0.00,成功,,",
].join("\n");

// ── 样例：支付宝新版导出「交易明细清单」（列名行含「交易订单号」） ──
const ALIPAY_NEW = [
  "支付宝交易明细清单",
  "账号:[demo@alipay.com]",
  "起始日期:[2024-07-01 00:00:00]终止日期:[2024-07-31 23:59:59]",
  "---------------------------------[交易记录明细]---------------------------------",
  "交易时间,交易分类,交易对方,对方账号,商品说明,收/支,金额,收/付款方式,交易状态,交易订单号,商家订单号,备注",
  "2024-07-03 10:00:00,餐饮美食,瑞幸咖啡,luckin@example.com,生椰拿铁*2,支出,31.20,招商银行(1234),交易成功,2024070322001438391401666666,202407030001,",
].join("\n");

// ── 样例：微信支付账单明细（UTF-8；构造时加 BOM + \r\n） ──
// 行内含：¥ 前缀金额、引号包裹的千分位逗号金额、已全额退款、中性交易「/」、对方已收钱
const WECHAT_LINES = [
  "微信支付账单明细,,,,,,,,,,,",
  "微信昵称：[阿伟],,,,,,,,,,,",
  "起始时间：[2024-03-01 00:00:00] 终止时间：[2024-03-31 23:59:59],,,,,,,,,,,",
  "导出类型：[全部],,,,,,,,,,,,",
  "导出时间：[2024-04-01 10:00:00],,,,,,,,,,,,",
  "共 5 笔记录,,,,,,,,,,,",
  "收入：2笔 133.88元,,,,,,,,,,,",
  "支出：2笔 1279.56元,,,,,,,,,,,",
  "中性交易：1笔 1000.00元,,,,,,,,,,,",
  "备注：以下是微信支付账单明细列表,,,,,,,,,,,",
  "----------------------微信支付账单明细列表--------------------,,,,,,,,,,,",
  "交易时间,交易类型,交易对方,商品,收/支,金额(元),支付方式,当前状态,交易单号,商户单号,备注",
  "2024-03-02 12:05:00,商户消费,肯德基宅急送,肯德基黄金鸡块,支出,¥45.00,招商银行(1234),支付成功,1000120240302120515985476102,M20240302001,/",
  "2024-03-05 09:30:00,微信红包,王小明,微信红包,收入,¥88.88,零钱,已存入零钱,1000120240305093050123456789,M20240305001,/",
  "2024-03-10 20:11:00,扫二维码付款,全家便利店,饭团+咖啡,支出,¥8.50,零钱,已全额退款,1000120240310201100987654321,M20240310001,/",
  "2024-03-15 08:00:00,零钱充值,/,零钱充值,/,¥1000.00,招商银行(1234),充值成功,1000120240315080000112233445,M20240315001,/",
  "2024-03-20 19:00:00,转账,老六,转账-聚餐AA,收入,¥45.00,零钱,对方已收钱,1000120240320190000556677889,M20240320001,/",
  '2024-03-25 10:00:00,商户消费,京东商城,NVIDIA RTX 显卡,支出,"¥1,234.56",招商银行(1234),支付成功,1000120240325100000667788990,M20240325002,/',
];
// 真实微信导出是 UTF-8（常带 BOM）+ \r\n
const WECHAT_BILL = "\uFEFF" + WECHAT_LINES.join("\r\n");

// ── A. 格式识别 ──────────────────────────────────

test("detectBillStatementFormat：识别支付宝旧版/新版与微信表头（含 BOM/\\r\\n）", () => {
  assert.equal(detectBillStatementFormat(ALIPAY_OLD), "alipay");
  assert.equal(detectBillStatementFormat(ALIPAY_NEW), "alipay");
  assert.equal(detectBillStatementFormat(WECHAT_BILL), "wechat");
  // 说明头被用户裁掉：仅凭列名行特征兜底
  assert.equal(detectBillStatementFormat(ALIPAY_OLD.slice(ALIPAY_OLD.indexOf("交易号"))), "alipay");
  assert.equal(detectBillStatementFormat(WECHAT_BILL.slice(WECHAT_BILL.indexOf("交易时间,"))), "wechat");
  // 普通文本 / 空文本
  assert.equal(detectBillStatementFormat("今天中午吃了个饭"), "unknown");
  assert.equal(detectBillStatementFormat(""), "unknown");
  assert.equal(detectBillStatementFormat("   \n  "), "unknown");
});

// ── B. 支付宝解析 ────────────────────────────────

test("parseBillStatement：支付宝旧版账单（说明头+引号转义+状态过滤+不计收支）", () => {
  const r = parseBillStatement(ALIPAY_OLD);
  assert.equal(r.source, "alipay");
  // 只入账 2 笔成功交易；等待付款 / 退款成功 / 不计收支 各跳过 1 行
  assert.equal(r.transactions.length, 2);
  assert.equal(r.skipped.length, 3);
  assert.deepEqual(r.skipped.map((s) => s.row), [8, 9, 10]);
  assert.ok(r.skipped.some((s) => s.reason.includes("等待付款")));
  assert.ok(r.skipped.some((s) => s.reason.includes("退款")));
  assert.ok(r.skipped.some((s) => s.reason.includes("不计收支")));

  const [t1, t2] = r.transactions;
  // 交易号作为幂等键写入 id（现有交易结构无 externalId 字段，以代码为准）
  assert.equal(t1.id, "alipay:2024060522001438391438598546");
  assert.equal(t1.date, "2024-06-05 12:30:00");
  assert.equal(t1.amount, 12.5);
  assert.equal(t1.type, "income");
  assert.equal(t1.merchant, "张三伟");
  assert.equal(t1.description, "早餐, 豆浆油条"); // 引号内的逗号不拆列
  assert.equal(t1.category, "其他");
  assert.equal(t1.source, "alipay");

  assert.equal(t2.id, "alipay:2024060822001438391466887410");
  assert.equal(t2.amount, 45.8);
  assert.equal(t2.type, "expense");
  assert.equal(t2.merchant, "盒马鲜生");
  assert.equal(t2.description, '"盒马"鲜奶 950ml*2'); // "" 转义为 "
});

test("parseBillStatement：支付宝新版明细清单（交易订单号作幂等键）", () => {
  const r = parseBillStatement(ALIPAY_NEW);
  assert.equal(r.source, "alipay");
  assert.equal(r.transactions.length, 1);
  const t = r.transactions[0];
  assert.equal(t.id, "alipay:2024070322001438391401666666");
  assert.equal(t.amount, 31.2);
  assert.equal(t.type, "expense");
  assert.equal(t.merchant, "瑞幸咖啡");
  assert.equal(t.description, "生椰拿铁*2");
});

test("parseBillStatement：支付宝 GBK 字节与 latin1 乱码文本可解码/修复", () => {
  // 上传文件拿到原始字节：官网导出是 GBK，decodeBillFileBytes 负责解成文本
  const gbkBytes = iconv.encode(ALIPAY_OLD, "gbk");
  const decoded = decodeBillFileBytes(gbkBytes);
  assert.equal(decoded, ALIPAY_OLD);
  assert.equal(detectBillStatementFormat(decoded), "alipay");
  assert.equal(parseBillStatement(decoded).transactions.length, 2);

  // 上游把 GBK 字节按 latin1 误读成字符串（乱码）：应自动修复并如实告警
  const mojibake = gbkBytes.toString("latin1");
  assert.equal(detectBillStatementFormat(mojibake), "alipay");
  const repaired = parseBillStatement(mojibake);
  assert.equal(repaired.source, "alipay");
  assert.equal(repaired.transactions.length, 2);
  assert.ok(repaired.warnings.some((w) => w.includes("GBK")));
});

// ── C. 微信解析 ────────────────────────────────

test("parseBillStatement：微信账单（¥金额+退款过滤+交易单号幂等键）", () => {
  const r = parseBillStatement(WECHAT_BILL);
  assert.equal(r.source, "wechat");
  // 入账 4 笔：肯德基支出 / 红包收入 / 转账收入 / 京东支出；退款 + 中性交易跳过
  assert.equal(r.transactions.length, 4);
  assert.equal(r.skipped.length, 2);
  assert.deepEqual(r.skipped.map((s) => s.row), [15, 16]);
  assert.ok(r.skipped.some((s) => s.reason.includes("退款")));
  assert.ok(r.skipped.some((s) => s.reason.includes("中性交易")));

  const byId = new Map(r.transactions.map((t) => [t.id, t]));
  // 交易单号作为幂等键写入 id
  const kfc = byId.get("wechat:1000120240302120515985476102");
  assert.ok(kfc);
  assert.equal(kfc!.amount, 45.0);
  assert.equal(kfc!.type, "expense");
  assert.equal(kfc!.merchant, "肯德基宅急送");
  assert.equal(kfc!.description, "肯德基黄金鸡块");
  assert.equal(kfc!.date, "2024-03-02 12:05:00");
  assert.equal(kfc!.source, "wechat");

  // 红包「已存入零钱」按收入入账
  const redPacket = byId.get("wechat:1000120240305093050123456789");
  assert.ok(redPacket);
  assert.equal(redPacket!.amount, 88.88);
  assert.equal(redPacket!.type, "income");

  // 「对方已收钱」的转账按收入入账
  const transfer = byId.get("wechat:1000120240320190000556677889");
  assert.ok(transfer);
  assert.equal(transfer!.type, "income");
  assert.equal(transfer!.amount, 45.0);

  // 引号包裹的「¥1,234.56」：¥ 前缀与千分位逗号都要正确剥离
  const jd = byId.get("wechat:1000120240325100000667788990");
  assert.ok(jd);
  assert.equal(jd!.amount, 1234.56);
  assert.equal(jd!.type, "expense");

  // 幂等：同一份账单重复解析，id 完全一致（可安全重放）
  const again = parseBillStatement(WECHAT_BILL);
  assert.deepEqual(
    again.transactions.map((t) => t.id),
    r.transactions.map((t) => t.id),
  );
});

test("parseBillStatement：maxRows 超限如实告警并截断", () => {
  const r = parseBillStatement(WECHAT_BILL, { maxRows: 2 });
  assert.equal(r.transactions.length, 2);
  assert.ok(r.warnings.some((w) => w.includes("超过最大解析行数")));
});

// ── unknown / 空文本：诚实失败，不编造数据 ──────

test("parseBillStatement：unknown 格式与空文本返回空交易并告警", () => {
  const unknown = parseBillStatement("这是随便一段对话文本，不是账单");
  assert.equal(unknown.source, "unknown");
  assert.equal(unknown.transactions.length, 0);
  assert.equal(unknown.skipped.length, 0);
  assert.ok(unknown.warnings.some((w) => w.includes("无法识别")));

  for (const t of ["", "   \n  "]) {
    const r = parseBillStatement(t);
    assert.equal(r.source, "unknown");
    assert.equal(r.transactions.length, 0);
    assert.ok(r.warnings.some((w) => w.includes("为空")));
  }
});

// ── D. 工具 handler：真实入账 + 重复导入幂等 ────

test("handlers：finance.import_transactions 识别微信账单入账，重复导入按交易单号去重", async () => {
  const dir = await mkdtemp(join(tmpdir(), "finance-bill-handler-"));
  try {
    const finance = new FinanceDeepService(dir);
    await finance.load();
    const handler = createFinanceImportTransactionsHandler(finance);
    const context = { sessionId: "sess-bill", userId: "actor-bill-test" };

    // 首次导入：4 笔入账（2 笔跳过行如实回传）
    const first = (await handler({ format: "csv", data: WECHAT_BILL }, context)) as Record<
      string,
      unknown
    >;
    assert.equal(first.ok, true);
    assert.equal(first.source, "wechat");
    assert.equal(first.imported, 4);
    assert.equal(first.total, 4);
    assert.equal(first.duplicatesSkipped, 0);
    assert.ok(String(first.summary).includes("微信"));

    // 账本里确实落了 4 条，且 id = 交易单号幂等键
    const ledger = finance.getTransactions("actor-bill-test");
    assert.equal(ledger.length, 4);
    assert.ok(ledger.some((t) => t.id === "wechat:1000120240302120515985476102"));

    // 重复导入同一份账单：0 笔新增，全部按交易单号去重
    const second = (await handler({ format: "csv", data: WECHAT_BILL }, context)) as Record<
      string,
      unknown
    >;
    assert.equal(second.ok, true);
    assert.equal(second.imported, 0);
    assert.equal(second.duplicatesSkipped, 4);
    assert.equal(finance.getTransactions("actor-bill-test").length, 4);

    // 非账单文本仍走原 json/csv 路径（不受新链路影响）
    const plain = (await handler(
      {
        format: "csv",
        data: "date,amount,type,merchant\n2024-03-01,10,expense,便利店",
      },
      context,
    )) as Record<string, unknown>;
    assert.equal(plain.ok, true);
    assert.equal(plain.imported, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
