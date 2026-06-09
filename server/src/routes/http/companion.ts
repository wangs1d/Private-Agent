import { randomUUID } from "crypto";
import type { FastifyInstance } from "fastify";
import {
  companionContactFeedbackBodySchema,
  companionBehaviorSignalUpdateBodySchema,
  companionBillReminderBodySchema,
  companionOnboardingBodySchema,
  companionPriceWatchBodySchema,
  companionProfileUpdateBodySchema,
  companionSessionQuerySchema,
  companionShoppingPlanBodySchema,
} from "../../schemas/api.js";
import type { HttpRouteDeps } from "./types.js";

const USER_BEHAVIOR_SIGNAL_KEY = "user_behavior_signal";
const USER_PROFILE_FACTS_KEY = "user_profile_facts";

type BehaviorSignals = {
  shoppingInterest: number;
  planningInterest: number;
  companionNeed: number;
  privacyConcern: number;
  updatedAt: string;
};

function toBehaviorSignals(v: unknown): BehaviorSignals {
  const obj = (v && typeof v === "object" ? (v as Record<string, unknown>) : {}) ?? {};
  return {
    shoppingInterest: Number(obj.shoppingInterest) || 0,
    planningInterest: Number(obj.planningInterest) || 0,
    companionNeed: Number(obj.companionNeed) || 0,
    privacyConcern: Number(obj.privacyConcern) || 0,
    updatedAt: typeof obj.updatedAt === "string" ? obj.updatedAt : new Date().toISOString(),
  };
}

export function registerCompanionRoutes(app: FastifyInstance, deps: HttpRouteDeps): void {
  const {
    companionService,
    scheduleTaskService,
    agentMemorySyncService,
    userPersonalizationService,
  } = deps;

  app.get("/companion/profile", async (request, reply) => {
    const parsed = companionSessionQuerySchema.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ ok: false, error: parsed.error.flatten() });
    return { ok: true, profile: companionService.getProfile(parsed.data.sessionId) };
  });

  app.patch("/companion/profile", async (request, reply) => {
    const parsed = companionProfileUpdateBodySchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ ok: false, error: parsed.error.flatten() });
    const { sessionId, ...patch } = parsed.data;
    const profile = await companionService.upsertProfile(sessionId, patch);
    return { ok: true, profile };
  });

  app.get("/companion/greeting", async (request, reply) => {
    const parsed = companionSessionQuerySchema.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ ok: false, error: parsed.error.flatten() });
    return { ok: true, message: companionService.getGreetingMessage(parsed.data.sessionId) };
  });

  app.post("/companion/onboarding", async (request, reply) => {
    const parsed = companionOnboardingBodySchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ ok: false, error: parsed.error.flatten() });
    const body = parsed.data;
    const likes = [
      ...body.focusModes.map((m) => (m === "shopping" ? "shopping deals" : m === "planning" ? "structured planning" : "friendly companion tone")),
      ...(body.shoppingPlatforms ?? []).map((p) => `platform:${p}`),
    ];
    await companionService.upsertProfile(body.sessionId, { likes });
    const seedSignal: BehaviorSignals = {
      shoppingInterest: body.focusModes.includes("shopping") ? 3 : 0,
      planningInterest: body.focusModes.includes("planning") ? 3 : 0,
      companionNeed: body.focusModes.includes("companion") ? 3 : 0,
      privacyConcern: 0,
      updatedAt: new Date().toISOString(),
    };
    {
      const { revision } = agentMemorySyncService.getSnapshot(body.sessionId, [USER_BEHAVIOR_SIGNAL_KEY]);
      await agentMemorySyncService.applyPatch(body.sessionId, revision, [
        { key: USER_BEHAVIOR_SIGNAL_KEY, op: "put", value: seedSignal },
      ]);
    }

    const createdBills: string[] = [];
    for (const b of body.billReminders ?? []) {
      const due = new Date(b.dueDate);
      if (Number.isNaN(due.getTime())) continue;
      due.setDate(due.getDate() - b.daysBefore);
      const task = await scheduleTaskService.createTask({
        sessionId: body.sessionId,
        title: `Bill reminder: ${b.billName}`,
        description: `Upcoming bill ${b.billName}`,
        kind: "reminder",
        runAt: due.toISOString(),
        recurrence: "none",
        timezone: "Asia/Shanghai",
        reminderMessage: `Your ${b.billName} bill is due in ${b.daysBefore} day(s).`,
      }).catch(() => null);
      if (task?.taskId) createdBills.push(task.taskId);
    }

    return {
      ok: true,
      firstTasks: [
        "Compare 3 products and pick best value",
        "Create today plan with top 3 priorities",
        "Set one bill reminder and one shopping watch",
      ],
      createdBillTaskIds: createdBills,
    };
  });

  app.post("/companion/price-watch", async (request, reply) => {
    const parsed = companionPriceWatchBodySchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ ok: false, error: parsed.error.flatten() });
    const body = parsed.data;
    await companionService.addPriceWatch({
      id: randomUUID(),
      sessionId: body.sessionId,
      item: body.item,
      currentPrice: body.currentPrice,
      targetPrice: body.targetPrice,
      currency: body.currency,
      createdAt: new Date().toISOString(),
    });
    const task = await scheduleTaskService.createTask({
      sessionId: body.sessionId,
      title: `Price check: ${body.item}`,
      description: `Track ${body.item} target ${body.targetPrice} ${body.currency}`,
      kind: "agent_task",
      runAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
      recurrence: "daily",
      timezone: "Asia/Shanghai",
      agentTask: {
        prompt: `Check latest price for "${body.item}". Alert me only when <= ${body.targetPrice} ${body.currency}.`,
        accessMode: "sandbox",
      },
    });
    return { ok: true, watchCreated: true, taskId: task.taskId };
  });

  app.post("/companion/bill-reminder", async (request, reply) => {
    const parsed = companionBillReminderBodySchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ ok: false, error: parsed.error.flatten() });
    const body = parsed.data;
    const due = new Date(body.dueDate);
    if (Number.isNaN(due.getTime())) {
      return reply.code(400).send({ ok: false, message: "Invalid dueDate" });
    }
    due.setDate(due.getDate() - body.daysBefore);
    const task = await scheduleTaskService.createTask({
      sessionId: body.sessionId,
      title: `Bill due: ${body.billName}`,
      description: `Upcoming bill ${body.billName}`,
      kind: "reminder",
      runAt: due.toISOString(),
      recurrence: "none",
      timezone: "Asia/Shanghai",
      reminderMessage: `Your ${body.billName} bill is due in ${body.daysBefore} day(s).`,
    });
    return { ok: true, taskId: task.taskId, nextRunAt: task.nextRunAt };
  });

  app.post("/companion/shopping-plan-to-schedule", async (request, reply) => {
    const parsed = companionShoppingPlanBodySchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ ok: false, error: parsed.error.flatten() });
    const body = parsed.data;
    const runAt = new Date(body.runAt);
    if (Number.isNaN(runAt.getTime())) {
      return reply.code(400).send({ ok: false, message: "Invalid runAt" });
    }
    const task = await scheduleTaskService.createTask({
      sessionId: body.sessionId,
      title: `Shopping decision: ${body.item}`,
      description: body.note ?? `Compare options for ${body.item}`,
      kind: "agent_task",
      runAt: runAt.toISOString(),
      recurrence: "none",
      timezone: body.timezone ?? "Asia/Shanghai",
      agentTask: {
        prompt: `Compare options for "${body.item}" under budget ${body.budget}. Give best value pick + quick summary.`,
        accessMode: "sandbox",
      },
    });
    return { ok: true, taskId: task.taskId, nextRunAt: task.nextRunAt };
  });

  app.get("/companion/insights", async (request, reply) => {
    const parsed = companionSessionQuerySchema.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ ok: false, error: parsed.error.flatten() });
    const sessionId = parsed.data.sessionId;
    const { entries } = agentMemorySyncService.getSnapshot(sessionId, [USER_BEHAVIOR_SIGNAL_KEY, USER_PROFILE_FACTS_KEY]);
    const behavior = toBehaviorSignals(entries[USER_BEHAVIOR_SIGNAL_KEY]);
    const facts = (() => {
      const raw = entries[USER_PROFILE_FACTS_KEY] as { facts?: unknown[] } | undefined;
      return Array.isArray(raw?.facts) ? raw?.facts?.slice(0, 20) : [];
    })();
    const profile = companionService.getProfile(sessionId);
    const understanding = userPersonalizationService?.getUnderstandingSnapshot(sessionId) ?? null;
    const topSignals = [
      { key: "shoppingInterest", value: behavior.shoppingInterest },
      { key: "planningInterest", value: behavior.planningInterest },
      { key: "companionNeed", value: behavior.companionNeed },
      { key: "privacyConcern", value: behavior.privacyConcern },
    ]
      .sort((a, b) => b.value - a.value)
      .slice(0, 2);
    return {
      ok: true,
      behavior,
      profile,
      topSignals,
      facts,
      understanding,
    };
  });

  app.patch("/companion/insights", async (request, reply) => {
    const parsed = companionBehaviorSignalUpdateBodySchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ ok: false, error: parsed.error.flatten() });
    const body = parsed.data;
    const { revision, entries } = agentMemorySyncService.getSnapshot(body.sessionId, [USER_BEHAVIOR_SIGNAL_KEY]);
    const current = toBehaviorSignals(entries[USER_BEHAVIOR_SIGNAL_KEY]);
    const next: BehaviorSignals = {
      shoppingInterest: body.shoppingInterest ?? current.shoppingInterest,
      planningInterest: body.planningInterest ?? current.planningInterest,
      companionNeed: body.companionNeed ?? current.companionNeed,
      privacyConcern: body.privacyConcern ?? current.privacyConcern,
      updatedAt: new Date().toISOString(),
    };
    const result = await agentMemorySyncService.applyPatch(body.sessionId, revision, [
      { key: USER_BEHAVIOR_SIGNAL_KEY, op: "put", value: next },
    ]);
    if (!result.ok) return reply.code(409).send({ ok: false, reason: result.reason });
    return { ok: true, behavior: next };
  });

  app.post("/companion/contact-feedback", async (request, reply) => {
    const parsed = companionContactFeedbackBodySchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ ok: false, error: parsed.error.flatten() });
    if (!userPersonalizationService) {
      return reply.code(503).send({ ok: false, error: "user personalization unavailable" });
    }
    const body = parsed.data;
    userPersonalizationService.observeContactOutcome(body.sessionId, {
      channel: body.channel,
      responded: body.responded,
      responseTimeMs: body.responseTimeMs,
      feedback: body.feedback,
      quietHours: body.quietHours,
    });
    return {
      ok: true,
      understanding: userPersonalizationService.getUnderstandingSnapshot(body.sessionId),
    };
  });
}
