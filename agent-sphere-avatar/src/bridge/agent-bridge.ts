/**
 * 主项目集成桥 — 可通过 postMessage / 自定义事件驱动 Agent 状态
 *
 * 示例（在主项目 Web 壳中）：
 *   window.dispatchEvent(new CustomEvent('agent-sphere:set-mood', { detail: { mood: 'listening' } }));
 */
import type { AgentMood, EmbodimentCommand } from "../types/agent";
import { SPHERE_DOM_EVENT } from "../embed-protocol";

export type { AgentMood, AgentState, EmbodimentCommand } from "../types/agent";
export { DEFAULT_AGENT_STATE } from "../types/agent";
export { SphereAgentScene } from "../components/SphereAgentScene";
export { SphereAgent } from "../components/SphereAgent";
export { useAgentState } from "../hooks/useAgentState";

const MOOD_EVENT = SPHERE_DOM_EVENT.mood;
const ENERGY_EVENT = SPHERE_DOM_EVENT.energy;
const CAPTION_EVENT = SPHERE_DOM_EVENT.caption;
const COMMAND_EVENT = SPHERE_DOM_EVENT.command;

export interface AgentBridgeHandlers {
  onMood?: (mood: AgentMood) => void;
  onEnergy?: (energy: number) => void;
  onCaption?: (caption: string) => void;
}

export function bindAgentBridge(handlers: AgentBridgeHandlers): () => void {
  const onMood = (e: Event) => {
    const mood = (e as CustomEvent<{ mood: AgentMood }>).detail?.mood;
    if (mood) handlers.onMood?.(mood);
  };
  const onEnergy = (e: Event) => {
    const energy = (e as CustomEvent<{ energy: number }>).detail?.energy;
    if (typeof energy === "number") handlers.onEnergy?.(energy);
  };
  const onCaption = (e: Event) => {
    const caption = (e as CustomEvent<{ caption: string }>).detail?.caption;
    if (caption) handlers.onCaption?.(caption);
  };

  window.addEventListener(MOOD_EVENT, onMood);
  window.addEventListener(ENERGY_EVENT, onEnergy);
  window.addEventListener(CAPTION_EVENT, onCaption);

  return () => {
    window.removeEventListener(MOOD_EVENT, onMood);
    window.removeEventListener(ENERGY_EVENT, onEnergy);
    window.removeEventListener(CAPTION_EVENT, onCaption);
  };
}

export function emitAgentMood(mood: AgentMood) {
  window.dispatchEvent(new CustomEvent(MOOD_EVENT, { detail: { mood } }));
}

export function emitAgentEnergy(energy: number) {
  window.dispatchEvent(new CustomEvent(ENERGY_EVENT, { detail: { energy } }));
}

export function emitAgentCaption(caption: string) {
  window.dispatchEvent(new CustomEvent(CAPTION_EVENT, { detail: { caption } }));
}

export function dispatchEmbodimentCommand(command: EmbodimentCommand) {
  window.dispatchEvent(new CustomEvent(COMMAND_EVENT, { detail: command }));
}

export function bindEmbodimentCommand(handler: (command: EmbodimentCommand) => void): () => void {
  const onCommand = (e: Event) => {
    const cmd = (e as CustomEvent<EmbodimentCommand>).detail;
    if (cmd?.action) handler(cmd);
  };
  window.addEventListener(COMMAND_EVENT, onCommand);
  return () => window.removeEventListener(COMMAND_EVENT, onCommand);
}
