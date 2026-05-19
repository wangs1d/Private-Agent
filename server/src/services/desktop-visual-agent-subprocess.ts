import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type {
  DesktopVisualAgentPort,
  DesktopVisualRunInput,
  DesktopVisualRunResult,
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
    const payload = {
      task: input.task,
      maxSteps: input.maxSteps ?? 40,
      region: input.region ?? null,
      stub: Boolean(input.stub),
    };
    const child = spawn(this.pythonExe, ["-m", "desktop_visual_agent.stdio_worker"], {
      cwd: this.packageRoot,
      env: { ...process.env },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";
    const onData = (buf: Buffer, which: "out" | "err") => {
      const s = buf.toString("utf8");
      if (which === "out") stdout += s;
      else stderr += s;
    };
    child.stdout.on("data", (b) => onData(b, "out"));
    child.stderr.on("data", (b) => onData(b, "err"));

    const exitPromise = new Promise<number>((resolve) => {
      child.once("close", (code) => resolve(code ?? 0));
    });

    child.stdin.write(`${JSON.stringify(payload)}\n`);
    child.stdin.end();

    return await new Promise<DesktopVisualRunResult>((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try {
          child.kill("SIGTERM");
        } catch {
          /* ignore */
        }
        resolve({ ok: false, error: `子进程超时（>${this.timeoutMs}ms）` });
      }, this.timeoutMs);

      void exitPromise.then((code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (code !== 0) {
          resolve({ ok: false, error: stderr.trim() || `python 退出码 ${code}` });
          return;
        }
        const line = stdout.trim().split(/\r?\n/).filter(Boolean).at(-1) ?? "";
        try {
          resolve(JSON.parse(line) as DesktopVisualRunResult);
        } catch {
          resolve({ ok: false, error: `无法解析子进程输出：${line.slice(0, 400)}` });
        }
      });

      child.once("error", (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ ok: false, error: err instanceof Error ? err.message : String(err) });
      });
    });
  }
}

/** 单例式工厂：按当前进程环境构造子进程桥接实现。 */
export function createDesktopVisualAgentFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): DesktopVisualAgentPort {
  return new SubprocessDesktopVisualAgent(env);
}
