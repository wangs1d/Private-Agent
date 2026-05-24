import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type {
  DesktopVisualAgentPort,
  DesktopVisualRunInput,
  DesktopVisualRunResult,
  DesktopVisualScreenshotInput,
  DesktopVisualScreenshotResult,
} from "./desktop-visual-agent-port.js";

function parseBooleanEnv(raw: string | undefined): boolean {
  if (!raw) return false;
  const v = raw.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

function defaultPackageRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "..", "..", "..", "desktop-visual-agent");
}

function resolvePackageRoot(): string {
  const fromEnv = process.env.DESKTOP_VISUAL_AGENT_ROOT?.trim();
  if (fromEnv && existsSync(join(fromEnv, "desktop_visual_agent"))) {
    return fromEnv;
  }
  const rel = defaultPackageRoot();
  if (existsSync(join(rel, "desktop_visual_agent"))) {
    return rel;
  }
  return rel;
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
  return spawn(pythonExe, ["-u", "-m", "desktop_visual_agent.stdio_worker"], {
    cwd: packageRoot,
    env: { ...process.env, PYTHONUNBUFFERED: "1" },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
}

async function runStdioWorker<T extends StdioWorkerResult>(
  payload: Record<string, unknown>,
  opts: { pythonExe: string; packageRoot: string; timeoutMs: number; timeoutLabel: string },
): Promise<T> {
  const child = spawnStdioWorker(payload, opts.pythonExe, opts.packageRoot);

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

export class SubprocessDesktopVisualAgent implements DesktopVisualAgentPort {
  private readonly enabled: boolean;
  private readonly pythonExe: string;
  private readonly packageRoot: string;
  private readonly timeoutMs: number;

  constructor(env: NodeJS.ProcessEnv = process.env) {
    this.enabled = parseBooleanEnv(env.DESKTOP_VISUAL_AGENT_ENABLED);
    this.pythonExe = env.DESKTOP_VISUAL_AGENT_PYTHON?.trim() || "python";
    this.packageRoot = resolvePackageRoot();
    const t = Number.parseInt(env.DESKTOP_VISUAL_AGENT_TIMEOUT_MS ?? "", 10);
    this.timeoutMs = Number.isFinite(t) && t > 0 ? t : 600_000;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  async runTask(input: DesktopVisualRunInput): Promise<DesktopVisualRunResult> {
    if (!this.enabled) {
      return { ok: false, error: "desktop visual agent 未启用（DESKTOP_VISUAL_AGENT_ENABLED）" };
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
      return { ok: false, error: "desktop visual agent 未启用（DESKTOP_VISUAL_AGENT_ENABLED）" };
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
export function createDesktopVisualAgentFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): DesktopVisualAgentPort {
  return new SubprocessDesktopVisualAgent(env);
}
