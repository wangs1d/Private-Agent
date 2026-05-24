import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const filePath = process.argv[2] || join(process.cwd(), "data", "chat-threads.json");

async function main() {
  console.log(`🔧 清理 chat-threads.json 中的孤立 tool 消息...`);
  console.log(`📁 文件路径: ${filePath}\n`);

  const raw = await readFile(filePath, "utf8");
  const data = JSON.parse(raw);

  if (!data?.sessions || typeof data.sessions !== "object") {
    console.error("❌ 无效的数据格式");
    process.exit(1);
  }

  let totalCleaned = 0;
  const sessionIds = Object.keys(data.sessions);

  for (const sessionId of sessionIds) {
    const session = data.sessions[sessionId];
    if (!session?.messages || !Array.isArray(session.messages)) continue;

    const originalLength = session.messages.length;

    const validToolCallIds = new Set<string>();
    for (const msg of session.messages) {
      if (msg.role === "assistant" && Array.isArray(msg.tool_calls)) {
        for (const tc of msg.tool_calls) {
          if (tc.id) validToolCallIds.add(tc.id);
        }
      }
    }

    session.messages = session.messages.filter((msg) => {
      if (msg.role !== "tool") return true;
      const tcId = msg.tool_call_id;
      if (!tcId) return false;
      if (!validToolCallIds.has(tcId)) {
        console.warn(`  ⚠️  [${sessionId}] 删除孤立 tool 消息: tool_call_id=${tcId}`);
        return false;
      }
      return true;
    });

    const cleanedCount = originalLength - session.messages.length;
    if (cleanedCount > 0) {
      totalCleaned += cleanedCount;
      console.log(`✅ [${sessionId}] 清理了 ${cleanedCount} 条孤立消息 (${originalLength} → ${session.messages.length})`);
    }
  }

  await writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");

  console.log(`\n🎉 完成！共清理 ${totalCleaned} 条孤立 tool 消息`);
  console.log(`📝 数据已保存到: ${filePath}`);
}

main().catch((err) => {
  console.error("❌ 清理失败:", err);
  process.exit(1);
});
