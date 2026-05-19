import test from "node:test";
import assert from "node:assert/strict";

import {
  unifiedHumanDirectiveSchema,
  unifiedMemoryPatchSchema,
  unifiedQuotaAdjustSchema,
} from "@private-ai-agent/agent-world";
import { UnifiedErrorCode } from "../src/protocol-unified-errors.js";
import { UnifiedIdempotencyService } from "../src/services/unified-idempotency-service.js";

test("unified schema accepts requestId for write operations", () => {
  const q = unifiedQuotaAdjustSchema.safeParse({
    userId: "u-1",
    op: "reserve",
    units: 10,
    requestId: "req-quota-1",
  });
  assert.equal(q.success, true);

  const m = unifiedMemoryPatchSchema.safeParse({
    sessionId: "s-1",
    basisRevision: 0,
    patches: [{ key: "k1", op: "put", value: "v1" }],
    requestId: "req-mem-1",
  });
  assert.equal(m.success, true);

  const h = unifiedHumanDirectiveSchema.safeParse({
    userId: "u-2",
    scope: "session",
    text: "请优先保证审计合规",
    requestId: "req-hd-1",
  });
  assert.equal(h.success, true);
});

test("unified schema rejects empty requestId", () => {
  const r = unifiedQuotaAdjustSchema.safeParse({
    userId: "u-1",
    op: "reserve",
    units: 1,
    requestId: "",
  });
  assert.equal(r.success, false);
});

test("idempotency service caches and replays by actor+action+requestId", () => {
  const svc = new UnifiedIdempotencyService();
  const actorId = "actor-1";
  const action = "protocol.unified.memory_patch";
  const requestId = "req-123";
  const payload = { ok: true, revision: 7 };

  assert.equal(svc.get(actorId, action, requestId), null);
  svc.set(actorId, action, requestId, payload);

  const cached = svc.get(actorId, action, requestId);
  assert.deepEqual(cached, payload);
  assert.equal(svc.get(actorId, action, "req-other"), null);
});

test("unified error code catalog is stable", () => {
  assert.equal(UnifiedErrorCode.ValidationError, "VALIDATION_ERROR");
  assert.equal(UnifiedErrorCode.Forbidden, "FORBIDDEN");
  assert.equal(UnifiedErrorCode.SessionRequired, "SESSION_REQUIRED");
});
