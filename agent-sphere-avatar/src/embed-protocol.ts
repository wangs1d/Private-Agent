/**
 * Agent Sphere 嵌入协议 — 单一事实来源
 *
 * 宿主页面与 iframe 之间通过 postMessage 通信。
 * 移植到其他项目时，只需遵守此协议，无需依赖 PAI 服务端。
 */
import type {
  AgentMood,
  AgentState,
  EmbodimentCommand,
  EmbodimentCommandAction,
  EmbodimentInteractAction,
  TaskEvent,
} from "./types/agent";

/** postMessage / CustomEvent 命名空间前缀 */
export const SPHERE_NS = "agent-sphere" as const;

/** iframe → 宿主 */
export const SPHERE_MSG = {
  ready: `${SPHERE_NS}:ready`,
  send: `${SPHERE_NS}:send`,
  touch: `${SPHERE_NS}:touch`,
  interact: `${SPHERE_NS}:interact`,
  boundary: `${SPHERE_NS}:boundary`,
  command: `${SPHERE_NS}:command`,
  pan: `${SPHERE_NS}:pan`,
} as const;

/** 宿主 → iframe */
export const SPHERE_HOST_MSG = {
  patch: `${SPHERE_NS}:patch`,
  command: `${SPHERE_NS}:command`,
} as const;

/** 兼容 PAI 服务端直推 */
export const PAI_EMBODIMENT_COMMAND = "agent.embodiment.command" as const;

/** 同页 CustomEvent（非 iframe 场景） */
export const SPHERE_DOM_EVENT = {
  mood: `${SPHERE_NS}:set-mood`,
  energy: `${SPHERE_NS}:set-energy`,
  caption: `${SPHERE_NS}:set-caption`,
  command: SPHERE_HOST_MSG.command,
} as const;

/** URL 查询参数 */
export const SPHERE_QUERY = {
  wsOff: "wsOff",
  ws: "ws",
  sessionId: "sessionId",
} as const;

export type SphereHostMessageType =
  (typeof SPHERE_HOST_MSG)[keyof typeof SPHERE_HOST_MSG];

export type SphereIframeMessageType =
  (typeof SPHERE_MSG)[keyof typeof SPHERE_MSG];

/** 宿主 → iframe 状态补丁 */
export type SpherePatchMessage = Partial<
  Pick<
    AgentState,
    | "mood"
    | "energy"
    | "caption"
    | "phase"
    | "subAgentType"
    | "subAgentDisplayName"
    | "source"
    | "taskEvents"
  >
> & {
  type: typeof SPHERE_HOST_MSG.patch;
  /** null 表示清除 caption */
  caption?: string | null;
};

/** 宿主 → iframe 具身指令 */
export type SphereCommandMessage = EmbodimentCommand & {
  type: typeof SPHERE_HOST_MSG.command | typeof PAI_EMBODIMENT_COMMAND;
};

/** iframe → 宿主 用户交互 */
export type SphereSendMessage = {
  type: typeof SPHERE_MSG.send;
  action: EmbodimentInteractAction;
  text?: string;
};

export type SphereReadyMessage = { type: typeof SPHERE_MSG.ready };

export type SphereTouchMessage = {
  type: typeof SPHERE_MSG.touch;
  phase: "start" | "drag" | "end";
  spinStrength?: number;
  totalRotationDeg?: number;
};

export type SphereBoundaryMessage = {
  type: typeof SPHERE_MSG.boundary;
  edge: "left" | "right" | "top" | "bottom";
};

export type SpherePanMessage = {
  type: typeof SPHERE_MSG.pan;
  dx: number;
  dy: number;
};

export type SphereIframeOutbound =
  | SphereReadyMessage
  | SphereSendMessage
  | SphereTouchMessage
  | SphereBoundaryMessage
  | SpherePanMessage
  | SphereCommandMessage;

export type SphereHostInbound = SpherePatchMessage | SphereCommandMessage;

const COMMAND_ACTIONS: ReadonlySet<EmbodimentCommandAction> = new Set([
  "roam",
  "move",
  "stop",
  "window_roam",
  "window_place",
  "query_state",
  "excite",
]);

export function isSphereCommandAction(
  action: unknown,
): action is EmbodimentCommandAction {
  return typeof action === "string" && COMMAND_ACTIONS.has(action as EmbodimentCommandAction);
}

export function readSphereQuery(key: keyof typeof SPHERE_QUERY): string | undefined {
  return new URLSearchParams(window.location.search).get(SPHERE_QUERY[key]) ?? undefined;
}

export function isWsOffMode(): boolean {
  return readSphereQuery("wsOff") === "1";
}

export function parseHostPatch(data: unknown): Partial<AgentState> | null {
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  if (d.type !== SPHERE_HOST_MSG.patch) return null;

  return {
    mood: d.mood as AgentMood | undefined,
    caption: d.caption === null ? undefined : (d.caption as string | undefined),
    energy: typeof d.energy === "number" ? d.energy : undefined,
    phase: d.phase ? String(d.phase) : undefined,
    subAgentType: d.subAgentType ? String(d.subAgentType) : undefined,
    subAgentDisplayName: d.subAgentDisplayName
      ? String(d.subAgentDisplayName)
      : undefined,
    source: d.source ? String(d.source) : undefined,
    taskEvents: Array.isArray(d.taskEvents)
      ? (d.taskEvents as TaskEvent[]).map((te) => ({
          ...te,
          timestamp: te.timestamp instanceof Date ? te.timestamp : new Date(te.timestamp ?? Date.now()),
        }))
      : undefined,
  };
}

/** 解析宿主 postMessage 为具身指令 */
export function parseHostCommand(data: unknown): EmbodimentCommand | null {
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  if (
    d.type !== SPHERE_HOST_MSG.command &&
    d.type !== PAI_EMBODIMENT_COMMAND
  ) {
    return null;
  }
  if (!isSphereCommandAction(d.action)) return null;

  return {
    action: d.action,
    x: typeof d.x === "number" ? d.x : undefined,
    y: typeof d.y === "number" ? d.y : undefined,
    z: typeof d.z === "number" ? d.z : undefined,
    strength: typeof d.strength === "number" ? d.strength : undefined,
    mood: d.mood as AgentMood | undefined,
    energy: typeof d.energy === "number" ? d.energy : undefined,
    caption:
      d.caption === null
        ? null
        : d.caption
          ? String(d.caption)
          : undefined,
    source: d.source ? String(d.source) : undefined,
  };
}

/** iframe 内：向宿主发送消息 */
export function postToHost(message: SphereIframeOutbound, targetOrigin = "*") {
  window.parent?.postMessage(message, targetOrigin);
}

/** 宿主侧：向 iframe 发送状态补丁 */
export function postPatchToSphere(
  frame: HTMLIFrameElement | null,
  patch: Omit<SpherePatchMessage, "type">,
  targetOrigin = "*",
) {
  frame?.contentWindow?.postMessage({ type: SPHERE_HOST_MSG.patch, ...patch }, targetOrigin);
}

/** 宿主侧：向 iframe 发送具身指令 */
export function postCommandToSphere(
  frame: HTMLIFrameElement | null,
  command: Omit<SphereCommandMessage, "type">,
  targetOrigin = "*",
) {
  frame?.contentWindow?.postMessage(
    { type: SPHERE_HOST_MSG.command, ...command },
    targetOrigin,
  );
}
