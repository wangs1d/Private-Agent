import { config as loadEnv } from "dotenv";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const serverRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");

/**
 * 加载 server 环境变量：先 `.env`（可提交示例/通用项），再 `.env.local`（本地密钥，覆盖前者）。
 * 密钥请只写在 `.env.local`，避免脚本从 `.env.example` 复制时覆盖。
 */
export function loadServerEnv(): void {
  const envPath = join(serverRoot, ".env");
  const localPath = join(serverRoot, ".env.local");

  if (existsSync(envPath)) {
    loadEnv({ path: envPath, quiet: true });
  }
  if (existsSync(localPath)) {
    loadEnv({ path: localPath, override: true, quiet: true });
  }
}

// 模块加载时立即执行：确保在任何其他模块 import 之前环境变量已就绪。
// 有些模块（如 chat-user-message.ts）在模块顶层调用 getAgentRuntimeConfig()，
// 如果 loadServerEnv() 被推迟到 index.ts 显式调用，那个缓存就已经写死了。
loadServerEnv();
