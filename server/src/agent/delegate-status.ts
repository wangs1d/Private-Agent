/**
 * 子 Agent 委派过程的「活人感」UI 文案（由模型生成，服务端只解析/透传）。
 */

import { MASTER_INVOKE_SUB_AGENT_REGISTRY } from "./master-subagent-delegate-tools.js";
import type { SubAgentType } from "../services/master-agent-types.js";

/** 子 Agent 报告末尾的「给用户看的进度/收尾」标记（由子 Agent 模型生成） */
export const USER_VISIBLE_PROGRESS_MARKER = "【用户可见进度】";

export type DelegateStatusPhase = "delegate_start" | "delegate_done" | "live" | "tool_start";

export type DelegateStatusPayload = {
  phase: DelegateStatusPhase;
  /** 主 Agent 或子 Agent 生成的口语化短句，直接展示给用户 */
  line: string;
  agentType?: SubAgentType;
  subAgentDisplayName?: string;
  toolName: string;
};

/**
 * 从工具参数（显式 userStatusLine / statusLine 字段）提取用户可见进度句。
 *
 * 从根源过滤"过程通报"：不再把 LLM 在 tool_calls 前的自然语言前言
 * （assistantPreamble，如"我帮你查查，稍等"）透传为 status 展示——
 * 那正是过程通报，前端会当 chat.agent_status 刷给用户。
 * 只有工具在设计上显式提供用户可见文案（如子 Agent 委派）时才保留。
 */
export function pickToolUserStatusLine(
  input: Record<string, unknown>,
  _assistantPreamble?: string,
): string | null {
  const fromInput = String(input.userStatusLine ?? input.statusLine ?? "").trim();
  return fromInput.length > 0 ? fromInput : null;
}

/** 主 Agent 调用 master.invoke_sub_agent 时必须填的 UI 文案字段 */
export function pickMasterDelegateStartLine(input: Record<string, unknown>): string | null {
  return pickToolUserStatusLine(input);
}

/** 从子 Agent 报告末尾解析【用户可见进度】行 */
export function pickSubAgentDoneLine(report: string): string | null {
  const text = report.trim();
  if (!text) return null;
  const re = /【用户可见进度】\s*([^\n【]+)/;
  const m = text.match(re);
  if (m?.[1]?.trim()) return m[1].trim();
  const idx = text.lastIndexOf(USER_VISIBLE_PROGRESS_MARKER);
  if (idx >= 0) {
    const tail = text.slice(idx + USER_VISIBLE_PROGRESS_MARKER.length).trim();
    const firstLine = tail.split("\n")[0]?.trim();
    if (firstLine) return firstLine;
  }
  return null;
}

export function isMasterInvokeSubAgentTool(toolName: string): boolean {
  const n = toolName.trim();
  return n === MASTER_INVOKE_SUB_AGENT_REGISTRY || n === "master_invoke_sub_agent";
}

export function buildDelegateStartPayload(
  input: Record<string, unknown>,
  agentName: string,
  agentType: SubAgentType,
): DelegateStatusPayload | null {
  const line = pickMasterDelegateStartLine(input);
  if (!line) return null;
  return {
    phase: "delegate_start",
    line,
    agentType,
    subAgentDisplayName: agentName,
    toolName: MASTER_INVOKE_SUB_AGENT_REGISTRY,
  };
}

export function buildDelegateDonePayload(
  line: string,
  agentName: string,
  agentType: SubAgentType,
): DelegateStatusPayload {
  return {
    phase: "delegate_done",
    line,
    agentType,
    subAgentDisplayName: agentName,
    toolName: MASTER_INVOKE_SUB_AGENT_REGISTRY,
  };
}

export function buildLiveAgentStatusPayload(
  line: string,
  phase: Extract<DelegateStatusPhase, "live" | "tool_start"> = "live",
  toolName = "agent",
): DelegateStatusPayload {
  return {
    phase,
    line,
    toolName,
  };
}
