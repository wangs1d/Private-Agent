// 测试 startDesktopTranslateTray 的新 options 不破坏现有路径。
// 传 autoInstallDeps=false，避免去装依赖。

import { startDesktopTranslateTray, shouldAutoStartDesktopTranslate, getDesktopTranslatePaths } from "./src/services/desktop-translate-auto-starter.js";

const env = process.env;
console.log("shouldAutoStart:", shouldAutoStartDesktopTranslate(env));
console.log("paths:", getDesktopTranslatePaths(env));
console.log("env.DESKTOP_TRANSLATE_AUTO_START:", env.DESKTOP_TRANSLATE_AUTO_START);

const stop = startDesktopTranslateTray({
  env,
  log: (line) => console.log("[LOG]", line),
  autoInstallDeps: false,
  autoInstallTimeoutMs: 5000,
  baseUrl: "http://127.0.0.1:3000",
  controlPort: 18766,
});

console.log("stop fn:", typeof stop);

setTimeout(async () => {
  console.log("--- testing tray IPC after 3s ---");
  try {
    const r = await fetch("http://127.0.0.1:18766/health", { method: "GET" });
    console.log("health status:", r.status);
    console.log("health body:", await r.text());
  } catch (e) {
    console.log("health error:", e);
  }
  console.log("--- testing /show-window ---");
  try {
    const r = await fetch("http://127.0.0.1:18766/show-window", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ hint: "from auto-starter test" }),
    });
    console.log("show status:", r.status);
    console.log("show body:", await r.text());
  } catch (e) {
    console.log("show error:", e);
  }
  console.log("--- stopping ---");
  stop();
  setTimeout(() => process.exit(0), 2000);
}, 3000);
