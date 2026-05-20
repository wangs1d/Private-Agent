/**
 * 多 Agent 监控 API 路由
 * 提供性能指标查询、执行历史、优化建议等
 */

import type { FastifyInstance } from "fastify";
import type { AgentCore } from "../../services/agent-core.js";

export function registerMultiAgentMonitorRoutes(app: FastifyInstance, deps: { agentCore?: AgentCore }): void {
  /**
   * GET /api/multi-agent/metrics
   * 获取性能指标快照
   */
  app.get("/api/multi-agent/metrics", async (request, reply) => {
    // 暂时返回占位符，实际需要从 AgentCore 获取 coordinator
    return {
      ok: true,
      metrics: {
        totalTasks: 0,
        message: "监控功能待集成到 AgentCore",
      },
      timestamp: new Date().toISOString(),
    };
  });

  /**
   * GET /api/multi-agent/history
   * 获取执行历史
   */
  app.get("/api/multi-agent/history", async (request, reply) => {
    return reply.code(501).send({
      ok: false,
      error: "执行历史功能暂未实现",
    });
  });

  /**
   * GET /api/multi-agent/suggestions
   * 获取优化建议
   */
  app.get("/api/multi-agent/suggestions", async (request, reply) => {
    return reply.code(501).send({
      ok: false,
      error: "优化建议功能暂未实现",
    });
  });

  /**
   * POST /api/multi-agent/concurrency
   * 动态调整并发度
   */
  app.post("/api/multi-agent/concurrency", async (request, reply) => {
    return reply.code(501).send({
      ok: false,
      error: "并发度调整功能暂未实现",
    });
  });

  /**
   * GET /api/multi-agent/status
   * 获取整体状态
   */
  app.get("/api/multi-agent/status", async (request, reply) => {
    return {
      ok: true,
      enabled: true,
      message: "多 Agent 系统已启用（KIMI 模型作为主脑）",
      config: {
        enableSubAgents: true,
        maxParallelTasks: process.env.MAX_PARALLEL_SUBTASKS || "5",
        taskTimeoutMs: process.env.SUBTASK_TIMEOUT_MS || "60000",
        verbose: process.env.MULTI_AGENT_VERBOSE === "true" || process.env.MULTI_AGENT_VERBOSE === "1",
      },
      timestamp: new Date().toISOString(),
    };
  });
}
