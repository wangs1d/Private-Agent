import {
  buildDelegateDonePayload,
  buildDelegateStartPayload,
  isMasterInvokeSubAgentTool,
  type DelegateStatusPayload,
} from "../agent/delegate-status.js";
import { parseSubAgentType } from "../agent/master-subagent-delegate-tools.js";
import type { ToolExecutedInfo, ToolExecuteStartInfo } from "../external-model/types.js";
import { ServerEventType } from "../protocol.js";
import { isScheduleCreateToolName } from "../tools/schedule-tool-names.js";

export type ChatToolWireContext = {
  sessionId: string;
  traceId: string;
  assistantMessageId: string;
  send: (json: string) => void;
};

function sendAgentStatus(ctx: ChatToolWireContext, status: DelegateStatusPayload): void {
  ctx.send(
    JSON.stringify({
      type: ServerEventType.ChatAgentStatus,
      payload: {
        sessionId: ctx.sessionId,
        messageId: ctx.assistantMessageId,
        traceId: ctx.traceId,
        phase: status.phase,
        line: status.line,
        agentType: status.agentType,
        subAgentDisplayName: status.subAgentDisplayName,
        toolName: status.toolName,
      },
    }),
  );
}

export function wireToolExecuteStart(ctx: ChatToolWireContext, info: ToolExecuteStartInfo): void {
  ctx.send(
    JSON.stringify({
      type: ServerEventType.ToolCall,
      payload: {
        toolName: info.toolName,
        input: info.input,
        traceId: ctx.traceId,
        assistantPreamble: info.assistantPreamble,
      },
    }),
  );

  if (!isMasterInvokeSubAgentTool(info.toolName)) return;

  const agentType = parseSubAgentType(info.input.agentType);
  const SUB_AGENT_LABELS: Record<string, string> = {
    life: "生活助手",
    work: "工作助手",
    social: "社交助手",
    entertainment: "娱乐助手",
    finance: "金融助手",
    tech: "技术助手",
    info: "信息助手",
    general: "通用助手",
  };
  const agentName = agentType ? (SUB_AGENT_LABELS[agentType] ?? agentType) : "助手";
  if (!agentType) return;

  const start = buildDelegateStartPayload(info.input, agentName, agentType);
  if (start) sendAgentStatus(ctx, start);
}

function sendScheduleTasksChanged(ctx: ChatToolWireContext, result: Record<string, unknown>): void {
  const taskId = String(result.taskId ?? "").trim();
  const nextRunAt = String(result.nextRunAt ?? "").trim();
  if (!taskId || !nextRunAt) return;
  ctx.send(
    JSON.stringify({
      type: ServerEventType.ScheduleTasksChanged,
      payload: {
        sessionId: ctx.sessionId,
        traceId: ctx.traceId,
        taskId,
        nextRunAt,
        title:
          result.reminderMessage && result.title === "AI 提醒任务"
            ? result.reminderMessage
            : result.title,
        kind: result.kind,
        reminderMessage: result.reminderMessage,
      },
    }),
  );
}

export function wireToolExecuted(ctx: ChatToolWireContext, info: ToolExecutedInfo): void {
  ctx.send(
    JSON.stringify({
      type: ServerEventType.ToolResult,
      payload: {
        toolName: info.toolName,
        ok: info.ok,
        result: info.result,
        traceId: ctx.traceId,
      },
    }),
  );

  if (
    info.ok &&
    isScheduleCreateToolName(info.toolName) &&
    info.result.ok === true &&
    info.result.taskId
  ) {
    sendScheduleTasksChanged(ctx, info.result);
  }

  if (!isMasterInvokeSubAgentTool(info.toolName) || !info.ok) return;

  const agentType = parseSubAgentType(info.result.agentType ?? info.input.agentType);
  const agentName = String(info.result.agentName ?? info.input.agentType ?? "助手").trim();
  const line = String(info.result.uiDoneLine ?? "").trim();
  if (!agentType || !line) return;

  sendAgentStatus(ctx, buildDelegateDonePayload(line, agentName, agentType));
}
