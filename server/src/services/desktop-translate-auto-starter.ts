import { spawn, type ChildProcess, type ChildProcessByStdio } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Readable } from "node:stream";

function envStr(env: NodeJS.ProcessEnv, key: string, fallback = ""): string {
  return env[key]?.trim() || fallback;
}

function defaultPackageRoot(): string {
  // server/src/services/this-file.ts → ../../.. → repo root
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "..", "..", "..", "desktop-translate");
}

function resolvePackageRoot(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = envStr(env, "DESKTOP_TRANSLATE_ROOT");
  if (fromEnv && existsSync(join(fromEnv, "translate_tray"))) {
    return fromEnv;
  }
  return defaultPackageRoot();
}

function defaultPythonExe(packageRoot: string): string {
  if (process.platform === "win32") {
    return join(packageRoot, ".venv", "Scripts", "python.exe");
  }
  return join(packageRoot, ".venv", "bin", "python");
}

function defaultInstallScript(packageRoot: string): string {
  return join(packageRoot, "install-deps.ps1");
}

function findPowershellExe(): string {
  if (process.platform !== "win32") return "sh";
  const candidates = [
    "pwsh.exe",
    "powershell.exe",
    join(process.env.WINDIR ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
  ];
  for (const c of candidates) {
    if (c.includes("\\") && existsSync(c)) return c;
  }
  return "powershell.exe";
}

export function getDesktopTranslatePaths(env: NodeJS.ProcessEnv = process.env): {
  pythonExe: string;
  packageRoot: string;
  installScript: string;
} {
  const packageRoot = resolvePackageRoot(env);
  const fromEnv = envStr(env, "DESKTOP_TRANSLATE_PYTHON");
  return {
    pythonExe: fromEnv || defaultPythonExe(packageRoot) || "python",
    packageRoot,
    installScript: envStr(env, "DESKTOP_TRANSLATE_INSTALL_SCRIPT") || defaultInstallScript(packageRoot),
  };
}

/** 默认随 server 启动桌面翻译托盘；设 DESKTOP_TRANSLATE_AUTO_START=0 可关闭。 */
export function shouldAutoStartDesktopTranslate(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const raw = env.DESKTOP_TRANSLATE_AUTO_START?.trim().toLowerCase();
  if (raw === "0" || raw === "false" || raw === "no" || raw === "off") return false;
  return true;
}

export type DesktopTranslateAutoStarterOptions = {
  env?: NodeJS.ProcessEnv;
  log?: (line: string) => void;
  /** 是否允许在没有 venv / 缺依赖的情况下自动跑 install-deps.ps1。默认 true。 */
  autoInstallDeps?: boolean;
  /** 自动装依赖时的最大等待时间（毫秒）。默认 300_000（5 分钟）。 */
  autoInstallTimeoutMs?: number;
};

/** 异步跑 install-deps.ps1，成功返回 true。 */
function runInstallDepsAsync(
  installScript: string,
  log: (line: string) => void,
  timeoutMs: number,
): Promise<boolean> {
  return new Promise((resolve) => {
    if (!existsSync(installScript)) {
      log(`[desktop-translate] 未找到安装脚本 ${installScript}`);
      resolve(false);
      return;
    }
    const ps = findPowershellExe();
    log(
      `[desktop-translate] 自动创建 venv 并安装依赖（powershell ${installScript}，最长 ${Math.round(timeoutMs / 1000)}s）`,
    );
    const child: ChildProcess = spawn(
      ps,
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", installScript],
      { stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
    );
    let settled = false;
    const finish = (ok: boolean, msg?: string): void => {
      if (settled) return;
      settled = true;
      if (ok) log(`[desktop-translate] 依赖安装完成`);
      else log(`[desktop-translate] 依赖安装失败${msg ? ": " + msg : ""}`);
      resolve(ok);
    };
    child.stdout?.on("data", (buf) => {
      for (const line of buf.toString("utf8").split(/\r?\n/).filter(Boolean)) {
        log(`[desktop-translate][install] ${line}`);
      }
    });
    child.stderr?.on("data", (buf) => {
      for (const line of buf.toString("utf8").split(/\r?\n/).filter(Boolean)) {
        log(`[desktop-translate][install] ${line}`);
      }
    });
    child.on("error", (err) => {
      finish(false, err instanceof Error ? err.message : String(err));
    });
    child.on("close", (code) => {
      finish(code === 0, `code=${code ?? "?"}`);
    });
    setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* ignore */
      }
      finish(false, "安装超时");
    }, timeoutMs);
  });
}

/** 用 venv Python 探一下关键依赖是否就绪。 */
function probeDepsAsync(pythonExe: string, log: (line: string) => void): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = spawn(
      pythonExe,
      [
        "-c",
        "import importlib,sys;sys.exit(0 if all(importlib.util.find_spec(m) for m in ['pystray','pynput','PIL','httpx']) else 1)",
      ],
      { stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
    );
    let settled = false;
    const finish = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      resolve(ok);
    };
    probe.on("error", () => finish(false));
    probe.on("close", (c) => finish(c === 0));
    setTimeout(() => {
      try {
        probe.kill();
      } catch {
        /* ignore */
      }
      finish(false);
    }, 30_000);
  });
}

/**
 * 异步确保 venv 存在且依赖已就绪。
 *  - 若 .venv 不存在：跑 install-deps.ps1
 *  - 若 venv 存在但 pystray 等关键依赖缺失：跑 install-deps.ps1
 */
async function ensureEnvironment(
  pythonExe: string,
  installScript: string,
  opts: {
    autoInstallDeps: boolean;
    autoInstallTimeoutMs: number;
    log: (line: string) => void;
  },
): Promise<{ ok: boolean; error?: string }> {
  const { autoInstallDeps, autoInstallTimeoutMs, log } = opts;
  if (existsSync(pythonExe)) {
    const ok = await probeDepsAsync(pythonExe, log);
    if (ok) return { ok: true };
    if (!autoInstallDeps) {
      return { ok: false, error: "依赖未安装（pystray/pynput/PIL/httpx）" };
    }
    log(`[desktop-translate] 关键依赖缺失，跑 install-deps.ps1`);
  } else {
    if (!autoInstallDeps) {
      return { ok: false, error: `未找到 ${pythonExe}，且已禁用自动安装依赖` };
    }
    log(`[desktop-translate] 未找到 ${pythonExe}，开始自动创建 venv 并装依赖`);
  }
  const ok = await runInstallDepsAsync(installScript, log, autoInstallTimeoutMs);
  if (!ok) return { ok: false, error: "install-deps.ps1 失败" };
  if (!existsSync(pythonExe)) {
    return { ok: false, error: `安装脚本完成但仍未找到 ${pythonExe}` };
  }
  return { ok: true };
}

/**
 * 在本机 spawn Python `translate_tray` 模块，托盘 + 全局热键。
 * 与 desktop-visual 完全解耦——只依赖 desktop-translate/ 子包。
 *
 * 行为：
 *  - 若 <packageRoot>/.venv 不存在且 autoInstallDeps=true，自动跑 install-deps.ps1
 *  - 若 venv 存在但依赖缺失（pystray/pynput 等），同样会自动重装
 *  - 启动期不阻塞 server：先注册一个延后 spawn，等 venv/依赖就绪后再启动托盘
 *  - 进程异常退出时，5s 后自动重连
 *  - 设 DESKTOP_TRANSLATE_AUTO_START=0 可关闭
 */
export function startDesktopTranslateTray(
  opts: DesktopTranslateAutoStarterOptions = {},
): () => void {
  const env = opts.env ?? process.env;
  if (!shouldAutoStartDesktopTranslate(env)) {
    return () => {};
  }

  const log = opts.log ?? ((line: string) => console.log(line));
  const autoInstallDeps = opts.autoInstallDeps !== false;
  const autoInstallTimeoutMs = opts.autoInstallTimeoutMs ?? 300_000;
  const { pythonExe, packageRoot, installScript } = getDesktopTranslatePaths(env);

  if (!existsSync(join(packageRoot, "translate_tray"))) {
    log(`[desktop-translate] 跳过自启动：未找到 ${packageRoot}`);
    return () => {};
  }

  const baseUrl =
    envStr(env, "PRIVATE_AI_AGENT_BASE_URL") || "http://127.0.0.1:8787";

  let stopped = false;
  let child: ChildProcessByStdio<null, Readable, Readable> | null = null;
  let restartTimer: ReturnType<typeof setTimeout> | null = null;
  let installing = false;

  const childEnv: NodeJS.ProcessEnv = {
    ...env,
    PRIVATE_AI_AGENT_BASE_URL: baseUrl,
    PYTHONUNBUFFERED: "1",
  };

  const spawnOnce = (): void => {
    if (stopped || installing) return;
    log(`[desktop-translate] spawn 托盘: ${pythonExe} -m translate_tray.translate_tray`);
    child = spawn(pythonExe, ["-u", "-m", "translate_tray.translate_tray"], {
      cwd: packageRoot,
      env: childEnv,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    let moduleMissing = false;
    child.stdout.on("data", (buf) => {
      for (const line of buf.toString("utf8").split(/\r?\n/).filter(Boolean)) {
        log(`[desktop-translate] ${line}`);
      }
    });
    child.stderr.on("data", (buf) => {
      const text = buf.toString("utf8");
      if (/ModuleNotFoundError|ImportError|No module named/.test(text)) {
        moduleMissing = true;
      }
      for (const line of text.split(/\r?\n/).filter(Boolean)) {
        log(`[desktop-translate] ${line}`);
      }
    });

    child.on("error", (err) => {
      log(`[desktop-translate] 进程错误: ${err instanceof Error ? err.message : String(err)}`);
      scheduleRestart(5_000);
    });

    child.on("close", (code) => {
      child = null;
      if (stopped) return;
      if (moduleMissing && autoInstallDeps) {
        log(`[desktop-translate] 检测到依赖缺失，重新跑 install-deps.ps1 后重启`);
        void (async () => {
          installing = true;
          try {
            const r = await runInstallDepsAsync(installScript, log, autoInstallTimeoutMs);
            installing = false;
            if (r) {
              scheduleRestart(2_000);
              return;
            }
          } catch {
            installing = false;
          }
          scheduleRestart(5_000);
        })();
        return;
      }
      log(`[desktop-translate] 进程退出 code=${code ?? "?"}，5s 后重连…`);
      scheduleRestart(5_000);
    });
  };

  const scheduleRestart = (delayMs: number): void => {
    if (stopped || restartTimer) return;
    restartTimer = setTimeout(() => {
      restartTimer = null;
      spawnOnce();
    }, delayMs);
  };

  log(
    `[desktop-translate] 随 server 自启动 → base=${baseUrl}  python=${pythonExe}（DESKTOP_TRANSLATE_AUTO_START=0 可关闭）`,
  );

  // 异步准备环境，不阻塞 server 启动
  void (async () => {
    try {
      installing = true;
      const r = await ensureEnvironment(pythonExe, installScript, {
        autoInstallDeps,
        autoInstallTimeoutMs,
        log,
      });
      installing = false;
      if (stopped) return;
      if (!r.ok) {
        log(
          `[desktop-translate] 跳过自启动：${r.error ?? "依赖环境未就绪"}（可手动运行根目录 start-translate.ps1）`,
        );
        return;
      }
      spawnOnce();
    } catch (e) {
      installing = false;
      log(
        `[desktop-translate] 环境准备异常: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  })();

  return () => {
    stopped = true;
    if (restartTimer) {
      clearTimeout(restartTimer);
      restartTimer = null;
    }
    if (child) {
      try {
        child.kill("SIGTERM");
      } catch {
        /* ignore */
      }
      child = null;
    }
  };
}
