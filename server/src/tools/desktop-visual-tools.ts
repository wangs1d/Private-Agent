import { resolveActorId } from "../agent/actor-id.js";
import type { AuditService } from "../services/audit-service.js";
import type { DesktopBridgeCoordinator } from "../services/desktop-bridge-coordinator.js";
import type { DesktopVisualPort, DesktopVisualRunInputInput } from "../services/desktop-visual-port.js";
import { resolveDesktopVisualVlmConfig } from "../services/desktop-visual-vlm-config.js";
import type { ToolRegistry } from "./tool-registry.js";

export type DesktopVisualToolsDeps = {
  localVisual: DesktopVisualPort;
  bridge: DesktopBridgeCoordinator;
  audit?: AuditService;
};

// ─────────────────────────────────────────────────────────────────────────
// 本轮工具调用历史追踪(代码层硬约束,不依赖 LLM 自觉)
// 用 chatUserMessageId 作 key,记录本轮已调用过的桌面工具名
// run_task 调用前必须先有 uia_query + run_input 调用记录,否则直接拒绝
// ─────────────────────────────────────────────────────────────────────────
const TURN_TOOL_HISTORY = new Map<string, Set<string>>();

function recordToolCallForTurn(ctx: { chatUserMessageId?: string }, toolName: string): void {
  const key = ctx.chatUserMessageId ?? "__no_msg_id__";
  let set = TURN_TOOL_HISTORY.get(key);
  if (!set) {
    set = new Set();
    TURN_TOOL_HISTORY.set(key, set);
  }
  set.add(toolName);
  // 简易清理:超过 200 条记录时清掉旧的(防止内存泄漏)
  if (TURN_TOOL_HISTORY.size > 200) {
    const firstKey = TURN_TOOL_HISTORY.keys().next().value;
    if (firstKey) TURN_TOOL_HISTORY.delete(firstKey);
  }
}

function hasCalledToolThisTurn(ctx: { chatUserMessageId?: string }, toolName: string): boolean {
  const key = ctx.chatUserMessageId ?? "__no_msg_id__";
  return TURN_TOOL_HISTORY.get(key)?.has(toolName) ?? false;
}

function desktopBridgeInvokeTimeoutMs(): number {
  const t = Number.parseInt(process.env.DESKTOP_BRIDGE_INVOKE_TIMEOUT_MS ?? "", 10);
  return Number.isFinite(t) && t > 0 ? t : 600_000;
}

function parseRegion(input: Record<string, unknown>): [number, number, number, number] | undefined {
  const r = input.region;
  if (Array.isArray(r) && r.length === 4 && r.every((x) => typeof x === "number" && Number.isFinite(x))) {
    return [Math.floor(r[0]), Math.floor(r[1]), Math.floor(r[2]), Math.floor(r[3])];
  }
  return undefined;
}

function bridgeInvokePayload(
  body: Record<string, unknown>,
): Record<string, unknown> {
  const vlm = resolveDesktopVisualVlmConfig();
  return vlm ? { ...body, vlm } : body;
}

function desktopUnavailableMessage(bridgeEnabled: boolean): string {
  if (bridgeEnabled) {
    return "电脑端未在线：请在本机运行桌面桥接（与手机相同 userId，session.init 带 desktopBridge:true），或设置 DESKTOP_VISUAL_ENABLED=1 由服务端本机截图。";
  }
  return "桌面能力未配置：请设置 DESKTOP_BRIDGE_ENABLED=1（或 DESKTOP_BRIDGE_TOKEN）并运行桥接客户端，或设置 DESKTOP_VISUAL_ENABLED=1 由服务端本机执行。";
}

/** 始终注册；执行时按桥接在线 / 本机 Python 择优，避免「完全访问」已开但工具未注册。 */
export function registerDesktopVisualTools(registry: ToolRegistry, deps: DesktopVisualToolsDeps): void {
  const bridgeEnabled = deps.bridge.isBridgeFeatureEnabled();

  registry.register("desktop.visual.screenshot", async (input, ctx) => {
    const region = parseRegion(input);
    const actorId = resolveActorId(ctx);

    if (deps.bridge.hasExecutor(actorId)) {
      const remote = await deps.bridge.invoke(
        actorId,
        bridgeInvokePayload({ action: "screenshot", region: region ?? null }),
        Math.min(desktopBridgeInvokeTimeoutMs(), 120_000),
      );
      if (remote?.ok && remote.imageBase64) {
        return {
          ok: true,
          imageBase64: remote.imageBase64,
          mimeType: remote.mimeType ?? "image/png",
          width: remote.width,
          height: remote.height,
          capturedAt: remote.capturedAt,
          message: `已通过电脑桥接截取屏幕${region ? `区域 [${region.join(", ")}]` : ""}，尺寸 ${remote.width ?? "?"}x${remote.height ?? "?"}`,
        };
      }
      if (remote && !remote.ok) {
        return { ok: false, error: remote.error ?? "电脑端截图失败" };
      }
    }

    if (deps.localVisual.isEnabled() && deps.localVisual.screenshot) {
      const result = await deps.localVisual.screenshot({ region });
      if (!result.ok) {
        return { ok: false, error: result.error ?? "截图失败" };
      }
      return {
        ok: true,
        imageBase64: result.imageBase64,
        mimeType: result.mimeType ?? "image/png",
        width: result.width,
        height: result.height,
        capturedAt: result.capturedAt,
        message: `已截取屏幕${region ? `区域 [${region.join(", ")}]` : ""}，尺寸 ${result.width}x${result.height}`,
      };
    }

    return { ok: false, error: desktopUnavailableMessage(bridgeEnabled) };
  });

  registry.register("desktop.visual.run_task", async (input, ctx) => {
    const task = typeof input.task === "string" ? input.task.trim() : "";
    if (!task) {
      return { ok: false, error: "缺少 task" };
    }
    // 代码层硬约束:本轮必须先调用过 uia_query 和 run_input,否则拒绝
    // 防止 LLM 跳过结构化路径直接走 VLM(VLM 当前不可用,必失败)
    const calledUia = hasCalledToolThisTurn(ctx, "desktop.uia_query");
    const calledInput = hasCalledToolThisTurn(ctx, "desktop.run_input");
    if (!calledUia || !calledInput) {
      const missing: string[] = [];
      if (!calledUia) missing.push("desktop.uia_query");
      if (!calledInput) missing.push("desktop.run_input");
      return {
        ok: false,
        error:
          `desktop.visual.run_task 是最后兜底手段,本轮必须先用结构化工具定位并尝试操作。` +
          `尚未调用: ${missing.join(", ")}。` +
          `正确顺序:desktop.open → desktop.uia_query(拿 bbox 中心)→ desktop.run_input(click/type/key)→ 验证后才能用本工具。`,
      };
    }
    const maxStepsRaw = input.maxSteps;
    const maxSteps =
      typeof maxStepsRaw === "number" && Number.isFinite(maxStepsRaw)
        ? Math.min(120, Math.max(1, Math.floor(maxStepsRaw)))
        : undefined;
    const region = parseRegion(input);
    const stub = input.stub === true;
    const actorId = resolveActorId(ctx);

    if (deps.bridge.hasExecutor(actorId)) {
      const remote = await deps.bridge.invoke(
        actorId,
        bridgeInvokePayload({
          action: "run_task",
          task,
          maxSteps: maxSteps ?? 40,
          region: region ?? null,
          stub,
        }),
        desktopBridgeInvokeTimeoutMs(),
      );
      if (remote) {
        deps.bridge.recordTaskResult(actorId, remote);
        return { ...remote };
      }
      return { ok: false, error: "电脑端执行器在调度瞬间不可用，请重试" };
    }

    if (deps.localVisual.isEnabled()) {
      const out = await deps.localVisual.runTask({ task, maxSteps, region, stub });
      if (deps.bridge.isBridgeFeatureEnabled()) {
        deps.bridge.recordTaskResult(actorId, out);
      }
      return out;
    }

    return { ok: false, error: desktopUnavailableMessage(bridgeEnabled) };
  });

  // -------------------------------------------------------------------------
  // desktop.run_shell：在 PC 本机跑一条受控的 shell 命令（cmd / powershell / bash）
  // 默认走 allowlist：白名单外的命令直接拒；allowDestructive=true 时仅走 denylist
  // （要求 DESKTOP_SHELL_ALLOWLIST=0 显式放开，否则拒）。
  // 安全护栏：审计日志 + 强制 token 鉴权 + 拒绝未启用开关 + env 脱敏（Python 侧）。
  // -------------------------------------------------------------------------
  registry.register("desktop.run_shell", async (input, ctx) => {
    const command = typeof input.command === "string" ? input.command.trim() : "";
    if (!command) {
      return { ok: false, error: "缺少 command" };
    }
    if (!isShellCommandAllowedByFeatureFlag()) {
      return {
        ok: false,
        error:
          "desktop.run_shell 未启用：在 server/.env.local 设置 DESKTOP_SHELL_ENABLED=1，" +
          "并强制设置 DESKTOP_BRIDGE_TOKEN（≥8 字符）做鉴权后再开启。",
      };
    }
    if (!deps.bridge.isBridgeFeatureEnabled()) {
      return {
        ok: false,
        error:
          "desktop.run_shell 强制要求 DESKTOP_BRIDGE_ENABLED=1 或 DESKTOP_BRIDGE_TOKEN（≥8 字符）以做鉴权。",
      };
    }

    const shellRaw = input.shell;
    const shell =
      shellRaw === "cmd" || shellRaw === "powershell" || shellRaw === "bash"
        ? shellRaw
        : undefined;
    const allowDestructive = input.allowDestructive === true;
    if (allowDestructive && !isShellAllowlistDisabled()) {
      return {
        ok: false,
        error:
          "allowDestructive=true 要求显式设置 DESKTOP_SHELL_ALLOWLIST=0（关闭白名单，仅留黑名单+正则）。",
      };
    }
    const cwd = typeof input.cwd === "string" && input.cwd.trim() ? input.cwd.trim() : undefined;
    const timeoutMs = clampShellTimeout(input.timeoutMs);

    const actorId = resolveActorId(ctx);

    // 审计：每次 desktop.run_shell 调用都落一条，含 actorId / command / shell /
    // allowDestructive / outcome（best-effort，失败不影响工具返回）。
    const startedAt = new Date().toISOString();
    const auditPromise = deps.audit
      ?.record({
        kind: "desktop.run_shell",
        actorId,
        command: command.slice(0, 400),
        shell: shell ?? null,
        allowDestructive,
        cwd: cwd ?? null,
        timeoutMs,
        startedAt,
      })
      .catch(() => undefined);

    const payload: Record<string, unknown> = {
      action: "run_shell",
      command,
      shell: shell ?? null,
      cwd: cwd ?? null,
      timeoutMs,
      allowDestructive,
    };

    let out: Record<string, unknown>;
    // 优先走电脑端 executor；否则退到本机 Python（必须在 server 同机部署时才有意义）
    if (deps.bridge.hasExecutor(actorId)) {
      const remote = await deps.bridge.invoke(
        actorId,
        payload,
        Math.min(desktopBridgeInvokeTimeoutMs(), timeoutMs + 5_000),
      );
      if (remote) {
        out = { ...remote };
      } else {
        out = { ok: false, error: "电脑端执行器在调度瞬间不可用，请重试" };
      }
    } else if (deps.localVisual.isEnabled() && deps.localVisual.runShell) {
      out = await deps.localVisual.runShell({
        command,
        shell: shell ?? null,
        cwd: cwd ?? null,
        timeoutMs,
        allowDestructive,
      });
    } else {
      out = {
        ok: false,
        error:
          "桌面能力未配置：电脑端 executor 不在线，且未启用 DESKTOP_VISUAL_ENABLED=1" +
          " 让服务端本机执行 run_shell。",
      };
    }

    await auditPromise;
    return out;
  });

  // -------------------------------------------------------------------------
  // desktop.open：原生 API 打开文件/网页/软件（不走 shell，不经白名单判定）
  // 不受 DESKTOP_SHELL_ENABLED 门控（与 screenshot 同级），只要桌面能力可用即可。
  // -------------------------------------------------------------------------
  registry.register("desktop.open", async (input, ctx) => {
    const target = input.target;
    const path = typeof input.path === "string" ? input.path.trim() : "";
    if (target !== "file" && target !== "url" && target !== "app") {
      return { ok: false, error: "target 必须是 file / url / app" };
    }
    if (!path) {
      return { ok: false, error: "缺少 path" };
    }

    const actorId = resolveActorId(ctx);
    const startedAt = new Date().toISOString();
    const auditPromise = deps.audit
      ?.record({
        kind: "desktop.open",
        actorId,
        command: `${target} ${path}`.slice(0, 400),
        shell: null,
        allowDestructive: false,
        cwd: null,
        timeoutMs: 15_000,
        startedAt,
      })
      .catch(() => undefined);

    const payload: Record<string, unknown> = {
      action: "open",
      target,
      path,
    };

    let out: Record<string, unknown>;
    if (deps.bridge.hasExecutor(actorId)) {
      const remote = await deps.bridge.invoke(
        actorId,
        payload,
        Math.min(desktopBridgeInvokeTimeoutMs(), 30_000),
      );
      out = remote ? { ...remote } : { ok: false, error: "电脑端执行器在调度瞬间不可用，请重试" };
    } else if (deps.localVisual.isEnabled() && deps.localVisual.open) {
      out = await deps.localVisual.open({ target, path });
    } else {
      out = { ok: false, error: desktopUnavailableMessage(bridgeEnabled) };
    }

    await auditPromise;
    return out;
  });

  // -------------------------------------------------------------------------
  // desktop.uia_query：Windows UIAutomation 结构化查询（不暴露 LLM，主 agent 内部用）
  // 不受 DESKTOP_SHELL_ENABLED 门控（与 desktop.open 一致）。
  // -------------------------------------------------------------------------
  registry.register("desktop.uia_query", async (input, ctx) => {
    const mode = input.mode;
    if (mode !== "query" && mode !== "read_children" && mode !== "inspect_point") {
      return { ok: false, error: "mode 必须是 query / read_children / inspect_point" };
    }
    recordToolCallForTurn(ctx, "desktop.uia_query");

    const actorId = resolveActorId(ctx);
    const startedAt = new Date().toISOString();
    const auditPromise = deps.audit
      ?.record({
        kind: "desktop.uia_query",
        actorId,
        command: `${mode} ${JSON.stringify(input.selector ?? input.point ?? {}).slice(0, 300)}`,
        shell: null,
        allowDestructive: false,
        cwd: null,
        timeoutMs: 30_000,
        startedAt,
      })
      .catch(() => undefined);

    const payload: Record<string, unknown> = {
      action: "uia_query",
      mode,
      selector: input.selector ?? null,
      point: input.point ?? null,
      topOnly: input.topOnly ?? null,
      limit: input.limit ?? null,
    };

    let out: Record<string, unknown>;
    if (deps.bridge.hasExecutor(actorId)) {
      const remote = await deps.bridge.invoke(
        actorId,
        payload,
        Math.min(desktopBridgeInvokeTimeoutMs(), 35_000),
      );
      out = remote ? { ...remote } : { ok: false, error: "电脑端执行器在调度瞬间不可用，请重试" };
    } else if (deps.localVisual.isEnabled() && deps.localVisual.uiaQuery) {
      const selector =
        input.selector && typeof input.selector === "object"
          ? (input.selector as Record<string, unknown>)
          : null;
      const point =
        input.point && typeof input.point === "object"
          ? (input.point as { x: number; y: number })
          : null;
      const topOnly = typeof input.topOnly === "boolean" ? input.topOnly : null;
      const limit = typeof input.limit === "number" ? input.limit : null;
      out = await deps.localVisual.uiaQuery({
        mode,
        selector,
        point,
        topOnly,
        limit,
      });
    } else {
      out = { ok: false, error: desktopUnavailableMessage(bridgeEnabled) };
    }

    await auditPromise;
    return out;
  });

  // -------------------------------------------------------------------------
  // desktop.run_input：原生键盘/鼠标模拟输入（不依赖 VLM）
  // 支持 click/double_click/type/key/shortcut/scroll/drag/move
  // 不受 DESKTOP_SHELL_ENABLED 门控，与 desktop.open 同级。
  // -------------------------------------------------------------------------
  registry.register("desktop.run_input", async (input, ctx) => {
    const action = String(input.action ?? "");
    const VALID = ["click", "double_click", "right_click", "move", "type", "key", "shortcut", "drag", "scroll"];
    if (!VALID.includes(action)) {
      return { ok: false, error: `action 必须是 ${VALID.join("/")} 之一，收到 ${action}` };
    }
    recordToolCallForTurn(ctx, "desktop.run_input");
    if (
      (action === "click" || action === "double_click" || action === "right_click" || action === "move" || action === "drag") &&
      (typeof input.x !== "number" || typeof input.y !== "number")
    ) {
      return { ok: false, error: `${action} 需要 x, y 坐标` };
    }
    if (action === "drag" && (typeof input.toX !== "number" || typeof input.toY !== "number")) {
      return { ok: false, error: "drag 需要 toX, toY 终点坐标" };
    }
    if (action === "type" && typeof input.text !== "string") {
      return { ok: false, error: "type 需要 text" };
    }
    if (action === "key" && typeof input.key !== "string") {
      return { ok: false, error: "key 需要 key 参数" };
    }
    if (action === "shortcut" && typeof input.keys !== "string") {
      return { ok: false, error: "shortcut 需要 keys 参数" };
    }
    if (action === "scroll" && typeof input.scrollClicks !== "number") {
      return { ok: false, error: "scroll 需要 scrollClicks" };
    }

    const actorId = resolveActorId(ctx);
    const startedAt = new Date().toISOString();
    const auditPromise = deps.audit
      ?.record({
        kind: "desktop.run_input",
        actorId,
        command: `${action}`.slice(0, 200),
        shell: null,
        allowDestructive: false,
        cwd: null,
        timeoutMs: 10_000,
        startedAt,
      })
      .catch(() => undefined);

    // run_input 不走 bridge（键盘/鼠标只能在服务器本机做），只走 localVisual
    if (!deps.localVisual.isEnabled()) {
      return { ok: false, error: desktopUnavailableMessage(bridgeEnabled) };
    }
    if (!deps.localVisual.runInput) {
      return { ok: false, error: "桌面输入服务未实现 runInput" };
    }

    const out = await deps.localVisual.runInput({
      action: action as DesktopVisualRunInputInput["action"],
      x: typeof input.x === "number" ? input.x : undefined,
      y: typeof input.y === "number" ? input.y : undefined,
      toX: typeof input.toX === "number" ? input.toX : undefined,
      toY: typeof input.toY === "number" ? input.toY : undefined,
      button: typeof input.button === "string" ? input.button : undefined,
      text: typeof input.text === "string" ? input.text : undefined,
      key: typeof input.key === "string" ? input.key : undefined,
      keys: typeof input.keys === "string" ? input.keys : undefined,
      scrollClicks: typeof input.scrollClicks === "number" ? input.scrollClicks : undefined,
    });

    await auditPromise;
    return out;
  });

  // -------------------------------------------------------------------------
  // desktop.run_automation：UIA 原生控件原子操作（不模拟鼠标键盘）
  // 一次调用完成 query → ValuePattern/InvokePattern/TogglePattern 操作
  // 不抢焦点，不要求窗口在前台。仅 Win32/WPF/WinForms 支持。
  // 不受 DESKTOP_SHELL_ENABLED 门控（与 desktop.open/desktop.uia_query 一致）。
  // -------------------------------------------------------------------------
  registry.register("desktop.run_automation", async (input, ctx) => {
    const action = String(input.action ?? "");
    const VALID = ["click", "set_value", "get_value", "toggle", "focus"];
    if (!VALID.includes(action)) {
      return { ok: false, error: `action 必须是 ${VALID.join("/")} 之一，收到 ${action}` };
    }
    const selector =
      input.selector && typeof input.selector === "object"
        ? (input.selector as Record<string, unknown>)
        : null;
    if (!selector || Object.keys(selector).length === 0) {
      return { ok: false, error: "selector 不能为空(至少给 name/control_type/automation_id 之一)" };
    }
    if (action === "set_value" && typeof input.value !== "string") {
      return { ok: false, error: "set_value 需要 value 字符串参数" };
    }
    recordToolCallForTurn(ctx, "desktop.run_automation");

    const actorId = resolveActorId(ctx);
    const startedAt = new Date().toISOString();
    const auditPromise = deps.audit
      ?.record({
        kind: "desktop.run_automation",
        actorId,
        command: `${action} ${JSON.stringify(selector).slice(0, 200)}`,
        shell: null,
        allowDestructive: false,
        cwd: null,
        timeoutMs: 15_000,
        startedAt,
      })
      .catch(() => undefined);

    // run_automation 走 bridge + localVisual 双路径(与 uia_query 一致)
    const payload: Record<string, unknown> = {
      action: "run_automation",
      action_name: action,
      selector,
      value: typeof input.value === "string" ? input.value : null,
      index: typeof input.index === "number" ? input.index : 0,
      topOnly: typeof input.topOnly === "boolean" ? input.topOnly : true,
    };

    let out: Record<string, unknown>;
    if (deps.bridge.hasExecutor(actorId)) {
      const remote = await deps.bridge.invoke(
        actorId,
        payload,
        Math.min(desktopBridgeInvokeTimeoutMs(), 20_000),
      );
      out = remote ? { ...remote } : { ok: false, error: "电脑端执行器在调度瞬间不可用，请重试" };
    } else if (deps.localVisual.isEnabled() && deps.localVisual.runAutomation) {
      out = await deps.localVisual.runAutomation({
        action: action as "click" | "set_value" | "get_value" | "toggle" | "focus",
        selector,
        value: typeof input.value === "string" ? input.value : undefined,
        index: typeof input.index === "number" ? input.index : 0,
        topOnly: typeof input.topOnly === "boolean" ? input.topOnly : true,
      });
    } else {
      out = { ok: false, error: desktopUnavailableMessage(bridgeEnabled) };
    }

    await auditPromise;
    return out;
  });

  // -------------------------------------------------------------------------
  // desktop.http_get：原生 HTTP GET(用 requests,不走 shell 避免注入)
  // 替代 shell curl 调用。带 SSRF 防护、超时、响应体截断。
  // 不受 DESKTOP_SHELL_ENABLED 门控(它是独立工具,不是 shell)。
  // -------------------------------------------------------------------------
  registry.register("desktop.http_get", async (input, ctx) => {
    const url = String(input.url ?? "").trim();
    if (!url) {
      return { ok: false, error: "url 不能为空" };
    }
    if (!/^https?:\/\//i.test(url)) {
      return { ok: false, error: "url 必须以 http:// 或 https:// 开头" };
    }
    const headers =
      input.headers && typeof input.headers === "object" && !Array.isArray(input.headers)
        ? (input.headers as Record<string, string>)
        : undefined;
    const timeoutMs =
      typeof input.timeoutMs === "number" && Number.isFinite(input.timeoutMs)
        ? Math.max(1000, Math.min(60000, Math.floor(input.timeoutMs)))
        : 15000;
    recordToolCallForTurn(ctx, "desktop.http_get");

    const actorId = resolveActorId(ctx);
    const startedAt = new Date().toISOString();
    const auditPromise = deps.audit
      ?.record({
        kind: "desktop.http_get",
        actorId,
        command: `GET ${url.slice(0, 200)}`,
        shell: null,
        allowDestructive: false,
        cwd: null,
        timeoutMs,
        startedAt,
      })
      .catch(() => undefined);

    // http_get 走 bridge + localVisual 双路径(与 run_automation 一致)
    const payload: Record<string, unknown> = {
      action: "http_get",
      url,
      headers: headers ?? null,
      timeoutMs,
    };

    let out: Record<string, unknown>;
    if (deps.bridge.hasExecutor(actorId)) {
      const remote = await deps.bridge.invoke(
        actorId,
        payload,
        Math.min(desktopBridgeInvokeTimeoutMs(), timeoutMs + 5000),
      );
      out = remote ? { ...remote } : { ok: false, error: "电脑端执行器在调度瞬间不可用，请重试" };
    } else if (deps.localVisual.isEnabled() && deps.localVisual.httpGet) {
      out = await deps.localVisual.httpGet({ url, headers, timeoutMs });
    } else {
      out = { ok: false, error: desktopUnavailableMessage(bridgeEnabled) };
    }

    await auditPromise;
    return out;
  });

  // -------------------------------------------------------------------------
  // desktop.web_search：桌面端联网搜索(Bing CN)
  // 用 requests 抓取 Bing 搜索结果,解析 HTML 提取标题/URL/摘要。
  // 不依赖服务端,桌面本机直接联网。带 SSRF 防护。
  // -------------------------------------------------------------------------
  registry.register("desktop.web_search", async (input, ctx) => {
    const query = String(input.query ?? "").trim();
    if (!query) {
      return { ok: false, error: "query 不能为空" };
    }
    const limit =
      typeof input.limit === "number" && Number.isFinite(input.limit)
        ? Math.max(1, Math.min(20, Math.floor(input.limit)))
        : 8;
    recordToolCallForTurn(ctx, "desktop.web_search");

    const actorId = resolveActorId(ctx);
    const startedAt = new Date().toISOString();
    const auditPromise = deps.audit
      ?.record({
        kind: "desktop.web_search",
        actorId,
        command: `search "${query.slice(0, 100)}"`,
        shell: null,
        allowDestructive: false,
        cwd: null,
        timeoutMs: 25000,
        startedAt,
      })
      .catch(() => undefined);

    const payload: Record<string, unknown> = {
      action: "web_search",
      query,
      limit,
    };

    let out: Record<string, unknown>;
    if (deps.bridge.hasExecutor(actorId)) {
      const remote = await deps.bridge.invoke(
        actorId,
        payload,
        Math.min(desktopBridgeInvokeTimeoutMs(), 30000),
      );
      out = remote ? { ...remote } : { ok: false, error: "电脑端执行器在调度瞬间不可用，请重试" };
    } else if (deps.localVisual.isEnabled() && deps.localVisual.webSearch) {
      out = await deps.localVisual.webSearch({ query, limit });
    } else {
      out = { ok: false, error: desktopUnavailableMessage(bridgeEnabled) };
    }

    await auditPromise;
    return out;
  });

  // -------------------------------------------------------------------------
  // desktop.web_fetch：桌面端网页抓取
  // 用 requests 抓取 URL,提取纯文本正文(去 HTML 标签/脚本/样式)。
  // 返回标题+摘要+正文。带 SSRF 防护。
  // -------------------------------------------------------------------------
  registry.register("desktop.web_fetch", async (input, ctx) => {
    const url = String(input.url ?? "").trim();
    if (!url) {
      return { ok: false, error: "url 不能为空" };
    }
    if (!/^https?:\/\//i.test(url)) {
      return { ok: false, error: "url 必须以 http:// 或 https:// 开头" };
    }
    recordToolCallForTurn(ctx, "desktop.web_fetch");

    const actorId = resolveActorId(ctx);
    const startedAt = new Date().toISOString();
    const auditPromise = deps.audit
      ?.record({
        kind: "desktop.web_fetch",
        actorId,
        command: `fetch ${url.slice(0, 200)}`,
        shell: null,
        allowDestructive: false,
        cwd: null,
        timeoutMs: 25000,
        startedAt,
      })
      .catch(() => undefined);

    const payload: Record<string, unknown> = {
      action: "web_fetch",
      url,
    };

    let out: Record<string, unknown>;
    if (deps.bridge.hasExecutor(actorId)) {
      const remote = await deps.bridge.invoke(
        actorId,
        payload,
        Math.min(desktopBridgeInvokeTimeoutMs(), 30000),
      );
      out = remote ? { ...remote } : { ok: false, error: "电脑端执行器在调度瞬间不可用，请重试" };
    } else if (deps.localVisual.isEnabled() && deps.localVisual.webFetch) {
      out = await deps.localVisual.webFetch({ url });
    } else {
      out = { ok: false, error: desktopUnavailableMessage(bridgeEnabled) };
    }

    await auditPromise;
    return out;
  });

  // -------------------------------------------------------------------------
  // desktop.run_preset：调用预打包的常用命令（token 更省）
  // 受 DESKTOP_SHELL_ENABLED 门控 + bridge 鉴权（与 run_shell 一致）。
  // 预设命令首 token 均在白名单内，无需 allowDestructive。
  // -------------------------------------------------------------------------
  registry.register("desktop.run_preset", async (input, ctx) => {
    const preset = typeof input.preset === "string" ? input.preset.trim() : "";
    if (!preset) {
      return { ok: false, error: "缺少 preset" };
    }
    if (!isShellCommandAllowedByFeatureFlag()) {
      return {
        ok: false,
        error: "desktop.run_preset 未启用：在 server/.env.local 设置 DESKTOP_SHELL_ENABLED=1。",
      };
    }
    if (!deps.bridge.isBridgeFeatureEnabled()) {
      return {
        ok: false,
        error: "desktop.run_preset 强制要求 DESKTOP_BRIDGE_ENABLED=1 或 DESKTOP_BRIDGE_TOKEN（≥8 字符）以做鉴权。",
      };
    }

    const args = (input.args && typeof input.args === "object" ? input.args : {}) as Record<
      string,
      unknown
    >;
    const built = buildPresetCommand(preset, args);
    if ("error" in built) {
      return { ok: false, error: built.error };
    }
    const { command, shell } = built;
    const timeoutMs = clampShellTimeout(input.timeoutMs);
    const actorId = resolveActorId(ctx);

    const startedAt = new Date().toISOString();
    const auditPromise = deps.audit
      ?.record({
        kind: "desktop.run_preset",
        actorId,
        command: `${preset} → ${command}`.slice(0, 400),
        shell,
        allowDestructive: false,
        cwd: null,
        timeoutMs,
        startedAt,
      })
      .catch(() => undefined);

    const payload: Record<string, unknown> = {
      action: "run_shell",
      command,
      shell,
      cwd: null,
      timeoutMs,
      allowDestructive: false,
    };

    let out: Record<string, unknown>;
    if (deps.bridge.hasExecutor(actorId)) {
      const remote = await deps.bridge.invoke(
        actorId,
        payload,
        Math.min(desktopBridgeInvokeTimeoutMs(), timeoutMs + 5_000),
      );
      out = remote ? { ...remote } : { ok: false, error: "电脑端执行器在调度瞬间不可用，请重试" };
    } else if (deps.localVisual.isEnabled() && deps.localVisual.runShell) {
      out = await deps.localVisual.runShell({
        command,
        shell,
        cwd: null,
        timeoutMs,
        allowDestructive: false,
      });
    } else {
      out = { ok: false, error: desktopUnavailableMessage(bridgeEnabled) };
    }

    await auditPromise;
    return out;
  });
}

// ---- helpers ----

function isShellCommandAllowedByFeatureFlag(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.DESKTOP_SHELL_ENABLED?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

function isShellAllowlistDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.DESKTOP_SHELL_ALLOWLIST?.trim().toLowerCase();
  // 默认白名单开（allowlist=1）；只有显式 0/false/no/off 才关
  if (raw === "0" || raw === "false" || raw === "no" || raw === "off") return true;
  if (raw === "1" || raw === "true" || raw === "yes" || raw === "on") return false;
  return false;
}

function clampShellTimeout(raw: unknown): number {
  // 默认 30s，硬上限 5min，下限 1s
  const n = typeof raw === "number" && Number.isFinite(raw) ? raw : 30_000;
  return Math.max(1_000, Math.min(300_000, Math.floor(n)));
}

// ---- 预设命令表（desktop.run_preset）----
// 每条预设：固定 shell + build(args) → 命令字符串。所有命令首 token 均在白名单内。
// 路径参数做基本防注入：CMD 剥危险字符后双引号包裹；PowerShell 单引号包裹并内部 ' 翻倍。

function safeCmdArg(s: unknown): string {
  // CMD 元字符 & | < > ^ % " 全部剥掉，防止截断/管道逃逸
  const cleaned = String(s ?? "").replace(/[&|<>^%"]/g, "");
  return `"${cleaned}"`;
}

function safePsArg(s: unknown): string {
  // PowerShell 用单引号包裹，内部 ' 翻倍转义
  const cleaned = String(s ?? "").replace(/'/g, "''");
  return `'${cleaned}'`;
}

type PresetDef = {
  shell: "cmd" | "powershell";
  build: (args: Record<string, unknown>) => string;
};

const SHELL_PRESETS: Record<string, PresetDef> = {
  // ---- CMD 倾向（简单单行）----
  list_dir: {
    shell: "cmd",
    build: (a) => `dir ${safeCmdArg(a.path)}`,
  },
  read_file: {
    shell: "cmd",
    build: (a) => `type ${safeCmdArg(a.path)}`,
  },
  file_info: {
    shell: "cmd",
    build: (a) => `dir ${safeCmdArg(a.path)}`,
  },
  find_files: {
    shell: "cmd",
    build: (a) => `dir /s /b ${safeCmdArg(String(a.path ?? "") + "\\" + String(a.pattern ?? "*"))}`,
  },
  ping: {
    shell: "cmd",
    build: (a) => {
      const count = typeof a.count === "number" && a.count > 0 ? Math.floor(a.count) : 4;
      return `ping -n ${count} ${safeCmdArg(a.host)}`;
    },
  },
  ipconfig: {
    shell: "cmd",
    build: (a) => (a.all ? "ipconfig /all" : "ipconfig"),
  },
  netstat: {
    shell: "cmd",
    build: () => "netstat -an",
  },
  nslookup: {
    shell: "cmd",
    build: (a) => `nslookup ${safeCmdArg(a.host)}`,
  },
  systeminfo: {
    shell: "cmd",
    build: () => "systeminfo",
  },
  tasklist: {
    shell: "cmd",
    build: (a) => {
      const f = typeof a.filter === "string" && a.filter.trim() ? a.filter.trim() : "";
      return f ? `tasklist /fi ${safeCmdArg("imagename eq " + f)}` : "tasklist";
    },
  },
  // ---- PowerShell 倾向（系统查询/批量）----
  processes: {
    shell: "powershell",
    build: (a) => {
      const name = typeof a.name === "string" && a.name.trim() ? a.name.trim() : "";
      const head = name ? `Get-Process -Name ${safePsArg(name)}` : "Get-Process";
      return `${head} | Select-Object Name,Id,CPU,WS | Format-Table -AutoSize`;
    },
  },
  services: {
    shell: "powershell",
    build: (a) => {
      const status = typeof a.status === "string" && a.status.trim() ? a.status.trim() : "";
      const head = status
        ? `Get-Service | Where-Object {$_.Status -eq ${safePsArg(status)}}`
        : "Get-Service";
      return `${head} | Format-Table -AutoSize`;
    },
  },
  disk_usage: {
    shell: "powershell",
    build: () => "Get-PSDrive -PSProvider FileSystem | Format-Table",
  },
  env_vars: {
    shell: "powershell",
    build: () => "Get-ChildItem Env: | Format-Table",
  },
  installed_apps: {
    shell: "powershell",
    build: () =>
      "Get-ItemProperty HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*," +
      " HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\* " +
      "| Select-Object -First 200 DisplayName,DisplayVersion,InstallLocation " +
      "| Format-Table -AutoSize",
  },
  // 注意：find_app / find_executable 已删除。
  // 这两条原本用于按名查找已装应用/可执行文件路径,
  // 与 desktop.open 的应用搜索逻辑(_find_exe + _find_start_menu_shortcut + 别名表)完全重叠。
  // 应用搜索统一走 desktop.open 即可。
  network_adapter: {
    shell: "powershell",
    build: () => "Get-NetAdapter | Format-Table",
  },
};

function buildPresetCommand(
  preset: string,
  args: Record<string, unknown>,
): { command: string; shell: "cmd" | "powershell" } | { error: string } {
  const def = SHELL_PRESETS[preset];
  if (!def) {
    return { error: `未知预设 '${preset}'，可用预设：${Object.keys(SHELL_PRESETS).join(", ")}` };
  }
  try {
    return { command: def.build(args ?? {}), shell: def.shell };
  } catch (e) {
    return { error: `预设 ${preset} 参数构造失败: ${e}` };
  }
}
