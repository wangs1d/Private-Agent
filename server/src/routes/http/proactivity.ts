// HTTP 路由：统一主动性管道的诊断与结果回传（docs/proactivity-architecture.md §4）
//
// GET  /api/proactivity/diagnostics —— "为什么发/为什么没发"全程可解释：
//       待发提案、最近 30 条仲裁决策（verdict + reasonChain）、outcome、预算用量、在场。
// POST /api/proactivity/outcome —— 客户端回传触达结果（accepted/dismissed/...），
//       回灌自适应冷却：连续忽略的 kind 自动降频，高接受率自动回升。
import type { FastifyInstance } from "fastify";

import type { ProactivePipeline } from "../../proactivity/proactive-pipeline.js";
import type { ProactiveOutcome } from "../../proactivity/pipeline-types.js";

const ALLOWED_OUTCOMES = new Set<ProactiveOutcome>([
  "accepted",
  "dismissed",
  "snoozed",
  "ignored",
  "replied",
]);

export function registerProactivityPipelineRoutes(
  app: FastifyInstance,
  deps: { pipeline: ProactivePipeline | null },
): void {
  const pipeline = deps.pipeline;
  if (!pipeline) return;

  app.get("/api/proactivity/diagnostics", async () => {
    return { ok: true, ...pipeline.diagnostics() };
  });

  app.post("/api/proactivity/outcome", async (request, reply) => {
    const body = (request.body ?? {}) as { deliveryId?: string; outcome?: string };
    const deliveryId = String(body.deliveryId ?? "").trim();
    const outcome = String(body.outcome ?? "").trim() as ProactiveOutcome;
    if (!deliveryId) return reply.code(400).send({ ok: false, error: "deliveryId required" });
    if (!ALLOWED_OUTCOMES.has(outcome)) {
      return reply.code(400).send({
        ok: false,
        error: `未知 outcome「${outcome}」，可选：${[...ALLOWED_OUTCOMES].join(", ")}`,
      });
    }
    const applied = pipeline.recordOutcome(deliveryId, outcome);
    if (!applied) return reply.code(404).send({ ok: false, error: "deliveryId not found" });
    return { ok: true, deliveryId, outcome };
  });
}
