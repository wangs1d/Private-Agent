/**
 * 联调脚本：验证商家下单桥接层（MerchantOrderService）。
 * 需要 mock-merchant-server.cjs 已启动（默认 18099）。
 * 用法：npx tsx server/scripts/test-merchant-order.ts
 */
import { join } from "node:path";
import { AlipayBotService } from "../src/services/alipay-bot-service.js";
import { MerchantOrderService } from "../src/services/merchant-order-service.js";

const service = new MerchantOrderService(
  join(process.cwd(), "data", "merchants.json"),
  new AlipayBotService(),
);
await service.load();

console.log("== merchants ==");
console.log(service.listMerchants().map((m) => `${m.id}(${m.name})`).join(", "));

const intent = "帮我买杯奶茶";
const routed = service.routeMerchant(intent);
console.log("== route('" + intent + "') =>", routed?.id, routed?.name);

const actorId = "test-user-001";
const sessionId = "test-session-0001";
const result = await service.placeOrder(actorId, sessionId, "mock-demo", {
  goods: "珍珠奶茶",
  quantity: 1,
  amount: 0.01,
});
console.log("== placeOrder ==");
console.log("ok:", result.ok);
console.log("merchant:", result.merchant?.id);
console.log("alias:", result.alias);
console.log("extractPath:", result.extractPath, "payloadType:", result.payloadType);
if (!result.ok) console.log("error:", result.error);
console.log("stdout(first 300):", (result.stdout ?? "").slice(0, 300).replace(/\n/g, "\\n"));
