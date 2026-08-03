import { useCallback, useState } from "react";
import type { AgentMood, AgentState } from "../types/agent";
import { DEFAULT_AGENT_STATE } from "../types/agent";
import type { Message } from "../components/MessageList";

function makeId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

export function useAgentState(initial?: Partial<AgentState>) {
  const [state, setState] = useState<AgentState>({
    ...DEFAULT_AGENT_STATE,
    ...initial,
  });

  const setMood = useCallback((mood: AgentMood) => {
    setState((prev) => ({ ...prev, mood }));
  }, []);

  const setEnergy = useCallback((energy: number) => {
    setState((prev) => ({ ...prev, energy: Math.min(1, Math.max(0, energy)) }));
  }, []);

  const setFocused = useCallback((focused: boolean) => {
    setState((prev) => ({ ...prev, focused }));
  }, []);

  const setCaption = useCallback((caption: string | undefined) => {
    setState((prev) => ({ ...prev, caption }));
  }, []);

  const apply = useCallback((patch: Partial<AgentState>) => {
    setState((prev) => ({ ...prev, ...patch }));
  }, []);

  /** 追加一条新消息（user / agent） */
  const pushMessage = useCallback((role: "user" | "agent", content: string) => {
    const msg: Message = {
      id: makeId(role),
      role,
      content,
      timestamp: new Date(),
    };
    setState((prev) => ({ ...prev, messages: [...(prev.messages ?? []), msg] }));
    return msg.id;
  }, []);

  /**
   * 追加文本到最后一条指定 role 的消息；
   * 若最后一条不是该 role，则新建一条。
   * 返回目标消息 id（用于后续 finalize）。
   */
  const appendToLastMessage = useCallback(
    (role: "user" | "agent", text: string): string => {
      let targetId = "";
      setState((prev) => {
        const list = prev.messages ?? [];
        const last = list[list.length - 1];
        if (last && last.role === role) {
          targetId = last.id;
          const updated: Message = { ...last, content: last.content + text };
          return { ...prev, messages: [...list.slice(0, -1), updated] };
        }
        targetId = makeId(role);
        const msg: Message = { id: targetId, role, content: text, timestamp: new Date() };
        return { ...prev, messages: [...list, msg] };
      });
      return targetId;
    },
    [],
  );

  /** 清空消息历史 */
  const clearMessages = useCallback(() => {
    setState((prev) => ({ ...prev, messages: [] }));
  }, []);

  return {
    state,
    setState,
    setMood,
    setEnergy,
    setFocused,
    setCaption,
    apply,
    pushMessage,
    appendToLastMessage,
    clearMessages,
  };
}

/** 呼吸灯相位 — 供材质动画使用 */
export function useBreathingPhase(speed = 1.2, energy = 0.55) {
  return useCallback(
    (elapsed: number) => {
      const base = (Math.sin(elapsed * speed) + 1) * 0.5;
      return 0.15 + base * (0.35 + energy * 0.5);
    },
    [speed, energy],
  );
}
