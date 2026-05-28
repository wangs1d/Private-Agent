import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(scriptDir, "..");
const dist = resolve(packageRoot, "dist");
const target = resolve(packageRoot, "../server/web/chat/assets/avatar");

if (!existsSync(dist)) {
  console.error("[copy-chat-avatar] dist/ not found — run npm run build first");
  process.exit(1);
}

if (existsSync(target)) rmSync(target, { recursive: true, force: true });
mkdirSync(target, { recursive: true });
cpSync(dist, target, { recursive: true });
console.log(`[copy-chat-avatar] copied ${dist} -> ${target}`);
