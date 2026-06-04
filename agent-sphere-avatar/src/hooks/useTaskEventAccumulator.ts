import { useCallback, useRef } from "react";
import type { TaskEvent } from "../types/agent";

/**
 * 将 TaskEvent 流累积到 state.taskEvents 数组中，并修剪上限。
 * 复用 useAgentState 的 apply 函数推送增量。
 */
export interface UseTaskEventAccumulatorOptions {
  maxEvents?: number;
  apply: (patch: { taskEvents: TaskEvent[] }) => void;
}

export function useTaskEventAccumulator({
  maxEvents = 60,
  apply,
}: UseTaskEventAccumulatorOptions) {
  const bufferRef = useRef<TaskEvent[]>([]);

  const onTaskEvent = useCallback(
    (event: TaskEvent) => {
      const next = [...bufferRef.current, event];
      const trimmed = next.length > maxEvents ? next.slice(-maxEvents) : next;
      bufferRef.current = trimmed;
      apply({ taskEvents: trimmed });
    },
    [apply, maxEvents],
  );

  const clear = useCallback(() => {
    bufferRef.current = [];
    apply({ taskEvents: [] });
  }, [apply]);

  return { onTaskEvent, clear };
}
