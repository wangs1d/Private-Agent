import { useEffect } from "react";
import { dispatchEmbodimentCommand } from "../bridge/agent-bridge";
import { parseHostCommand, parseHostPatch, postToHost, SPHERE_MSG } from "../embed-protocol";
import type { AgentState } from "../types/agent";

interface UseEmbedParentBridgeOptions {
  apply: (patch: Partial<AgentState>) => void;
  /** 收到 patch 后的额外回调 */
  onPatch?: (patch: Partial<AgentState>, raw: unknown) => void;
  /** 是否监听具身指令 */
  relayCommands?: boolean;
}

/**
 * iframe 嵌入模式：监听宿主 postMessage，转发 ready 信号。
 * embed.html 使用。
 */
export function useEmbedParentBridge({
  apply,
  onPatch,
  relayCommands = true,
}: UseEmbedParentBridgeOptions) {
  useEffect(() => {
    const onMessage = (ev: MessageEvent) => {
      const patch = parseHostPatch(ev.data);
      if (patch) {
        apply(patch);
        onPatch?.(patch, ev.data);
        return;
      }

      if (relayCommands) {
        const command = parseHostCommand(ev.data);
        if (command) dispatchEmbodimentCommand(command);
      }
    };

    window.addEventListener("message", onMessage);
    postToHost({ type: SPHERE_MSG.ready });
    return () => window.removeEventListener("message", onMessage);
  }, [apply, onPatch, relayCommands]);
}
