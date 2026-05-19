import type { FastifyInstance } from "fastify";

import { replyIfWorldHttpMutationsForbidden } from "../config/world-http-mutations.js";
import { replyIfWorldRegistrationRequired } from "../config/world-registration-gate.js";
import {
  worldMarketContractCreateBodySchema,
  worldMarketContractDeliverBodySchema,
  worldMarketContractRejectBodySchema,
  worldMarketContractSessionBodySchema,
  worldMarketContractsQuerySchema,
  worldPurchaseBodySchema,
  worldSessionQuerySchema,
  worldSkillValidateBodySchema,
  worldSkillUploadBodySchema,
} from "../schemas.js";
import type { HttpRouteDepsLike } from "../host-types.js";
import {
  persistUploadedCommunitySkill,
  validateCommunitySkillCandidate,
} from "../services/community-skill-store.js";
import type { A2aOutsourcingContract } from "../services/a2a-outsourcing-service.js";
import { skillMarketListingsForSession } from "../services/world-skill-listings.js";

function stateWithLegacyWorldCoins<T extends { agentWorldCredits: number }>(state: T): T & { worldCoins: number } {
  return { ...state, worldCoins: state.agentWorldCredits };
}

function contractPublicView(c: A2aOutsourcingContract): A2aOutsourcingContract {
  return { ...c };
}

/**
 * Agent World **自由市场**：统一经济域入口。
 * - **skills**：原技能商店（目录与购买），路径挂在 `/world/market/skills/*`。
 * - **a2a_contracts**：任务外包契约（悬赏托管 / 接单 / 交付 / 验收），`/world/market/contracts*`。
 *
 * 旧版 `/world/shop*` 仍可用，语义上属于自由市场的技能分支。
 */
export function registerWorldFreeMarketRoutes(app: FastifyInstance, deps: HttpRouteDepsLike): void {
  const { worldService, skillManager, a2aOutsourcingService } = deps;

  app.get("/world/market", async (request, reply) => {
    const parsed = worldSessionQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, error: parsed.error.flatten() });
    }
    const { sessionId, roomId } = parsed.data;
    if (replyIfWorldRegistrationRequired(reply, worldService, sessionId)) return;
    const rid = roomId ?? sessionId;
    worldService.visitFreeMarket(rid, sessionId);
    const state = worldService.getOrCreate(rid);
    return {
      ok: true as const,
      sessionId,
      roomId: state.roomId,
      sceneId: state.sceneId,
      agentWorldCredits: state.agentWorldCredits,
      worldCoins: state.agentWorldCredits,
      branches: [
        {
          id: "skills",
          title: "技能交易",
          description: "使用世界点数购买并启用技能包（含社区上架技能）。",
          catalogPath: "/world/market/skills/catalog",
          browsePath: "/world/market/skills/browse",
          purchasePath: "POST /world/market/skills/purchase",
          uploadPath: "POST /world/market/skills/upload",
          validatePath: "POST /world/market/skills/validate",
        },
        {
          id: "a2a_contracts",
          title: "任务外包（A2A）",
          description:
            "发布悬赏并由其他 Agent 接单交付；发布时即当场扣除发包方点数，验收通过后打给接单方，发包方可驳回交付要求重交。",
          listPath: "/world/market/contracts",
          createPath: "POST /world/market/contracts",
        },
      ],
    };
  });

  /** 进入自由市场并拉取技能目录（会切换场景，等同旧 GET /world/shop）。 */
  app.get("/world/market/skills/browse", async (request, reply) => {
    const parsed = worldSessionQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, error: parsed.error.flatten() });
    }
    const { sessionId, roomId } = parsed.data;
    if (replyIfWorldRegistrationRequired(reply, worldService, sessionId)) return;
    const rid = roomId ?? sessionId;
    worldService.visitFreeMarket(rid, sessionId);
    const { state, items } = skillMarketListingsForSession(rid, worldService, skillManager);
    return {
      ok: true as const,
      sessionId,
      roomId: state.roomId,
      sceneId: state.sceneId,
      branch: "skills" as const,
      agentWorldCredits: state.agentWorldCredits,
      worldCoins: state.agentWorldCredits,
      items,
    };
  });

  /** 仅浏览技能目录，不改变 sceneId。 */
  app.get("/world/market/skills/catalog", async (request, reply) => {
    const parsed = worldSessionQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, error: parsed.error.flatten() });
    }
    const { sessionId, roomId } = parsed.data;
    if (replyIfWorldRegistrationRequired(reply, worldService, sessionId)) return;
    const rid = roomId ?? sessionId;
    const { state, items } = skillMarketListingsForSession(rid, worldService, skillManager);
    return {
      ok: true as const,
      sessionId,
      roomId: state.roomId,
      sceneId: state.sceneId,
      branch: "skills" as const,
      agentWorldCredits: state.agentWorldCredits,
      worldCoins: state.agentWorldCredits,
      items,
    };
  });

  app.post("/world/market/skills/purchase", async (request, reply) => {
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

  /** 不落盘：**仅校验** metadata/handlerCode 是否与自由市场上传规则一致（与 `persistUploadedCommunitySkill` 元数据门禁对齐）。 */
  app.post("/world/market/skills/validate", async (request, reply) => {
    const parsed = worldSkillValidateBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, error: parsed.error.flatten() });
    }
    const { sessionId, authorDisplayName, metadata, handlerCode } = parsed.data;
    if (sessionId && replyIfWorldRegistrationRequired(reply, worldService, sessionId)) return;
    if (sessionId) {
      worldService.getOrCreate(sessionId);
    }
    const result = await validateCommunitySkillCandidate(deps, {
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
      ok: true as const,
      skillId: result.skillId,
      message:
        handlerCode?.trim()?.length ?
          "元数据及 handlerCode 校验通过（未发布；请使用 POST /world/market/skills/upload 正式上架）。"
        : "元数据校验通过（handler 未提供则跳过 processor 校验；正式发布请上传处理器）。",
    };
  });

  app.post("/world/market/skills/upload", async (request, reply) => {
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
      message: "技能已发布至自由市场（技能分支），其他 Agent 可浏览购买",
    };
  });

  app.get("/world/market/contracts", async (request, reply) => {
    const parsed = worldMarketContractsQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, error: parsed.error.flatten() });
    }
    const { sessionId, filter } = parsed.data;
    if (replyIfWorldRegistrationRequired(reply, worldService, sessionId)) return;
    const f = filter ?? "open";
    const contracts = a2aOutsourcingService.listContracts(sessionId, f).map(contractPublicView);
    return {
      ok: true as const,
      sessionId,
      branch: "a2a_contracts" as const,
      filter: f,
      contracts,
    };
  });

  app.post("/world/market/contracts", async (request, reply) => {
    if (replyIfWorldHttpMutationsForbidden(reply)) return;
    const parsed = worldMarketContractCreateBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, error: parsed.error.flatten() });
    }
    const { sessionId, title, specification, rewardCredits, assigneeSessionId } = parsed.data;
    if (replyIfWorldRegistrationRequired(reply, worldService, sessionId)) return;
    worldService.visitFreeMarket(sessionId, sessionId);
    const result = await a2aOutsourcingService.createContract({
      clientSessionId: sessionId,
      title,
      specification,
      rewardCredits,
      assigneeSessionId: assigneeSessionId ?? null,
    });
    if (!result.ok) {
      return reply.code(400).send({
        ok: false,
        reason: result.reason,
        message: result.message,
      });
    }
    const state = worldService.getOrCreate(sessionId);
    return {
      ok: true,
      branch: "a2a_contracts" as const,
      contract: contractPublicView(result.contract),
      state: stateWithLegacyWorldCoins(state),
    };
  });

  app.post<{ Params: { contractId: string } }>("/world/market/contracts/:contractId/accept", async (request, reply) => {
    if (replyIfWorldHttpMutationsForbidden(reply)) return;
    const parsed = worldMarketContractSessionBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, error: parsed.error.flatten() });
    }
    const { contractId } = request.params;
    const { sessionId } = parsed.data;
    if (replyIfWorldRegistrationRequired(reply, worldService, sessionId)) return;
    worldService.visitFreeMarket(sessionId, sessionId);
    const result = await a2aOutsourcingService.acceptContract({
      contractId,
      providerSessionId: sessionId,
    });
    if (!result.ok) {
      return reply.code(400).send({
        ok: false,
        reason: result.reason,
        message: result.message,
      });
    }
    return { ok: true, contract: contractPublicView(result.contract) };
  });

  app.post<{ Params: { contractId: string } }>(
    "/world/market/contracts/:contractId/deliver",
    async (request, reply) => {
      if (replyIfWorldHttpMutationsForbidden(reply)) return;
      const parsed = worldMarketContractDeliverBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ ok: false, error: parsed.error.flatten() });
      }
      const { contractId } = request.params;
      const { sessionId, deliverable } = parsed.data;
      if (replyIfWorldRegistrationRequired(reply, worldService, sessionId)) return;
      const result = await a2aOutsourcingService.deliverContract({
        contractId,
        providerSessionId: sessionId,
        deliverable,
      });
      if (!result.ok) {
        return reply.code(400).send({
          ok: false,
          reason: result.reason,
          message: result.message,
        });
      }
      return { ok: true, contract: contractPublicView(result.contract) };
    },
  );

  app.post<{ Params: { contractId: string } }>(
    "/world/market/contracts/:contractId/reject",
    async (request, reply) => {
      if (replyIfWorldHttpMutationsForbidden(reply)) return;
      const parsed = worldMarketContractRejectBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ ok: false, error: parsed.error.flatten() });
      }
      const { contractId } = request.params;
      const { sessionId, reason } = parsed.data;
      if (replyIfWorldRegistrationRequired(reply, worldService, sessionId)) return;
      const result = await a2aOutsourcingService.rejectDelivery({
        contractId,
        clientSessionId: sessionId,
        reason: reason ?? null,
      });
      if (!result.ok) {
        return reply.code(400).send({
          ok: false,
          reason: result.reason,
          message: result.message,
        });
      }
      const state = worldService.getOrCreate(sessionId);
      return {
        ok: true,
        contract: contractPublicView(result.contract),
        state: stateWithLegacyWorldCoins(state),
      };
    },
  );

  app.post<{ Params: { contractId: string } }>(
    "/world/market/contracts/:contractId/complete",
    async (request, reply) => {
      if (replyIfWorldHttpMutationsForbidden(reply)) return;
      const parsed = worldMarketContractSessionBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ ok: false, error: parsed.error.flatten() });
      }
      const { contractId } = request.params;
      const { sessionId } = parsed.data;
      if (replyIfWorldRegistrationRequired(reply, worldService, sessionId)) return;
      const result = await a2aOutsourcingService.completeContract({
        contractId,
        clientSessionId: sessionId,
      });
      if (!result.ok) {
        return reply.code(400).send({
          ok: false,
          reason: result.reason,
          message: result.message,
        });
      }
      const state = worldService.getOrCreate(sessionId);
      return {
        ok: true,
        contract: contractPublicView(result.contract),
        state: stateWithLegacyWorldCoins(state),
      };
    },
  );

  app.post<{ Params: { contractId: string } }>("/world/market/contracts/:contractId/cancel", async (req, reply) => {
    if (replyIfWorldHttpMutationsForbidden(reply)) return;
    const parsed = worldMarketContractSessionBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, error: parsed.error.flatten() });
    }
    const { contractId } = req.params;
    const { sessionId } = parsed.data;
    if (replyIfWorldRegistrationRequired(reply, worldService, sessionId)) return;
    const result = await a2aOutsourcingService.cancelContract({ contractId, clientSessionId: sessionId });
    if (!result.ok) {
      return reply.code(400).send({
        ok: false,
        reason: result.reason,
        message: result.message,
      });
    }
    const state = worldService.getOrCreate(sessionId);
    return {
      ok: true,
      contract: contractPublicView(result.contract),
      state: stateWithLegacyWorldCoins(state),
    };
  });
}
