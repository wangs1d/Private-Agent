import {
  buildDelegateDonePayload,
  buildDelegateStartPayload,
  buildLiveAgentStatusPayload,
  isMasterInvokeSubAgentTool,
  pickToolUserStatusLine,
  type DelegateStatusPayload,
} from "../agent/delegate-status.js";
import { parseSubAgentType } from "../agent/master-subagent-delegate-tools.js";
import type { ToolExecutedInfo, ToolExecuteStartInfo } from "../external-model/types.js";
import { ServerEventType } from "../protocol.js";
import { embodimentThinking } from "../services/agent-embodiment.js";
import { isScheduleMutationToolName } from "../tools/schedule-tool-names.js";

export type ChatToolWireContext = {
  sessionId: string;
  traceId: string;
  assistantMessageId: string;
  send: (json: string) => void;
};

function sendAgentStatus(ctx: ChatToolWireContext, status: DelegateStatusPayload): void {
  embodimentThinking(ctx.sessionId, ctx.send, status.line, {
    phase: status.phase,
    subAgentType: status.agentType,
    subAgentDisplayName: status.subAgentDisplayName,
    source: status.toolName ? "tool" : "delegate",
  });
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
  const userStatusLine = pickToolUserStatusLine(info.input, info.assistantPreamble);
  if (userStatusLine) {
    embodimentThinking(ctx.sessionId, ctx.send, userStatusLine, {
      phase: "tool_start",
      source: "tool",
    });
  }
  ctx.send(
    JSON.stringify({
      type: ServerEventType.ToolCall,
      payload: {
        toolName: info.toolName,
        input: info.input,
        traceId: ctx.traceId,
        assistantPreamble: info.assistantPreamble,
        ...(userStatusLine ? { userStatusLine } : {}),
      },
    }),
  );

  if (!isMasterInvokeSubAgentTool(info.toolName)) {
    if (userStatusLine) {
      sendAgentStatus(ctx, buildLiveAgentStatusPayload(userStatusLine, "tool_start", info.toolName));
    }
    return;
  }

  const agentType = parseSubAgentType(info.input.agentType);
  const SUB_AGENT_LABELS: Record<string, string> = {
    life: "生活助手",
    work: "工作助手",
    social: "社交助手",
    entertainment: "娱乐助手",
    finance: "金融助手",
    tech: "技术助手",
    info: "信息助手",
    creative: "创意助手",
    security: "安全助手",
  };
  const agentName = agentType ? (SUB_AGENT_LABELS[agentType] ?? agentType) : "助手";
  if (!agentType) return;

  const start = buildDelegateStartPayload(info.input, agentName, agentType);
  if (start) sendAgentStatus(ctx, start);
}

function sendScheduleTasksChanged(ctx: ChatToolWireContext, result: Record<string, unknown>): void {
  const taskId = String(result.taskId ?? "").trim();
  if (!taskId) return;

  const actionRaw = String(result.action ?? "").trim();
  const action =
    actionRaw === "deleted" || actionRaw === "updated" || actionRaw === "created"
      ? actionRaw
      : "created";

  if (action === "deleted") {
    ctx.send(
      JSON.stringify({
        type: ServerEventType.ScheduleTasksChanged,
        payload: {
          sessionId: ctx.sessionId,
          traceId: ctx.traceId,
          action: "deleted",
          taskId,
        },
      }),
    );
    return;
  }

  const nextRunAt = String(result.nextRunAt ?? "").trim();
  if (!nextRunAt) return;
  ctx.send(
    JSON.stringify({
      type: ServerEventType.ScheduleTasksChanged,
      payload: {
        sessionId: ctx.sessionId,
        traceId: ctx.traceId,
        action,
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
    isScheduleMutationToolName(info.toolName) &&
    info.result.ok === true &&
    info.result.taskId
  ) {
    const isDelete = info.toolName.replace(/_/g, ".") === "calendar.delete_task";
    sendScheduleTasksChanged(ctx, {
      ...info.result,
      action: isDelete ? "deleted" : "created",
    });
  }

  if (!isMasterInvokeSubAgentTool(info.toolName) || !info.ok) return;
  if (info.result.ok === false) return;

  const agentType = parseSubAgentType(info.result.agentType ?? info.input.agentType);
  const agentName = String(info.result.agentName ?? info.input.agentType ?? "助手").trim();
  const line =
    String(info.result.uiDoneLine ?? "").trim() ||
    (info.result.background === true
      ? String(info.result.message ?? "助手已在后台处理，稍后会汇总结果…").trim()
      : "");
  if (!agentType || !line) return;

  sendAgentStatus(ctx, buildDelegateDonePayload(line, agentName, agentType));
}
