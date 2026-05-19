import type { FastifyInstance } from "fastify";
import {
  weatherCurrentQuerySchema,
  weatherLinkTaskBodySchema,
  weatherPrefsGetQuerySchema,
  weatherPrefsPutBodySchema,
} from "../../schemas/api.js";
import type { HttpRouteDeps } from "./types.js";

export function registerWeatherRoutes(app: FastifyInstance, deps: HttpRouteDeps): void {
  const { weatherService, weatherPrefsService, scheduleTaskService } = deps;

  app.post("/weather/link-task", async (request, reply) => {
    const parsed = weatherLinkTaskBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, error: parsed.error.flatten() });
    }
    const { sessionId, taskId } = parsed.data;
    const task = scheduleTaskService.getTask(taskId);
    if (!task || task.sessionId !== sessionId || task.kind !== "weather_brief") {
      return reply.code(400).send({ ok: false, message: "任务不存在或类型不是天气简报" });
    }
    const prefs = weatherPrefsService.get(sessionId);
    if (!prefs) {
      return { ok: true, linked: false, needLocation: true };
    }
    const saved = await weatherPrefsService.upsert({
      ...prefs,
      morningReminderEnabled: true,
      weatherTaskId: taskId,
    });
    return { ok: true, linked: true, prefs: saved };
  });

  app.get("/weather", async () => ({
    domain: "weather",
    endpoints: ["/weather/current", "/weather/prefs"],
  }));

  app.get("/weather/current", async (request, reply) => {
    const parsed = weatherCurrentQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, error: parsed.error.flatten() });
    }
    const { latitude, longitude, timezone, label } = parsed.data;
    try {
      const brief = await weatherService.getBrief(
        latitude,
        longitude,
        timezone?.trim() || "Asia/Shanghai",
        label?.trim() || undefined,
      );
      return { ok: true, brief };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return reply.code(400).send({ ok: false, message });
    }
  });

  app.get("/weather/prefs", async (request, reply) => {
    const parsed = weatherPrefsGetQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, error: parsed.error.flatten() });
    }
    const prefs = weatherPrefsService.get(parsed.data.sessionId);
    return { ok: true, prefs: prefs ?? null };
  });

  app.put("/weather/prefs", async (request, reply) => {
    const parsed = weatherPrefsPutBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, error: parsed.error.flatten() });
    }
    const body = parsed.data;
    const tz = body.timezone?.trim() || "Asia/Shanghai";
    const prev = weatherPrefsService.get(body.sessionId);

    const explicitMorning = body.morningReminderEnabled;
    const morningEnabled =
      explicitMorning !== undefined
        ? explicitMorning
        : (prev?.morningReminderEnabled ?? false);

    try {
      if (explicitMorning === false) {
        if (prev?.weatherTaskId) {
          try {
            await scheduleTaskService.updateTask(prev.weatherTaskId, { status: "cancelled" });
          } catch {
            /* ignore */
          }
        }
        const saved = await weatherPrefsService.upsert({
          sessionId: body.sessionId,
          latitude: body.latitude,
          longitude: body.longitude,
          label: body.label,
          timezone: tz,
          morningReminderEnabled: false,
          weatherTaskId: undefined,
        });
        return { ok: true, prefs: saved };
      }

      if (morningEnabled) {
        const needFirstRunAt = !prev?.weatherTaskId;
        const runAtRaw = body.morningFirstRunAt?.trim();
        if (needFirstRunAt && !runAtRaw) {
          return reply.code(400).send({
            ok: false,
            message: "首次开启早间简报时请提供 morningFirstRunAt（本地时间对应的 ISO 字符串）",
          });
        }
        let taskId = prev?.weatherTaskId;
        if (runAtRaw) {
          const runAt = new Date(runAtRaw);
          if (Number.isNaN(runAt.getTime())) {
            return reply.code(400).send({ ok: false, message: "morningFirstRunAt 时间格式无效" });
          }
          if (runAt.getTime() < Date.now() - 5000) {
            return reply.code(400).send({ ok: false, message: "morningFirstRunAt 须为未来时间" });
          }
          if (taskId) {
            const existing = scheduleTaskService.getTask(taskId);
            if (existing) {
              await scheduleTaskService.updateTask(taskId, {
                runAt: runAt.toISOString(),
                recurrence: "daily",
                timezone: tz,
                status: "active",
              });
            } else {
              taskId = undefined;
            }
          }
          if (!taskId) {
            const task = await scheduleTaskService.createTask({
              sessionId: body.sessionId,
              title: "每日天气与穿衣提示",
              description: "基于已保存位置生成当日天气与穿衣建议（Open-Meteo）",
              kind: "weather_brief",
              runAt: runAt.toISOString(),
              recurrence: "daily",
              timezone: tz,
            });
            taskId = task.taskId;
          }
        } else if (taskId) {
          const existing = scheduleTaskService.getTask(taskId);
          if (existing && existing.status !== "active") {
            await scheduleTaskService.updateTask(taskId, { status: "active" });
          }
        } else {
          return reply.code(400).send({
            ok: false,
            message: "开启早间简报前请先提供 morningFirstRunAt，或通过日程创建 weather_brief 任务",
          });
        }

        const saved = await weatherPrefsService.upsert({
          sessionId: body.sessionId,
          latitude: body.latitude,
          longitude: body.longitude,
          label: body.label,
          timezone: tz,
          morningReminderEnabled: true,
          weatherTaskId: taskId,
        });
        return { ok: true, prefs: saved };
      }

      const saved = await weatherPrefsService.upsert({
        sessionId: body.sessionId,
        latitude: body.latitude,
        longitude: body.longitude,
        label: body.label,
        timezone: tz,
        morningReminderEnabled: prev?.morningReminderEnabled ?? false,
        weatherTaskId: prev?.weatherTaskId,
      });
      return { ok: true, prefs: saved };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return reply.code(400).send({ ok: false, message });
    }
  });
}
