/**
 * 主 Agent 委派监控 API（路径 `/api/multi-agent/*` 保留兼容）
 */

import type { FastifyInstance } from "fastify";
import {
  isMasterAgentDelegationEnabled,
  isMasterAgentDelegationVerbose,
} from "../../agent/master-agent-delegate-env.js";
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
    const enabled = isMasterAgentDelegationEnabled();
    return {
      ok: true,
      enabled,
      message: enabled ?
        "主 Agent 委派已启用（主 Agent 通过 master_invoke_sub_agent 串行调用子 Agent）"
      : "主 Agent 委派未启用",
      config: {
        enableSubAgents: enabled,
        maxParallelTasks: "1",
        taskTimeoutMs: process.env.SUBTASK_TIMEOUT_MS || "60000",
        verbose: isMasterAgentDelegationVerbose(),
      },
      timestamp: new Date().toISOString(),
    };
  });
}
