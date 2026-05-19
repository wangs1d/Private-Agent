import type { FastifyReply } from "fastify";

import type { WorldService } from "../services/world-service.js";

/**
 * 未完成开放式 Agent 注册时拦截世界玩法 HTTP（读状态与注册接口除外）。
 */
export function replyIfWorldRegistrationRequired(
  reply: FastifyReply,
  worldService: WorldService,
  sessionId: string,
): boolean {
  if (worldService.isAgentWorldRegistered(sessionId)) return false;
  void reply.code(403).send({
    ok: false,
    reason: "WORLD_REGISTRATION_REQUIRED",
    message: "请先完成 Agent World 注册",
  });
  return true;
}
