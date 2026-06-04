/**
 * 启动本地三服务；端口已占用则跳过（绑定探测，启动前再检一次）。
 */
import { spawn, execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { isTcpPortInUse } from "./port-in-use.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const isWin = process.platform === "win32";

// Set console codepage to UTF-8 on Windows to avoid garbled Chinese output.
if (isWin) {
  try { execSync("chcp 65001", { stdio: "ignore" }); } catch {}
}

/** server 最后启动，减少与其它进程抢 3000 的竞态 */
const SERVICES = [
  { name: "world", port: 3333, npmScript: "dev:all:world" },
  { name: "social", port: 3001, npmScript: "dev:all:social" },
  { name: "server", port: 3000, npmScript: "dev:all:server" },
];

function spawnNpm(args, opts = {}) {
  return spawn("npm", args, {
    cwd: root,
    stdio: "inherit",
    shell: isWin,
    ...opts,
  });
}

function runAndWait(childFactory) {
  return new Promise((resolve, reject) => {
    const child = childFactory();
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`process exited with ${code}`));
    });
    child.on("error", reject);
  });
}

async function filterAvailable(services) {
  const available = [];
  for (const svc of services) {
    if (!(await isTcpPortInUse(svc.port))) available.push(svc);
  }
  return available;
}

let toStart = await filterAvailable(SERVICES);

if (toStart.length === 0) {
  process.exit(0);
}

await runAndWait(() => spawnNpm(["run", "build", "-w", "@private-ai-agent/agent-world"]));

toStart = await filterAvailable(toStart);

if (toStart.length === 0) {
  process.exit(0);
}

const children = [];
for (const svc of toStart) {
  if (await isTcpPortInUse(svc.port)) continue;
  children.push(spawnNpm(["run", svc.npmScript]));
}

if (children.length === 0) {
  process.exit(0);
}

let shuttingDown = false;

function shutdown(exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    if (!child.killed) child.kill("SIGTERM");
  }
  setTimeout(() => {
    for (const child of children) {
      if (!child.killed) child.kill("SIGKILL");
    }
    process.exit(exitCode);
  }, 1500).unref();
}

for (const child of children) {
  child.on("exit", (code) => {
    if (shuttingDown) return;
    if (code !== 0 && code !== null) shutdown(code ?? 1);
  });
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

await new Promise(() => {});
