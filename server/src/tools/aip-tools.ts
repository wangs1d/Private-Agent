import type { AipService } from "../aip/aip-service.js";
import { AIP_VERSION } from "../aip/aip-types.js";
import type { ToolRegistry } from "./tool-registry.js";

/**
 * AI 原生交互协议（AIP）v0.1 工具：结构化跨 Agent 消息，与自然语言解耦以便不同厂商实现互操作。
 */
export function registerAipTools(registry: ToolRegistry, aip: AipService): void {
  registry.register("aip.dispatch", async (input, context) => {
    const toSessionId = String(input.toSessionId ?? "").trim();
    if (!toSessionId) throw new Error("缺少 toSessionId");
    const kind = String(input.kind ?? "").trim();
    if (!kind) throw new Error("缺少 kind");
    const payload =
      input.payload !== undefined && input.payload !== null && typeof input.payload === "object"
        ? (input.payload as Record<string, unknown>)
        : {};
    const correlationId =
      typeof input.correlationId === "string" && input.correlationId.length > 0
        ? input.correlationId
        : undefined;
    const proposalId =
      typeof input.proposalId === "string" && input.proposalId.length > 0 ? input.proposalId : undefined;
    const rawEnvelope = {
      aipVersion: AIP_VERSION,
      kind,
      payload,
      ...(correlationId ? { correlationId } : {}),
      ...(proposalId ? { proposalId } : {}),
    };
    const r = aip.dispatch({
      fromSessionId: context.sessionId,
      toSessionId,
      rawEnvelope,
      traceId: typeof input.traceId === "string" ? input.traceId : undefined,
      chatUserMessageId: context.chatUserMessageId,
    });
    if (!r.ok) throw new Error(r.message);
    return {
      ok: true,
      messageId: r.record.messageId,
      toSessionId,
      pushedToPeer: r.pushedToPeer,
      aip: r.record.aip,
      summary: r.record.text,
    };
  });

  registry.register("aip.list_my_state", async (_input, context) => {
    return {
      ok: true,
      sessionId: context.sessionId,
      alliances: aip.listAlliancesForSession(context.sessionId),
      openConflicts: aip.listOpenConflictsForSession(context.sessionId),
    };
  });

  registry.register("aip.get_proposal", async (input, context) => {
    const proposalId = String(input.proposalId ?? "").trim();
    if (!proposalId) throw new Error("缺少 proposalId");
    const p = aip.getProposal(proposalId);
    if (!p) return { ok: false, reason: "NOT_FOUND", message: "提议不存在" };
    if (p.fromSessionId !== context.sessionId && p.toSessionId !== context.sessionId) {
      throw new Error("无权查看该提议");
    }
    return { ok: true, proposal: p };
  });
}
