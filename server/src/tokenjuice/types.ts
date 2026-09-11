export type ToolOutputCompactInput = {
  toolName: string;
  ok: boolean;
  result: Record<string, unknown>;
  preferredMaxChars?: number;
  stripKeys?: string[];
};

export type ToolOutputCompactOutput = {
  content: string;
  rawBytes: number;
  compactBytes: number;
  ruleId?: string;
  compacted: boolean;
  /**
   * 压缩前的完整原文（strip 后 JSON 序列化文本）。
   * ObservationPack（external-model/observation-pack.ts）在压缩点用它归档
   * obs_recall 句柄；部分早期返回路径可能缺省。
   */
  rawText?: string;
};
