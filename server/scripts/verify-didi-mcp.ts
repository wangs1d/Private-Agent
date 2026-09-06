/**
 * 临时验证脚本：走 McpClientService 真实链路验证滴滴 http MCP（沙箱端点，返回 Mock 数据）
 * 用法：cd server && npx tsx scripts/verify-didi-mcp.ts
 * 链路：maps_textsearch 拿坐标 → taxi_estimate 估价 → taxi_create_order 下单
 *       → taxi_query_order 查单 → taxi_get_driver_location 司机位置 → taxi_cancel_order 取消
 * 验证完可删除
 */
import "../src/config/load-server-env.js";
import { McpClientService } from "../src/services/mcp-client-service.js";

/** 从 MCP 工具结果中提取文本（content[].text 或原始 JSON） */
function textOf(result: Record<string, unknown>): string {
  const content = (result as { content?: Array<{ type?: string; text?: string }> }).content;
  if (Array.isArray(content)) {
    return content.map((c) => c?.text ?? "").join("\n");
  }
  return JSON.stringify(result);
}

/** 深度查找对象中第一个命中的 key */
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

/** 从工具结果文本中解析 JSON（尽力而为） */
function parseResultJson(result: Record<string, unknown>): unknown {
  const text = textOf(result);
  try {
    return JSON.parse(text);
  } catch {
    const m = text.match(/\{[\s\S]*\}/);
    if (m) {
      try {
        return JSON.parse(m[0]);
      } catch {
        /* ignore */
      }
    }
  }
  return text;
}

async function main() {
  const svc = new McpClientService();
  console.log("servers:", svc.listServers().map((s) => `${s.alias}(${s.type})`));

  await svc.discoverTools();
  const tools = svc.listTools();
  console.log(`discovered ${tools.length} tools:`, tools.map((t) => t.rawToolName).join(", "));
  if (tools.length === 0) {
    console.error("FAIL: no tools discovered");
    process.exit(1);
  }

  const call = async (toolName: string, args: Record<string, unknown>) => {
    const t0 = Date.now();
    const res = await svc.callTool("didi", toolName, args, 60_000);
    console.log(`\n>>> ${toolName} (${Date.now() - t0}ms, ok=${res.ok})`);
    console.log(textOf(res.result).slice(0, 500));
    return res;
  };

  // 1. 地图搜索拿坐标（滴滴要求坐标必须来自 maps_textsearch，不能假设）
  const originRes = await call("maps_textsearch", { keywords: "北京西站", city: "北京" });
  const destRes = await call("maps_textsearch", { keywords: "西二旗地铁站", city: "北京" });
  const originParsed = parseResultJson(originRes.result);
  const destParsed = parseResultJson(destRes.result);
  const readCoords = (parsed: unknown): { lng: string; lat: string } | undefined => {
    const loc = deepFind(parsed, /^(location|lng_lat|coord)$/i);
    if (loc && typeof loc === "object") {
      const { lng, lat } = loc as { lng?: unknown; lat?: unknown };
      if (lng !== undefined && lat !== undefined) return { lng: String(lng), lat: String(lat) };
    }
    return undefined;
  };
  const originCoords = readCoords(originParsed);
  const destCoords = readCoords(destParsed);
  const origin = originCoords ? `${originCoords.lng},${originCoords.lat}` : "";
  const destination = destCoords ? `${destCoords.lng},${destCoords.lat}` : "";
  console.log(`\norigin=${origin}, destination=${destination}`);
  if (!/^\d+\.?\d*,\d+\.?\d*$/.test(origin) || !/^\d+\.?\d*,\d+\.?\d*$/.test(destination)) {
    console.error("FAIL: 未能从 maps_textsearch 解析出坐标");
    svc.closeAll();
    process.exit(1);
  }
  const [originLng, originLat] = origin.split(",");
  const [destLng, destLat] = destination.split(",");

  // 2. 估价（坐标/数字参数必须传字符串）
  const estimateRes = await call("taxi_estimate", {
    from_lng: originLng,
    from_lat: originLat,
    from_name: "北京西站",
    to_lng: destLng,
    to_lat: destLat,
    to_name: "西二旗地铁站",
  });
  // 沙箱估价结果是自由文本，从文本中提取品类代码与预估流程ID
  const estimateText = textOf(estimateRes.result);
  const estimateTraceId = estimateText.match(/预估流程ID[:：]\s*([a-z0-9]+)/i)?.[1] ?? "";
  const productCategory = estimateText.match(/快车\s*\(product_category:\s*(\d+)\)/i)?.[1] ?? "";
  console.log(`\nestimate_trace_id=${estimateTraceId}, product_category=${productCategory}`);

  // 3. 下单（沙箱固定返回 北京西站 → 西二旗 快车 Mock 订单）
  let orderId = "";
  if (estimateTraceId && productCategory) {
    const createRes = await call("taxi_create_order", {
      product_category: productCategory,
      estimate_trace_id: estimateTraceId,
    });
    const createParsed = parseResultJson(createRes.result);
    orderId =
      String(deepFind(createParsed, /order_id|orderId/i) ?? "")
      || textOf(createRes.result).match(/订单号[:：]\s*([A-Za-z0-9]+)/)?.[1]
      || "";

    // 4. 查单（沙箱按查询次数依次推进状态：0 匹配中 → 1 已接单 → 2 已到达 → 4 行程中 → 5 完成）
    await call("taxi_query_order", orderId ? { order_id: orderId } : {});

    // 5. 司机位置
    if (orderId) {
      await call("taxi_get_driver_location", { order_id: orderId });
    }

    // 6. 取消订单（沙箱不产生真实订单）
    if (orderId) {
      await call("taxi_cancel_order", { order_id: orderId, reason: "验证脚本测试取消" });
    }
  } else {
    console.warn("\nWARN: 未能解析出 estimate_trace_id / product_category，跳过下单链路");
  }

  svc.closeAll();
  console.log(tools.length > 0 && originRes.ok && estimateRes.ok ? "PASS" : "FAIL");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
