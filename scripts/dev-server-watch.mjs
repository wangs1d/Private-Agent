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

// `node dev-server-watch.mjs runtime` → remote 拓扑：runtime watch（内部端口）
// + gateway watch（对外端口）；缺省参数 → embedded 单进程（src/index.ts）
const entryArg = process.argv[2] ?? "";
const isRemoteEntry = entryArg === "runtime";
const entry = isRemoteEntry ? "src/runtime-main.ts" : "src/index.ts";

config({ path: join(serverDir, ".env"), quiet: true });
config({ path: join(serverDir, ".env.local"), quiet: true });

const portRaw = Number(process.env.PORT ?? "3000");
const port = Number.isInteger(portRaw) && portRaw > 0 && portRaw < 65536 ? portRaw : 3000;
const runtimeHttpPortRaw = Number(process.env.RUNTIME_HTTP_PORT ?? "3211");
const runtimeHttpPort =
  Number.isInteger(runtimeHttpPortRaw) && runtimeHttpPortRaw > 0 && runtimeHttpPortRaw < 65536
    ? runtimeHttpPortRaw
    : 3211;

if (await isTcpPortInUse(isRemoteEntry ? runtimeHttpPort : port)) {
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

const child = spawn("npx", ["tsx", "watch", "--clear-screen=false", entry], {
  cwd: serverDir,
  stdio: "inherit",
  shell: isWin,
  env: {
    ...process.env,
    ...(isRemoteEntry ? { RUNTIME_MODE: "remote" } : {}),
    NODE_OPTIONS: [process.env.NODE_OPTIONS, "--max-old-space-size=512"].filter(Boolean).join(" "),
    AGENT_WORLD_PLACEHOLDER_REGISTER: "1",
    ALLOW_WORLD_HTTP_MUTATIONS: "1",
    AGENT_PROMPT_WORLD_CAPS: "1",
    ENABLE_MASTER_AGENT_DELEGATION: "1",
  },
});

// remote 拓扑：runtime 之外加挂 gateway watch（对外端口 3000；被占用则跳过）
let gatewayWatchChild = null;
if (isRemoteEntry && !(await isTcpPortInUse(port))) {
  gatewayWatchChild = spawn("npx", ["tsx", "watch", "--clear-screen=false", "src/gateway-main.ts"], {
    cwd: serverDir,
    stdio: "inherit",
    shell: isWin,
    env: { ...process.env, RUNTIME_MODE: "remote" },
  });
  gatewayWatchChild.on("exit", (code) => {
    if (code !== 0 && code !== null) {
      console.error(`[dev-server] gateway watch 异常退出: code=${code}`);
    }
  });
}

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
  if (gatewayWatchChild && !gatewayWatchChild.killed) {
    try {
      gatewayWatchChild.kill("SIGTERM");
    } catch {
      /* ignore */
    }
  }
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
