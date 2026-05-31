import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 将 dist/ 复制到宿主项目的静态资源目录。
 *
 * 环境变量：
 *   AVATAR_DEPLOY_DIR — 目标目录（默认 ../server/web/chat/assets/avatar）
 */
const scriptDir = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(scriptDir, "..");
const dist = resolve(packageRoot, "dist");
const target = resolve(
  packageRoot,
  process.env.AVATAR_DEPLOY_DIR ?? "../server/web/chat/assets/avatar",
);

if (!existsSync(dist)) {
  console.error("[copy-chat-avatar] dist/ not found — run npm run build first");
  process.exit(1);
}

if (existsSync(target)) rmSync(target, { recursive: true, force: true });
mkdirSync(target, { recursive: true });
cpSync(dist, target, { recursive: true });
console.log(`[copy-chat-avatar] copied ${dist} -> ${target}`);
