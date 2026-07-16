import {
  buildDelegateDonePayload,
  buildDelegateStartPayload,
  buildLiveAgentStatusPayload,
  isMasterInvokeSubAgentTool,
  pickToolUserStatusLine,
  type DelegateStatusPayload,
} from "../agent/delegate-status.js";
import { parseSubAgentType } from "../agent/master-subagent-delegate-tools.js";
import { getAgentRuntimeConfig } from "../agent/agent-runtime-config.js";
import { buildExecutionEventPayload } from "../agent/turn-events.js";
import type { ToolExecutedInfo, ToolExecuteStartInfo } from "../external-model/types.js";
import { ServerEventType } from "../protocol.js";
import { embodimentThinking } from "../services/agent-embodiment.js";
import { isScheduleMutationToolName } from "../tools/schedule-tool-names.js";
import { formatStatusForDisplay } from "../utils/text.js";

export type ChatToolWireContext = {
  sessionId: string;
  traceId: string;
  assistantMessageId: string;
  send: (json: string) => void;
  /**
   * 「分阶段异步对话交互 v2」可选：tool_call 起始时间表（id → epoch ms），
   * 用于在 tool_result 阶段计算 elapsedMs。
   * 若调用方未传，elapsedMs 会默认 0。
   */
  toolStartedAt?: Map<string, number>;
};

/** 同 traceId 内单调递增的 eventId 计数器（避免引入全局单例，handler 退出即丢）。 */
let executionEventSeq = 0;
function nextExecutionEventId(): string {
  executionEventSeq += 1;
  return `evt-${Date.now()}-${executionEventSeq}`;
}

/** 「分阶段异步对话交互 v2」结构化执行事件发射。
 *  与 v1 tool.call / tool.result / chat.agent_status 并行存在，
 *  由 CHAT_TURN_PANEL_V2 开关控制是否下发。
 *  客户端按 kind 区分：tool_call / tool_result / agent_start / agent_done / log。 */
function sendExecutionEvent(
  ctx: ChatToolWireContext,
  kind:
    | "tool_call"
    | "tool_result"
    | "agent_start"
    | "agent_done"
    | "log",
  body: {
    thought?: string;
    toolCall?: Parameters<typeof buildExecutionEventPayload>[0]["toolCall"];
    toolResult?: Parameters<typeof buildExecutionEventPayload>[0]["toolResult"];
    agentStart?: Parameters<typeof buildExecutionEventPayload>[0]["agentStart"];
    agentDone?: Parameters<typeof buildExecutionEventPayload>[0]["agentDone"];
    log?: string;
  },
): void {
  if (!getAgentRuntimeConfig().turnPanelV2.enabled) return;
  ctx.send(
    JSON.stringify({
      type: ServerEventType.ChatExecutionEvent,
      payload: buildExecutionEventPayload({
        sessionId: ctx.sessionId,
        traceId: ctx.traceId,
        eventId: nextExecutionEventId(),
        kind,
        ...body,
      }),
    }),
  );
}

/** 摘要化工具入参（避免把大对象塞进 WS 协议）。 */
function summarizeArgs(input: Record<string, unknown>): string {
  try {
    const json = JSON.stringify(input);
    if (!json || json === "{}") return "";
    return json.length > 200 ? `${json.slice(0, 200)}…` : json;
  } catch {
    return "";
  }
}

/** 摘要化工具结果（取关键字段，文本超长截断）。 */
function summarizeResult(
  result: Record<string, unknown> | undefined,
): string | undefined {
  if (!result) return undefined;
  const text =
    typeof result.text === "string"
      ? result.text
      : typeof result.message === "string"
        ? result.message
        : typeof result.preview === "string"
          ? result.preview
          : "";
  if (!text) return undefined;
  return text.length > 200 ? `${text.slice(0, 200)}…` : text;
}

function sendAgentStatus(ctx: ChatToolWireContext, status: DelegateStatusPayload): void {
  const displayLine = formatStatusForDisplay(status.line);
  if (!displayLine) return;
  embodimentThinking(ctx.sessionId, ctx.send, displayLine, {
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
        line: displayLine,
        agentType: status.agentType,
        subAgentDisplayName: status.subAgentDisplayName,
        toolName: status.toolName,
      },
    }),
  );
  // v2：把 agent_status 同步下发为 execution_event(kind=log)，
  // 让 v1 自由文本链路和 v2 结构化链路并存；UI 端按开关决定渲染哪条。
  sendExecutionEvent(ctx, "log", { log: displayLine });
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
  // v2：结构化 tool_call 卡片
  sendExecutionEvent(ctx, "tool_call", {
    toolCall: {
      id: `${ctx.traceId}:${info.toolName}`,
      name: info.toolName,
      argsPreview: summarizeArgs(info.input),
    },
  });

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
    security: "安全助手",
  };
  const agentName = agentType ? (SUB_AGENT_LABELS[agentType] ?? agentType) : "助手";
  if (!agentType) return;

  const start = buildDelegateStartPayload(info.input, agentName, agentType);
  if (start) sendAgentStatus(ctx, start);

  // v2：结构化 agent_start 卡片
  const taskText = String(
    info.input.task ?? info.input.query ?? info.input.userMessage ?? "",
  ).trim();
  sendExecutionEvent(ctx, "agent_start", {
    agentStart: {
      id: `${ctx.traceId}:${agentType}`,
      role: agentName,
      ...(taskText ? { task: taskText.length > 200 ? `${taskText.slice(0, 200)}…` : taskText } : {}),
    },
  });
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
  // v2：结构化 tool_result 卡片
  const toolCallId = `${ctx.traceId}:${info.toolName}`;
  const startedAt = ctx.toolStartedAt?.get(toolCallId);
  const elapsedMs = startedAt ? Date.now() - startedAt : 0;
  if (startedAt != null) ctx.toolStartedAt?.delete(toolCallId);
  sendExecutionEvent(ctx, "tool_result", {
    toolResult: {
      id: toolCallId,
      name: info.toolName,
      preview: summarizeResult(info.result as Record<string, unknown> | undefined),
      ok: info.ok,
      elapsedMs,
    },
  });

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

  // v2：结构化 agent_done 卡片
  sendExecutionEvent(ctx, "agent_done", {
    agentDone: {
      id: `${ctx.traceId}:${agentType}`,
      role: agentName,
      ok: true,
      elapsedMs,
    },
  });
}
