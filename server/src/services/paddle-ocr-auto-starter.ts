/**
 * PaddleOCR HTTP 服务自启器。
 *
 * 行为：
 *  - 在本机 spawn `python -m desktop_visual.paddle_ocr_server --host ... --port ...`
 *  - 端口默认 8765，可由 PADDLE_OCR_PORT 覆盖
 *  - 若 venv 不存在或缺 paddleocr 依赖，自动跑 install-deps.ps1
 *  - 进程退出时 5s 后自动重连
 *  - 设 PADDLE_OCR_AUTO_START=0 可关闭
 */
import { spawn, type ChildProcess, type ChildProcessByStdio } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Readable } from "node:stream";

function envStr(env: NodeJS.ProcessEnv, key: string, fallback = ""): string {
  return env[key]?.trim() || fallback;
}

function envInt(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = env[key]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) return fallback;
  return n;
}

function defaultPackageRoot(): string {
  // server/src/services/this-file.ts → ../../.. → repo root
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "..", "..", "..", "desktop-visual");
}

function resolvePackageRoot(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = envStr(env, "PADDLE_OCR_ROOT");
  if (fromEnv && existsSync(join(fromEnv, "desktop_visual", "paddle_ocr_server.py"))) {
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

export function getPaddleOcrPaths(env: NodeJS.ProcessEnv = process.env): {
  pythonExe: string;
  packageRoot: string;
  installScript: string;
} {
  const packageRoot = resolvePackageRoot(env);
  const fromEnv = envStr(env, "PADDLE_OCR_PYTHON");
  return {
    pythonExe: fromEnv || defaultPythonExe(packageRoot) || "python",
    packageRoot,
    installScript: envStr(env, "PADDLE_OCR_INSTALL_SCRIPT") || defaultInstallScript(packageRoot),
  };
}

export function shouldAutoStartPaddleOcr(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.PADDLE_OCR_AUTO_START?.trim().toLowerCase();
  if (raw === "0" || raw === "false" || raw === "no" || raw === "off") return false;
  return true;
}

export type PaddleOcrAutoStarterOptions = {
  env?: NodeJS.ProcessEnv;
  log?: (line: string) => void;
  autoInstallDeps?: boolean;
  autoInstallTimeoutMs?: number;
};

function runInstallDepsAsync(
  installScript: string,
  log: (line: string) => void,
  timeoutMs: number,
): Promise<boolean> {
  return new Promise((resolve) => {
    if (!existsSync(installScript)) {
      log(`[paddle-ocr] 未找到安装脚本 ${installScript}`);
      resolve(false);
      return;
    }
    const ps = findPowershellExe();
    log(
      `[paddle-ocr] 自动创建 venv 并安装依赖（powershell ${installScript}，最长 ${Math.round(timeoutMs / 1000)}s）`,
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
      resolve(ok);
      if (!ok && msg) log(`[paddle-ocr][install] 失败：${msg}`);
    };
    child.stdout.on("data", (buf) => {
      for (const line of buf.toString("utf8").split(/\r?\n/).filter(Boolean)) {
        log(`[paddle-ocr][install] ${line}`);
      }
    });
    child.stderr.on("data", (buf) => {
      for (const line of buf.toString("utf8").split(/\r?\n/).filter(Boolean)) {
        log(`[paddle-ocr][install] ${line}`);
      }
    });
    child.on("error", (err) => finish(false, err instanceof Error ? err.message : String(err)));
    child.on("close", (code) => finish(code === 0, `code=${code ?? "?"}`));
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

function probeDepsAsync(pythonExe: string): Promise<boolean> {
  return new Promise((resolve) => {
    // paddlepaddle 3.x 包名已重命名为 `paddle`；`paddlex` 才是 paddleocr 3.x 的入口
    const probe = spawn(
      pythonExe,
      [
        "-c",
        "from importlib import util; mods=['fastapi','uvicorn','paddleocr','paddle','paddlex']; import sys; sys.exit(0 if all(util.find_spec(m) for m in mods) else 1)",
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
    const ok = await probeDepsAsync(pythonExe);
    if (ok) return { ok: true };
    if (!autoInstallDeps) {
      return { ok: false, error: "依赖未安装（paddleocr/paddlepaddle/fastapi/uvicorn）" };
    }
    log(`[paddle-ocr] 关键依赖缺失，跑 install-deps.ps1`);
  } else {
    if (!autoInstallDeps) {
      return { ok: false, error: `未找到 ${pythonExe}，且已禁用自动安装依赖` };
    }
    log(`[paddle-ocr] 未找到 ${pythonExe}，开始自动创建 venv 并装依赖`);
  }
  const ok = await runInstallDepsAsync(installScript, log, autoInstallTimeoutMs);
  if (!ok) return { ok: false, error: "install-deps.ps1 失败" };
  if (!existsSync(pythonExe)) {
    return { ok: false, error: `安装脚本完成但仍未找到 ${pythonExe}` };
  }
  const ok2 = await probeDepsAsync(pythonExe);
  if (!ok2) return { ok: false, error: "安装后仍缺关键依赖" };
  return { ok: true };
}

export function startPaddleOcrServer(
  opts: PaddleOcrAutoStarterOptions = {},
): () => void {
  const env = opts.env ?? process.env;
  if (!shouldAutoStartPaddleOcr(env)) {
    return () => {};
  }

  const log = opts.log ?? ((line: string) => console.log(line));
  const autoInstallDeps = opts.autoInstallDeps !== false;
  const autoInstallTimeoutMs = opts.autoInstallTimeoutMs ?? 900_000; // 15min，paddlepaddle 很大
  const { pythonExe, packageRoot, installScript } = getPaddleOcrPaths(env);

  const host = envStr(env, "PADDLE_OCR_HOST", "127.0.0.1");
  const port = envInt(env, "PADDLE_OCR_PORT", 8765);

  if (!existsSync(join(packageRoot, "desktop_visual", "paddle_ocr_server.py"))) {
    log(`[paddle-ocr] 跳过自启动：未找到 ${packageRoot}/desktop_visual/paddle_ocr_server.py`);
    return () => {};
  }

  let stopped = false;
  let child: ChildProcessByStdio<null, Readable, Readable> | null = null;
  let restartTimer: ReturnType<typeof setTimeout> | null = null;
  let installing = false;

  const childEnv: NodeJS.ProcessEnv = {
    ...env,
    PADDLE_OCR_HOST: host,
    PADDLE_OCR_PORT: String(port),
    // 把所有 Paddle/pip 缓存目录透传给子进程,严禁再写 C 盘
    PADDLE_OCR_MODEL_DIR: envStr(env, "PADDLE_OCR_MODEL_DIR", "D:\\paddle\\paddleocr"),
    PPOCR_HOME: envStr(env, "PADDLE_OCR_MODEL_DIR", "D:\\paddle\\paddleocr"),
    PADDLE_PDX_CACHE_HOME: envStr(env, "PADDLE_PDX_CACHE_HOME", "D:\\paddle\\paddlex"),
    PIP_CACHE_DIR: envStr(env, "PIP_CACHE_DIR", "D:\\paddle\\pip"),
    HF_HOME: envStr(env, "HF_HOME", "D:\\paddle\\hf"),
    HUGGINGFACE_HUB_CACHE: envStr(
      env,
      "HUGGINGFACE_HUB_CACHE",
      "D:\\paddle\\hf\\hub",
    ),
    // Paddle inference 临时文件走 D 盘
    TEMP: envStr(env, "PADDLE_TMP_DIR", "D:\\paddle\\tmp"),
    TMP: envStr(env, "PADDLE_TMP_DIR", "D:\\paddle\\tmp"),
    TMPDIR: envStr(env, "PADDLE_TMP_DIR", "D:\\paddle\\tmp"),
    PYTHONUNBUFFERED: "1",
  };

  const spawnOnce = (): void => {
    if (stopped || installing) return;
    log(`[paddle-ocr] spawn: ${pythonExe} -m desktop_visual.paddle_ocr_server --host ${host} --port ${port}`);
    child = spawn(
      pythonExe,
      ["-u", "-m", "desktop_visual.paddle_ocr_server", "--host", host, "--port", String(port)],
      { cwd: packageRoot, env: childEnv, stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
    );

    let moduleMissing = false;
    child.stdout.on("data", (buf) => {
      for (const line of buf.toString("utf8").split(/\r?\n/).filter(Boolean)) {
        log(`[paddle-ocr] ${line}`);
      }
    });
    child.stderr.on("data", (buf) => {
      const text = buf.toString("utf8");
      if (/ModuleNotFoundError|ImportError|No module named/.test(text)) {
        moduleMissing = true;
      }
      for (const line of text.split(/\r?\n/).filter(Boolean)) {
        log(`[paddle-ocr] ${line}`);
      }
    });

    child.on("error", (err) => {
      log(`[paddle-ocr] 进程错误: ${err instanceof Error ? err.message : String(err)}`);
      scheduleRestart(5_000);
    });

    child.on("close", (code) => {
      child = null;
      if (stopped) return;
      if (moduleMissing && autoInstallDeps) {
        log(`[paddle-ocr] 检测到依赖缺失，重新跑 install-deps.ps1 后重启`);
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
      log(`[paddle-ocr] 进程退出 code=${code ?? "?"}，5s 后重连…`);
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
    `[paddle-ocr] 随 server 自启动 → ${host}:${port}  python=${pythonExe}（PADDLE_OCR_AUTO_START=0 可关闭）`,
  );

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
          `[paddle-ocr] 跳过自启动：${r.error ?? "依赖环境未就绪"}（可手动运行根目录 start-paddle-ocr.ps1）`,
        );
        return;
      }
      spawnOnce();
    } catch (e) {
      installing = false;
      log(`[paddle-ocr] 环境准备异常: ${e instanceof Error ? e.message : String(e)}`);
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
