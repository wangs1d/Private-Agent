import { z } from "zod";

/** 与 docs/AGENT-PROTOCOL-CATALOG.md（第一部分 L1–L6）对齐的通用协议实现版本（传输面）。 */
export const UNIFIED_PROTOCOL_VERSION = "0.1" as const;
const requestIdSchema = z.string().min(1).max(128);

/** 客户端 → 服务端 WebSocket `type`。 */
export const UnifiedClientEventType = {
  Capabilities: "protocol.unified.capabilities",
  QuotaAdjust: "protocol.unified.quota.adjust",
  MemoryPatch: "protocol.unified.memory.patch",
  MemoryGet: "protocol.unified.memory.get",
  HumanDirective: "protocol.unified.human.directive",
  GovernanceProbe: "protocol.unified.governance.probe",
} as const;

/** 服务端 → 客户端 WebSocket `type`。 */
export const UnifiedServerEventType = {
  Capabilities: "protocol.unified.capabilities",
  QuotaState: "protocol.unified.quota.state",
  MemorySnapshot: "protocol.unified.memory.snapshot",
  HumanDirectiveAck: "protocol.unified.human.directive.ack",
  GovernanceAck: "protocol.unified.governance.ack",
} as const;

export const unifiedCapabilitiesClientSchema = z.object({
  traceId: z.string().optional(),
  requestId: requestIdSchema.optional(),
});

const atLeastOneActor = (val: { userId?: string; sessionId?: string }, ctx: z.RefinementCtx) => {
  const u = val.userId?.trim();
  const s = val.sessionId?.trim();
  if (!u && !s) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "需要 userId 或 sessionId" });
  }
};

/** L4 记忆等按此 id 分桶：优先 `userId`（稳定用户标识），否则回退 `sessionId`（兼容旧客户端）。 */
export function resolveUnifiedMemoryActorId(payload: {
  userId?: string | undefined;
  sessionId?: string | undefined;
}): string {
  const u = payload.userId?.trim();
  if (u) return u;
  const s = payload.sessionId?.trim();
  return s ?? "";
}

export const unifiedQuotaAdjustSchema = z
  .object({
    userId: z.string().min(1).optional(),
    sessionId: z.string().min(1).optional(),
    op: z.enum(["reserve", "consume", "release"]),
    units: z.number().int().positive(),
    reason: z.string().max(400).optional(),
    traceId: z.string().optional(),
    requestId: requestIdSchema.optional(),
  })
  .superRefine(atLeastOneActor);

export const unifiedMemoryPatchSchema = z
  .object({
    userId: z.string().min(1).optional(),
    sessionId: z.string().min(1).optional(),
    basisRevision: z.number().int().nonnegative(),
    patches: z
      .array(
        z.object({
          key: z.string().min(1).max(256),
          op: z.enum(["put", "delete"]),
          /** JSON 可序列化值；`delete` 可省略 */
          value: z.unknown().optional(),
        }),
      )
      .max(200),
    traceId: z.string().optional(),
    requestId: requestIdSchema.optional(),
  })
  .superRefine(atLeastOneActor);

export const unifiedMemoryGetSchema = z
  .object({
    userId: z.string().min(1).optional(),
    sessionId: z.string().min(1).optional(),
    keys: z.array(z.string().min(1).max(256)).max(100).optional(),
    traceId: z.string().optional(),
    requestId: requestIdSchema.optional(),
  })
  .superRefine(atLeastOneActor);

export const unifiedHumanDirectiveSchema = z
  .object({
    userId: z.string().min(1).optional(),
    sessionId: z.string().min(1).optional(),
    scope: z.enum(["session", "partition"]),
    partitionId: z.string().optional(),
    text: z.string().min(1).max(16_000),
    priority: z.enum(["low", "normal", "high"]).optional(),
    traceId: z.string().optional(),
    requestId: requestIdSchema.optional(),
  })
  .superRefine(atLeastOneActor);

export const unifiedGovernanceProbeSchema = z
  .object({
    userId: z.string().min(1).optional(),
    sessionId: z.string().min(1).optional(),
    action: z.string().min(1).max(200),
    context: z.record(z.string(), z.unknown()).optional(),
    traceId: z.string().optional(),
    requestId: requestIdSchema.optional(),
  })
  .superRefine(atLeastOneActor);

export type UnifiedLayerId = "L1" | "L2" | "L3" | "L4" | "L5" | "L6";

/** well-known 与 capabilities 响应中声明的层能力（实现可渐进补齐）。 */
export const UNIFIED_LAYER_MANIFEST: ReadonlyArray<{
  id: UnifiedLayerId;
  title: string;
  wsClientEvents: string[];
  wsServerEvents: string[];
  httpPaths: string[];
}> = [
  {
    id: "L1",
    title: "传输载体",
    wsClientEvents: [UnifiedClientEventType.Capabilities],
    wsServerEvents: [UnifiedServerEventType.Capabilities],
    httpPaths: [],
  },
  {
    id: "L2",
    title: "实时与一致性",
    wsClientEvents: [],
    wsServerEvents: [],
    httpPaths: [],
  },
  {
    id: "L3",
    title: "算力与接入",
    wsClientEvents: [UnifiedClientEventType.QuotaAdjust],
    wsServerEvents: [UnifiedServerEventType.QuotaState],
    httpPaths: ["/protocol/unified/quota"],
  },
  {
    id: "L4",
    title: "记忆与调度",
    wsClientEvents: [UnifiedClientEventType.MemoryPatch, UnifiedClientEventType.MemoryGet],
    wsServerEvents: [UnifiedServerEventType.MemorySnapshot],
    httpPaths: ["/protocol/unified/memory"],
  },
  {
    id: "L5",
    title: "领域语义",
    wsClientEvents: [UnifiedClientEventType.HumanDirective],
    wsServerEvents: [UnifiedServerEventType.HumanDirectiveAck],
    httpPaths: [],
  },
  {
    id: "L6",
    title: "治理与合规",
    wsClientEvents: [UnifiedClientEventType.GovernanceProbe],
    wsServerEvents: [UnifiedServerEventType.GovernanceAck],
    httpPaths: [],
  },
];
