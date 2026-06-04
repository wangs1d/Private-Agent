import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type {
  DesktopVisualPort,
  DesktopVisualRunInput,
  DesktopVisualRunResult,
  DesktopVisualScreenshotInput,
  DesktopVisualScreenshotResult,
} from "./desktop-visual-port.js";
import { resolveDesktopVisualVlmConfig } from "./desktop-visual-vlm-config.js";

function parseBooleanEnv(raw: string | undefined): boolean {
  if (!raw) return false;
  const v = raw.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

function envStr(env: NodeJS.ProcessEnv, key: string, legacyKey: string, fallback = ""): string {
  return env[key]?.trim() || env[legacyKey]?.trim() || fallback;
}

function isVisualEnabled(env: NodeJS.ProcessEnv): boolean {
  return (
    parseBooleanEnv(env.DESKTOP_VISUAL_ENABLED) ||
    parseBooleanEnv(env.DESKTOP_VISUAL_AGENT_ENABLED)
  );
}

function packageDirExists(root: string): boolean {
  return (
    existsSync(join(root, "desktop_visual")) ||
    existsSync(join(root, "desktop_visual_agent"))
  );
}

function defaultPackageRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "..", "..", "..", "desktop-visual");
}

function resolvePackageRoot(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = envStr(env, "DESKTOP_VISUAL_ROOT", "DESKTOP_VISUAL_AGENT_ROOT");
  if (fromEnv && packageDirExists(fromEnv)) {
    return fromEnv;
  }
  const rel = defaultPackageRoot();
  if (packageDirExists(rel)) {
    return rel;
  }
  return rel;
}

/** 供桥接自启动与子进程共用 Python 路径与包根目录。 */
export function getDesktopVisualPaths(env: NodeJS.ProcessEnv = process.env): {
  pythonExe: string;
  packageRoot: string;
} {
  return {
    pythonExe: envStr(env, "DESKTOP_VISUAL_PYTHON", "DESKTOP_VISUAL_AGENT_PYTHON", "python"),
    packageRoot: resolvePackageRoot(env),
  };
}

type StdioWorkerResult = { ok: boolean; error?: string; [key: string]: unknown };

function parseLastJsonLine(stdout: string): StdioWorkerResult | null {
  const line = stdout.trim().split(/\r?\n/).filter(Boolean).at(-1) ?? "";
  if (!line.startsWith("{")) return null;
  try {
    return JSON.parse(line) as StdioWorkerResult;
  } catch {
    return null;
  }
}

function spawnStdioWorker(payload: Record<string, unknown>, pythonExe: string, packageRoot: string) {
  return spawn(pythonExe, ["-u", "-m", "desktop_visual.stdio_worker"], {
    cwd: packageRoot,
    env: { ...process.env, PYTHONUNBUFFERED: "1" },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
}

function withVlmPayload(payload: Record<string, unknown>): Record<string, unknown> {
  const vlm = resolveDesktopVisualVlmConfig();
  return vlm ? { ...payload, vlm } : payload;
}

async function runStdioWorker<T extends StdioWorkerResult>(
  payload: Record<string, unknown>,
  opts: { pythonExe: string; packageRoot: string; timeoutMs: number; timeoutLabel: string },
): Promise<T> {
  const child = spawnStdioWorker(withVlmPayload(payload), opts.pythonExe, opts.packageRoot);

  let stdout = "";
  let stderr = "";
  let settled = false;
  let timer: ReturnType<typeof setTimeout>;

  const exitPromise = new Promise<number>((resolve) => {
    child.once("close", (code) => resolve(code ?? 0));
  });

  const resultPromise = new Promise<T>((resolve) => {
    const finish = (result: T) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child.kill("SIGTERM");
      } catch {
        /* ignore */
      }
      resolve(result);
    };

    child.stdout.on("data", (b) => {
      stdout += b.toString("utf8");
      const parsed = parseLastJsonLine(stdout);
      if (parsed) finish(parsed as T);
    });
    child.stderr.on("data", (b) => {
      stderr += b.toString("utf8");
    });

    child.stdin.write(`${JSON.stringify(payload)}\n`);
    child.stdin.end();

    timer = setTimeout(() => {
      finish({ ok: false, error: `${opts.timeoutLabel}（>${opts.timeoutMs}ms）` } as T);
    }, opts.timeoutMs);

    void exitPromise.then((code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        resolve({ ok: false, error: stderr.trim() || `python 退出码 ${code}` } as T);
        return;
      }
      const parsed = parseLastJsonLine(stdout);
      if (parsed) {
        resolve(parsed as T);
        return;
      }
      const line = stdout.trim().split(/\r?\n/).filter(Boolean).at(-1) ?? "";
      resolve({ ok: false, error: `无法解析子进程输出：${line.slice(0, 400)}` } as T);
    });

    child.once("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: false, error: err instanceof Error ? err.message : String(err) } as T);
    });
  });

  return resultPromise;
}

export class SubprocessDesktopVisual implements DesktopVisualPort {
  private readonly enabled: boolean;
  private readonly pythonExe: string;
  private readonly packageRoot: string;
  private readonly timeoutMs: number;

  constructor(env: NodeJS.ProcessEnv = process.env) {
    this.enabled = isVisualEnabled(env);
    const paths = getDesktopVisualPaths(env);
    this.pythonExe = paths.pythonExe;
    this.packageRoot = paths.packageRoot;
    const t = Number.parseInt(
      envStr(env, "DESKTOP_VISUAL_TIMEOUT_MS", "DESKTOP_VISUAL_AGENT_TIMEOUT_MS"),
      10,
    );
    this.timeoutMs = Number.isFinite(t) && t > 0 ? t : 600_000;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  async runTask(input: DesktopVisualRunInput): Promise<DesktopVisualRunResult> {
    if (!this.enabled) {
      return { ok: false, error: "桌面纯视觉未启用（DESKTOP_VISUAL_ENABLED）" };
    }
    return runStdioWorker<DesktopVisualRunResult>(
      {
        action: "run_task",
        task: input.task,
        maxSteps: input.maxSteps ?? 40,
        region: input.region ?? null,
        stub: Boolean(input.stub),
      },
      {
        pythonExe: this.pythonExe,
        packageRoot: this.packageRoot,
        timeoutMs: this.timeoutMs,
        timeoutLabel: "子进程超时",
      },
    );
  }

  async screenshot(input?: DesktopVisualScreenshotInput): Promise<DesktopVisualScreenshotResult> {
    if (!this.enabled) {
      return { ok: false, error: "桌面纯视觉未启用（DESKTOP_VISUAL_ENABLED）" };
    }

    return runStdioWorker<DesktopVisualScreenshotResult>(
      {
        action: "screenshot",
        region: input?.region ?? null,
      },
      {
        pythonExe: this.pythonExe,
        packageRoot: this.packageRoot,
        timeoutMs: Math.min(30_000, this.timeoutMs),
        timeoutLabel: "截图超时",
      },
    );
  }
}

/** 单例式工厂：按当前进程环境构造子进程桥接实现。 */
export function createDesktopVisualFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): DesktopVisualPort {
  return new SubprocessDesktopVisual(env);
}
