import { getDesktopTranslatePaths, shouldAutoStartDesktopTranslate, startDesktopTranslateTray } from "./src/services/desktop-translate-auto-starter.js";

const env = process.env;
console.log("shouldAutoStart:", shouldAutoStartDesktopTranslate(env));
console.log("paths:", JSON.stringify(getDesktopTranslatePaths(env), null, 2));
console.log("DESKTOP_TRANSLATE_AUTO_START env:", JSON.stringify(env.DESKTOP_TRANSLATE_AUTO_START));
console.log("PRIVATE_AI_AGENT_BASE_URL env:", JSON.stringify(env.PRIVATE_AI_AGENT_BASE_URL));

const stop = startDesktopTranslateTray({
  env,
  log: (line) => console.log("[LOG]", line),
  autoInstallDeps: false, // 不实际跑 install-deps，方便测试
  autoInstallTimeoutMs: 5000,
});

console.log("stop fn:", typeof stop);

// 5s 后退出
setTimeout(() => {
  console.log("exiting");
  stop();
  process.exit(0);
}, 5000);
