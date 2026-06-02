import type { FastifyInstance } from "fastify";
import {
  scheduleTaskCreateBodySchema,
  scheduleTaskListQuerySchema,
  scheduleTaskRunsQuerySchema,
  scheduleTaskUpdateBodySchema,
} from "../../schemas/api.js";
import {
  notifyScheduleTasksChanged,
  scheduleWsPayloadDeleted,
  scheduleWsPayloadFromTask,
} from "../../services/schedule-ws-notify.js";
import type { HttpRouteDeps } from "./types.js";

export function registerScheduleRoutes(app: FastifyInstance, deps: HttpRouteDeps): void {
  const { scheduleTaskService, wsConnectionRegistry } = deps;

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
      notifyScheduleTasksChanged(
        wsConnectionRegistry,
        scheduleWsPayloadFromTask(task, "created"),
      );
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
      const existing = scheduleTaskService.getTask(request.params.taskId);
      const task = await scheduleTaskService.updateTask(request.params.taskId, parsed.data);
      if (parsed.data.status === "cancelled") {
        notifyScheduleTasksChanged(
          wsConnectionRegistry,
          scheduleWsPayloadDeleted(existing?.sessionId ?? task.sessionId, task.taskId),
        );
      } else {
        notifyScheduleTasksChanged(
          wsConnectionRegistry,
          scheduleWsPayloadFromTask(task, "updated"),
        );
      }
      return { ok: true, task };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return reply.code(400).send({ ok: false, message });
    }
  });

  app.delete<{ Params: { taskId: string } }>("/schedule/tasks/:taskId", async (request, reply) => {
    try {
      const existing = scheduleTaskService.getTask(request.params.taskId);
      await scheduleTaskService.deleteTask(request.params.taskId);
      if (existing) {
        notifyScheduleTasksChanged(
          wsConnectionRegistry,
          scheduleWsPayloadDeleted(existing.sessionId, existing.taskId),
        );
      }
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

  app.get("/schedule/runs", async (request, reply) => {
    const parsed = scheduleTaskRunsQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, error: parsed.error.flatten() });
    }
    const runs = scheduleTaskService.listRuns(parsed.data.taskId, parsed.data.limit ?? 20);
    return { ok: true, runs };
  });
}
