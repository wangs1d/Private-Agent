/**
 * 临时验证脚本：走 McpClientService 真实链路验证瑞幸下单全流程
 * 用法：cd server && npx tsx scripts/verify-luckin-order.ts
 * 链路：queryShopList 查门店 → searchProductForMcp 选品 → previewOrder 预览
 *       → createOrder 创建订单（未支付）→ queryOrderDetailInfo 查单 → cancelOrder 取消
 * 取消发生在支付前，不产生实际扣款。验证完可删除
 */
import "../src/config/load-server-env.js";
import { McpClientService } from "../src/services/mcp-client-service.js";

/** 从 MCP 工具结果中提取文本 */
function textOf(result: Record<string, unknown>): string {
  const content = (result as { content?: Array<{ type?: string; text?: string }> }).content;
  if (Array.isArray(content)) {
    return content.map((c) => c?.text ?? "").join("\n");
  }
  return JSON.stringify(result);
}

function parseJson(result: Record<string, unknown>): any {
  const text = textOf(result);
  try {
    return JSON.parse(text);
  } catch {
    const m = text.match(/\{[\s\S]*\}/);
    if (m) {
      try { return JSON.parse(m[0]); } catch { /* ignore */ }
    }
    return text;
  }
}

/** 深度查找第一个命中 key 的值 */
function deepFind(obj: unknown, keyPattern: RegExp): unknown {
  if (Array.isArray(obj)) {
    for (const item of obj) {
      const hit = deepFind(item, keyPattern);
      if (hit !== undefined) return hit;
    }
    return undefined;
  }
  if (obj && typeof obj === "object") {
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      if (keyPattern.test(k) && v !== undefined && v !== null && v !== "") return v;
      const hit = deepFind(v, keyPattern);
      if (hit !== undefined) return hit;
    }
  }
  return undefined;
}

async function main() {
  const svc = new McpClientService();
  await svc.discoverTools();
  const tools = svc.listTools().filter((t) => t.serverAlias === "luckin");
  if (tools.length === 0) {
    console.error("FAIL: luckin 工具未发现");
    svc.closeAll();
    process.exit(1);
  }
  console.log(`luckin tools: ${tools.map((t) => t.rawToolName).join(", ")}`);

  const call = async (toolName: string, args: Record<string, unknown>) => {
    const t0 = Date.now();
    const res = await svc.callTool("luckin", toolName, args, 60_000);
    console.log(`\n>>> ${toolName} (${Date.now() - t0}ms, ok=${res.ok})`);
    console.log(textOf(res.result).slice(0, 600));
    return res;
  };

  // 1. 查门店（北京国贸附近坐标）
  const shopRes = await call("queryShopList", { longitude: 116.461337, latitude: 39.908722 });
  const shopParsed = parseJson(shopRes.result);
  const shopList = Array.isArray(shopParsed?.data) ? shopParsed.data : (Array.isArray(shopParsed) ? shopParsed : []);
  const shop = shopList[0];
  const deptId = Number(deepFind(shop, /^deptId$/) ?? NaN);
  if (!Number.isFinite(deptId)) {
    console.error("\nFAIL: 未解析到门店 deptId");
    svc.closeAll();
    process.exit(1);
  }
  console.log(`\n选定门店: deptId=${deptId}`);

  // 2. 选品
  const productRes = await call("searchProductForMcp", { deptId, query: "生椰拿铁" });
  const productParsed = parseJson(productRes.result);
  const product = deepFind(productParsed, /^productId$/) ? productParsed : undefined;
  const productId = Number(deepFind(productParsed, /^productId$/) ?? NaN);
  const skuCode = String(deepFind(productParsed, /^skuCode$/) ?? "");
  if (!Number.isFinite(productId) || !skuCode) {
    console.error("\nFAIL: 未解析到商品 productId/skuCode");
    svc.closeAll();
    process.exit(1);
  }
  console.log(`\n选定商品: productId=${productId}, skuCode=${skuCode}`);

  // 3. 预览订单（拿到价格）
  await call("previewOrder", {
    deptId,
    productList: [{ amount: 1, productId, skuCode }],
  });

  // 4. 创建订单（未支付）
  const createRes = await call("createOrder", {
    deptId,
    productList: [{ amount: 1, productId, skuCode }],
    longitude: 116.461337,
    latitude: 39.908722,
  });
  const createParsed = parseJson(createRes.result);
  const orderId = String(deepFind(createParsed, /^(order_?id|orderId)$/i) ?? "");
  console.log(`\norderId=${orderId || "(未解析到)"}`);

  // 5. 查单
  if (orderId) {
    await call("queryOrderDetailInfo", { orderId });
    // 6. 立即取消（未支付，不产生扣款）
    await call("cancelOrder", { orderId });
  }

  svc.closeAll();
  console.log(shopRes.ok && productRes.ok && createRes.ok ? "\nPASS" : "\nFAIL");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
