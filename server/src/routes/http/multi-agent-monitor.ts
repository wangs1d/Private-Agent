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

function parseLimit(raw: unknown, fallback: number, max: number): number {
  const n = Number.parseInt(String(raw ?? ""), 10);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(n, max);
}

export function registerMultiAgentMonitorRoutes(app: FastifyInstance, deps: { agentCore?: AgentCore }): void {
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
    return {
      ok: true,
      maxParallelTasks: 1,
      message: "子 Agent 委派固定为串行；maxParallelTasks 始终为 1。",
      timestamp: new Date().toISOString(),
    };
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
        ? "主 Agent 委派已启用（主 Agent 通过 master_invoke_sub_agent 串行调用子 Agent）"
        : "主 Agent 委派未启用",
      config: {
        enableSubAgents: enabled,
        maxParallelTasks: 1,
        taskTimeoutMs: cfg.subtaskTimeoutMs,
        techSubtaskTimeoutMs: cfg.techSubtaskTimeoutMs,
        maxSubAgentInvocationsPerTurn: cfg.maxSubAgentInvocationsPerTurn,
        verbose: isMasterAgentDelegationVerbose(),
      },
      metrics: snapshot?.metrics ?? null,
      timestamp: new Date().toISOString(),
    };
  });
}
