/**
 * 与 TS 服务一同异步并行启动 tool-router FastAPI 微服务（HTTP REST 模式）。
 *
 * 使用方式（复用方）：
 *   import { spawnToolRouter } from "./spawn-tool-router.mjs";
 *   const toolRouterChild = await spawnToolRouter();   // 未配置/端口占用时返回 null
 *   // 退出时一并 child.kill("SIGTERM")
 *
 * 行为约定：
 *   - 未配置 `TOOL_ROUTER_HTTP_URL`（TS 端走 stdio 兜底）→ 不启动，返回 null
 *   - 配置 `TOOL_ROUTER_AUTO_START=0/false/no/off` → 跳过自动拉起
 *   - 目标端口已被占用（用户已手动启动）→ 不重复拉起，返回 null
 *   - 其余情况 spawn `python -m uvicorn tool_router.main:app`（cwd=tool-router），
 *     优先使用 tool-router/.venv，缺失时回退系统 PATH 中的 python
 */
import { spawn } from "node:child_process";
import { config as dotenvConfig } from "dotenv";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isTcpPortInUse } from "./port-in-use.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const serverDir = join(root, "server");
const toolRouterDir = join(root, "tool-router");

dotenvConfig({ path: join(serverDir, ".env"), quiet: true });
dotenvConfig({ path: join(serverDir, ".env.local"), override: true, quiet: true });

/** 读取 TS 端配置的 tool-router HTTP 地址；未配置返回 null。 */
export function resolveToolRouterHttpUrl() {
  const url = (process.env.TOOL_ROUTER_HTTP_URL ?? "").trim();
  return url ? url.replace(/\/+$/, "") : null;
}

/** 从 HTTP URL 解析端口，缺省 8787。 */
export function resolveToolRouterPort() {
  const matched = resolveToolRouterHttpUrl()?.match(/:(\d+)/);
  return matched ? Number(matched[1]) : 8787;
}

/** 是否允许 npm 启动时自动拉起 FastAPI（默认允许）。 */
export function toolRouterAutoStartEnabled() {
  const value = (process.env.TOOL_ROUTER_AUTO_START ?? "").trim().toLowerCase();
  return !["0", "false", "no", "off"].includes(value);
}

function resolvePythonCommand() {
  if (process.platform === "win32") {
    const venvPython = join(toolRouterDir, ".venv", "Scripts", "python.exe");
    if (existsSync(venvPython)) return venvPython;
  }
  return "python";
}

/**
 * 异步并行启动 tool-router FastAPI。
 * @returns {Promise<import("node:child_process").ChildProcess | null>}
 */
export async function spawnToolRouter() {
  const httpUrl = resolveToolRouterHttpUrl();
  if (!httpUrl) {
    console.log("[tool-router] 未配置 TOOL_ROUTER_HTTP_URL（TS 走 stdio 兜底），跳过自动拉起");
    return null;
  }
  if (!toolRouterAutoStartEnabled()) {
    console.log("[tool-router] TOOL_ROUTER_AUTO_START 已关闭，跳过自动拉起");
    return null;
  }

  const port = resolveToolRouterPort();
  // uvicorn 绑定 127.0.0.1；ps1 手动启动绑定 0.0.0.0 时同样占用 127.0.0.1，
  // 故统一探测 127.0.0.1（用 0.0.0.0 探测会漏检仅绑定回环的既有服务）
  if (await isTcpPortInUse(port, "127.0.0.1")) {
    console.log(`[tool-router] 端口 ${port} 已被占用（可能已手动启动），跳过自动拉起`);
    return null;
  }

  const python = resolvePythonCommand();
  console.log(`[tool-router] 异步并行启动 FastAPI ${httpUrl} ...`);

  const child = spawn(
    python,
    ["-m", "uvicorn", "tool_router.main:app", "--host", "127.0.0.1", "--port", String(port)],
    {
      cwd: toolRouterDir,
      stdio: "inherit",
      windowsHide: true,
      shell: false,
      env: { ...process.env, TOOL_ROUTER_HOST: "127.0.0.1", TOOL_ROUTER_PORT: String(port) },
    },
  );

  child.on("error", (err) => {
    console.error("[tool-router] FastAPI 启动失败（HTTP 不可用时 TS 自动回退 stdio）:", err.message);
  });

  return child;
}
