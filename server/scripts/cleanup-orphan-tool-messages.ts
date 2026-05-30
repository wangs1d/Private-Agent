import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";

import { sanitizeToolCallMessageChain } from "../src/external-model/chat-thread-sanitize.js";

const filePath = process.argv[2] || join(process.cwd(), "data", "chat-threads.json");

async function main() {
  console.log("🔧 清理 chat-threads.json 中的损坏 tool 链...");
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
    session.messages = sanitizeToolCallMessageChain(
      session.messages as ChatCompletionMessageParam[],
      `[cleanup:${sessionId}]`,
    );

    const cleanedCount = originalLength - session.messages.length;
    if (cleanedCount > 0) {
      totalCleaned += cleanedCount;
      console.log(
        `✅ [${sessionId}] 清理了 ${cleanedCount} 条消息 (${originalLength} → ${session.messages.length})`,
      );
    }
  }

  await writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");

  console.log(`\n🎉 完成！共清理 ${totalCleaned} 条损坏消息`);
  console.log(`📝 数据已保存到: ${filePath}`);
}

main().catch((err) => {
  console.error("❌ 清理失败:", err);
  process.exit(1);
});
