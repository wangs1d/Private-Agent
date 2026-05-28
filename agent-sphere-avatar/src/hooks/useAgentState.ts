import { useCallback, useState } from "react";
import type { AgentMood, AgentState } from "../types/agent";
import { DEFAULT_AGENT_STATE } from "../types/agent";

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

  return { state, setState, setMood, setEnergy, setFocused, setCaption, apply };
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
