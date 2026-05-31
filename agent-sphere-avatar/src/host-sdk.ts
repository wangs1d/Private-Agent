/**
 * 宿主侧 SDK — 可在任意 Web 项目中嵌入球形 Agent iframe
 *
 * 用法见 PORTABLE.md
 */
import type { AgentState, EmbodimentCommand, EmbodimentInteractAction } from "./types/agent";
import {
  SPHERE_MSG,
  postCommandToSphere,
  postPatchToSphere,
  type SpherePatchMessage,
} from "./embed-protocol";

export type { AgentState, EmbodimentCommand, EmbodimentInteractAction };
export {
  SPHERE_HOST_MSG,
  SPHERE_MSG,
  postPatchToSphere,
  postCommandToSphere,
} from "./embed-protocol";
export { mapWsToAgentUpdate, resetWsMapperState } from "./bridge/ws-agent-mapper";
export type { AgentWsUpdate, WsEnvelope } from "./bridge/ws-agent-mapper";

export interface SphereHostOptions {
  /** iframe 元素或选择器 */
  frame: HTMLIFrameElement | string;
  /** embed.html 的完整 URL（含查询参数） */
  src?: string;
  /** postMessage targetOrigin，默认 "*" */
  targetOrigin?: string;
  onReady?: () => void;
  onSend?: (action: EmbodimentInteractAction, text?: string) => void;
  onTouch?: (detail: Record<string, unknown>) => void;
  onBoundary?: (edge: string) => void;
  onPan?: (dx: number, dy: number) => void;
  onCommand?: (command: EmbodimentCommand) => void;
}

export interface SphereHostController {
  frame: HTMLIFrameElement;
  patch: (patch: Omit<SpherePatchMessage, "type">) => void;
  command: (command: Omit<EmbodimentCommand, "type"> & { action: EmbodimentCommand["action"] }) => void;
  destroy: () => void;
}

function resolveFrame(frame: HTMLIFrameElement | string): HTMLIFrameElement {
  if (typeof frame === "string") {
    const el = document.querySelector(frame);
    if (!(el instanceof HTMLIFrameElement)) {
      throw new Error(`[agent-sphere] iframe not found: ${frame}`);
    }
    return el;
  }
  return frame;
}

/**
 * 绑定宿主 ↔ iframe 双向通信。
 * 推荐 embed 模式：`embed.html?wsOff=1`，由宿主统一管理 WebSocket。
 */
export function createSphereHost(options: SphereHostOptions): SphereHostController {
  const frame = resolveFrame(options.frame);
  const origin = options.targetOrigin ?? "*";

  if (options.src && frame.src !== options.src) {
    frame.src = options.src;
  }

  const onMessage = (ev: MessageEvent) => {
    if (ev.source !== frame.contentWindow) return;
    const data = ev.data;
    if (!data || typeof data !== "object") return;

    switch (data.type) {
      case SPHERE_MSG.ready:
        options.onReady?.();
        break;
      case SPHERE_MSG.send:
        options.onSend?.(data.action, data.text);
        break;
      case SPHERE_MSG.touch:
        options.onTouch?.(data as Record<string, unknown>);
        break;
      case SPHERE_MSG.boundary:
        options.onBoundary?.(data.edge);
        break;
      case SPHERE_MSG.pan:
        options.onPan?.(data.dx, data.dy);
        break;
      case SPHERE_MSG.command:
        if (data.action) options.onCommand?.(data as EmbodimentCommand);
        break;
      default:
        break;
    }
  };

  window.addEventListener("message", onMessage);

  return {
    frame,
    patch: (patch) => postPatchToSphere(frame, patch, origin),
    command: (command) => postCommandToSphere(frame, command, origin),
    destroy: () => window.removeEventListener("message", onMessage),
  };
}

/** 构建 embed URL — base 可为相对或绝对路径 */
export function buildEmbedUrl(
  basePath: string,
  params?: { wsOff?: boolean; sessionId?: string; ws?: string },
): string {
  const base = basePath.replace(/\/?$/, "/");
  const url = new URL(`${base}embed.html`, window.location.origin);
  if (params?.wsOff !== false) url.searchParams.set("wsOff", "1");
  if (params?.sessionId) url.searchParams.set("sessionId", params.sessionId);
  if (params?.ws) url.searchParams.set("ws", params.ws);
  return url.pathname + url.search;
}
