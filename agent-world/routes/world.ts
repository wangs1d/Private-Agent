import type { FastifyInstance } from "fastify";

import { replyIfWorldHttpMutationsForbidden } from "../config/world-http-mutations.js";
import { allowAgentWorldPlaceholderRegister } from "../config/world-register-placeholder.js";
import { replyIfWorldRegistrationRequired } from "../config/world-registration-gate.js";
import {
  worldCreditsAuditQuerySchema,
  worldCreditsAuditSummaryQuerySchema,
  worldLeisureBodySchema,
  worldPurchaseBodySchema,
  worldRegisterAgentQuickBodySchema,
  worldRegisterChallengeBodySchema,
  worldRegisterVerifyBodySchema,
  worldSessionQuerySchema,
  worldSkillUploadBodySchema,
} from "../schemas.js";
import type { HttpRouteDepsLike, SkillManagerLike } from "../host-types.js";
import { persistUploadedCommunitySkill } from "../services/community-skill-store.js";
import { skillMarketListingsForSession } from "../services/world-skill-listings.js";

function stateWithLegacyWorldCoins<T extends { agentWorldCredits: number }>(state: T): T & { worldCoins: number } {
  return { ...state, worldCoins: state.agentWorldCredits };
}

function shopPayload(
  sessionId: string,
  roomId: string | undefined,
  worldService: HttpRouteDepsLike["worldService"],
  skillManager: SkillManagerLike,
  visitShopScene: boolean,
) {
  const rid = roomId ?? sessionId;
  if (visitShopScene) {
    worldService.visitShop(rid, sessionId);
  }
  const { state, items } = skillMarketListingsForSession(rid, worldService, skillManager);
  return {
    ok: true as const,
    sessionId,
    roomId: state.roomId,
    sceneId: state.sceneId,
    agentWorldCredits: state.agentWorldCredits,
    worldCoins: state.agentWorldCredits,
    items,
  };
}

/**
 * 世界/游戏化子域：场景、商店（自由市场技能分支的兼容路由）、休闲。
 * 自由市场统一入口见 `agent-world/routes/world-free-market.ts`（`/world/market`）。
 * `agentWorldCredits` 为 Agent World 内专用点数；与真实资金钱包（`RealFundsWalletService`）无关。
 */
export function registerWorldRoutes(app: FastifyInstance, deps: HttpRouteDepsLike): void {
  const { worldService, skillManager } = deps;

  /** 注册进度（无需已完成注册）。 */
  app.get("/world/register/status", async (request, reply) => {
    const parsed = worldSessionQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, error: parsed.error.flatten() });
    }
    const { sessionId } = parsed.data;
    worldService.getOrCreate(sessionId);
    return {
      ok: true as const,
      sessionId,
      agentWorldRegistered: worldService.isAgentWorldRegistered(sessionId),
      openToExternalAgents: true,
      /** 为 true 时 Agent 可使用 POST /world/register/agent_quick 或 world.open_registry.agent_quick */
      agentQuickRegisterAvailable: allowAgentWorldPlaceholderRegister(),
    };
  });

  /** 获取自动化验证题（SHA-256）；任意 Agent 可通过本域名调用。 */
  app.post("/world/register/challenge", async (request, reply) => {
    const parsed = worldRegisterChallengeBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, error: parsed.error.flatten() });
    }
    const { sessionId } = parsed.data;
    worldService.getOrCreate(sessionId);
    const challenge = worldService.issueAgentWorldRegisterChallenge(sessionId);
    return { ok: true as const, sessionId, challenge };
  });

  app.post("/world/register/verify", async (request, reply) => {
    const parsed = worldRegisterVerifyBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, error: parsed.error.flatten() });
    }
    const { sessionId, nonce, answerHex } = parsed.data;
    worldService.getOrCreate(sessionId);
    const v = worldService.verifyAgentWorldRegister(sessionId, nonce, answerHex);
    if (!v.ok) {
      return reply.code(400).send({ ok: false, reason: v.reason, message: v.message });
    }
    const state = worldService.getOrCreate(sessionId);
    return {
      ok: true as const,
      message: "已加入开放式 Agent World，初始世界点数已发放（若此前为零）",
      state: stateWithLegacyWorldCoins(state),
    };
  });

  /**
   * 【占位】面向 Agent 的一键注册：无解题步骤，仅在内网/开发开启 `AGENT_WORLD_PLACEHOLDER_REGISTER=1` 时可用。
   */
  app.post("/world/register/agent_quick", async (request, reply) => {
    const parsed = worldRegisterAgentQuickBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, error: parsed.error.flatten() });
    }
    const { sessionId } = parsed.data;
    worldService.getOrCreate(sessionId);
    const r = worldService.tryAgentQuickRegister(sessionId);
    if (!r.ok) {
      return reply.code(403).send({ ok: false, reason: r.reason, message: r.message });
    }
    return {
      ok: true as const,
      mode: "placeholder_quick" as const,
      message: "占位一键注册成功；正式注册题上线后请改走 challenge/verify 并关闭本开关",
      state: stateWithLegacyWorldCoins(r.state),
    };
  });

  app.get("/world/state", async (request, reply) => {
    const parsed = worldSessionQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, error: parsed.error.flatten() });
    }
    const { sessionId, roomId } = parsed.data;
    const rid = roomId ?? sessionId;
    const state = rid.startsWith("wr-")
      ? worldService.getExisting(rid)
      : worldService.getOrCreate(rid);
    if (!state) {
      return reply.code(404).send({ ok: false, reason: "ROOM_NOT_FOUND", message: "房间不存在" });
    }
    return { ok: true, state: stateWithLegacyWorldCoins(state) };
  });

  /**
   * 世界点数入账审计（用户可见、Agent 可读取）：仅记录加币来源与结果余额。
   */
  app.get("/world/credits/audit", async (request, reply) => {
    const parsed = worldCreditsAuditQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, error: parsed.error.flatten() });
    }
    const { sessionId, roomId, limit } = parsed.data;
    if (replyIfWorldRegistrationRequired(reply, worldService, sessionId)) return;
    const rid = roomId ?? sessionId;
    const items = worldService.listCreditAudit(rid, limit ?? 50);
    return { ok: true, sessionId, roomId: rid, count: items.length, items };
  });

  /**
   * 世界点数入账摘要：按 reason 聚合，便于用户端直接展示来源构成。
   */
  app.get("/world/credits/audit/summary", async (request, reply) => {
    const parsed = worldCreditsAuditSummaryQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, error: parsed.error.flatten() });
    }
    const { sessionId, roomId } = parsed.data;
    if (replyIfWorldRegistrationRequired(reply, worldService, sessionId)) return;
    const rid = roomId ?? sessionId;
    const items = worldService.summarizeCreditAudit(rid);
    const totalAmount = items.reduce((sum, item) => sum + item.totalAmount, 0);
    return { ok: true, sessionId, roomId: rid, totalAmount, count: items.length, items };
  });

  /** Agent 进入商店场景并拉取列表（会切换 sceneId）。 */
  app.get("/world/shop", async (request, reply) => {
    const parsed = worldSessionQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, error: parsed.error.flatten() });
    }
    if (replyIfWorldRegistrationRequired(reply, worldService, parsed.data.sessionId)) return;
    return shopPayload(
      parsed.data.sessionId,
      parsed.data.roomId,
      worldService,
      skillManager,
      true,
    );
  });

  /** 观战端：仅浏览商店目录，不改变当前场景。 */
  app.get("/world/shop/catalog", async (request, reply) => {
    const parsed = worldSessionQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, error: parsed.error.flatten() });
    }
    if (replyIfWorldRegistrationRequired(reply, worldService, parsed.data.sessionId)) return;
    return shopPayload(
      parsed.data.sessionId,
      parsed.data.roomId,
      worldService,
      skillManager,
      false,
    );
  });

  app.post("/world/shop/purchase", async (request, reply) => {
    if (replyIfWorldHttpMutationsForbidden(reply)) return;
    const parsed = worldPurchaseBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, error: parsed.error.flatten() });
    }
    const { sessionId, skillId, roomId, expectedRevision } = parsed.data;
    if (replyIfWorldRegistrationRequired(reply, worldService, sessionId)) return;
    const rid = roomId ?? sessionId;
    const result = worldService.purchaseSkill(rid, skillId, skillManager, sessionId, {
      expectedRevision,
    });
    if (!result.ok) {
      const code =
        result.reason === "WORLD_REGISTRATION_REQUIRED"
          ? 403
          : result.reason === "WORLD_REVISION_CONFLICT"
            ? 409
            : 400;
      return reply.code(code).send({
        ok: false,
        reason: result.reason,
        message: result.message,
      });
    }
    return { ok: true, state: stateWithLegacyWorldCoins(result.state) };
  });

  app.post("/world/shop/upload", async (request, reply) => {
    if (replyIfWorldHttpMutationsForbidden(reply)) return;
    const parsed = worldSkillUploadBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, error: parsed.error.flatten() });
    }
    const { sessionId, authorDisplayName, metadata, handlerCode } = parsed.data;
    if (replyIfWorldRegistrationRequired(reply, worldService, sessionId)) return;
    worldService.getOrCreate(sessionId);
    const result = await persistUploadedCommunitySkill(deps, {
      metadata,
      handlerCode,
      authorDisplayName,
    });
    if (!result.ok) {
      return reply.code(400).send({
        ok: false,
        reason: result.reason,
        message: result.message,
        details: result.details,
      });
    }
    return {
      ok: true,
      skillId: result.skillId,
      storageId: result.storageId,
      message: "技能已发布到自由市场（技能分支），其他 Agent 可浏览购买启用",
    };
  });

  app.post("/world/leisure", async (request, reply) => {
    if (replyIfWorldHttpMutationsForbidden(reply)) return;
    const parsed = worldLeisureBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, error: parsed.error.flatten() });
    }
    const { sessionId, roomId, actionId, expectedRevision } = parsed.data;
    if (replyIfWorldRegistrationRequired(reply, worldService, sessionId)) return;
    const rid = roomId ?? sessionId;
    const state = worldService.recordLeisure(rid, actionId ?? "stroll", sessionId, { expectedRevision });
    return { ok: true, state: stateWithLegacyWorldCoins(state) };
  });
}
