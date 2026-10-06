/**
 * 客户端热循环看门：盯 client/flutter_app/lib，一变就自动跑
 * scripts/rebuild-desktop-debug.ps1（增量重编 Dart kernel → 同步
 * windows_dist\Debug → 重启桌面应用），Dart 改动免手动构建。
 *
 * 服务端不用它：常驻链 dev 模式走 tsx watch，改 TypeScript 本就自动生效。
 *
 * 边界：
 *   - 只覆盖 Dart 代码。native 改动（windows/runner/**、插件、pubspec 依赖）
 *     需要 flutter 工具全量构建，这里只提示不重建（rebuild 脚本同款限制）。
 *   - 编译期间再来的改动会合并，跑完这一轮后自动补一轮，不丢改动。
 *
 * 用法：npm run dev:client:watch   （开一个终端常驻即可；日志直接打到终端）
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const appDir = path.join(root, "client", "flutter_app");
const libDir = path.join(appDir, "lib");
const rebuildScript = path.join(root, "scripts", "rebuild-desktop-debug.ps1");

const DEBOUNCE_MS = 1200;

let pending = false; // 防抖窗口内有新改动
let running = false; // 有一轮 rebuild 正在执行
let rerunQueued = false; // 执行期间又来改动，跑完补一轮

const stamp = () => new Date().toLocaleTimeString("sv-SE");

function triggerRebuild(reason) {
  if (running) {
    rerunQueued = true;
    return;
  }
  running = true;
  console.log(`[${stamp()}] [client-watch] 检测到改动(${reason})，开始 rebuild...`);
  const child = spawn(
    "powershell",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", rebuildScript],
    { cwd: root, stdio: "inherit" },
  );
  child.on("exit", (code) => {
    running = false;
    if (code !== 0) {
      console.error(`[${stamp()}] [client-watch] rebuild 失败 exit=${code}（上一版 kernel 已回滚，应用可能是旧代码）`);
    } else {
      console.log(`[${stamp()}] [client-watch] rebuild 完成，应用已重启`);
    }
    if (rerunQueued) {
      rerunQueued = false;
      triggerRebuild("补充轮");
    }
  });
  child.on("error", (err) => {
    running = false;
    console.error(`[client-watch] 拉起 rebuild 脚本失败: ${err.message}`);
  });
}

let debounceTimer = null;
function schedule(reason) {
  pending = true;
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    pending = false;
    triggerRebuild(reason);
  }, DEBOUNCE_MS);
}

if (!fs.existsSync(libDir)) {
  console.error(`[client-watch] 未找到 ${libDir}，请在仓库根目录运行`);
  process.exit(1);
}

fs.watch(libDir, { recursive: true }, (_event, file) => {
  if (!file) return schedule("lib");
  const f = String(file).replace(/\\/g, "/");
  // 编辑器临时文件不触发
  if (f.endsWith("~") || f.startsWith(".")) return;
  schedule(f);
});

// pubspec 变了（新依赖/native 插件）增量 kernel 救不了，提示人工全量构建
try {
  fs.watch(path.join(appDir, "pubspec.yaml"), () => {
    console.warn(`[${stamp()}] [client-watch] pubspec.yaml 变了：新依赖/native 插件需要全量 flutter build，本次未自动处理`);
  });
} catch {
  /* 文件不存在时忽略 */
}

try {
  fs.watch(path.join(appDir, "windows"), { recursive: true }, () => {
    console.warn(`[${stamp()}] [client-watch] native 代码(windows/**)变了：需要全量 flutter build windows --debug，本次未自动处理`);
  });
} catch {
  /* 目录不存在时忽略 */
}

console.log(`[client-watch] watching ${libDir}`);
console.log("[client-watch] 改 Dart 文件即自动增量重编并重启应用；改 native/pubspec 只提示，请手动全量构建");
setInterval(() => {}, 2_147_483_647); // 常驻
