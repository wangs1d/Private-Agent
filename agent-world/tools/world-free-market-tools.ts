import type { A2aOutsourcingService } from "../services/a2a-outsourcing-service.js";
import type { SkillManagerLike, ToolRegistryLike } from "../host-types.js";
import type { WorldService } from "../services/world-service.js";
import { skillMarketListingsForSession } from "../services/world-skill-listings.js";
import { resolveWorldRoomId, worldMutationOpts } from "./world-tool-input.js";

/**
 * Agent World 自由市场：技能分支 + A2A 任务外包。前缀 `world.free_market.*`。
 * 可变操作支持可选 `roomId`（缺省为个人房 = sessionId）、`expectedRevision` 乐观并发。
 */
export function registerWorldFreeMarketTools(
  registry: ToolRegistryLike,
  worldService: WorldService,
  a2a: A2aOutsourcingService,
  skillManager: SkillManagerLike,
): void {
  registry.register("world.free_market.enter", async (input, context) => {
    worldService.assertAgentWorldRegistered(context.sessionId);
    const rid = resolveWorldRoomId(input, context.sessionId);
    const opts = worldMutationOpts(input);
    worldService.visitFreeMarket(rid, context.sessionId, opts);
    const state = worldService.getOrCreate(rid);
    return {
      ok: true,
      roomId: state.roomId,
      summary: "已进入自由市场场景（技能交易与 A2A 外包同属此经济域）",
      sceneId: state.sceneId,
      agentWorldCredits: state.agentWorldCredits,
      revision: state.revision,
      branches: ["skills", "a2a_contracts"],
    };
  });

  registry.register("world.free_market.list_skill_listings", async (input, context) => {
    worldService.assertAgentWorldRegistered(context.sessionId);
    const rid = resolveWorldRoomId(input, context.sessionId);
    const visit = input.visit === true;
    if (visit) {
      worldService.visitFreeMarket(rid, context.sessionId, worldMutationOpts(input));
    }
    const { state, items } = skillMarketListingsForSession(rid, worldService, skillManager);
    return {
      ok: true,
      roomId: state.roomId,
      sceneId: state.sceneId,
      revision: state.revision,
      agentWorldCredits: state.agentWorldCredits,
      itemCount: items.length,
      items,
    };
  });

  registry.register("world.free_market.purchase_skill", async (input, context) => {
    worldService.assertAgentWorldRegistered(context.sessionId);
    const skillId = String(input.skillId ?? "").trim();
    if (!skillId) throw new Error("缺少 skillId");
    const rid = resolveWorldRoomId(input, context.sessionId);
    const result = worldService.purchaseSkill(
      rid,
      skillId,
      skillManager,
      context.sessionId,
      worldMutationOpts(input),
    );
    if (!result.ok) throw new Error(result.message);
    return {
      ok: true,
      roomId: result.state.roomId,
      revision: result.state.revision,
      state: result.state,
      message: "已扣点并启用技能",
    };
  });

  registry.register("world.free_market.list_contracts", async (input, context) => {
    worldService.assertAgentWorldRegistered(context.sessionId);
    const filterRaw = String(input.filter ?? "open").trim();
    const filter = filterRaw === "mine" ? "mine" : "open";
    const contracts = a2a.listContracts(context.sessionId, filter);
    return {
      ok: true,
      filter,
      count: contracts.length,
      contracts,
    };
  });

  registry.register("world.free_market.list_credit_audit", async (input, context) => {
    worldService.assertAgentWorldRegistered(context.sessionId);
    const rid = resolveWorldRoomId(input, context.sessionId);
    const limitRaw = Number(input.limit ?? 50);
    const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(200, Math.floor(limitRaw))) : 50;
    const items = worldService.listCreditAudit(rid, limit);
    return {
      ok: true,
      sessionId: context.sessionId,
      roomId: rid,
      count: items.length,
      items,
    };
  });

  registry.register("world.free_market.summarize_credit_audit", async (input, context) => {
    worldService.assertAgentWorldRegistered(context.sessionId);
    const rid = resolveWorldRoomId(input, context.sessionId);
    const items = worldService.summarizeCreditAudit(rid);
    const totalAmount = items.reduce((sum, item) => sum + item.totalAmount, 0);
    return {
      ok: true,
      sessionId: context.sessionId,
      roomId: rid,
      totalAmount,
      count: items.length,
      items,
    };
  });

  registry.register("world.free_market.create_contract", async (input, context) => {
    worldService.assertAgentWorldRegistered(context.sessionId);
    const title = String(input.title ?? "").trim();
    const specification = String(input.specification ?? "").trim();
    const rewardCredits = Number(input.rewardCredits ?? 0);
    const assigneeRaw = input.assigneeSessionId;
    const assigneeSessionId =
      assigneeRaw !== undefined && assigneeRaw !== null ? String(assigneeRaw).trim() : undefined;
    const result = await a2a.createContract({
      clientSessionId: context.sessionId,
      title,
      specification,
      rewardCredits,
      assigneeSessionId: assigneeSessionId && assigneeSessionId.length > 0 ? assigneeSessionId : null,
    });
    if (!result.ok) throw new Error(result.message);
    worldService.visitFreeMarket(context.sessionId, context.sessionId);
    return {
      ok: true,
      contract: result.contract,
      agentWorldCredits: worldService.getOrCreate(context.sessionId).agentWorldCredits,
    };
  });

  registry.register("world.free_market.accept_contract", async (input, context) => {
    worldService.assertAgentWorldRegistered(context.sessionId);
    const contractId = String(input.contractId ?? "").trim();
    if (!contractId) throw new Error("缺少 contractId");
    worldService.visitFreeMarket(context.sessionId, context.sessionId);
    const result = await a2a.acceptContract({
      contractId,
      providerSessionId: context.sessionId,
    });
    if (!result.ok) throw new Error(result.message);
    return { ok: true, contract: result.contract };
  });

  registry.register("world.free_market.deliver_contract", async (input, context) => {
    worldService.assertAgentWorldRegistered(context.sessionId);
    const contractId = String(input.contractId ?? "").trim();
    const deliverable = String(input.deliverable ?? "");
    if (!contractId) throw new Error("缺少 contractId");
    const result = await a2a.deliverContract({
      contractId,
      providerSessionId: context.sessionId,
      deliverable,
    });
    if (!result.ok) throw new Error(result.message);
    return { ok: true, contract: result.contract };
  });

  registry.register("world.free_market.complete_contract", async (input, context) => {
    worldService.assertAgentWorldRegistered(context.sessionId);
    const contractId = String(input.contractId ?? "").trim();
    if (!contractId) throw new Error("缺少 contractId");
    const result = await a2a.completeContract({
      contractId,
      clientSessionId: context.sessionId,
    });
    if (!result.ok) throw new Error(result.message);
    return {
      ok: true,
      contract: result.contract,
      agentWorldCredits: worldService.getOrCreate(context.sessionId).agentWorldCredits,
    };
  });

  registry.register("world.free_market.reject_delivery", async (input, context) => {
    worldService.assertAgentWorldRegistered(context.sessionId);
    const contractId = String(input.contractId ?? "").trim();
    if (!contractId) throw new Error("缺少 contractId");
    const reason =
      input.reason !== undefined && input.reason !== null ? String(input.reason) : undefined;
    const result = await a2a.rejectDelivery({
      contractId,
      clientSessionId: context.sessionId,
      reason,
    });
    if (!result.ok) throw new Error(result.message);
    return {
      ok: true,
      contract: result.contract,
      agentWorldCredits: worldService.getOrCreate(context.sessionId).agentWorldCredits,
    };
  });

  registry.register("world.free_market.cancel_contract", async (input, context) => {
    worldService.assertAgentWorldRegistered(context.sessionId);
    const contractId = String(input.contractId ?? "").trim();
    if (!contractId) throw new Error("缺少 contractId");
    const result = await a2a.cancelContract({
      contractId,
      clientSessionId: context.sessionId,
    });
    if (!result.ok) throw new Error(result.message);
    return {
      ok: true,
      contract: result.contract,
      agentWorldCredits: worldService.getOrCreate(context.sessionId).agentWorldCredits,
    };
  });
}
