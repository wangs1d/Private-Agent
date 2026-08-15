/**
 * 启动 server 开发 watch；端口已占用则直接退出（不进入 node --watch 空等）。
 */
import { spawn } from "node:child_process";
import { config } from "dotenv";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isTcpPortInUse } from "./port-in-use.mjs";
import { spawnToolRouter } from "./spawn-tool-router.mjs";
import {
  readGatewayPort,
  spawnOpenClawGateway,
  waitForPort,
} from "./spawn-openclaw-gateway.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const serverDir = join(root, "server");
const isWin = process.platform === "win32";

config({ path: join(serverDir, ".env"), quiet: true });
config({ path: join(serverDir, ".env.local"), quiet: true });

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

// tool-router FastAPI：与 TS 服务异步并行拉起（端口占用时自动跳过）
const toolRouterChild = await spawnToolRouter();

const child = spawn("npx", ["tsx", "watch", "--clear-screen=false", "src/index.ts"], {
  cwd: serverDir,
  stdio: "inherit",
  shell: isWin,
  env: {
    ...process.env,
    NODE_OPTIONS: [process.env.NODE_OPTIONS, "--max-old-space-size=512"].filter(Boolean).join(" "),
    AGENT_WORLD_PLACEHOLDER_REGISTER: "1",
    ALLOW_WORLD_HTTP_MUTATIONS: "1",
    AGENT_PROMPT_WORLD_CAPS: "1",
    ENABLE_MASTER_AGENT_DELEGATION: "1",
  },
});

function stopGateway() {
  if (gatewayChild && !gatewayChild.killed) {
    try {
      gatewayChild.kill("SIGTERM");
    } catch {
      /* ignore */
    }
  }
}

function stopToolRouter() {
  if (toolRouterChild && !toolRouterChild.killed) {
    try {
      toolRouterChild.kill("SIGTERM");
    } catch {
      /* ignore */
    }
  }
}

function stopAll() {
  stopGateway();
  stopToolRouter();
}

child.on("error", (err) => {
  console.error("[dev-server] 子进程启动失败:", err instanceof Error ? err.message : String(err));
  stopAll();
  process.exit(1);
});

child.on("exit", (code, signal) => {
  if (signal === "SIGTERM" || signal === "SIGINT") {
    // 父进程主动关闭，正常退出
    stopAll();
    process.exit(0);
    return;
  }
  console.error(`[dev-server] 子进程异常退出: code=${code ?? "?"}, signal=${signal ?? "none"}`);
  stopAll();
  // 延迟退出，给日志时间输出
  setTimeout(() => process.exit(code ?? 1), 500).unref();
});
process.once("SIGINT", () => {
  stopAll();
  process.exit(0);
});
process.once("SIGTERM", () => {
  stopAll();
  process.exit(0);
});
