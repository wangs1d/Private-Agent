/**
 * 临时验证脚本：走 McpClientService 真实链路验证瑞幸 http MCP
 * 用法：cd server && npx tsx scripts/verify-luckin-mcp.ts
 * 第一步：发现工具并列出入参 Schema（后续下单链路依据 Schema 组装）
 * 验证完可删除
 */
import "../src/config/load-server-env.js";
import { McpClientService } from "../src/services/mcp-client-service.js";

async function main() {
  const svc = new McpClientService();
  console.log("servers:", svc.listServers().map((s) => `${s.alias}(${s.type})`));

  await svc.discoverTools();
  const tools = svc.listTools().filter((t) => t.serverAlias === "luckin");
  console.log(`\ndiscovered ${tools.length} luckin tools:`);
  for (const t of tools) {
    console.log(`\n### ${t.rawToolName}: ${(t.description || "").slice(0, 80)}`);
    console.log(JSON.stringify(t.parameters, null, 1).slice(0, 700));
  }

  svc.closeAll();
  console.log(tools.length === 8 ? "\nPASS" : `\nFAIL (expected 8 tools, got ${tools.length})`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
