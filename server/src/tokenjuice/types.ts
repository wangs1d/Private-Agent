export type ToolOutputCompactInput = {
  toolName: string;
  ok: boolean;
  result: Record<string, unknown>;
};

export type ToolOutputCompactOutput = {
  content: string;
  rawBytes: number;
  compactBytes: number;
  ruleId?: string;
  compacted: boolean;
};
