/**
 * 临时验证脚本：走 McpClientService 真实链路验证 rollinggo http MCP
 * 用法：cd server && npx tsx scripts/verify-rollinggo-mcp.ts
 * 验证完可删除
 */
import { McpClientService } from "../src/services/mcp-client-service.js";

async function main() {
  const svc = new McpClientService();
  console.log("servers:", svc.listServers().map((s) => `${s.alias}(${s.type})`));

  await svc.discoverTools();

  const tools = svc.listTools();
  console.log(`discovered ${tools.length} tools:`);
  for (const t of tools) {
    console.log(`  - ${t.name}: ${t.description.slice(0, 80)}`);
  }

  if (tools.length === 0) {
    console.error("FAIL: no tools discovered");
    process.exit(1);
  }

  // 实测一次 searchHotels（真实库存查询，走 60s 超时）
  const tomorrow = new Date(Date.now() + 24 * 3600 * 1000).toISOString().slice(0, 10);
  const t0 = Date.now();
  const result = await svc.callTool("rollinggo", "searchHotels", {
    place: "上海",
    placeType: "城市",
    originQuery: "帮我找上海的酒店，住一晚，两人一间",
    checkInParam: {
      checkInDate: tomorrow,
      stayNights: 1,
      adultsPerRoom: 2,
    },
    size: 3,
  });
  console.log(`searchHotels took ${Date.now() - t0}ms, ok=${result.ok}`);
  const text = JSON.stringify(result.result);
  console.log("result preview:", text.slice(0, 600));

  // 再测 getHotelSearchTags（无参数工具）
  const tags = await svc.callTool("rollinggo", "getHotelSearchTags", {});
  console.log(`getHotelSearchTags ok=${tags.ok}, preview: ${JSON.stringify(tags.result).slice(0, 200)}`);

  svc.closeAll();
  console.log(tools.length > 0 && result.ok ? "PASS" : "FAIL");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
