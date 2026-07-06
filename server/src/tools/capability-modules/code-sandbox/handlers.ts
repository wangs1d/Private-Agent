import type { ToolHandler, ToolContext, ToolRegistry } from "../../tool-registry.js";
import { resolveActorId } from "../../../agent/actor-id.js";
import type { CodeSandboxService } from "../../../services/code-sandbox-service.js";

/**
 * code-sandbox 工具 handler 工厂集合 + 注册入口。
 *
 * 每个 handler 调用 {@link CodeSandboxService} 对应方法，统一返回：
 *   - 成功：`{ ok: true, ..., summary: string }`
 *   - 失败：`{ ok: false, error: string, retryable?: boolean }`
 *
 * 注册入口见本文件 {@link registerCodeSandboxTools}，由 `./index.ts` 的
 * `buildCodeSandboxModule` 在 `CapabilityModule.register` 中调用。
 *
 * Phase 2：code.run 优先走 worker 线程（故障隔离），失败时 fallback 到主进程。
 */

/** code-sandbox 模块依赖（局部类型，避免修改全局 CapabilityModuleDeps）。 */
export interface CodeSandboxModuleDeps {
  codeSandboxService: CodeSandboxService;
}

/** 是否启用 worker 线程隔离（环境变量控制，默认开启）。 */
function isWorkerEnabled(): boolean {
  const v = process.env.CODE_RUN_WORKER_ENABLED ?? "1";
  return v === "1" || v === "true" || v === "on";
}

/** code.run —— 执行 Python / Node 代码。 */
export function createCodeRunHandler(
  service: CodeSandboxService,
): ToolHandler {
  return async (input: Record<string, unknown>, context: ToolContext) => {
    const language = input.language === "node" ? "node" : "python";
    const code = typeof input.code === "string" ? input.code : "";
    if (!code) {
      return { ok: false, error: "缺少 code（要执行的源代码）" };
    }
    const workspaceId =
      typeof input.workspaceId === "string" && input.workspaceId.trim()
        ? input.workspaceId.trim()
        : undefined;
    const timeoutMs =
      typeof input.timeoutMs === "number" && Number.isFinite(input.timeoutMs)
        ? Math.floor(input.timeoutMs)
        : undefined;
    const stdin = typeof input.stdin === "string" ? input.stdin : undefined;

    const actorId = resolveActorId(context);

    // Phase 2：优先走 worker 线程（故障隔离），失败时 fallback 到主进程
    if (isWorkerEnabled()) {
      try {
        const { workerPool } = await import("../../../services/worker-pool.js");
        const result = await workerPool.submit<{
          ok: boolean;
          stdout: string;
          stderr: string;
          exitCode: number | null;
          durationMs: number;
          timedOut: boolean;
          truncated: boolean;
          workspacePath: string;
          error?: string;
        }>("code.run", {
          actorId,
          params: { language, code, workspaceId, timeoutMs, stdin },
        }, Math.max(30_000, (timeoutMs ?? 30_000) + 5_000));

        if (!result.ok) {
          return {
            ok: false,
            error: result.error ?? "代码执行失败",
            exitCode: result.exitCode,
            stderr: result.stderr,
            stdout: result.stdout,
            timedOut: result.timedOut,
            truncated: result.truncated,
            durationMs: result.durationMs,
            workspacePath: result.workspacePath,
            retryable: result.timedOut,
            summary: result.timedOut
              ? `代码执行超时（${result.durationMs}ms），可简化代码或缩短运行时间后重试`
              : `代码执行失败（exit=${result.exitCode}，耗时 ${result.durationMs}ms）[worker]`,
          };
        }
        return {
          ok: true,
          exitCode: result.exitCode,
          stdout: result.stdout,
          stderr: result.stderr,
          durationMs: result.durationMs,
          truncated: result.truncated,
          workspacePath: result.workspacePath,
          summary: result.truncated
            ? `代码执行完成（exit=${result.exitCode}，耗时 ${result.durationMs}ms）[worker] stdout/stderr 已截断到 8KB，如需完整输出请用 code.write_file 写产物再 code.read_file 分段读`
            : `代码执行完成（exit=${result.exitCode}，耗时 ${result.durationMs}ms）[worker]`,
        };
      } catch (workerErr) {
        console.warn(`[code.run] worker 线程失败，fallback 到主进程: ${workerErr instanceof Error ? workerErr.message : workerErr}`);
        // 继续走下面的主进程路径
      }
    }

    // 主进程执行路径（fallback）
    const result = await service.runCode(actorId, {
      language,
      code,
      workspaceId,
      timeoutMs,
      stdin,
    });

    if (!result.ok) {
      return {
        ok: false,
        error: result.error ?? "代码执行失败",
        exitCode: result.exitCode,
        stderr: result.stderr,
        stdout: result.stdout,
        timedOut: result.timedOut,
        truncated: result.truncated,
        durationMs: result.durationMs,
        workspacePath: result.workspacePath,
        retryable: result.timedOut,
        summary: result.timedOut
          ? `代码执行超时（${result.durationMs}ms），可简化代码或缩短运行时间后重试`
          : `代码执行失败（exit=${result.exitCode}，耗时 ${result.durationMs}ms）`,
      };
    }
    return {
      ok: true,
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      durationMs: result.durationMs,
      truncated: result.truncated,
      workspacePath: result.workspacePath,
      summary: result.truncated
        ? `代码执行完成（exit=${result.exitCode}，耗时 ${result.durationMs}ms）stdout/stderr 已截断到 8KB，如需完整输出请用 code.write_file 写产物再 code.read_file 分段读`
        : `代码执行完成（exit=${result.exitCode}，耗时 ${result.durationMs}ms）`,
    };
  };
}

/** code.list_files —— 列出工作目录文件。 */
export function createCodeListFilesHandler(
  service: CodeSandboxService,
): ToolHandler {
  return async (input: Record<string, unknown>, context: ToolContext) => {
    const workspaceId = typeof input.workspaceId === "string" ? input.workspaceId.trim() : "";
    if (!workspaceId) {
      return { ok: false, error: "缺少 workspaceId" };
    }
    const actorId = resolveActorId(context);
    const files = await service.listFiles(actorId, workspaceId);
    const failed = files.filter((f) => !f.ok);
    if (failed.length > 0 && files.length === failed.length) {
      return { ok: false, error: failed[0]?.error ?? "列出文件失败" };
    }
    return {
      ok: true,
      files: files.map((f) => ({
        path: f.path,
        size: f.size,
        ...(f.ok ? {} : { error: f.error }),
      })),
      workspacePath: service.resolveWorkspacePath(actorId, workspaceId) ?? "",
      summary: `列出 ${files.length} 个文件`,
    };
  };
}

/** code.read_file —— 读取工作目录文件。 */
export function createCodeReadFileHandler(
  service: CodeSandboxService,
): ToolHandler {
  return async (input: Record<string, unknown>, context: ToolContext) => {
    const workspaceId = typeof input.workspaceId === "string" ? input.workspaceId.trim() : "";
    const fileName = typeof input.fileName === "string" ? input.fileName.trim() : "";
    if (!workspaceId) return { ok: false, error: "缺少 workspaceId" };
    if (!fileName) return { ok: false, error: "缺少 fileName" };

    const actorId = resolveActorId(context);
    const result = await service.readFile(actorId, workspaceId, fileName);
    if (!result.ok) {
      return { ok: false, error: result.error };
    }
    return {
      ok: true,
      path: result.path,
      content: result.content,
      size: result.size,
      summary: `读取文件 ${result.path}（${result.size} 字节）`,
    };
  };
}

/** code.write_file —— 写入工作目录文件。 */
export function createCodeWriteFileHandler(
  service: CodeSandboxService,
): ToolHandler {
  return async (input: Record<string, unknown>, context: ToolContext) => {
    const workspaceId = typeof input.workspaceId === "string" ? input.workspaceId.trim() : "";
    const fileName = typeof input.fileName === "string" ? input.fileName.trim() : "";
    const content = typeof input.content === "string" ? input.content : "";
    if (!workspaceId) return { ok: false, error: "缺少 workspaceId" };
    if (!fileName) return { ok: false, error: "缺少 fileName" };
    if (!content) return { ok: false, error: "缺少 content（要写入的文本）" };

    const actorId = resolveActorId(context);
    const result = await service.writeFile(actorId, workspaceId, fileName, content);
    if (!result.ok) {
      return { ok: false, error: result.error };
    }
    return {
      ok: true,
      path: result.path,
      size: result.size,
      summary: `写入文件 ${result.path}（${result.size} 字节）`,
    };
  };
}

/**
 * 注册 code-sandbox 全部工具到 ToolRegistry。
 *
 * 调用方：`buildCodeSandboxModule` 的 `CapabilityModule.register` 闭包，
 * 最终由 `registerAllCapabilityModules` 在启动阶段统一调用。
 */
export function registerCodeSandboxTools(
  registry: ToolRegistry,
  deps: CodeSandboxModuleDeps,
): void {
  const { codeSandboxService } = deps;
  registry.register("code.run", createCodeRunHandler(codeSandboxService));
  registry.register("code.list_files", createCodeListFilesHandler(codeSandboxService));
  registry.register("code.read_file", createCodeReadFileHandler(codeSandboxService));
  registry.register("code.write_file", createCodeWriteFileHandler(codeSandboxService));
}
