export type AgentReply = {
  text: string;
  toolName?: string;
  toolInput?: Record<string, unknown>;
  /** 即时路径已执行工具时附带结果，避免 WebSocket 层重复开桌 */
  toolResult?: Record<string, unknown>;
  /** 为 true 时表示外部模型已通过 onAssistantDelta 推送过增量，WebSocket 层勿再对 text 做 chunkText */
  streamedChunks?: boolean;
  /** 语义意图理解不明确时，向用户发起澄清反问 */
  clarification?: {
    question: string;
    options?: string[];
  };
  /**
   * 本轮实际发起过的工具调用摘要（toolName(参数要点)，onToolExecuteStart 采集，上限 12 条）。
   * 后台任务升级段用它延续快通道的执行轨迹，避免整轮从零重跑（A2）。
   */
  attemptedToolCalls?: string[];
};
