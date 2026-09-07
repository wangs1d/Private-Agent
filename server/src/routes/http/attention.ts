// 分级触达注意力路由（决策中心面板数据源 + ack 归一入口）
//
// GET  /api/attention?userId=&sessionId=   决策中心快照：
//        pending     未决事项（open 记录，含投递/升级历史，新在前）
//        doneToday   今天已闭合的触达（acked/resolved/expired，新在前）
//        activity    主动动作台账（AgentActivityStore，与「代办足迹卡」同源）
// POST /api/attention/ack                  ack 归一：{userId, id, via}
//        任何界面的用户回应（弹窗按钮/通知点击/收件箱处理）都调这里，
//        ReachRouter 的升级计时看到 ack 即停。
// POST /api/attention/reach                通用触达入口（Agent/工具链主动上报）：
//        {userId, kind, title, summary, urgency?, decision?, deadlineAt?, spend?}
//
// 花钱类确认的「批准/拒绝执行」仍走 /api/approvals/resolve（hub 执行路径），
// 那条路径内部会同步闭合注意力记录；本文件的 ack 只表达「用户已知悉」。
import type { FastifyInstance } from "fastify";

import { resolveActorId } from "../../agent/actor-id.js";
import type { AttentionStore, AttentionUrgency, AttentionDecision } from "../../proactivity/attention-store.js";
import type { ReachRouter } from "../../proactivity/reach-router.js";
import type { AgentActivityStore } from "../../proactivity/activity-store.js";

const VALID_URGENCY: ReadonlySet<string> = new Set(["interrupt", "alert", "normal", "log"]);
const VALID_DECISION: ReadonlySet<string> = new Set(["confirm", "fyi", "none"]);

export interface AttentionRouteDeps {
  attentionStore: AttentionStore;
  reachRouter: ReachRouter;
  activityStore?: AgentActivityStore | null;
}

export function registerAttentionRoutes(app: FastifyInstance, deps: AttentionRouteDeps): void {
  const { attentionStore, reachRouter, activityStore } = deps;

  /** GET /api/attention：决策中心快照 */
  app.get("/api/attention", async (request) => {
    const query = request.query as { userId?: string; sessionId?: string; limit?: string };
    const actorId = resolveActorId({ userId: query.userId, sessionId: query.sessionId ?? "" });
    const limit = Math.max(1, Math.min(100, Number.parseInt(query.limit ?? "", 10) || 50));
    const pending = attentionStore.listOpen(actorId);
    const doneToday = attentionStore
      .listAll(actorId, limit)
      .filter((r) => r.state !== "open");
    const activity = activityStore?.list(actorId, 20) ?? [];
    return {
      ok: true,
      pending,
      doneToday,
      activity,
      unreadActivity: activityStore?.unreadCount(actorId) ?? 0,
    };
  });

  /** POST /api/attention/ack：ack 归一（升级链即停） */
  app.post("/api/attention/ack", async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const userId = typeof body.userId === "string" ? body.userId.trim() : "";
    const sessionId = typeof body.sessionId === "string" ? body.sessionId.trim() : "";
    const actorId = resolveActorId({ userId, sessionId });
    const id = typeof body.id === "string" ? body.id.trim() : "";
    const via = typeof body.via === "string" ? body.via.trim() : "client";
    if (!id) return reply.code(400).send({ ok: false, error: "缺少 id" });
    const record = attentionStore.get(id);
    if (!record) return reply.code(404).send({ ok: false, error: "注意力记录不存在" });
    if (record.actorId !== actorId) {
      return reply.code(403).send({ ok: false, error: "记录不属于当前用户" });
    }
    const updated = reachRouter.ack(id, via);
    return { ok: true, record: updated };
  });

  /**
   * POST /api/attention/reach：通用触达入口。
   * Agent/工具链觉察到需要用户知道的事（如日程变更已自动调整）时上报，
   * 由 ReachRouter 按矩阵选择通道并挂升级。
   */
  app.post("/api/attention/reach", async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const userId = typeof body.userId === "string" ? body.userId.trim() : "";
    const sessionId = typeof body.sessionId === "string" ? body.sessionId.trim() : "";
    const actorId = resolveActorId({ userId, sessionId });
    const kind = typeof body.kind === "string" ? body.kind.trim() : "";
    const title = typeof body.title === "string" ? body.title.trim() : "";
    const summary = typeof body.summary === "string" ? body.summary.trim() : "";
    if (!kind) return reply.code(400).send({ ok: false, error: "缺少 kind" });
    if (!title) return reply.code(400).send({ ok: false, error: "缺少 title" });
    const urgencyRaw = typeof body.urgency === "string" ? body.urgency : "normal";
    const decisionRaw = typeof body.decision === "string" ? body.decision : "fyi";
    if (!VALID_URGENCY.has(urgencyRaw)) {
      return reply.code(400).send({ ok: false, error: `urgency 必须是：${[...VALID_URGENCY].join("/")}` });
    }
    if (!VALID_DECISION.has(decisionRaw)) {
      return reply.code(400).send({ ok: false, error: `decision 必须是：${[...VALID_DECISION].join("/")}` });
    }
    const deadlineRaw = body.deadlineAt;
    const deadlineAt =
      typeof deadlineRaw === "number" && Number.isFinite(deadlineRaw)
        ? deadlineRaw
        : typeof deadlineRaw === "string" && deadlineRaw
          ? Date.parse(deadlineRaw) || null
          : null;
    const record = await reachRouter.route({
      actorId,
      kind,
      title,
      summary,
      urgency: urgencyRaw as AttentionUrgency,
      decision: decisionRaw as AttentionDecision,
      spend: body.spend === true,
      deadlineAt,
      meta: (body.meta as Record<string, unknown> | undefined) ?? undefined,
    });
    return { ok: true, record };
  });
}
