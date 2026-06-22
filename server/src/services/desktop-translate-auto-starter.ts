import { spawn, type ChildProcessByStdio } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Readable } from "node:stream";

function parseBooleanEnv(raw: string | undefined): boolean {
  if (!raw) return false;
  const v = raw.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

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
  const rel = defaultPackageRoot();
  return rel;
}

function defaultPythonExe(packageRoot: string): string {
  if (process.platform === "win32") {
    return join(packageRoot, ".venv", "Scripts", "python.exe");
  }
  return join(packageRoot, ".venv", "bin", "python");
}

export function getDesktopTranslatePaths(env: NodeJS.ProcessEnv = process.env): {
  pythonExe: string;
  packageRoot: string;
} {
  const packageRoot = resolvePackageRoot(env);
  const fromEnv = envStr(env, "DESKTOP_TRANSLATE_PYTHON");
  return {
    pythonExe: fromEnv || defaultPythonExe(packageRoot) || "python",
    packageRoot,
  };
}

/** 默认随 server 启动桌面翻译托盘；设 DESKTOP_TRANSLATE_AUTO_START=0 可关闭。 */
export function shouldAutoStartDesktopTranslate(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const raw = env.DESKTOP_TRANSLATE_AUTO_START?.trim().toLowerCase();
  if (raw === "0" || raw === "false" || raw === "no" || raw === "off") return false;
  // 默认开启
  if (raw === "1" || raw === "true" || raw === "yes" || raw === "on") return true;
  return true;
}

export type DesktopTranslateAutoStarterOptions = {
  env?: NodeJS.ProcessEnv;
  log?: (line: string) => void;
};

/**
 * 在本机 spawn Python `translate_tray` 模块，托盘 + 全局热键。
 * 与 desktop-visual 完全解耦——只依赖 desktop-translate/ 子包。
 */
export function startDesktopTranslateTray(
  opts: DesktopTranslateAutoStarterOptions = {},
): () => void {
  const env = opts.env ?? process.env;
  if (!shouldAutoStartDesktopTranslate(env)) {
    return () => {};
  }

  const log = opts.log ?? ((line: string) => console.log(line));
  const { pythonExe, packageRoot } = getDesktopTranslatePaths(env);
  if (!existsSync(join(packageRoot, "translate_tray"))) {
    log(`[desktop-translate] 跳过自启动：未找到 ${packageRoot}`);
    return () => {};
  }
  if (!existsSync(pythonExe)) {
    log(
      `[desktop-translate] 跳过自启动：未找到 ${pythonExe}，请先运行 desktop-translate\\install-deps.ps1 创建虚拟环境`,
    );
    return () => {};
  }

  const baseUrl =
    envStr(env, "PRIVATE_AI_AGENT_BASE_URL") || "http://127.0.0.1:8787";

  let stopped = false;
  let child: ChildProcessByStdio<null, Readable, Readable> | null = null;
  let restartTimer: ReturnType<typeof setTimeout> | null = null;

  const childEnv: NodeJS.ProcessEnv = {
    ...env,
    PRIVATE_AI_AGENT_BASE_URL: baseUrl,
    PYTHONUNBUFFERED: "1",
  };

  const spawnOnce = (): void => {
    if (stopped) return;
    child = spawn(pythonExe, ["-u", "-m", "translate_tray.translate_tray"], {
      cwd: packageRoot,
      env: childEnv,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    child.stdout.on("data", (buf) => {
      for (const line of buf.toString("utf8").split(/\r?\n/).filter(Boolean)) {
        log(`[desktop-translate] ${line}`);
      }
    });
    child.stderr.on("data", (buf) => {
      for (const line of buf.toString("utf8").split(/\r?\n/).filter(Boolean)) {
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
  spawnOnce();

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
