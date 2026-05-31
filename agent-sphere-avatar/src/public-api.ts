/**
 * Agent Sphere Avatar — 公共 API
 *
 * 移植到其他项目时可：
 * 1. 复制整个 agent-sphere-avatar/ 目录
 * 2. npm install && npm run build:standalone
 * 3. 静态托管 dist/，用 createSphereHost 或 iframe + postMessage 集成
 */
export type {
  AgentMood,
  AgentState,
  EmbodimentCommand,
  EmbodimentCommandAction,
  EmbodimentInteractAction,
  EmbodimentInteractPayload,
} from "./types/agent";
export { DEFAULT_AGENT_STATE } from "./types/agent";

export {
  SPHERE_NS,
  SPHERE_MSG,
  SPHERE_HOST_MSG,
  SPHERE_DOM_EVENT,
  SPHERE_QUERY,
  PAI_EMBODIMENT_COMMAND,
  isWsOffMode,
  readSphereQuery,
  parseHostPatch,
  parseHostCommand,
  postToHost,
  postPatchToSphere,
  postCommandToSphere,
} from "./embed-protocol";
export type {
  SpherePatchMessage,
  SphereCommandMessage,
  SphereSendMessage,
  SphereHostInbound,
  SphereIframeOutbound,
} from "./embed-protocol";

export {
  bindAgentBridge,
  emitAgentMood,
  emitAgentEnergy,
  emitAgentCaption,
  dispatchEmbodimentCommand,
  bindEmbodimentCommand,
} from "./bridge/agent-bridge";
export type { AgentBridgeHandlers } from "./bridge/agent-bridge";

export { mapWsToAgentUpdate, resetWsMapperState } from "./bridge/ws-agent-mapper";
export type { AgentWsUpdate, WsEnvelope } from "./bridge/ws-agent-mapper";

export { createSphereHost, buildEmbedUrl } from "./host-sdk";
export type { SphereHostOptions, SphereHostController } from "./host-sdk";

export { SphereAgentScene } from "./components/SphereAgentScene";
export { SphereAgent } from "./components/SphereAgent";
export { useAgentState } from "./hooks/useAgentState";
