import type { FastifyInstance } from "fastify";
import { ServerEventType } from "../../protocol.js";
import { MorningBriefingService } from "../../services/morning-briefing-service.js";
import { getUserPreferences } from "./user-preferences.js";
import { markMorningBriefingDelivered } from "./user-preferences.js";
import type { HttpRouteDeps } from "./types.js";

/**
 * 测试专用：手动触发一次早间简报 WS 事件。
 *
 * 用途：补齐调度器订阅挂载链路前，先验证客户端卡片渲染是否 OK。
 * 调用方式：POST /api/test/trigger-briefing，body { sessionId?: string, mode?: "voice"|"window"|"card" }
 *
 * 生产环境应通过 MorningBriefingScheduler 的 subscribe + tick 触发。
 */
export function registerBriefingTestRoutes(
  app: FastifyInstance,
  deps: Pick<HttpRouteDeps, "wsConnectionRegistry">,
): void {
  app.post("/api/test/trigger-briefing", async (request, reply) => {
    const wsRegistry = deps.wsConnectionRegistry;
    if (!wsRegistry) {
      return reply.code(503).send({ ok: false, error: "wsConnectionRegistry 未注入" });
    }

    const body = (request.body ?? {}) as {
      sessionId?: string;
      mode?: "voice" | "window" | "card";
    };
    const sessionId = body.sessionId?.trim();
    if (!sessionId) {
      return reply.code(400).send({ ok: false, error: "sessionId required" });
    }
    const mode = body.mode ?? "card";

    const service = new MorningBriefingService({
      getSessionPrefs: (sid) => getUserPreferences(sid),
    });
    const narration = await service.narrateBriefing(sessionId);

    const sent = wsRegistry.trySend(
      sessionId,
      JSON.stringify({
        type: ServerEventType.MorningBriefing,
        payload: {
          sessionId,
          mode,
          narrationText: narration.narrationText,
          briefing: narration.briefing,
        },
      }),
    );

    if (sent) {
      markMorningBriefingDelivered(sessionId, "scheduled");
    }

    return {
      ok: true,
      delivered: sent,
      mode,
      sessionId,
      briefing: narration.briefing,
      narrationText: narration.narrationText,
    };
  });
}
