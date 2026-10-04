import type { FastifyInstance } from "fastify";

import { resolveActorId } from "../../agent/actor-id.js";
import { resolvePrimaryChatSessionId } from "../../agent/master-chat-session.js";
import { getChatThreadStore } from "../../external-model/chat-thread-store.js";
import type { ExternalChatProvider } from "../../external-model/types.js";
import { getAgentRuntimeConfig } from "../../agent/agent-runtime-config.js";
import type { AgentMemorySyncService } from "../../services/agent-memory-sync-service.js";
import { clearAllMemoryForActor } from "../../services/memory-clear-service.js";

/**
 * 用户数据管理路由：删除全部聊天记录 + 清空 Agent 记忆 / 删除单轮对话。
 * 供客户端“删除全部聊天”与“删除这一轮”按钮调用。
 */
export function registerChatDataRoutes(
  app: FastifyInstance,
  deps: { externalChat?: ExternalChatProvider | null; agentMemorySyncService: AgentMemorySyncService },
): void {
  app.post<{ Body: { userId?: string; sessionId?: string } }>(
    "/api/chat-data/clear-all",
    async (request, reply) => {
      const body = request.body ?? {};
      const actorId = resolveActorId({
        userId: body.userId,
        sessionId: body.sessionId ?? "",
      });
      if (!actorId) {
        return reply.code(400).send({ ok: false, message: "missing userId or sessionId" });
      }

      const cleared = await clearAllMemoryForActor(actorId, deps);

      return {
        ok: true,
        cleared,
      };
    },
  );

  /**
   * 删除「一整轮对话」（用户提问 + Agent 该轮的全部回复）。
   *
   * 只从对话线程里摘掉这一轮，其余历史上下文与 Agent 记忆全部保留——与
   * clear-all 的全量清空是两条完全不同的路径。客户端「删除」按钮此前只能发
   * `chat.clear_history`（= clearAllMemoryForActor），删一条即忘掉全部历史，
   * 本接口是那条误伤路径的精准替代。
   */
  app.post<{
    Body: { userId?: string; sessionId?: string; messageId?: string; text?: string };
  }>(
    "/api/chat-data/delete-turn",
    async (request, reply) => {
      const body = request.body ?? {};
      const actorId = resolveActorId({
        userId: body.userId,
        sessionId: body.sessionId ?? "",
      });
      if (!actorId) {
        return reply.code(400).send({ ok: false, message: "missing userId or sessionId" });
      }
      const messageId = body.messageId?.trim();
      if (!messageId) {
        return reply.code(400).send({ ok: false, message: "missing messageId" });
      }

      // text 可选：被删消息的原文。仅用于本功能上线前落盘的旧线程（没有 clientMessageId
      // 字段，重启后按 id 定位不到）——服务端只在唯一命中时才按文本兜底定位。
      const fallbackText = typeof body.text === "string" ? body.text.slice(0, 4000) : undefined;

      const masterOn = getAgentRuntimeConfig().masterDelegation.enabled;
      const result = getChatThreadStore().deleteTurn(
        resolvePrimaryChatSessionId(actorId, masterOn),
        messageId,
        fallbackText,
      );

      return {
        ok: result.ok,
        reason: result.reason,
        removed: result.removed ?? 0,
      };
    },
  );
}