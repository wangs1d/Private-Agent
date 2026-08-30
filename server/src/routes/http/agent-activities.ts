import type { FastifyInstance } from "fastify";
import {
  agentActivityListQuerySchema,
  agentActivityReadBodySchema,
  agentActivityRecordBodySchema,
} from "../../schemas/api.js";
import type { AgentActivityStore } from "../../proactivity/activity-store.js";

/** 助手动态台账（右侧面板「助手动态」卡数据源）：
 * - GET  /agent/activities       拉取最近动态 + 未读数（面板挂载/轮询）
 * - POST /agent/activities/read  批量置已读（面板展示 2s 后 / 打开对应消息时）
 * - POST /agent/activities       手动落一条记录（Agent 工具链完成代办后上报） */
export function registerAgentActivityRoutes(
  app: FastifyInstance,
  deps: { activityStore: AgentActivityStore },
): void {
  const { activityStore } = deps;

  app.get("/agent/activities", async (request, reply) => {
    const parsed = agentActivityListQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, error: parsed.error.flatten() });
    }
    const { actorId, limit } = parsed.data;
    return {
      ok: true,
      activities: activityStore.list(actorId, limit),
      unreadCount: activityStore.unreadCount(actorId),
    };
  });

  app.post("/agent/activities/read", async (request, reply) => {
    const parsed = agentActivityReadBodySchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, error: parsed.error.flatten() });
    }
    const { actorId, ids } = parsed.data;
    return { ok: true, marked: activityStore.markRead(actorId, ids) };
  });

  app.post("/agent/activities", async (request, reply) => {
    const parsed = agentActivityRecordBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, error: parsed.error.flatten() });
    }
    const activity = activityStore.record(parsed.data);
    if (activity == null) {
      return { ok: true, deduped: true, activity: null };
    }
    return { ok: true, activity };
  });
}
