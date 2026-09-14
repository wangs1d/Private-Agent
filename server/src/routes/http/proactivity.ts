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
import type { ProactivitySuppressionStore } from "../../proactivity/suppression-store.js";
import type { ProactiveOutcome } from "../../proactivity/pipeline-types.js";

const ALLOWED_OUTCOMES = new Set<ProactiveOutcome>([
  "accepted",
  "dismissed",
  "snoozed",
  "ignored",
  "replied",
]);

const ALLOWED_PUSH_PROVIDERS = new Set(["jpush", "bark", "webhook"]);

/** 用户语义化反馈动作（一键"太多了/别推这个"直通频控与静音表） */
const ALLOWED_FEEDBACK_ACTIONS = new Set(["too_many", "mute_topic", "resume_topic", "like"]);

/** 允许被反馈静音的触达类别：与抑制表路由白名单对齐 + 简报系 kind */
const FEEDBACK_SUPPRESSIBLE_KINDS = new Set([
  "greeting",
  "interest_share",
  "interest_alert",
  "care",
  "followup",
  "task_celebration",
  "overwork_care",
  "weather_alert",
  "life_reminder",
  "monthly_report",
  "digest",
  "morning_briefing",
]);

export type ProactivityFabricDeps = {
  /** 传感器健康快照（L1） */
  sensorHealth: () => unknown;
  /** 当前仲裁快照 + 预览裁决（L3） */
  arbiterPreview: () => unknown;
  /** 目标板统计（L4） */
  goalStats: () => unknown;
  /** 成本校准快照（接受率 → alert 阈值） */
  calibration?: () => unknown;
  /** 评估器探针（L2：id/订阅流/状态键） */
  evaluatorProbes?: () => unknown;
  /** outcome 回灌桥（CostCalibrator.observe） */
  observeOutcome?: (outcome: string) => void;
  /** 主动话术生成器状态（内容型场景 LLM 用量） */
  phraseStats?: () => unknown;
  /** 主动呼叫器状态（通话轮次/冷却） */
  callStats?: () => unknown;
  /** 自检来电（?call=1 实拨一通测试电话验证呼叫闭环） */
  testCall?: (actorId: string) => Promise<unknown> | unknown;
  /** 设备信号上行（家居/手机/可穿戴 → 传感层 feeder） */
  emitDeviceSignal?: (input: {
    actorId: string;
    sensorId: string;
    kind: string;
    fingerprint?: string;
    salience?: "high" | "medium" | "low";
    payload?: Record<string, unknown>;
    at?: number;
  }) => { ok: boolean; deduped?: boolean; error?: string };
  /** 真实链路自检：fire=true 时实际投递一条测试消息 */
  selftest: (fire: boolean) => Promise<Record<string, unknown>> | Record<string, unknown>;
};

export function registerProactivityPipelineRoutes(
  app: FastifyInstance,
  deps: {
    pipeline: ProactivePipeline | null;
    pushService?: MobilePushService | null;
    fabric?: ProactivityFabricDeps | null;
    suppressionStore?: ProactivitySuppressionStore | null;
  },
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
  deps.fabric?.observeOutcome?.(outcome);
  return { ok: true, deliveryId, outcome };
});

  // 用户语义化反馈：一键"太多了 / 这个话题别再推 / 喜欢"→ 频控自适应 + 话题静音。
  //   deliveryId 优先（主动消息卡片自带）；简报等无 deliveryId 的投递物用 kind + actorId。
  //   too_many / like → 自适应冷却（负反馈冷却×1.5、正反馈回落）；
  //   mute_topic / resume_topic → 抑制表（仲裁器与 Hub 发送前都会检查）。
  app.post("/api/proactivity/feedback", async (request, reply) => {
    const body = (request.body ?? {}) as {
      deliveryId?: string;
      actorId?: string;
      kind?: string;
      action?: string;
      keywords?: unknown;
      note?: string;
      target?: string;
    };
    const action = String(body.action ?? "").trim();
    if (!ALLOWED_FEEDBACK_ACTIONS.has(action)) {
      return reply.code(400).send({
        ok: false,
        error: `未知 action「${action}」，可选：${[...ALLOWED_FEEDBACK_ACTIONS].join(", ")}`,
      });
    }
    const deliveryId = String(body.deliveryId ?? "").trim();
    let actorId = String(body.actorId ?? "").trim();
    let kind = String(body.kind ?? "").trim();
    if (deliveryId) {
      const record = pipeline.describeDelivery(deliveryId);
      if (!record) {
        return reply.code(404).send({ ok: false, error: "deliveryId not found" });
      }
      actorId = actorId || record.actorId;
      kind = kind || record.kind;
    }
    if (!kind) return reply.code(400).send({ ok: false, error: "kind required（或提供 deliveryId）" });

    const suppression = deps.suppressionStore ?? null;
    const suppressible = FEEDBACK_SUPPRESSIBLE_KINDS.has(kind);
    const applied: Record<string, unknown> = {};

    if (action === "too_many" || action === "like") {
      // 频控自适应：有投递记录走完整 outcome 状态机；否则直接回灌冷却
      const positive = action === "like";
      if (deliveryId) {
        applied.outcomeRecorded = pipeline.recordOutcome(
          deliveryId,
          positive ? "accepted" : "dismissed",
        );
      } else {
        pipeline.noteKindFeedback(kind, positive);
        applied.cooldownAdjusted = true;
      }
    }

    if (action === "mute_topic" || action === "resume_topic") {
      if (!actorId) {
        return reply.code(400).send({ ok: false, error: "actorId required for topic actions" });
      }
      if (!suppression) {
        return reply.code(503).send({ ok: false, error: "suppression store not wired" });
      }
      if (!suppressible) {
        return reply.code(400).send({
          ok: false,
          error: `类别「${kind}」暂不支持话题静音，可选：${[...FEEDBACK_SUPPRESSIBLE_KINDS].join(", ")}`,
        });
      }
      if (action === "mute_topic") {
        const keywords = Array.isArray(body.keywords)
          ? body.keywords.map((k) => String(k).trim()).filter(Boolean)
          : [];
        applied.suppressions = await suppression.add(actorId, kind, keywords, body.note);
        // 静音本身也是一次负反馈，同步回灌冷却
        if (deliveryId) pipeline.recordOutcome(deliveryId, "dismissed");
        else pipeline.noteKindFeedback(kind, false);
      } else {
        applied.suppressions = await suppression.remove(actorId, String(body.target ?? "").trim() || kind);
      }
    }

    return { ok: true, action, actorId: actorId || undefined, kind, ...applied };
  });

  // ─── 五层主动性架构观测端点 ───
  // GET /api/proactivity/sensors —— L1 传感层健康面板：谁活着、谁熔断、最近产出
  app.get("/api/proactivity/sensors", async () => {
    if (!deps.fabric) return { ok: false, error: "fabric not wired" };
    return { ok: true, sensors: deps.fabric.sensorHealth(), goals: deps.fabric.goalStats() };
  });

  // GET /api/proactivity/selftest —— 一键链路自检：上下文快照 + 打断成本 + 裁决预览。
  //   ?fire=1 实际投递一条测试消息（验证直达车道端到端可用）
  app.get("/api/proactivity/selftest", async (request) => {
    const q = request.query as { fire?: string; call?: string };
    const fire = q.fire === "1";
    if (!deps.fabric) return { ok: false, error: "fabric not wired" };
    const base = (await deps.fabric.selftest(fire)) as Record<string, unknown>;
    if (q.call === "1") {
      const actorId = String(base.actorId ?? "local_user");
      base.testCall = deps.fabric.testCall
        ? await deps.fabric.testCall(actorId)
        : { ok: false, error: "testCall not wired" };
    }
    return { ok: true, ...base };
  });

  // POST /api/proactivity/device-signal —— 物理设备信号统一上行入口
  // （Flutter 端 WS 复用同一 payload 结构；家居网关/脚本/第三方直接 POST）
  app.post("/api/proactivity/device-signal", async (request, reply) => {
    const emit = deps.fabric?.emitDeviceSignal;
    if (!emit) return reply.code(503).send({ ok: false, error: "fabric not wired" });
    const body = (request.body ?? {}) as Record<string, unknown>;
    const actorId = String(body.actorId ?? "").trim();
    const sensorId = String(body.sensorId ?? "").trim();
    const kind = String(body.kind ?? "").trim();
    if (!actorId || !sensorId || !kind) {
      return reply.code(400).send({ ok: false, error: "actorId / sensorId / kind required" });
    }
    const result = emit({
      actorId,
      sensorId,
      kind,
      ...(typeof body.fingerprint === "string" ? { fingerprint: body.fingerprint } : {}),
      ...(body.salience === "high" || body.salience === "medium" || body.salience === "low"
        ? { salience: body.salience }
        : {}),
      ...(body.payload && typeof body.payload === "object" ? { payload: body.payload as Record<string, unknown> } : {}),
      ...(typeof body.at === "number" ? { at: body.at } : {}),
    });
    return reply.code(result.ok ? 200 : 400).send(result);
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
