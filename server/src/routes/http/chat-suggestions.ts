// HTTP 路由：聊天推荐项（「为你推荐」客户端数据源）
//
// GET /api/chat/suggestions —— 按能力就绪状态过滤 + 服务端抽样后的推荐列表
//   （每条含 capabilityId，供客户端做「能力上新」检测）。抽样叠加按用户个性化：
//   近 14 天真实用过的能力保底在场并出「回访版」文案（personalized=true），
//   数据源为 habit-loop 工具执行观察；画像层按行为信号加权轮换。
//   身份取 ?userId（ACCESS_AUTH_REQUIRED 开启时由周界 hook 钉死为 token
//   归属用户，无法伪造）；无身份 = 完全不个性化，绝不混算其他用户数据。
import type { FastifyInstance } from "fastify";

import { getChatSuggestions } from "../../services/chat-suggestions-service.js";

export function registerChatSuggestionRoutes(app: FastifyInstance): void {
  app.get("/api/chat/suggestions", async (request) => {
    const q = request.query as { userId?: string; sessionId?: string };
    const actorId = (q.userId ?? q.sessionId ?? "").trim();
    const { suggestions } = getChatSuggestions(new Date(), actorId);
    return {
      ok: true,
      count: suggestions.length,
      suggestions,
    };
  });
}
