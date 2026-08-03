// Agent Body Center —— Hand 手/运动执行器
//
// 8 个 BodyModule 之一：负责 agent 对外的「手」——UI 自动化 / 浏览器 / 文件 / 代码沙盒。
// 通过 act() 按 action.tool 前缀路由到具体子系统：
//   - desktop.visual.*  → desktopVisualPort（本机 Python）或 desktopBridge（远程 PC 桥接）
//   - agent_browser.*    → agentBrowserService（Playwright 无头浏览器会话池）
//   - file_doc.*         → fileProcessingService（文件读写/解析/导出）
//   - code_sandbox.*     → codeSandboxService（Python/Node 代码沙盒）
//
// 设计原则（与 BodyModuleLike 一致）：
//   - 子系统缺失时优雅降级（返回 ok=false + errorMessage），不抛异常
//   - 执行前后发布 body.hand.task_progress / body.hand.task_done 信号到 BodyBus
//   - lastActivityAt 在每次 act 后更新
//   - registerTools 仅占位（实际工具下沉在 Task 12 完成）

import type { DesktopBridgeCoordinator } from "../services/desktop-bridge-coordinator.js";
import type {
  DesktopVisualPort,
  DesktopVisualRunInput,
} from "../services/desktop-visual-port.js";
import type { AgentBrowserService } from "../services/agent-browser-service.js";
import type { FileProcessingService } from "../services/file-processing-service.js";
import type { CodeSandboxService } from "../services/code-sandbox-service.js";

import type { BodyBus } from "./body-bus.js";
import type {
  BodyAction,
  BodyActionResult,
  BodyModuleLike,
  BodyModuleSnapshot,
  BodySenseQuery,
  BodySenseResult,
  BodySignal,
  BodyToolRegistry,
} from "./types.js";

/** Hand 依赖注入参数。任一子系统均可选，缺失时 act 返回 ok=false 优雅降级。 */
export interface HandDeps {
  bodyBus: BodyBus;
  desktopBridge?: DesktopBridgeCoordinator;
  desktopVisualPort?: DesktopVisualPort;
  agentBrowserService?: AgentBrowserService;
  fileProcessingService?: FileProcessingService;
  codeSandboxService?: CodeSandboxService;
}

/** desktop bridge invoke 默认超时（与 desktop-visual-tools.ts 对齐）。 */
const DESKTOP_BRIDGE_INVOKE_TIMEOUT_MS_DEFAULT = 600_000;

/** args 摘要最大长度（防止信号 payload 过大）。 */
const ARGS_SUMMARY_MAX_LEN = 200;

/**
 * Hand —— 手/运动执行器。
 *
 * 实现 BodyModuleLike 接口。act() 按 tool 前缀路由到具体子系统；
 * 执行前后通过 BodyBus 发布 task_progress / task_done 信号。
 */
export class Hand implements BodyModuleLike {
  readonly name = "hand" as const;
  readonly label = "手/运动执行器";
  readonly tools: string[] = [
    "desktop.visual.screenshot",
    "desktop.visual.run_task",
    "agent_browser.navigate",
    "agent_browser.click",
    "agent_browser.extract",
    "file_doc.read",
    "file_doc.write",
    "file_doc.parse",
    "file_doc.export",
    "code_sandbox.run_python",
    "code_sandbox.run_node",
  ];

  private readonly deps: HandDeps;
  private online = false;
  private lastActivityAt: string | null = null;
  /** 当前正在执行的任务数（用于 sense hand.task_status）。 */
  private activeTaskCount = 0;

  constructor(deps: HandDeps) {
    this.deps = deps;
  }

  // ─── 生命周期 ──────────────────────────────────────────────────

  async start(): Promise<void> {
    this.online = true;
    console.log("[Hand] 已启动（手/运动执行器）");
  }

  async stop(): Promise<void> {
    this.online = false;
    console.log("[Hand] 已停止");
  }

  // ─── 动作执行 ──────────────────────────────────────────────────

  async act(action: BodyAction): Promise<BodyActionResult> {
    const startedAt = new Date();
    const startedAtIso = startedAt.toISOString();
    const tool = action.tool ?? "";
    const actorId = action.actorId ?? "anonymous";
    const source = action.source ?? "unknown";

    // 执行前发布 task_progress 信号
    this.publishSignal({
      kind: "body.hand.task_progress",
      payload: {
        tool,
        argsSummary: summarizeArgs(action.args),
        source,
        startedAt: startedAtIso,
      },
      actorId,
    });

    this.activeTaskCount++;
    let ok = false;
    let errorMessage: string | undefined;
    let result: Record<string, unknown> = {};

    try {
      const ret = await this.dispatch(action, actorId);
      ok = ret.ok;
      result = ret.result;
      if (!ok && ret.errorMessage != null) {
        errorMessage = ret.errorMessage;
      }
    } catch (e) {
      ok = false;
      errorMessage = `hand dispatch error: ${e instanceof Error ? e.message : String(e)}`;
    } finally {
      this.activeTaskCount = Math.max(0, this.activeTaskCount - 1);
    }

    const finishedAt = Date.now();
    const durationMs = finishedAt - startedAt.getTime();
    this.lastActivityAt = new Date(finishedAt).toISOString();

    // 执行后发布 task_done 信号
    this.publishSignal({
      kind: "body.hand.task_done",
      payload: {
        tool,
        success: ok,
        durationMs,
        ...(errorMessage != null ? { error: errorMessage } : {}),
      },
      actorId,
    });

    if (!ok) {
      return {
        ok: false,
        result,
        ...(errorMessage != null ? { errorMessage } : {}),
        durationMs,
      };
    }
    return { ok: true, result, durationMs };
  }

  // ─── 感官查询 ──────────────────────────────────────────────────

  async sense(query: BodySenseQuery): Promise<BodySenseResult> {
    const kind = query.kind ?? "";
    if (kind === "hand.task_status") {
      return {
        ok: true,
        module: "hand",
        data: {
          activeTaskCount: this.activeTaskCount,
          online: this.online,
          lastActivityAt: this.lastActivityAt,
        },
      };
    }
    if (kind === "hand.tools") {
      return {
        ok: true,
        module: "hand",
        data: {
          tools: [...this.tools],
          subsystems: this.getSubsystemStatuses(),
        },
      };
    }
    return {
      ok: false,
      module: "hand",
      errorMessage: `unknown sense kind: ${kind}`,
      data: {},
    };
  }

  // ─── 快照 ─────────────────────────────────────────────────────

  snapshot(): BodyModuleSnapshot {
    return {
      name: "hand",
      label: this.label,
      tools: [...this.tools],
      online: this.online,
      subsystems: this.getConfiguredSubsystemIds(),
      lastActivityAt: this.lastActivityAt,
      metadata: {
        activeTaskCount: this.activeTaskCount,
      },
    };
  }

  // ─── 工具注册 ────────────────────────────────────────────────

  /**
   * 把 desktop.visual.* / agent_browser.* / file_doc.* / code_sandbox.* 工具
   * 挂到外部 ToolRegistry，handler 内部委托 this.act()。
   *
   * actorId 暂时无法获取（BodyToolRegistry 接口未传 context），保持 undefined。
   * 返回值：成功 { ok: true, ...result.result }；失败 { ok: false, error, ...result.result }。
   */
  registerTools(registry: BodyToolRegistry): void {
    for (const toolName of this.tools) {
      registry.register(toolName, async (input) => {
        const result = await this.act({
          tool: toolName,
          args: input,
          source: "body_module",
        });
        if (!result.ok) {
          return {
            ok: false,
            error:
              result.errorMessage ??
              result.reason ??
              "body module action failed",
            ...result.result,
          };
        }
        return { ok: true, ...result.result };
      });
    }
  }

  // ─── 内部：按 tool 前缀分发 ─────────────────────────────────────

  private async dispatch(
    action: BodyAction,
    actorId: string,
  ): Promise<BodyActionResult> {
    const tool = action.tool;
    if (tool.startsWith("desktop.visual.")) {
      return this.dispatchDesktopVisual(tool, action.args, actorId);
    }
    if (tool.startsWith("agent_browser.")) {
      return this.dispatchAgentBrowser(tool, action.args, actorId);
    }
    if (tool.startsWith("file_doc.")) {
      return this.dispatchFileDoc(tool, action.args, actorId);
    }
    if (tool.startsWith("code_sandbox.")) {
      return this.dispatchCodeSandbox(tool, action.args, actorId);
    }
    return {
      ok: false,
      result: {},
      errorMessage: `unknown tool prefix: ${tool}`,
    };
  }

  // ─── desktop.visual.* ──────────────────────────────────────────

  private async dispatchDesktopVisual(
    tool: string,
    args: Record<string, unknown>,
    actorId: string,
  ): Promise<BodyActionResult> {
    const bridge = this.deps.desktopBridge;
    const visualPort = this.deps.desktopVisualPort;

    const bridgeOnline = !!bridge && bridge.hasExecutor(actorId);
    const localVisualOnline = !!visualPort && visualPort.isEnabled();

    if (!bridgeOnline && !localVisualOnline) {
      return {
        ok: false,
        result: {},
        errorMessage: "desktop bridge offline",
      };
    }

    if (tool === "desktop.visual.screenshot") {
      const region = parseRegion(args.region);

      // 优先走 bridge（远程 PC 截图）
      if (bridgeOnline && bridge) {
        const remote = await bridge.invoke(
          actorId,
          { action: "screenshot", region: region ?? null },
          Math.min(this.bridgeInvokeTimeoutMs(), 120_000),
        );
        if (remote) {
          return toBodyActionResult(remote);
        }
      }
      // 回退到本机 Python
      if (visualPort && visualPort.isEnabled() && visualPort.screenshot) {
        const r = await visualPort.screenshot({ region });
        return toBodyActionResult(r);
      }
      return {
        ok: false,
        result: {},
        errorMessage: "desktop bridge offline",
      };
    }

    if (tool === "desktop.visual.run_task") {
      const task = typeof args.task === "string" ? args.task.trim() : "";
      if (!task) {
        return { ok: false, result: {}, errorMessage: "缺少 task" };
      }
      const maxStepsRaw = args.maxSteps;
      const maxSteps =
        typeof maxStepsRaw === "number" && Number.isFinite(maxStepsRaw)
          ? Math.min(120, Math.max(1, Math.floor(maxStepsRaw)))
          : undefined;
      const region = parseRegion(args.region);
      const stub = args.stub === true;

      if (bridgeOnline && bridge) {
        const remote = await bridge.invoke(
          actorId,
          {
            action: "run_task",
            task,
            maxSteps: maxSteps ?? 40,
            region: region ?? null,
            stub,
          },
          this.bridgeInvokeTimeoutMs(),
        );
        if (remote) {
          bridge.recordTaskResult(actorId, remote);
          return toBodyActionResult(remote);
        }
      }
      if (visualPort && visualPort.isEnabled()) {
        const input: DesktopVisualRunInput = {
          task,
          stub,
          ...(maxSteps != null ? { maxSteps } : {}),
          ...(region != null ? { region } : {}),
        };
        const r = await visualPort.runTask(input);
        if (bridge && bridge.isBridgeFeatureEnabled()) {
          bridge.recordTaskResult(actorId, r);
        }
        return toBodyActionResult(r);
      }
      return {
        ok: false,
        result: {},
        errorMessage: "desktop bridge offline",
      };
    }

    return {
      ok: false,
      result: {},
      errorMessage: `unknown desktop.visual tool: ${tool}`,
    };
  }

  // ─── agent_browser.* ───────────────────────────────────────────

  private async dispatchAgentBrowser(
    tool: string,
    args: Record<string, unknown>,
    actorId: string,
  ): Promise<BodyActionResult> {
    const service = this.deps.agentBrowserService;
    if (!service) {
      return {
        ok: false,
        result: {},
        errorMessage: "subsystem not configured: agent_browser",
      };
    }

    // 构造最小 ToolContext（agent_browser.* 服务需要 sessionId / userId）
    const ctx = {
      sessionId: actorId,
      userId: actorId,
    };

    if (tool === "agent_browser.navigate" || tool === "agent_browser.open") {
      const url = typeof args.url === "string" ? args.url.trim() : "";
      if (!url) {
        return { ok: false, result: {}, errorMessage: "缺少 url" };
      }
      const opts: Record<string, unknown> = {};
      if (args.viewport && typeof args.viewport === "object") {
        const vp = args.viewport as Record<string, unknown>;
        const width = typeof vp.width === "number" ? vp.width : undefined;
        const height = typeof vp.height === "number" ? vp.height : undefined;
        if (width && height) opts.viewport = { width, height };
      }
      if (typeof args.waitUntil === "string") opts.waitUntil = args.waitUntil;
      if (typeof args.timeout === "number") opts.timeout = args.timeout;

      const r = await service.open(ctx, url, opts);
      return toBodyActionResult(r);
    }

    if (tool === "agent_browser.click") {
      const sessionId =
        typeof args.sessionId === "string" ? args.sessionId.trim() : "";
      const selector = typeof args.selector === "string" ? args.selector : "";
      if (!sessionId) {
        return { ok: false, result: {}, errorMessage: "缺少 sessionId" };
      }
      if (!selector) {
        return { ok: false, result: {}, errorMessage: "缺少 selector" };
      }

      const opts: {
        timeout?: number;
        button?: "left" | "right";
        doubleClick?: boolean;
      } = {};
      if (typeof args.timeout === "number") opts.timeout = args.timeout;
      if (args.button === "left" || args.button === "right") {
        opts.button = args.button;
      }
      if (typeof args.doubleClick === "boolean") {
        opts.doubleClick = args.doubleClick;
      }

      const r = await service.click(ctx, sessionId, selector, opts);
      return toBodyActionResult(r);
    }

    if (tool === "agent_browser.extract" || tool === "agent_browser.extract_text") {
      const sessionId =
        typeof args.sessionId === "string" ? args.sessionId.trim() : "";
      if (!sessionId) {
        return { ok: false, result: {}, errorMessage: "缺少 sessionId" };
      }
      const selector =
        typeof args.selector === "string" && args.selector.trim()
          ? args.selector
          : undefined;
      const opts: { includeInteractive?: boolean } = {};
      if (typeof args.includeInteractive === "boolean") {
        opts.includeInteractive = args.includeInteractive;
      }

      const r = await service.extractText(ctx, sessionId, selector, opts);
      return toBodyActionResult(r);
    }

    return {
      ok: false,
      result: {},
      errorMessage: `unknown agent_browser tool: ${tool}`,
    };
  }

  // ─── file_doc.* ────────────────────────────────────────────────

  private async dispatchFileDoc(
    tool: string,
    args: Record<string, unknown>,
    actorId: string,
  ): Promise<BodyActionResult> {
    const service = this.deps.fileProcessingService;
    if (!service) {
      return {
        ok: false,
        result: {},
        errorMessage: "subsystem not configured: file_doc",
      };
    }

    if (tool === "file_doc.read") {
      const path = typeof args.path === "string" ? args.path : undefined;
      const url = typeof args.url === "string" ? args.url : undefined;
      const base64 = typeof args.base64 === "string" ? args.base64 : undefined;
      const encoding =
        typeof args.encoding === "string"
          ? (args.encoding as BufferEncoding)
          : undefined;

      const r = await service.readText({ path, url, base64, encoding });
      return toBodyActionResult(r);
    }

    if (tool === "file_doc.write") {
      const content = typeof args.content === "string" ? args.content : "";
      const fileName = typeof args.fileName === "string" ? args.fileName : "";
      const encoding =
        typeof args.encoding === "string"
          ? (args.encoding as BufferEncoding)
          : undefined;

      if (!content) {
        return { ok: false, result: {}, errorMessage: "缺少 content" };
      }
      if (!fileName.trim()) {
        return { ok: false, result: {}, errorMessage: "缺少 fileName" };
      }

      const r = await service.writeText({
        content,
        actorId,
        fileName,
        encoding,
      });
      return toBodyActionResult(r);
    }

    if (tool === "file_doc.parse") {
      const path = typeof args.path === "string" ? args.path : undefined;
      const url = typeof args.url === "string" ? args.url : undefined;
      const base64 = typeof args.base64 === "string" ? args.base64 : undefined;
      const format =
        args.format === "docx" || args.format === "xlsx" || args.format === "pptx"
          ? (args.format as "docx" | "xlsx" | "pptx")
          : undefined;

      if (format) {
        const r = await service.parseOffice({ path, url, base64, format });
        return toBodyActionResult(r);
      }
      const r = await service.parsePdf({ path, url, base64 });
      return toBodyActionResult(r);
    }

    if (tool === "file_doc.export") {
      const rawContent = args.content;
      const format =
        typeof args.format === "string"
          ? (args.format as
              | "md"
              | "json"
              | "csv"
              | "xlsx"
              | "txt"
              | "pdf"
              | "docx")
          : "";
      const fileName =
        typeof args.fileName === "string" ? args.fileName : undefined;
      const sheetName =
        typeof args.sheetName === "string" ? args.sheetName : undefined;

      if (rawContent == null || (typeof rawContent === "string" && rawContent === "")) {
        return { ok: false, result: {}, errorMessage: "缺少 content" };
      }
      const validFormats = ["md", "json", "csv", "xlsx", "txt", "pdf", "docx"];
      if (typeof format !== "string" || !validFormats.includes(format)) {
        return {
          ok: false,
          result: {},
          errorMessage: `不支持的 format：${format || "(空)"}`,
        };
      }
      const content: string | Record<string, unknown> | unknown[] =
        typeof rawContent === "string"
          ? rawContent
          : (rawContent as Record<string, unknown>);

      const r = await service.exportFormat({
        content,
        format: format as "md" | "json" | "csv" | "xlsx" | "txt" | "pdf" | "docx",
        actorId,
        fileName,
        sheetName,
      });
      return toBodyActionResult(r);
    }

    return {
      ok: false,
      result: {},
      errorMessage: `unknown file_doc tool: ${tool}`,
    };
  }

  // ─── code_sandbox.* ────────────────────────────────────────────

  private async dispatchCodeSandbox(
    tool: string,
    args: Record<string, unknown>,
    actorId: string,
  ): Promise<BodyActionResult> {
    const service = this.deps.codeSandboxService;
    if (!service) {
      return {
        ok: false,
        result: {},
        errorMessage: "subsystem not configured: code_sandbox",
      };
    }

    let language: "python" | "node";
    if (tool === "code_sandbox.run_python") {
      language = "python";
    } else if (tool === "code_sandbox.run_node") {
      language = "node";
    } else {
      return {
        ok: false,
        result: {},
        errorMessage: `unknown code_sandbox tool: ${tool}`,
      };
    }

    const code = typeof args.code === "string" ? args.code : "";
    if (!code) {
      return { ok: false, result: {}, errorMessage: "缺少 code" };
    }
    const workspaceId =
      typeof args.workspaceId === "string" && args.workspaceId.trim()
        ? args.workspaceId.trim()
        : undefined;
    const timeoutMs =
      typeof args.timeoutMs === "number" && Number.isFinite(args.timeoutMs)
        ? Math.floor(args.timeoutMs)
        : undefined;
    const stdin = typeof args.stdin === "string" ? args.stdin : undefined;

    const r = await service.runCode(actorId, {
      language,
      code,
      workspaceId,
      timeoutMs,
      stdin,
    });
    return toBodyActionResult(r);
  }

  // ─── 内部工具 ──────────────────────────────────────────────────

  /** desktop bridge invoke 超时（环境变量覆盖）。 */
  private bridgeInvokeTimeoutMs(): number {
    const t = Number.parseInt(
      process.env.DESKTOP_BRIDGE_INVOKE_TIMEOUT_MS ?? "",
      10,
    );
    return Number.isFinite(t) && t > 0 ? t : DESKTOP_BRIDGE_INVOKE_TIMEOUT_MS_DEFAULT;
  }

  /** 已配置的子系统 id 列表（用于 snapshot.subsystems）。 */
  private getConfiguredSubsystemIds(): string[] {
    const list: string[] = [];
    if (this.deps.desktopVisualPort) list.push("desktop-visual-port");
    if (this.deps.desktopBridge) list.push("desktop-bridge");
    if (this.deps.agentBrowserService) list.push("agent-browser");
    if (this.deps.fileProcessingService) list.push("file-processing");
    if (this.deps.codeSandboxService) list.push("code-sandbox");
    return list;
  }

  /** 子系统在线状态（用于 sense hand.tools）。 */
  private getSubsystemStatuses(): Array<{ id: string; online: boolean }> {
    const statuses: Array<{ id: string; online: boolean }> = [];
    if (this.deps.desktopVisualPort) {
      statuses.push({
        id: "desktop-visual-port",
        online: this.deps.desktopVisualPort.isEnabled(),
      });
    }
    if (this.deps.desktopBridge) {
      // 桥接是否启用配置（不是单个 actor 是否在线）
      statuses.push({
        id: "desktop-bridge",
        online: this.deps.desktopBridge.isBridgeFeatureEnabled(),
      });
    }
    if (this.deps.agentBrowserService) {
      statuses.push({ id: "agent-browser", online: true });
    }
    if (this.deps.fileProcessingService) {
      statuses.push({ id: "file-processing", online: true });
    }
    if (this.deps.codeSandboxService) {
      statuses.push({ id: "code-sandbox", online: true });
    }
    return statuses;
  }

  /** 发布 body 信号到 BodyBus（fire-and-forget，失败仅记日志）。 */
  private publishSignal(
    signal: Omit<BodySignal, "module" | "timestamp">,
  ): void {
    const full: BodySignal = {
      ...signal,
      module: "hand",
      timestamp: new Date().toISOString(),
    };
    try {
      this.deps.bodyBus.publish(full);
    } catch (err) {
      console.log(`[Hand] publish signal error: ${err}`);
    }
  }
}

// ─── 内部辅助函数 ────────────────────────────────────────────────

/**
 * 把各子系统的统一返回结构（`{ ok, error?, ...rest }`）归一化为 BodyActionResult。
 *
 * - 成功：剥离 ok 字段，其余作为 result 返回
 * - 失败：剥离 ok 与 error，其余作为 result 返回；error 转 errorMessage
 */
function toBodyActionResult<T extends { ok: boolean; error?: string }>(
  r: T,
): BodyActionResult {
  const ok = !!r.ok;
  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(r as Record<string, unknown>)) {
    if (k === "ok" || k === "error") continue;
    result[k] = v;
  }
  if (!ok) {
    const error = typeof r.error === "string" ? r.error : undefined;
    return {
      ok: false,
      result,
      ...(error != null ? { errorMessage: error } : {}),
    };
  }
  return { ok: true, result };
}

/** 解析 args.region 为 [left, top, width, height]。 */
function parseRegion(
  raw: unknown,
): [number, number, number, number] | undefined {
  if (
    Array.isArray(raw) &&
    raw.length === 4 &&
    raw.every((x) => typeof x === "number" && Number.isFinite(x))
  ) {
    return [
      Math.floor(raw[0]),
      Math.floor(raw[1]),
      Math.floor(raw[2]),
      Math.floor(raw[3]),
    ];
  }
  return undefined;
}

/** 把 args 安全序列化为简短字符串（截断到 ARGS_SUMMARY_MAX_LEN）。 */
function summarizeArgs(args: Record<string, unknown>): string {
  let s: string;
  try {
    s = JSON.stringify(args);
  } catch {
    s = String(args);
  }
  if (s.length > ARGS_SUMMARY_MAX_LEN) {
    return s.slice(0, ARGS_SUMMARY_MAX_LEN) + "...[truncated]";
  }
  return s;
}
