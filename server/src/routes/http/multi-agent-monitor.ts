/**
 * 主 Agent 委派监控 API（路径 `/api/multi-agent/*` 保留兼容）
 */

import type { FastifyInstance } from "fastify";
import {
  isMasterAgentDelegationEnabled,
  isMasterAgentDelegationVerbose,
} from "../../agent/master-agent-delegate-env.js";
import { getAgentRuntimeConfig } from "../../agent/agent-runtime-config.js";
import type { AgentCore } from "../../services/agent-core.js";
import type { ScheduleTaskService } from "../../services/schedule-task-service.js";

function parseLimit(raw: unknown, fallback: number, max: number): number {
  const n = Number.parseInt(String(raw ?? ""), 10);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(n, max);
}

function buildAsyncCenterPayload(
  agentCore: AgentCore,
  scheduleTaskService: ScheduleTaskService,
  sessionId: string,
  messageId?: string,
): Record<string, unknown> {
  const background = agentCore.getSubAgentBackgroundTasks(sessionId, messageId);
  const running = Array.isArray(background["running"]) ? background["running"] : [];
  const completed = Array.isArray(background["backgroundCompleted"])
    ? background["backgroundCompleted"]
    : [];
  const reports = Array.isArray(background["reports"]) ? background["reports"] : [];

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
      runningBackgroundCount: running.length,
      completedBackgroundCount: completed.length,
      reportCount: reports.length,
      hasBackgroundWork: running.length > 0 || completed.length > 0,
      hasStagedDialogue: true,
      scheduledAgentTaskCount: scheduledAgentTasks.length,
    },
    channels: {
      backgroundTasks: background,
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
      backgroundTask:
        "Use for long-running, detachable, independently deliverable work that should complete even if the user leaves the current chat.",
      stagedDialogue:
        "Use for short-running, context-heavy work that still belongs to the current conversation and benefits from step-by-step visible progress.",
      scheduledAgentTask:
        "Use for recurring or delayed agent work that should run again in the future and be managed from the async center.",
    },
  };
}

export function registerMultiAgentMonitorRoutes(
  app: FastifyInstance,
  deps: { agentCore?: AgentCore; scheduleTaskService: ScheduleTaskService },
): void {
  /**
   * GET /api/multi-agent/metrics
   * 获取性能指标快照
   */
  app.get("/api/multi-agent/metrics", async (_request, reply) => {
    const agentCore = deps.agentCore;
    if (!agentCore) {
      return reply.code(503).send({ ok: false, error: "AgentCore 未就绪" });
    }
    const snapshot = agentCore.getMasterAgentDelegationSnapshot();
    return {
      ok: true,
      enabled: snapshot.enabled,
      metrics: snapshot.metrics,
      subAgentMetrics: snapshot.subAgentMetrics,
      config: snapshot.config,
      timestamp: new Date().toISOString(),
    };
  });

  /**
   * GET /api/multi-agent/history?limit=10
   * 获取执行历史
   */
  app.get<{ Querystring: { limit?: string } }>("/api/multi-agent/history", async (request, reply) => {
    const agentCore = deps.agentCore;
    if (!agentCore) {
      return reply.code(503).send({ ok: false, error: "AgentCore 未就绪" });
    }
    const snapshot = agentCore.getMasterAgentDelegationSnapshot();
    if (!snapshot.enabled) {
      return reply.code(404).send({ ok: false, error: "主 Agent 委派未启用" });
    }
    const limit = parseLimit(request.query.limit, 10, 100);
    const history = snapshot.history.slice(0, limit);
    return {
      ok: true,
      count: history.length,
      history,
      timestamp: new Date().toISOString(),
    };
  });

  /**
   * GET /api/multi-agent/suggestions
   * 获取优化建议
   */
  app.get("/api/multi-agent/suggestions", async (_request, reply) => {
    const agentCore = deps.agentCore;
    if (!agentCore) {
      return reply.code(503).send({ ok: false, error: "AgentCore 未就绪" });
    }
    const snapshot = agentCore.getMasterAgentDelegationSnapshot();
    return {
      ok: true,
      enabled: snapshot.enabled,
      suggestions: snapshot.suggestions,
      subAgentMetrics: snapshot.subAgentMetrics,
      timestamp: new Date().toISOString(),
    };
  });

  /**
   * POST /api/multi-agent/concurrency
   * 动态调整并发度（当前架构固定串行，接口保留兼容）
   */
  app.post<{ Body: { maxParallel?: number } }>("/api/multi-agent/concurrency", async (request, reply) => {
    const agentCore = deps.agentCore;
    if (!agentCore) {
      return reply.code(503).send({ ok: false, error: "AgentCore 未就绪" });
    }
    const snapshot = agentCore.getMasterAgentDelegationSnapshot();
    if (!snapshot.enabled) {
      return reply.code(404).send({ ok: false, error: "主 Agent 委派未启用" });
    }
    const maxParallel = Number(request.body?.maxParallel ?? 1);
    agentCore.adjustMasterAgentConcurrency(maxParallel);
    const cfg = getAgentRuntimeConfig().masterDelegation;
    const effective = Math.min(Math.max(1, maxParallel), cfg.maxParallelSubAgents);
    return {
      ok: true,
      maxParallelTasks: effective,
      maxAllowed: cfg.maxParallelSubAgents,
      message: `子 Agent 并行上限已调整为 ${effective}（环境变量 MAX_PARALLEL_SUB_AGENTS 上限 ${cfg.maxParallelSubAgents}）。`,
      timestamp: new Date().toISOString(),
    };
  });

  /**
   * GET /api/multi-agent/background-tasks?sessionId=&messageId=
   * 查询子 Agent 后台任务与本轮委派报告
   */
  app.get<{ Querystring: { sessionId?: string; messageId?: string } }>(
    "/api/multi-agent/background-tasks",
    async (request, reply) => {
      const agentCore = deps.agentCore;
      if (!agentCore) {
        return reply.code(503).send({ ok: false, error: "AgentCore 未就绪" });
      }
      const sessionId = String(request.query.sessionId ?? "").trim();
      if (!sessionId) {
        return reply.code(400).send({ ok: false, error: "sessionId is required" });
      }
      const messageId = String(request.query.messageId ?? "").trim() || undefined;
      return {
        ...agentCore.getSubAgentBackgroundTasks(sessionId, messageId),
        timestamp: new Date().toISOString(),
      };
    },
  );

  /**
   * GET /api/agent/async-center?sessionId=&messageId=
   * 统一异步中心聚合接口：
   * - backgroundTasks: 服务端后台子任务/委派报告
   * - stagedDialogue: 客户端根据 chat.turn_* 事件流渲染的分阶段对话
   */
  app.get<{ Querystring: { sessionId?: string; messageId?: string } }>(
    "/api/agent/async-center",
    async (request, reply) => {
      const agentCore = deps.agentCore;
      if (!agentCore) {
        return reply.code(503).send({ ok: false, error: "AgentCore 未就绪" });
      }
      const sessionId = String(request.query.sessionId ?? "").trim();
      if (!sessionId) {
        return reply.code(400).send({ ok: false, error: "sessionId is required" });
      }
      const messageId = String(request.query.messageId ?? "").trim() || undefined;
      return {
        ...buildAsyncCenterPayload(agentCore, deps.scheduleTaskService, sessionId, messageId),
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
    const agentCore = deps.agentCore;
    const sessionId = String(request.body?.sessionId ?? "").trim();
    const channel = String(request.body?.channel ?? "").trim();
    const action = String(request.body?.action ?? "").trim();
    const targetId = String(request.body?.targetId ?? "").trim();
    if (!sessionId || !channel || !action || !targetId) {
      return reply.code(400).send({ ok: false, error: "sessionId, channel, action, targetId are required" });
    }
    if (!agentCore) {
      return reply.code(503).send({ ok: false, error: "AgentCore 未就绪" });
    }

    if (channel === "background_task") {
      if (!["confirm", "retry", "continue_processing"].includes(action)) {
        return reply.code(400).send({ ok: false, error: "Unsupported background_task action" });
      }
      const result = await agentCore.handleSubAgentBackgroundTaskAction(
        sessionId,
        targetId,
        action as "confirm" | "retry" | "continue_processing",
      );
      return {
        ...result,
        snapshot: buildAsyncCenterPayload(agentCore, deps.scheduleTaskService, sessionId),
      };
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
        snapshot: buildAsyncCenterPayload(agentCore, deps.scheduleTaskService, sessionId),
      };
    }

    return reply.code(400).send({ ok: false, error: "Unsupported async center channel" });
  });

  /**
   * GET /api/multi-agent/status
   * 获取整体状态
   */
  app.get("/api/multi-agent/status", async (_request, reply) => {
    const enabled = isMasterAgentDelegationEnabled();
    const cfg = getAgentRuntimeConfig().masterDelegation;
    const agentCore = deps.agentCore;
    const snapshot = agentCore?.getMasterAgentDelegationSnapshot();

    return {
      ok: true,
      enabled,
      coordinatorActive: Boolean(snapshot?.enabled),
      message: enabled
        ? `主 Agent 委派已启用（并行上限 ${snapshot?.config?.maxParallelTasks ?? cfg.maxParallelSubAgents}，支持后台委派）`
        : "主 Agent 委派未启用",
      config: {
        enableSubAgents: enabled,
        maxParallelTasks: snapshot?.config?.maxParallelTasks ?? cfg.maxParallelSubAgents,
        taskTimeoutMs: cfg.subtaskTimeoutMs,
        techSubtaskTimeoutMs: cfg.techSubtaskTimeoutMs,
        infoSubtaskTimeoutMs: cfg.infoSubtaskTimeoutMs,
        maxSubAgentInvocationsPerTurn: cfg.maxSubAgentInvocationsPerTurn,
        verbose: isMasterAgentDelegationVerbose(),
      },
      metrics: snapshot?.metrics ?? null,
      timestamp: new Date().toISOString(),
    };
  });
}
