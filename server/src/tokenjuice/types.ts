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
};
