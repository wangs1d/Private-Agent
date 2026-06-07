import { randomUUID } from "node:crypto";

import { parseAgentAccessMode, type AgentAccessMode } from "../agent/agent-access-mode.js";
import type { ClientLocationWire } from "../types/client-location.js";
import type { AgentCore } from "./agent-core.js";
import { formatScheduleToolResultForUser } from "../tools/schedule-user-reply.js";
import { getToolResultProcessor } from "./tool-result-processor.js";

export type ChatTurnInput = {
  text: string;
  messageId?: string;
  userId?: string;
  agentAccessMode?: AgentAccessMode;
  /** 与 App 一致：记忆、工具、Master Agent、人设 */
  preferFullPipeline?: boolean;
  clientLocation?: ClientLocationWire;
};

export type ChatTurnResult = {
  ok: true;
  finalText: string;
  messageId: string;
  /** 可选：TTS 合成的音频数据（用于微信桥接等需要推送语音的场景） */
  ttsAudio?: { format: string; base64: string } | null;
  /** 可选：标记此回复是否为提醒类（用于微信端特殊渲染） */
  reminderType?: "popup" | "tts_alarm" | "phone_call" | null;
};

export type ChatTurnError = {
  ok: false;
  message: string;
};

/**
 * 与 WebSocket `chat.user_message` 共用 AgentCore 路径（工具、记忆、Master Agent），
 * 供微信消息桥等无 WS 客户端调用。
 */
export async function runChatTurnForActor(
  agentCore: AgentCore,
  actorId: string,
  input: ChatTurnInput,
): Promise<ChatTurnResult | ChatTurnError> {
  const text = input.text.trim();
  if (!text) {
    return { ok: false, message: "消息内容为空" };
  }

  const messageId = input.messageId?.trim() || `wechat-bridge-${randomUUID()}`;
  const userId = input.userId?.trim() || actorId;
  const agentAccessMode = parseAgentAccessMode(input.agentAccessMode);

  try {
    const reply = await agentCore.handleUserMessage(actorId, text, {
      chatUserMessageId: messageId,
      userId,
      agentAccessMode,
      preferFullPipeline: input.preferFullPipeline ?? true,
      clientLocation: input.clientLocation,
    });

    let toolResult: { ok: boolean; result?: Record<string, unknown> } | undefined;
    if (reply.toolName && reply.toolInput) {
      toolResult = reply.toolResult
        ? { ok: true, result: reply.toolResult }
        : await agentCore.runToolIfNeeded(actorId, reply, {
            chatUserMessageId: messageId,
            userId,
            agentAccessMode,
          });
    }

    const scheduleOutcome =
      reply.toolName && toolResult?.result
        ? formatScheduleToolResultForUser(reply.toolName, toolResult.result)
        : null;

    let finalText =
      scheduleOutcome?.trim() ||
      reply.text.trim() ||
      "抱歉，我暂时无法生成回复，请稍后重试。";

    finalText = getToolResultProcessor().processAssistantText(finalText);

    return { ok: true, finalText, messageId };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[chat-turn-runner] failed:", err);
    return { ok: false, message: msg };
  }
}
