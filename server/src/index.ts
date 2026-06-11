import { loadServerEnv } from "./config/load-server-env.js";
import { exitIfDevPortInUse, isDevListenConflict } from "./utils/port-in-use.js";
import { getRuntimeConfig } from "./config/env.js";
import { createExternalChatProviderFromEnv } from "./external-model/index.js";
import { createAppServices } from "./bootstrap/create-app-services.js";
import { initializeRuntimeState } from "./bootstrap/initialize-runtime-state.js";
import { startDesktopBridgeAutoClient } from "./services/desktop-bridge-auto-starter.js";
import { startOpenClawModelSyncWatcher } from "./services/openclaw-config-sync.js";
import {
  isWechatClawBridgeEnabled,
  readWechatClawBridgeConfig,
} from "./services/wechat-claw-bridge-service.js";
import { isWechatClawFeatureEnabled } from "./services/openclaw-gateway-client.js";
import { isTcpPortInUse } from "./utils/port-in-use.js";

// 始终从 server/.env + server/.env.local 加载（密钥放 .env.local，避免被脚本误覆盖）
loadServerEnv();

// ─── 全局异常处理：防止未捕获异常导致进程意外崩溃 ───
process.on("uncaughtException", (err: Error) => {
  console.error("[FATAL] uncaughtException:", err.message || err);
  console.error(err.stack || "(no stack)");
  // 记录错误后优雅退出，让外部进程管理器（如 node --watch / pm2）决定是否重启
  shutdown?.();
  setTimeout(() => process.exit(1), 2000).unref();
});

process.on("unhandledRejection", (reason: unknown, promise: Promise<unknown>) => {
  const msg = reason instanceof Error ? reason.message : String(reason ?? "unknown");
  console.error("[WARN] unhandledRejection:", msg);
  // 不退出进程，仅记录警告；如果是严重错误会触发后续的 uncaughtException
});

await exitIfDevPortInUse(getRuntimeConfig().port);

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
try {
  await services.app.listen({
    port: runtime.port,
    host: "0.0.0.0",
  });
} catch (err) {
  if (isDevListenConflict(err)) process.exit(0);
  throw err;
}

// ─── Webhook: Agent 上线事件 ───
services.webhookService.emit("agent.online", {
  port: runtime.port,
  version: "1.0",
  uptime: new Date().toISOString(),
});

const stopDesktopBridge = startDesktopBridgeAutoClient({
  port: runtime.port,
  log: (line) => services.app.log.info(line),
});
const stopOpenClawModelSync = isWechatClawBridgeEnabled(process.env)
  ? (() => {
      const bridge = readWechatClawBridgeConfig(process.env);
      console.log(
        `[wechat-claw] 消息桥已启用 → POST http://127.0.0.1:${bridge.serverPort}/integrations/wechat-claw/bridge/chat（OpenClaw 插件 before_dispatch）`,
      );
      if (isWechatClawFeatureEnabled(process.env)) {
        const gwPort = Number(
          process.env.OPENCLAW_GATEWAY_WS_URL?.match(/:(\d+)/)?.[1] ?? "18789",
        );
        void isTcpPortInUse(gwPort, "127.0.0.1").then((inUse) => {
          if (!inUse) {
            console.warn(
              `[wechat-claw] Gateway 未在 127.0.0.1:${gwPort} 监听，微信将无法回复。请重启 dev:all 或单独运行: openclaw gateway`,
            );
          }
        });
      }
      return () => {};
    })()
  : startOpenClawModelSyncWatcher(process.env);

const shutdown = (): void => {
  // ─── Webhook: Agent 下线事件 ───
  services.webhookService.emit("agent.offline", {
    port: runtime.port,
    reason: "graceful_shutdown",
    timestamp: new Date().toISOString(),
  });
  services.webhookService.stop();
  stopDesktopBridge();
  stopOpenClawModelSync();
  void services.app.close().finally(() => process.exit(0));
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
const worldStandalone = process.env.AGENT_WORLD_STANDALONE_URL?.trim() || "http://127.0.0.1:3333";
console.log(
  `[dev] server http://127.0.0.1:${runtime.port} | Agent World ${worldStandalone}`,
);
