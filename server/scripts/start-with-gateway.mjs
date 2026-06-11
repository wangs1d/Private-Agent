import { spawn } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { config as dotenvConfig } from "dotenv";
import net from "node:net";

const __dirname = dirname(fileURLToPath(import.meta.url));
const serverDir = resolve(__dirname, "..");

// 加载 env（与服务端 loadServerEnv 一致）
dotenvConfig({ path: resolve(serverDir, ".env") });
dotenvConfig({ path: resolve(serverDir, ".env.local"), override: true });

const isGatewayEnabled = () => {
  const enabled = (process.env.WECHAT_CLAW_ENABLED ?? "").trim();
  return ["1", "true", "yes", "on"].includes(enabled.toLowerCase());
};

const children = [];

function spawnProcess(command, args, opts = {}) {
  const child = spawn(command, args, {
    stdio: "inherit",
    windowsHide: true,
    ...opts,
  });
  children.push(child);
  child.on("exit", (code) => {
    if (code !== 0 && code !== null && !opts.ignoreExitCode) {
      console.error(`[startup] ${command} 异常退出 (code=${code})`);
    }
  });
  return child;
}

async function waitForPort(port, timeoutMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      await new Promise((resolve, reject) => {
        const socket = net.createConnection({ port, host: "127.0.0.1" }, () => {
          socket.destroy();
          resolve();
        });
        socket.on("error", reject);
        socket.setTimeout(500, () => {
          socket.destroy();
          reject(new Error("timeout"));
        });
      });
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  throw new Error(`端口 ${port} 等待超时 (${timeoutMs}ms)`);
}

function killAll() {
  for (const child of children) {
    try {
      child.kill("SIGTERM");
    } catch { /* ignore */ }
  }
  process.exit(0);
}

async function main() {
  // 1. 如果启用了微信 Claw，启动 OpenClaw Gateway
  if (isGatewayEnabled()) {
    const port = process.env.OPENCLAW_GATEWAY_WS_URL?.match(/:(\d+)/)?.[1] ?? "18789";
    const token = process.env.OPENCLAW_GATEWAY_TOKEN?.trim() ?? "";

    console.log("[startup] 正在启动 OpenClaw Gateway...");

    const openclawCmd = process.platform === "win32"
      ? "openclaw.cmd"
      : "openclaw";

    spawnProcess(openclawCmd, [
      "gateway", "run",
      "--port", port,
      "--auth", "none",
      "--force",
      "--allow-unconfigured",
    ], { ignoreExitCode: true, shell: true });

    try {
      await waitForPort(Number(port), 30000);
      console.log(`[startup] OpenClaw Gateway 已就绪 (ws://127.0.0.1:${port})`);
    } catch {
      console.error("[startup] OpenClaw Gateway 启动超时，继续启动服务...");
    }
  }

  // 2. 启动 Node 服务
  spawnProcess("node", ["--max-old-space-size=512", "dist/index.js"], { cwd: serverDir });

  process.once("SIGINT", killAll);
  process.once("SIGTERM", killAll);
}

main().catch((err) => {
  console.error("[startup] 启动失败:", err.message);
  process.exit(1);
});
