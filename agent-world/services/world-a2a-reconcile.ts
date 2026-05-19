import type { A2aOutsourcingService } from "./a2a-outsourcing-service.js";
import type { AuditServiceLike } from "../host-types.js";
import type { WorldService } from "./world-service.js";

function isActiveEscrowStatus(s: string): boolean {
  return s === "open" || s === "in_progress" || s === "delivered";
}

export type A2aReconcileAdjustment = {
  sessionId: string;
  previousEscrowReserved: number;
  expectedEscrowReserved: number;
  previousCredits: number;
  creditsAfter: number;
  creditsDelta: number;
  balanceClampedToZero: boolean;
};

/**
 * 以契约文件为权威，校正各发包方 `a2aEscrowReserved` 与 `agentWorldCredits`：
 * - 若契约中仍有未结单悬赏，但本地记录的托管额偏少 → 从余额补扣差额；
 * - 若本地托管额多于契约合计 → 差额退回余额。
 *
 * 应在 `WorldService.load` 与 `A2aOutsourcingService.load` 之后调用一次。
 */
export async function reconcileWorldA2aEscrows(
  world: WorldService,
  a2a: A2aOutsourcingService,
  audit?: AuditServiceLike,
): Promise<{ adjustments: A2aReconcileAdjustment[] }> {
  const expectedByClient = new Map<string, number>();
  for (const c of a2a.listAllContracts()) {
    if (!isActiveEscrowStatus(c.status)) continue;
    const prev = expectedByClient.get(c.clientSessionId) ?? 0;
    expectedByClient.set(c.clientSessionId, prev + c.rewardCredits);
  }

  const sessionIds = new Set<string>([...expectedByClient.keys()]);
  for (const rid of world.listRoomIds()) {
    if (rid.startsWith("wr-")) continue;
    sessionIds.add(rid);
  }

  const adjustments: A2aReconcileAdjustment[] = [];

  for (const sessionId of sessionIds) {
    const s = world.getOrCreate(sessionId);
    const expected = expectedByClient.get(sessionId) ?? 0;
    const stored = s.a2aEscrowReserved;
    if (expected === stored) continue;

    const diff = expected - stored;
    const previousCredits = s.agentWorldCredits;
    s.agentWorldCredits -= diff;
    s.a2aEscrowReserved = expected;
    let balanceClampedToZero = false;
    if (s.agentWorldCredits < 0) {
      s.agentWorldCredits = 0;
      balanceClampedToZero = true;
    }
    adjustments.push({
      sessionId,
      previousEscrowReserved: stored,
      expectedEscrowReserved: expected,
      previousCredits,
      creditsAfter: s.agentWorldCredits,
      creditsDelta: s.agentWorldCredits - previousCredits,
      balanceClampedToZero,
    });
  }

  for (const adj of adjustments) {
    world.markWorldMutated(adj.sessionId);
  }

  if (audit) {
    await audit.record({
      type: "world.a2a_reconcile",
      at: new Date().toISOString(),
      adjustmentCount: adjustments.length,
      adjustments,
    });
  }

  return { adjustments };
}
