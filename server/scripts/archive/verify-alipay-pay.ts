/**
 * 临时验证脚本：完整闭环测试 —— 重新下单 → 立即 submit-payment。
 * 验证「买」链路是否真实可达：钱包授权 → 商家下单拿短链 → 提交支付。
 * 用法：npx tsx scripts/verify-alipay-pay.ts
 */
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { AlipayBotService } from "../src/services/alipay-bot-service.js";
import { MerchantOrderService } from "../src/services/merchant-order-service.js";

const alipayBot = new AlipayBotService();
const wallet = alipayBot.forUser("123456");

console.log("== 1) check-wallet ==");
console.log(JSON.stringify(await wallet.checkWallet(), null, 2));

const merchants = new MerchantOrderService(join(process.cwd(), "data", "merchants.json"), alipayBot);
await merchants.load();

console.log("\n== 2) 意图路由 ==");
const routed = merchants.routeMerchant("帮我买杯奶茶");
console.log("route =>", routed?.id, routed?.name);

console.log("\n== 3) 下单拿短链 ==");
const sessionId = randomUUID();
const order = await merchants.placeOrder("123456", sessionId, "mock-demo", {
  goods: "珍珠奶茶", quantity: 1, amount: 0.01,
});
console.log("ok:", order.ok, "| merchant:", order.merchant?.id, "| alias:", order.alias);
if (!order.ok) {
  console.log("error:", order.error);
  process.exit(1);
}

console.log("\n== 4) 立即 submit-payment ==");
const pay = await wallet.submitPayment(
  sessionId,
  order.alias!,
  `服务内容：珍珠奶茶 x1，支付金额：¥0.01，支付对象：${order.merchant?.name}`,
);
console.log("ok:", pay.ok);
console.log("stdout:", (pay.stdout ?? "").slice(0, 1200));
if (pay.media?.length) console.log("media:", pay.media);
if (pay.error) console.log("error:", pay.error);
if (pay.stderr) console.log("stderr:", (pay.stderr ?? "").slice(0, 300));
