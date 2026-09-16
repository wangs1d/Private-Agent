import { resolveActorId } from "../../../agent/actor-id.js";
import type { ToolHandler, ToolRegistry } from "../../tool-registry.js";
import type { SharedBrowserCoordinator } from "../../../services/shared-browser-coordinator.js";

/**
 * shared_browser.* 工具 handler 集合 + 注册入口。
 *
 * 执行端不在服务端，而在客户端（Flutter Windows）的 WebView2 浏览器里：
 * handler 把动作经 SharedBrowserCoordinator 转发到用户当前打开的浏览器，
 * 用户与 Agent 共用同一个页面（用户的登录态、Cookie 天然可用）。
 *
 * 安全：协调器内部对每次 invoke/failed 写审计日志（category "shared_browser"）；
 * 浏览器在线检查前置（离线时立即失败，不排队）。
 */
export interface SharedBrowserModuleDeps {
  sharedBrowserCoordinator: SharedBrowserCoordinator;
}

function offlineResult() {
  return {
    ok: false,
    error: "共用浏览器未连接：请让用户打开客户端「常用工具 → 浏览器」后重试",
    retryable: false,
  };
}

function createInvokeHandler(
  coordinator: SharedBrowserCoordinator,
  action: string,
  buildParams: (input: Record<string, unknown>) => Record<string, unknown>,
  validate?: (input: Record<string, unknown>) => string | null,
): ToolHandler {
  return async (input: Record<string, unknown>, context) => {
    const invalid = validate?.(input);
    if (invalid) return { ok: false, error: invalid };

    const actorId = resolveActorId(context);
    if (!coordinator.hasExecutor(actorId)) return offlineResult();
    return coordinator.invoke(actorId, action, buildParams(input));
  };
}

/**
 * 注册 shared-browser 全部工具到 ToolRegistry。
 *
 * 调用方：`capability-modules/index.ts` 的 `buildCapabilityModules` 闭包。
 */
export function registerSharedBrowserTools(
  registry: ToolRegistry,
  deps: SharedBrowserModuleDeps,
): void {
  const { sharedBrowserCoordinator } = deps;

  registry.register(
    "shared_browser.navigate",
    createInvokeHandler(sharedBrowserCoordinator, "navigate", (input) => ({
      url: String(input.url ?? "").trim(),
    }), (input) => (String(input.url ?? "").trim() ? null : "缺少 url")),
  );

  registry.register(
    "shared_browser.control",
    createInvokeHandler(sharedBrowserCoordinator, "control", (input) => ({
      action: String(input.action ?? ""),
    }), (input) => {
      const action = String(input.action ?? "");
      return ["back", "forward", "reload", "stop", "home"].includes(action)
        ? null
        : "action 须为 back/forward/reload/stop/home 之一";
    }),
  );

  registry.register(
    "shared_browser.click",
    createInvokeHandler(sharedBrowserCoordinator, "click", (input) => ({
      selector: typeof input.selector === "string" ? input.selector : undefined,
      text: typeof input.text === "string" ? input.text : undefined,
      index: typeof input.index === "number" ? input.index : undefined,
    }), (input) =>
      (typeof input.selector === "string" && input.selector.trim())
      || (typeof input.text === "string" && input.text.trim())
      || typeof input.index === "number"
        ? null
        : "selector / text / index 至少传一个"),
  );

  registry.register(
    "shared_browser.type",
    createInvokeHandler(sharedBrowserCoordinator, "type", (input) => ({
      selector: typeof input.selector === "string" ? input.selector : undefined,
      text: String(input.text ?? ""),
      submit: input.submit === true,
      clear: input.clear !== false,
    }), (input) => (String(input.text ?? "") ? null : "缺少 text")),
  );

  registry.register(
    "shared_browser.scroll",
    createInvokeHandler(sharedBrowserCoordinator, "scroll", (input) => ({
      deltaY: typeof input.deltaY === "number" ? input.deltaY : undefined,
      to: typeof input.to === "string" ? input.to : undefined,
    })),
  );

  registry.register(
    "shared_browser.read_page",
    createInvokeHandler(sharedBrowserCoordinator, "read_page", (input) => ({
      selector: typeof input.selector === "string" && input.selector.trim()
        ? input.selector
        : undefined,
      includeInteractive: input.includeInteractive !== false,
      maxChars: typeof input.maxChars === "number" ? input.maxChars : undefined,
    })),
  );
}
