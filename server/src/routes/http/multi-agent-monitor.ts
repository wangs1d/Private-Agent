/**
 * 异步中心 API（历史路径 `/api/multi-agent/*` 与 `/api/agent/async-center` 保留兼容）。
 *
 * 2026-08-29 架构收敛：master 委派层（MasterAgentCoordinator / 子 Agent 编排）已删除，
 * 任务轮统一走 plan-and-execute 全量工具循环。本文件原委派监控端点
 * （metrics / history / suggestions / concurrency / background-tasks / status）随层一并移除。
 * 2026-09-08 彻底清除：`backgroundTasks` 通道占位与 `background_task` 动作分支
 * 一并删除——后台任务的对客状态链路已由任务面接管（TaskHub → chat.task_update
 * 广播 + chat.task_cancel 取消，见 task-plane/），HTTP 轮询/动作通道不再保留。
 * `scheduledAgentTasks`（定时任务）通道不受影响。
 */

import type { FastifyInstance } from "fastify";
import type { RuntimeFacade } from "../../runtime/runtime-facade.js";
import type { ScheduleTaskService } from "../../services/schedule-task-service.js";

function buildAsyncCenterPayload(
  _runtime: RuntimeFacade,
  scheduleTaskService: ScheduleTaskService,
  sessionId: string,
  messageId?: string,
): Record<string, unknown> {
  const scheduledAgentTasks = scheduleTaskService
    .listTasksBySession(sessionId, {
      from: new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString(),
      to: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
    })
    .filter((task) => task.kind === "agent_task")
    .map((task) => ({
      taskId: task.taskId,
      title: task.title,
      description: task.description,
      status: task.status,
      nextRunAt: task.nextRunAt,
      lastRunAt: task.lastRunAt ?? null,
      availableActions:
        task.status === "paused"
          ? ["resume", "run_now", "delete"]
          : task.status === "active"
              ? ["pause", "run_now", "delete"]
              : task.status === "completed"
                  ? ["run_now", "delete"]
                  : ["delete"],
    }));

  return {
    ok: true,
    centerType: "agent_async_center",
    sessionId,
    messageId: messageId ?? null,
    summary: {
      scheduledAgentTaskCount: scheduledAgentTasks.length,
    },
    channels: {
      scheduledAgentTasks: {
        items: scheduledAgentTasks,
      },
      stagedDialogue: {
        supported: true,
        source: "client_turn_state",
        description:
          "Staged dialogue stays in the active chat stream and should be rendered from chat.turn_* websocket state.",
      },
    },
    routingGuide: {
      scheduledAgentTask:
        "Use for recurring or delayed agent work that should run again in the future and be managed from the async center.",
    },
  };
}

export function registerMultiAgentMonitorRoutes(
  app: FastifyInstance,
  deps: { runtime?: RuntimeFacade; scheduleTaskService: ScheduleTaskService },
): void {
  /**
   * GET /api/agent/async-center?sessionId=&messageId=
   * 统一异步中心聚合接口：
   * - scheduledAgentTasks: 定时/周期任务
   * - stagedDialogue: 客户端根据 chat.turn_* 事件流渲染的分阶段对话
   */
  app.get<{ Querystring: { sessionId?: string; messageId?: string } }>(
    "/api/agent/async-center",
    async (request, reply) => {
      const runtime = deps.runtime;
      if (!runtime) {
        return reply.code(503).send({ ok: false, error: "Agent Runtime 未就绪" });
      }
      const sessionId = String(request.query.sessionId ?? "").trim();
      if (!sessionId) {
        return reply.code(400).send({ ok: false, error: "sessionId is required" });
      }
      const messageId = String(request.query.messageId ?? "").trim() || undefined;
      return {
        ...buildAsyncCenterPayload(runtime, deps.scheduleTaskService, sessionId, messageId),
        timestamp: new Date().toISOString(),
      };
    },
  );

  app.post<{
    Body: {
      sessionId?: string;
      channel?: string;
      action?: string;
      targetId?: string;
    };
  }>("/api/agent/async-center/actions", async (request, reply) => {
    const runtime = deps.runtime;
    const sessionId = String(request.body?.sessionId ?? "").trim();
    const channel = String(request.body?.channel ?? "").trim();
    const action = String(request.body?.action ?? "").trim();
    const targetId = String(request.body?.targetId ?? "").trim();
    if (!sessionId || !channel || !action || !targetId) {
      return reply.code(400).send({ ok: false, error: "sessionId, channel, action, targetId are required" });
    }
    if (!runtime) {
      return reply.code(503).send({ ok: false, error: "Agent Runtime 未就绪" });
    }

    if (channel === "scheduled_agent_task") {
      const service = deps.scheduleTaskService;
      const task = service.getTask(targetId);
      if (!task || task.sessionId !== sessionId || task.kind !== "agent_task") {
        return reply.code(404).send({ ok: false, error: "Scheduled agent task not found" });
      }
      if (action === "pause") {
        await service.updateTask(targetId, { status: "paused" });
      } else if (action === "resume") {
        await service.updateTask(targetId, { status: "active" });
      } else if (action === "run_now") {
        await service.triggerNow(targetId);
      } else if (action === "delete") {
        await service.deleteTask(targetId);
      } else {
        return reply.code(400).send({ ok: false, error: "Unsupported scheduled_agent_task action" });
      }
      return {
        ok: true,
        channel,
        action,
        targetId,
        snapshot: buildAsyncCenterPayload(runtime, deps.scheduleTaskService, sessionId),
      };
    }

    return reply.code(400).send({ ok: false, error: "Unsupported async center channel" });
  });
}
