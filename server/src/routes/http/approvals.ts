// 待确认收件箱 HTTP 路由（花钱需确认的主动服务确认 + 其他主动化消息的统一对外视图）
//
// GET  /api/approvals?userId=&sessionId=  收件箱快照：
//        items    待确认条目（spend=true 需用户点确认；false 仅展示，倒序）
//        activity 最近主动动态（AgentActivityStore 台账，只读）
// POST /api/approvals/resolve             解析一项 {userId, sessionId?, source, id, decision}
//
// 口径：习惯自动化不进收件箱（Agent 自己的习惯无需确认）；task 来源（awaiting_approval）
// 亦不接入——其 approve 仅翻状态、不恢复编排主循环，会造成"批了不跑"的假确认
// （见 approval-inbox-service 文件头）。
// 校验为手动白名单（与 catalog.ts 一致，本仓库 HTTP 层未统一挂 schema 校验）。
import type { FastifyInstance } from "fastify";

import { resolveActorId } from "../../agent/actor-id.js";
import type { ApprovalInboxService, ApprovalSource } from "../../services/approval-inbox-service.js";

const APPROVAL_DECISIONS: ReadonlySet<string> = new Set(["approve", "decline"]);

export interface ApprovalRouteDeps {
  approvalInboxService: ApprovalInboxService;
}

export function registerApprovalRoutes(app: FastifyInstance, deps: ApprovalRouteDeps): void {
  const { approvalInboxService } = deps;

  /** GET /api/approvals：收件箱快照（待确认 + 主动动态） */
  app.get("/api/approvals", async (request) => {
    const query = request.query as { userId?: string; sessionId?: string };
    const actorId = resolveActorId({ userId: query.userId, sessionId: query.sessionId ?? "" });
    const snapshot = await approvalInboxService.list(actorId);
    return {
      ok: true,
      count: snapshot.items.length,
      items: snapshot.items,
      activity: snapshot.activity,
    };
  });

  /** POST /api/approvals/resolve：批准 / 拒绝一条花钱类待确认 */
  app.post("/api/approvals/resolve", async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const userId = typeof body.userId === "string" ? body.userId.trim() : "";
    const sessionId = typeof body.sessionId === "string" ? body.sessionId.trim() : "";
    const actorId = resolveActorId({ userId, sessionId });
    const source = typeof body.source === "string" ? body.source.trim() : "";
    const id = typeof body.id === "string" ? body.id.trim() : "";
    const decision = typeof body.decision === "string" ? body.decision.trim() : "";
    if (source !== "proactivity") {
      return reply.code(400).send({ ok: false, error: "source 必须是：proactivity" });
    }
    if (!id) return reply.code(400).send({ ok: false, error: "缺少 id" });
    if (!APPROVAL_DECISIONS.has(decision)) {
      return reply.code(400).send({ ok: false, error: `decision 必须是：${[...APPROVAL_DECISIONS].join(" / ")}` });
    }
    const result = await approvalInboxService.resolve(
      actorId,
      source as ApprovalSource,
      id,
      decision as "approve" | "decline",
    );
    if (!result.ok) {
      return reply.code(400).send({ ok: false, error: result.detail ?? "解析失败" });
    }
    return { ok: true, detail: result.detail };
  });
}
