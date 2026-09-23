// HTTP 路由：聊天推荐项（「为你推荐」客户端数据源）
//
// GET /api/chat/suggestions —— 按能力就绪状态过滤 + 服务端抽样后的推荐列表
//   （每条含 capabilityId，供客户端做「能力上新」检测）。抽样叠加使用习惯
//   个性化：近 14 天真实用过的能力保底在场并出「回访版」文案
//   （personalized=true），数据源为 habit-loop 工具执行观察。
import type { FastifyInstance } from "fastify";

import { getChatSuggestions } from "../../services/chat-suggestions-service.js";

export function registerChatSuggestionRoutes(app: FastifyInstance): void {
  app.get("/api/chat/suggestions", async () => {
    const { suggestions } = getChatSuggestions();
    return {
      ok: true,
      count: suggestions.length,
      suggestions,
    };
  });
}
