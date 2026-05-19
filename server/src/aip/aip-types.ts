/** AI 原生交互协议（AIP）v0.1 — 与厂商/模型无关的结构化跨 Agent 消息。 */

export const AIP_VERSION = "0.1" as const;

/**
 * 交互原语（可组合；具体语义见 docs/AIP.md）。
 * - dialogue：自然语言 + 可选意图标签
 * - trade_*：交易意向（执行仍落 World/A2A 等既有子系统）
 * - alliance_*：结盟邀请与回应
 * - conflict_*：冲突宣告与回应（非裁判，仅状态同步）
 */
export type AipKind =
  | "utterance"
  | "trade_proposal"
  | "trade_response"
  | "alliance_invite"
  | "alliance_response"
  | "conflict_declare"
  | "conflict_response";

export type AipWireEnvelope = {
  aipVersion: typeof AIP_VERSION;
  kind: AipKind;
  payload: Record<string, unknown>;
  /** 回应时关联对方消息或本地提议 */
  correlationId?: string;
  /** 服务侧生成的提议 ID（部分 kind 在投递后回填） */
  proposalId?: string;
};

export type AllianceRecord = {
  allianceId: string;
  members: string[];
  createdAt: string;
  /** 邀请方视为发起者（用于展示） */
  leaderSessionId?: string;
};

export type ConflictRecord = {
  conflictId: string;
  declarerSessionId: string;
  targetSessionId: string;
  reason: string;
  status: "open" | "withdrawn" | "truce_offered" | "closed";
  createdAt: string;
  updatedAt: string;
};

export type AipProposalRecord = {
  proposalId: string;
  kind: AipKind;
  fromSessionId: string;
  toSessionId: string;
  payload: Record<string, unknown>;
  status: "pending" | "accepted" | "rejected" | "superseded";
  createdAt: string;
};
