import type { WorldMutationOptions } from "../services/world-service.js";

export function resolveWorldRoomId(input: Record<string, unknown>, sessionId: string): string {
  const r = input.roomId;
  if (typeof r === "string" && r.trim().length > 0) return r.trim();
  return sessionId;
}

export function worldMutationOpts(input: Record<string, unknown>): WorldMutationOptions {
  const e = input.expectedRevision;
  if (e === undefined || e === null) return {};
  const n = Number(e);
  if (!Number.isFinite(n)) return {};
  return { expectedRevision: Math.max(0, Math.floor(n)) };
}
