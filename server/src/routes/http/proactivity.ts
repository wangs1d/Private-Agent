// HTTP 路由：统一主动性管道的诊断/结果回传 + 移动端推送通道注册（docs/proactivity-architecture.md §4）
//
// GET  /api/proactivity/diagnostics —— "为什么发/为什么没发"全程可解释：
//       待发提案、最近 30 条仲裁决策（verdict + reasonChain）、outcome、预算用量、在场。
// POST /api/proactivity/outcome —— 客户端回传触达结果（accepted/dismissed/...），
//       回灌自适应冷却：连续忽略的 kind 自动降频，高接受率自动回升。
// POST/DELETE /api/proactivity/push/register —— 客户端上报/注销推送 token（provider + token）。
// GET  /api/proactivity/push/status —— 已配置 provider 与各 actor 注册的 token 概览。
// POST /api/proactivity/push/test —— 给指定 actor 发一条测试推送（验证通道连通）。
import type { FastifyInstance } from "fastify";

import type { ProactivePipeline } from "../../proactivity/proactive-pipeline.js";
import type { MobilePushService } from "../../proactivity/mobile-push-service.js";
import type { ProactiveOutcome } from "../../proactivity/pipeline-types.js";

const ALLOWED_OUTCOMES = new Set<ProactiveOutcome>([
  "accepted",
  "dismissed",
  "snoozed",
  "ignored",
  "replied",
]);

const ALLOWED_PUSH_PROVIDERS = new Set(["jpush", "bark", "webhook"]);

export function registerProactivityPipelineRoutes(
  app: FastifyInstance,
  deps: { pipeline: ProactivePipeline | null; pushService?: MobilePushService | null },
): void {
  const pipeline = deps.pipeline;
  if (!pipeline) return;

  // 诊断快照。可选查询参数（沉默决策反问）：
  //   ?silenceKeyword=体检&silenceDays=7 → 附加 silenceSearch（效用评估沉默留痕检索）
  app.get("/api/proactivity/diagnostics", async (request) => {
    const result: Record<string, unknown> = { ok: true, ...pipeline.diagnostics() };
    const q = request.query as { silenceKeyword?: string; silenceDays?: string };
    if (q.silenceKeyword?.trim() || q.silenceDays) {
      const days = Math.max(1, Math.min(90, Number(q.silenceDays) > 0 ? Number(q.silenceDays) : 7));
      result.silenceSearch = pipeline.searchSilences({
        keyword: q.silenceKeyword?.trim() || undefined,
        sinceMs: Date.now() - days * 24 * 60 * 60 * 1000,
        limit: 20,
      });
    }
    return result;
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

  const pushService = deps.pushService ?? null;

  app.post("/api/proactivity/push/register", async (request, reply) => {
    if (!pushService) return reply.code(503).send({ ok: false, error: "push service not wired" });
    const body = (request.body ?? {}) as { actorId?: string; provider?: string; token?: string; deviceId?: string };
    const actorId = String(body.actorId ?? "").trim();
    const provider = String(body.provider ?? "").trim();
    if (!actorId) return reply.code(400).send({ ok: false, error: "actorId required" });
    if (!ALLOWED_PUSH_PROVIDERS.has(provider)) {
      return reply.code(400).send({
        ok: false,
        error: `未知 provider「${provider}」，可选：${[...ALLOWED_PUSH_PROVIDERS].join(", ")}`,
      });
    }
    const entries = pushService.register(actorId, { provider, token: body.token?.trim() || undefined, deviceId: body.deviceId?.trim() || undefined });
    return { ok: true, actorId, entries };
  });

  app.delete("/api/proactivity/push/register", async (request) => {
    if (!pushService) return { ok: false, error: "push service not wired" };
    const body = (request.body ?? {}) as { actorId?: string; provider?: string; token?: string };
    const actorId = String(body.actorId ?? "").trim();
    if (!actorId) return { ok: false, error: "actorId required" };
    const entries = pushService.unregister(actorId, String(body.provider ?? "").trim(), body.token?.trim() || undefined);
    return { ok: true, actorId, entries };
  });

  app.get("/api/proactivity/push/status", async () => {
    if (!pushService) return { ok: false, providers: [], error: "push service not wired" };
    return {
      ok: true,
      configuredProviders: pushService.configuredProviders(),
      tokens: pushService.listAll().map(([actorId, entries]) => ({ actorId, count: entries.length, providers: entries.map((e) => e.provider) })),
    };
  });

  app.post("/api/proactivity/push/test", async (request, reply) => {
    if (!pushService) return reply.code(503).send({ ok: false, error: "push service not wired" });
    const body = (request.body ?? {}) as { actorId?: string };
    const actorId = String(body.actorId ?? "").trim();
    if (!actorId) return reply.code(400).send({ ok: false, error: "actorId required" });
    if (!pushService.hasChannel(actorId)) {
      return reply.code(409).send({
        ok: false,
        error: "该 actor 无可用推送通道：未注册 token 或 provider 未配置（检查 JPUSH_APP_KEY 等环境变量）",
      });
    }
    const result = await pushService.push({
      actorId,
      title: "推送通道测试",
      body: "这是一条测试推送：两端都不在线时，日程与重要提醒会通过这条通道送到你手机上。",
      importance: "high",
      kind: "push_test",
      deliveryId: `test_${Date.now().toString(36)}`,
    });
    return { ok: result.ok, provider: result.provider, reason: result.reason };
  });
}
