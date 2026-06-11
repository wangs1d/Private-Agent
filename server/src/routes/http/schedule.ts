import type { FastifyInstance } from "fastify";
import {
  scheduleTaskCreateBodySchema,
  scheduleTaskListQuerySchema,
  scheduleTaskRunsQuerySchema,
  scheduleTaskUpdateBodySchema,
} from "../../schemas/api.js";
import type { HttpRouteDeps } from "./types.js";

export function registerScheduleRoutes(app: FastifyInstance, deps: HttpRouteDeps): void {
  const { scheduleTaskService } = deps;

  app.get("/schedule", async () => ({
    domain: "schedule",
    tasksPath: "/schedule/tasks",
    runsPath: "/schedule/runs",
  }));

  app.get("/schedule/tasks", async (request, reply) => {
    const parsed = scheduleTaskListQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, error: parsed.error.flatten() });
    }
    const { sessionId, from, to } = parsed.data;
    const tasks = scheduleTaskService.listTasksBySession(sessionId, { from, to });
    return { ok: true, tasks };
  });

  app.post("/schedule/tasks", async (request, reply) => {
    const parsed = scheduleTaskCreateBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, error: parsed.error.flatten() });
    }
    try {
      const task = await scheduleTaskService.createTask(parsed.data);
      return { ok: true, task };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return reply.code(400).send({ ok: false, message });
    }
  });

  app.patch<{ Params: { taskId: string } }>("/schedule/tasks/:taskId", async (request, reply) => {
    const parsed = scheduleTaskUpdateBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, error: parsed.error.flatten() });
    }
    try {
      const task = await scheduleTaskService.updateTask(request.params.taskId, parsed.data);
      return { ok: true, task };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return reply.code(400).send({ ok: false, message });
    }
  });

  app.delete<{ Params: { taskId: string } }>("/schedule/tasks/:taskId", async (request, reply) => {
    try {
      await scheduleTaskService.deleteTask(request.params.taskId);
      return { ok: true };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return reply.code(400).send({ ok: false, message });
    }
  });

  app.post<{ Params: { taskId: string } }>(
    "/schedule/tasks/:taskId/trigger",
    async (request, reply) => {
      try {
        await scheduleTaskService.triggerNow(request.params.taskId);
        return { ok: true };
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        return reply.code(400).send({ ok: false, message });
      }
    },
  );

  app.post<{ Params: { token: string } }>(
    "/schedule/webhook/:token",
    async (request, reply) => {
      try {
        const task = await scheduleTaskService.triggerByWebhookToken(request.params.token);
        return { ok: true, task };
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        return reply.code(400).send({ ok: false, message });
      }
    },
  );

  app.get("/schedule/runs", async (request, reply) => {
    const parsed = scheduleTaskRunsQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, error: parsed.error.flatten() });
    }
    const runs = scheduleTaskService.listRuns(parsed.data.taskId, parsed.data.limit ?? 20);
    return { ok: true, runs };
  });
}
