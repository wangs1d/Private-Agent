/**
 * FunASR 自托管 ASR HTTP 服务自启器（与 paddle-ocr-auto-starter 同模式）。
 *
 * 行为：
 *  - 在本机 spawn `python server/scripts/funasr_server.py --host ... --port ...`
 *  - 端口默认 8001，可由 FUNASR_PORT 覆盖
 *  - 进程退出时 5s 后自动重连
 *  - 设 FUNASR_AUTO_START=0 可关闭
 *  - 启动成功后自动写入 FUNASR_BASE_URL，让 voice-dialogue 的 FunAsrAdapter 立刻可用
 *
 * 与 paddle-ocr 的差异：
 *  - 不需要 venv（funasr/torch 走系统 Python 即可）
 *  - 首次启动会从 ModelScope 下载 ~1GB 模型到 ~/.cache/funasr/，无超时限制（设 30min 兜底）
 *  - 不自动跑 install 脚本（依赖装好是前置条件，缺依赖会打印提示并 5s 重连）
 */
import { spawn, execFileSync, type ChildProcessByStdio } from "node:child_process";
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

function defaultScriptPath(): string {
  // server/src/services/this-file.ts → ../../scripts/funasr_server.py
  // services → src → server，scripts 在 server/ 下
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "..", "..", "scripts", "funasr_server.py");
}

function resolvePythonExe(env: NodeJS.ProcessEnv = process.env): string | null {
  const fromEnv = envStr(env, "FUNASR_PYTHON");
  if (fromEnv) return fromEnv;
  if (process.platform !== "win32") return "python";

  // Windows 下 python.exe 可能不在 PATH，尝试常见安装路径
  const candidates = [
    "python.exe",
    "python3.exe",
    "py.exe",
    `${process.env.LOCALAPPDATA}\\Programs\\Python\\Python313\\python.exe`,
    `${process.env.LOCALAPPDATA}\\Programs\\Python\\Python312\\python.exe`,
    `${process.env.LOCALAPPDATA}\\Programs\\Python\\Python311\\python.exe`,
    `${process.env.ProgramFiles}\\Python313\\python.exe`,
    `${process.env.ProgramFiles}\\Python312\\python.exe`,
    `${process.env.ProgramFiles}\\Python311\\python.exe`,
    `${process.env.SystemRoot}\\py.exe`,
  ];
  for (const c of candidates) {
    try {
      execFileSync(c, ["--version"], { stdio: "ignore", timeout: 2000 });
      return c;
    } catch {
      // 继续尝试下一个
    }
  }
  // 未找到任何 Python：返回 null，由调用方给出友好提示（不进入 5s 重连刷屏）
  return null;
}

export function shouldAutoStartFunasr(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.FUNASR_AUTO_START?.trim().toLowerCase();
  if (raw === "0" || raw === "false" || raw === "no" || raw === "off") return false;
  return true;
}

export type FunasrAutoStarterOptions = {
  env?: NodeJS.ProcessEnv;
  log?: (line: string) => void;
};

/**
 * 启动 FunASR Python 子进程并守护。返回 stop 函数。
 *
 * 副作用：若启动成功，会回写 `process.env.FUNASR_BASE_URL`，让后续
 * `createAppServices` 中实例化的 `FunAsrAdapter.isEnabled()` 返回 true。
 */
export function startFunasrServer(
  opts: FunasrAutoStarterOptions = {},
): () => void {
  const env = opts.env ?? process.env;
  if (!shouldAutoStartFunasr(env)) {
    return () => {};
  }

  const log = opts.log ?? ((line: string) => console.log(line));
  const pythonExe = resolvePythonExe(env);
  const scriptPath = envStr(env, "FUNASR_SCRIPT_PATH") || defaultScriptPath();

  if (pythonExe === null) {
    log(
      `[funasr] 未找到 Python 解释器（PATH 及常见安装路径均无 python.exe），跳过 ASR 自启动。` +
        `安装 Python 后重启 server，或设置 FUNASR_PYTHON=/path/to/python.exe 指定解释器。`,
    );
    return () => {};
  }

  const host = envStr(env, "FUNASR_HOST", "127.0.0.1");
  const port = envInt(env, "FUNASR_PORT", 8001);

  if (!existsSync(scriptPath)) {
    log(`[funasr] 跳过自启动：未找到 ${scriptPath}`);
    return () => {};
  }

  let stopped = false;
  let child: ChildProcessByStdio<null, Readable, Readable> | null = null;
  let restartTimer: ReturnType<typeof setTimeout> | null = null;
  /** 首次启动标记：模型加载期间不重连太快，避免日志刷屏 */
  let firstStart = true;

  const childEnv: NodeJS.ProcessEnv = {
    ...env,
    PYTHONUNBUFFERED: "1",
    // 模型缓存目录默认 ~/.cache/funasr/，可由 FUNASR_MODEL_CACHE 覆盖
    FUNASR_MODEL_CACHE: envStr(env, "FUNASR_MODEL_CACHE", ""),
  };

  const spawnOnce = (): void => {
    if (stopped) return;
    log(
      `[funasr] spawn: ${pythonExe} ${scriptPath} --host ${host} --port ${port}` +
        (firstStart ? "（首次启动会从 ModelScope 下载 ~1GB 模型，请耐心等待）" : ""),
    );
    child = spawn(
      pythonExe,
      [scriptPath, "--host", host, "--port", String(port)],
      { env: childEnv, stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
    );

    let moduleMissing = false;
    child.stdout?.on("data", (buf) => {
      for (const line of buf.toString("utf8").split(/\r?\n/).filter(Boolean)) {
        log(`[funasr] ${line}`);
        // 模型加载完成的标志：Uvicorn running on ...
        if (/Uvicorn running on|Application startup complete/.test(line)) {
          firstStart = false;
          log(`[funasr] ✅ ASR 服务已就绪`);
        }
      }
    });
    child.stderr?.on("data", (buf) => {
      const text = buf.toString("utf8");
      if (/ModuleNotFoundError|ImportError|No module named/.test(text)) {
        moduleMissing = true;
      }
      for (const line of text.split(/\r?\n/).filter(Boolean)) {
        log(`[funasr] ${line}`);
      }
    });

    child.on("error", (err) => {
      log(`[funasr] 进程错误: ${err instanceof Error ? err.message : String(err)}`);
      scheduleRestart(5_000);
    });

    child.on("close", (code) => {
      child = null;
      if (stopped) return;
      if (moduleMissing) {
        log(
          `[funasr] 依赖缺失（funasr/torch/fastapi/uvicorn），请运行：pip install -r server/scripts/funasr_requirements.txt`,
        );
        // 依赖缺失不重连，避免刷屏；用户装完依赖重启 server 即可
        return;
      }
      log(`[funasr] 进程退出 code=${code ?? "?"}，5s 后重连…`);
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
    `[funasr] 随 server 自启动 → ${host}:${port}  python=${pythonExe}（FUNASR_AUTO_START=0 可关闭）`,
  );

  // 同步写入 BASE_URL：必须在 createAppServices 之前生效，让 FunAsrAdapter.isEnabled()
  // 返回 true。子进程实际 ready 需要时间（首次下模型更久），但 adapter 只是记录 URL，
  // 真正发请求时若 connection refused 会走 catch 返回空文本（与现有降级逻辑一致）。
  if (!process.env.FUNASR_BASE_URL) {
    process.env.FUNASR_BASE_URL = `http://${host}:${port}`;
  }

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
