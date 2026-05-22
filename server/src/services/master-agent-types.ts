/** 子 Agent 类型 — 主 Agent 可委派的专业角色 */

export type SubAgentType =
  | "life"
  | "work"
  | "social"
  | "entertainment"
  | "finance"
  | "tech"
  | "info"
  | "general";

export interface SubAgentCapability {
  type: SubAgentType;
  name: string;
  description: string;
  keywords: string[];
  tools: string[];
}

export interface SubTask {
  id: string;
  description: string;
  assignedAgent: SubAgentType;
  priority: number;
  dependencies: string[];
  estimatedComplexity: "low" | "medium" | "high";
}

export interface SubAgentResult {
  taskId: string;
  agentType: SubAgentType;
  success: boolean;
  result: string;
  metadata?: Record<string, unknown>;
  executionTime?: number;
}
