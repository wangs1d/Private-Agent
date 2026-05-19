import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { FriendService } from "../../services/friend-service.js";
import type { AgentAccountService } from "../../services/agent-account-service.js";

function accountActorRefine(data: { userId?: string; sessionId?: string }, ctx: z.RefinementCtx): void {
  const u = data.userId?.trim() ?? "";
  const s = data.sessionId?.trim() ?? "";
  if (!u && !s) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "userId 或 sessionId 至少填一项",
      path: ["userId"],
    });
  }
}

/** 发送好友请求 */
const sendFriendRequestSchema = z
  .object({
    userId: z.string().optional(),
    sessionId: z.string().optional(),
    toActorId: z.string().min(1),
    message: z.string().max(500).optional(),
  })
  .superRefine(accountActorRefine);

/** 响应好友请求 */
const respondFriendRequestSchema = z
  .object({
    userId: z.string().optional(),
    sessionId: z.string().optional(),
    requestId: z.string().min(1),
    accept: z.boolean(),
  })
  .superRefine(accountActorRefine);

/** 取消好友请求 */
const cancelFriendRequestSchema = z
  .object({
    userId: z.string().optional(),
    sessionId: z.string().optional(),
    requestId: z.string().min(1),
  })
  .superRefine(accountActorRefine);

/** 查询参数 */
const friendQuerySchema = z
  .object({
    userId: z.string().optional(),
    sessionId: z.string().optional(),
  })
  .superRefine(accountActorRefine);

function accountActorFromBody(data: { userId?: string; sessionId?: string }): string {
  const u = data.userId?.trim() ?? "";
  const s = data.sessionId?.trim() ?? "";
  return u || s;
}

export function registerFriendRoutes(
  app: FastifyInstance,
  deps: {
    friendService: FriendService;
    agentAccountService: AgentAccountService;
  }
): void {
  const { friendService, agentAccountService } = deps;

  /**
   * 发送好友请求
   * POST /friends/request
   */
  app.post("/friends/request", async (request, reply) => {
    const parsed = sendFriendRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, error: parsed.error.flatten() });
    }

    const fromActorId = accountActorFromBody(parsed.data);
    const toActorId = parsed.data.toActorId.trim();

    // 检查目标用户是否存在
    const targetAccount = agentAccountService.getByActorId(toActorId);
    if (!targetAccount) {
      return reply.code(404).send({ ok: false, message: "目标用户不存在" });
    }

    const result = await friendService.sendFriendRequest(
      fromActorId,
      toActorId,
      parsed.data.message
    );

    if (!result.ok) {
      return reply.code(400).send({ ok: false, message: result.reason });
    }

    return { ok: true, request: result.request };
  });

  /**
   * 响应好友请求（接受/拒绝）
   * POST /friends/request/respond
   */
  app.post("/friends/request/respond", async (request, reply) => {
    const parsed = respondFriendRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, error: parsed.error.flatten() });
    }

    const responderActorId = accountActorFromBody(parsed.data);
    const result = await friendService.respondToRequest(
      parsed.data.requestId,
      responderActorId,
      parsed.data.accept
    );

    if (!result.ok) {
      return reply.code(400).send({ ok: false, message: result.reason });
    }

    return { ok: true, request: result.request };
  });

  /**
   * 取消好友请求
   * POST /friends/request/cancel
   */
  app.post("/friends/request/cancel", async (request, reply) => {
    const parsed = cancelFriendRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, error: parsed.error.flatten() });
    }

    const requesterActorId = accountActorFromBody(parsed.data);
    const result = await friendService.cancelRequest(
      parsed.data.requestId,
      requesterActorId
    );

    if (!result.ok) {
      return reply.code(400).send({ ok: false, message: result.reason });
    }

    return { ok: true };
  });

  /**
   * 获取 incoming 好友请求（别人发给我的）
   * GET /friends/requests/incoming
   */
  app.get("/friends/requests/incoming", async (request, reply) => {
    const parsed = friendQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, error: parsed.error.flatten() });
    }

    const actorId = accountActorFromBody(parsed.data);
    const requests = friendService.getIncomingRequests(actorId);

    return { ok: true, requests };
  });

  /**
   * 获取 outgoing 好友请求（我发给别人的）
   * GET /friends/requests/outgoing
   */
  app.get("/friends/requests/outgoing", async (request, reply) => {
    const parsed = friendQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, error: parsed.error.flatten() });
    }

    const actorId = accountActorFromBody(parsed.data);
    const requests = friendService.getOutgoingRequests(actorId);

    return { ok: true, requests };
  });

  /**
   * 获取所有好友请求历史
   * GET /friends/requests/all
   */
  app.get("/friends/requests/all", async (request, reply) => {
    const parsed = friendQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, error: parsed.error.flatten() });
    }

    const actorId = accountActorFromBody(parsed.data);
    const requests = friendService.getAllRequests(actorId);

    return { ok: true, requests };
  });

  /**
   * 获取好友列表
   * GET /friends/list
   */
  app.get("/friends/list", async (request, reply) => {
    const parsed = friendQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, error: parsed.error.flatten() });
    }

    const actorId = accountActorFromBody(parsed.data);
    const friends = friendService.getFriends(actorId);

    // 为每个好友添加账号信息
    const friendsWithDetails = friends.map((f: any) => {
      const account = agentAccountService.getByActorId(f.friendActorId);
      return {
        ...f,
        displayName: account?.displayName ?? f.friendActorId,
        email: account?.email ?? null,
      };
    });

    return { ok: true, friends: friendsWithDetails };
  });

  /**
   * 检查好友关系
   * GET /friends/check
   */
  app.get("/friends/check", async (request, reply) => {
    const parsed = friendQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, error: parsed.error.flatten() });
    }

    const actorId = accountActorFromBody(parsed.data);
    const query = request.query as Record<string, unknown>;
    const targetActorId = String(query.targetActorId ?? "").trim();

    if (!targetActorId) {
      return reply.code(400).send({ ok: false, message: "缺少 targetActorId 参数" });
    }

    const areFriends = friendService.areFriends(actorId, targetActorId);
    return { ok: true, areFriends };
  });
}
