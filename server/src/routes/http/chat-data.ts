import type { FastifyInstance } from "fastify";

import { resolveActorId } from "../../agent/actor-id.js";
import type { ExternalChatProvider } from "../../external-model/types.js";
import type { AgentMemorySyncService } from "../../services/agent-memory-sync-service.js";
import { clearAllMemoryForActor } from "../../services/memory-clear-service.js";

/**
 * 用户数据管理路由：删除全部聊天记录 + 清空 Agent 记忆。
 * 供客户端“删除全部聊天”按钮调用，返回被清理的各类计数。
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
}