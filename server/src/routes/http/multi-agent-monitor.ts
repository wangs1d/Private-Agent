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
    const query = request.query as { limit?: string };
    const limit = query.limit ? parseInt(query.limit, 10) : 10;
    
    const coordinator = deps.agentRuntime?.getMasterAgentCoordinator();
    
    if (!coordinator) {
      return reply.code(404).send({
        ok: false,
        error: "多 Agent 协调器未启用",
      });
    }
    
    const history = coordinator.getExecutionHistory(limit);
    
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
  app.get("/api/multi-agent/suggestions", async (request, reply) => {
    const coordinator = deps.agentRuntime?.getMasterAgentCoordinator();
    
    if (!coordinator) {
      return reply.code(404).send({
        ok: false,
        error: "多 Agent 协调器未启用",
      });
    }
    
    const suggestions = coordinator.getOptimizationSuggestions();
    
    return {
      ok: true,
      suggestions,
      count: suggestions.length,
      timestamp: new Date().toISOString(),
    };
  });

  /**
   * POST /api/multi-agent/concurrency
   * 动态调整并发度
   */
  app.post("/api/multi-agent/concurrency", async (request, reply) => {
    const body = request.body as { maxParallel?: number };
    const maxParallel = body.maxParallel;
    
    if (!maxParallel || !Number.isInteger(maxParallel) || maxParallel < 1 || maxParallel > 20) {
      return reply.code(400).send({
        ok: false,
        error: "无效的参数，maxParallel 必须是 1-20 之间的整数",
      });
    }
    
    const coordinator = deps.agentRuntime?.getMasterAgentCoordinator();
    
    if (!coordinator) {
      return reply.code(404).send({
        ok: false,
        error: "多 Agent 协调器未启用",
      });
    }
    
    coordinator.adjustConcurrency(maxParallel);
    
    return {
      ok: true,
      message: `并发度已调整为 ${maxParallel}`,
      timestamp: new Date().toISOString(),
    };
  });

  /**
   * GET /api/multi-agent/status
   * 获取整体状态
   */
  app.get("/api/multi-agent/status", async (request, reply) => {
    const coordinator = deps.agentRuntime?.getMasterAgentCoordinator();
    
    if (!coordinator) {
      return reply.code(200).send({
        ok: true,
        enabled: false,
        message: "多 Agent 系统未启用",
      });
    }
    
    const metrics = coordinator.getMetricsSnapshot();
    const suggestions = coordinator.getOptimizationSuggestions();
    
    return {
      ok: true,
      enabled: true,
      metrics,
      suggestions,
      config: {
        enableSubAgents: true,
        maxParallelTasks: metrics.totalTasks > 0 ? "dynamic" : process.env.MAX_PARALLEL_SUBTASKS || "5",
        taskTimeoutMs: process.env.SUBTASK_TIMEOUT_MS || "60000",
        verbose: process.env.MULTI_AGENT_VERBOSE === "true" || process.env.MULTI_AGENT_VERBOSE === "1",
      },
      timestamp: new Date().toISOString(),
    };
  });
}
