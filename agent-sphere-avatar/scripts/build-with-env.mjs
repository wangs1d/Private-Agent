/**
 * 带 AVATAR_PUBLIC_PATH 的 Vite 构建（跨平台）
 * 用法: node scripts/build-with-env.mjs [publicPath]
 */
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const publicPath = process.argv[2] ?? "./";
const scriptDir = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(scriptDir, "..");

process.env.AVATAR_PUBLIC_PATH = publicPath;

const tsc = spawnSync("npx", ["tsc", "--noEmit"], {
  cwd: packageRoot,
  stdio: "inherit",
  shell: true,
});
if (tsc.status !== 0) process.exit(tsc.status ?? 1);

const vite = spawnSync("npx", ["vite", "build"], {
  cwd: packageRoot,
  stdio: "inherit",
  shell: true,
  env: { ...process.env, AVATAR_PUBLIC_PATH: publicPath },
});
process.exit(vite.status ?? 1);
