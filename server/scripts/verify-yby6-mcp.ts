/**
 * 临时验证脚本：走 McpClientService 真实链路验证 yby6-video stdio MCP（项目内 venv）
 * 用法：cd server && npx tsx scripts/verify-yby6-mcp.ts
 * 链路：spawn tools/mcp/yby6-video venv exe → initialize → tools/list（预期 3 个工具）
 *       → share_url_parse_tool_wrapper 实测解析一个公开视频链接
 * 验证完可删除
 */
import "../src/config/load-server-env.js";
import { McpClientService } from "../src/services/mcp-client-service.js";

function textOf(result: Record<string, unknown>): string {
  const content = (result as { content?: Array<{ type?: string; text?: string }> }).content;
  if (Array.isArray(content)) {
    return content.map((c) => c?.text ?? "").join("\n");
  }
  return JSON.stringify(result);
}

async function main() {
  const svc = new McpClientService();
  console.log("servers:", svc.listServers().map((s) => `${s.alias}(${s.type})`));

  await svc.discoverTools();
  const tools = svc.listTools().filter((t) => t.serverAlias === "yby6-video");
  console.log(`\ndiscovered ${tools.length} yby6-video tools:`);
  for (const t of tools) {
    console.log(`  - ${t.rawToolName}: ${(t.description || "").trim().split("\n")[0]}`);
  }
  if (tools.length === 0) {
    console.error("FAIL: 未发现任何 yby6-video 工具");
    svc.closeAll();
    process.exit(1);
  }

  // 实测解析一个公开视频链接（B站公开视频），验证 tools/call 全链路
  const t0 = Date.now();
  const res = await svc.callTool("yby6-video", "share_url_parse_tool_wrapper", {
    url: "https://www.bilibili.com/video/BV1GJ411x7h7/",
  }, 60_000);
  const text = textOf(res.result);
  console.log(`\n>>> share_url_parse_tool_wrapper (${Date.now() - t0}ms, ok=${res.ok})`);
  console.log(text.slice(0, 800));

  svc.closeAll();
  console.log(tools.length >= 3 && res.ok ? "\nPASS" : "\nFAIL");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
