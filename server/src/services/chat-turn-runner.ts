import { randomUUID } from "node:crypto";

import { parseAgentAccessMode, type AgentAccessMode } from "../agent/agent-access-mode.js";
import type { ClientLocationWire } from "../types/client-location.js";
import type { AgentCore } from "./agent-core.js";
import { formatScheduleToolResultForUser } from "../tools/schedule-user-reply.js";
import { getToolResultProcessor } from "./tool-result-processor.js";
import { dedupeAdjacentLines } from "../utils/text.js";

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
 * 与 WebSocket `chat.user_message` 共用 AgentCore 路径（工具、记忆、Master Agent、人设），
 * 供微信消息桥等无 WS 客户端调用。
 */

/** 将工具执行结果转为可读文本 */
function stringifyToolResult(result: Record<string, unknown>): string {
  if (!result) return "";

  // 字符串直接返回
  if (typeof result === "string") return result;

  // 带 items 数组的搜索/列表类结果
  if (Array.isArray(result.items)) {
    return (result.items as unknown[])
      .map((item) => {
        if (!item || typeof item !== "object") return String(item ?? "");
        const obj = item as Record<string, unknown>;
        return [obj.title, obj.snippet, obj.content, obj.summary, obj.description]
          .filter((v): v is string => typeof v === "string")
          .join("\n");
      })
      .filter(Boolean)
      .join("\n\n");
  }

  // 带 content / summary 字段
  if (typeof result.content === "string") return result.content;
  if (typeof result.summary === "string") return result.summary;

  for (const field of ["text", "body", "description", "snippet"] as const) {
    if (typeof result[field] === "string") return result[field];
  }

  try {
    return JSON.stringify(result, null, 2);
  } catch {
    return String(result);
  }
}
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

    /** 非调度类工具的结果文本：当 Provider 不支持内联 tool loop 时，
     *  LLM 仅输出过程描述（如"正在搜索…"），实际内容在 toolResult 中 */
    const rawToolResultText =
      reply.toolName && toolResult?.ok && toolResult.result && !scheduleOutcome
        ? stringifyToolResult(toolResult.result)
        : "";

    let finalText: string;
    if (rawToolResultText) {
      // 有独立工具结果时，以结果为主，LLM 过程文本为辅
      const processText = reply.text.trim();
      finalText = rawToolResultText;
      if (processText && !rawToolResultText.includes(processText.slice(0, 40))) {
        finalText = `${processText}\n\n${rawToolResultText}`;
      }
    } else {
      finalText =
        scheduleOutcome?.trim() ||
        reply.text.trim() ||
        "抱歉，我暂时无法生成回复，请稍后重试。";
    }

    // 折叠相邻的重复行（同 WS 路径）：避免 LLM 把工具前导与最终回复写成同一句。
    finalText = dedupeAdjacentLines(finalText);
    finalText = getToolResultProcessor().processAssistantText(finalText, { plainTextMode: true });

    return { ok: true, finalText, messageId };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[chat-turn-runner] failed:", err);
    return { ok: false, message: msg };
  }
}
