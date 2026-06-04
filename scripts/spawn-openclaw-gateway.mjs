/**
 * 开发环境启动 OpenClaw Gateway（与 server/scripts/start-with-gateway.mjs 参数一致）。
 * 读取 server/.env 与 server/.env.local。
 */
import { spawn } from "node:child_process";
import { config as dotenvConfig } from "dotenv";
import net from "node:net";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const serverDir = join(dirname(fileURLToPath(import.meta.url)), "..", "server");

dotenvConfig({ path: join(serverDir, ".env") });
dotenvConfig({ path: join(serverDir, ".env.local"), override: true });

function isEnabled() {
  const v = (process.env.WECHAT_CLAW_ENABLED ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

export async function waitForPort(port, timeoutMs = 30_000) {
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
      return true;
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  return false;
}

/**
 * @returns {import('node:child_process').ChildProcess | null}
 */
function resolveOpenClawEntrypoint() {
  const candidates = [];
  if (process.env.APPDATA) {
    candidates.push(
      join(process.env.APPDATA, "npm", "node_modules", "openclaw", "openclaw.mjs"),
    );
  }
  if (process.env.OPENCLAW_HOME) {
    candidates.push(join(process.env.OPENCLAW_HOME, "openclaw.mjs"));
  }
  for (const path of candidates) {
    if (existsSync(path)) return path;
  }
  return null;
}

export function spawnOpenClawGateway() {
  if (!isEnabled()) return null;

  const port = Number(process.env.OPENCLAW_GATEWAY_WS_URL?.match(/:(\d+)/)?.[1] ?? "18789");
  const openclawMjs = resolveOpenClawEntrypoint();
  const gatewayArgs = [
    "gateway",
    "run",
    "--port",
    String(port),
    "--auth",
    "none",
    "--force",
    "--allow-unconfigured",
  ];

  console.log(`[openclaw] 启动 Gateway ws://127.0.0.1:${port} (--auth none)`);

  const env = { ...process.env };
  const npmPrefix = env.APPDATA ? `${env.APPDATA}\\npm` : "";
  if (npmPrefix && !env.PATH?.toLowerCase().includes(npmPrefix.toLowerCase())) {
    env.PATH = `${npmPrefix};${env.PATH ?? ""}`;
  }

  const child = openclawMjs
    ? spawn(process.execPath, [openclawMjs, ...gatewayArgs], {
        stdio: "inherit",
        windowsHide: true,
        shell: false,
        detached: false,
        env,
      })
    : spawn(resolveOpenClawCommand(), gatewayArgs, {
        stdio: "inherit",
        windowsHide: true,
        shell: false,
        detached: false,
        env,
      });

  child.on("error", (err) => {
    console.error(
      "[openclaw] 无法启动 Gateway（请先执行: npm run setup:openclaw）",
      err.message,
    );
  });

  return child;
}

function resolveOpenClawCommand() {
  if (process.platform === "win32") {
    const npmOpenclaw = process.env.APPDATA
      ? join(process.env.APPDATA, "npm", "openclaw.cmd")
      : "";
    if (npmOpenclaw) return npmOpenclaw;
    return "openclaw.cmd";
  }
  return "openclaw";
}

export function readGatewayPort() {
  return Number(process.env.OPENCLAW_GATEWAY_WS_URL?.match(/:(\d+)/)?.[1] ?? "18789");
}
