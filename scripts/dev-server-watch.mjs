/**
 * 启动 server 开发 watch；端口已占用则直接退出（不进入 node --watch 空等）。
 */
import { spawn } from "node:child_process";
import { config } from "dotenv";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isTcpPortInUse } from "./port-in-use.mjs";
import {
  readGatewayPort,
  spawnOpenClawGateway,
  waitForPort,
} from "./spawn-openclaw-gateway.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const serverDir = join(root, "server");
const isWin = process.platform === "win32";

config({ path: join(serverDir, ".env") });
config({ path: join(serverDir, ".env.local") });

const portRaw = Number(process.env.PORT ?? "3000");
const port = Number.isInteger(portRaw) && portRaw > 0 && portRaw < 65536 ? portRaw : 3000;

if (await isTcpPortInUse(port)) {
  process.exit(0);
}

let gatewayChild = null;
const gatewayPort = readGatewayPort();
if (!(await isTcpPortInUse(gatewayPort))) {
  gatewayChild = spawnOpenClawGateway();
  if (gatewayChild) {
    const ready = await waitForPort(gatewayPort, 25_000);
    if (!ready) {
      console.warn(`[openclaw] Gateway 端口 ${gatewayPort} 未就绪，微信 Claw 绑定可能失败`);
    }
  }
}

const child = spawn(
  "node",
  ["--watch-path=src", "--import", "tsx", "--watch", "src/index.ts"],
  {
    cwd: serverDir,
    stdio: "inherit",
    shell: false,
    env: {
      ...process.env,
      AGENT_WORLD_PLACEHOLDER_REGISTER: "1",
      ALLOW_WORLD_HTTP_MUTATIONS: "1",
      AGENT_PROMPT_WORLD_CAPS: "1",
      ENABLE_MASTER_AGENT_DELEGATION: "1",
    },
  },
);

function stopGateway() {
  if (gatewayChild && !gatewayChild.killed) {
    try {
      gatewayChild.kill("SIGTERM");
    } catch {
      /* ignore */
    }
  }
}

child.on("exit", (code, signal) => {
  stopGateway();
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 1);
});

process.once("SIGINT", () => {
  stopGateway();
  process.exit(0);
});
process.once("SIGTERM", () => {
  stopGateway();
  process.exit(0);
});
child.on("error", () => process.exit(1));
