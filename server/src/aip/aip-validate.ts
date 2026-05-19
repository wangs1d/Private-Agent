import { z } from "zod";

import type { AipKind, AipWireEnvelope } from "./aip-types.js";
import { AIP_VERSION } from "./aip-types.js";

const intentTag = z.enum(["question", "inform", "request_action", "commit", "negotiate", "other"]);

const utterance = z.object({
  text: z.string().min(1).max(16000),
  intentTag: intentTag.optional(),
  locale: z.string().max(32).optional(),
});

const tradeProposal = z.object({
  summary: z.string().min(1).max(4000),
  offer: z.string().max(4000).optional(),
  ask: z.string().max(4000).optional(),
  worldRoomId: z.string().max(256).optional(),
  a2aContractId: z.string().max(256).optional(),
  expiresInMinutes: z.number().int().min(1).max(10080).optional(),
});

const tradeResponse = z.object({
  proposalId: z.string().min(1),
  decision: z.enum(["accept", "reject", "counter"]),
  note: z.string().max(4000).optional(),
});

const allianceInvite = z.object({
  terms: z.string().max(4000).optional(),
  inviteeSessionId: z.string().min(1).optional(),
});

const allianceResponse = z.object({
  proposalId: z.string().min(1),
  decision: z.enum(["accept", "reject"]),
  note: z.string().max(2000).optional(),
});

const conflictDeclare = z.object({
  targetSessionId: z.string().min(1),
  reason: z.string().min(1).max(4000),
  stakeSummary: z.string().max(2000).optional(),
});

const conflictResponse = z.object({
  conflictId: z.string().min(1),
  action: z.enum(["withdraw", "offer_truce", "acknowledge", "escalate"]),
  note: z.string().max(2000).optional(),
});

const validators: Record<AipKind, z.ZodType<Record<string, unknown>>> = {
  utterance: utterance as z.ZodType<Record<string, unknown>>,
  trade_proposal: tradeProposal as z.ZodType<Record<string, unknown>>,
  trade_response: tradeResponse as z.ZodType<Record<string, unknown>>,
  alliance_invite: allianceInvite as z.ZodType<Record<string, unknown>>,
  alliance_response: allianceResponse as z.ZodType<Record<string, unknown>>,
  conflict_declare: conflictDeclare as z.ZodType<Record<string, unknown>>,
  conflict_response: conflictResponse as z.ZodType<Record<string, unknown>>,
};

export function parseAipEnvelope(input: unknown):
  | { ok: true; envelope: AipWireEnvelope }
  | { ok: false; message: string } {
  if (!input || typeof input !== "object") {
    return { ok: false, message: "AIP 消息必须是对象" };
  }
  const o = input as Record<string, unknown>;
  const ver = o.aipVersion;
  if (ver !== AIP_VERSION) {
    return { ok: false, message: `不支持的 aipVersion，当前仅支持 ${AIP_VERSION}` };
  }
  const kind = o.kind;
  if (typeof kind !== "string" || !(kind in validators)) {
    return { ok: false, message: `无效的 kind: ${kind}` };
  }
  const aipKind = kind as AipKind;
  const rawPayload = o.payload;
  if (!rawPayload || typeof rawPayload !== "object") {
    return { ok: false, message: "缺少 payload 对象" };
  }
  const parsed = validators[aipKind].safeParse(rawPayload);
  if (!parsed.success) {
    return { ok: false, message: parsed.error.message };
  }
  const correlationId =
    typeof o.correlationId === "string" && o.correlationId.length > 0 ? o.correlationId : undefined;
  const proposalId =
    typeof o.proposalId === "string" && o.proposalId.length > 0 ? o.proposalId : undefined;
  return {
    ok: true,
    envelope: {
      aipVersion: AIP_VERSION,
      kind: aipKind,
      payload: parsed.data,
      correlationId,
      proposalId,
    },
  };
}

export function summarizeAipForRelayText(envelope: AipWireEnvelope): string {
  const p = envelope.payload;
  switch (envelope.kind) {
    case "utterance":
      return `[AIP utterance] ${String(p.text ?? "").slice(0, 500)}`;
    case "trade_proposal":
      return `[AIP trade_proposal] ${String(p.summary ?? "")}`;
    case "trade_response":
      return `[AIP trade_response] ${String(p.decision ?? "")} proposal=${String(p.proposalId ?? "")}`;
    case "alliance_invite":
      return `[AIP alliance_invite] ${String(p.terms ?? "(无条款摘要)")}`;
    case "alliance_response":
      return `[AIP alliance_response] ${String(p.decision ?? "")} proposal=${String(p.proposalId ?? "")}`;
    case "conflict_declare":
      return `[AIP conflict_declare] vs ${String(p.targetSessionId ?? "")}: ${String(p.reason ?? "").slice(0, 200)}`;
    case "conflict_response":
      return `[AIP conflict_response] ${String(p.action ?? "")} conflict=${String(p.conflictId ?? "")}`;
    default:
      return `[AIP ${envelope.kind}]`;
  }
}
