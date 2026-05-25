import { config as loadEnv } from "dotenv";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// 始终从 server/.env 加载，避免从 monorepo 根目录启动时读不到密钥
loadEnv({ path: join(dirname(fileURLToPath(import.meta.url)), "../.env") });

import { createExternalChatProviderFromEnv } from "./external-model/index.js";
import { createAppServices } from "./bootstrap/create-app-services.js";
import { getRuntimeConfig } from "./config/env.js";
import { initializeRuntimeState } from "./bootstrap/initialize-runtime-state.js";
import { startDesktopBridgeAutoClient } from "./services/desktop-bridge-auto-starter.js";

const runtime = getRuntimeConfig();
const externalChatProbe = createExternalChatProviderFromEnv();
if (externalChatProbe?.isEnabled()) {
  console.log(
    `[external-model] 已启用 ${externalChatProbe.displayLabel}（${process.env.MOONSHOT_MODEL ?? process.env.OPENAI_MODEL ?? "default"}）`,
  );
} else {
  console.warn(
    "[external-model] 未启用：请在 server/.env 配置 MOONSHOT_API_KEY 或 OPENAI_API_KEY 后重启服务",
  );
}
const services = await createAppServices();
await initializeRuntimeState(services);
await services.app.listen({
  port: runtime.port,
  host: "0.0.0.0",
});

const stopDesktopBridge = startDesktopBridgeAutoClient({
  port: runtime.port,
  log: (line) => services.app.log.info(line),
});

const shutdown = (): void => {
  stopDesktopBridge();
  void services.app.close().finally(() => process.exit(0));
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
const socialUrl = process.env.SOCIAL_PLATFORM_PUBLIC_URL?.trim() || "http://127.0.0.1:3001";
const worldStandalone = process.env.AGENT_WORLD_STANDALONE_URL?.trim() || "http://127.0.0.1:3333";
console.log(
  `[dev] server http://127.0.0.1:${runtime.port} | Agent World ${worldStandalone} | 社交推文 ${socialUrl}`,
);
