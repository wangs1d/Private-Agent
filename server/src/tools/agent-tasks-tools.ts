// 工具：agent.tasks.list —— Agent 自主任务状态查询（Task 18 管家任务闭环）
//
// 用户问「我还有什么待办」「之前那个任务跑完了吗」时，LLM 调本工具
// 查 agent-task-store（持久化任务状态机）拿到确定性状态列表，LLM 只负责措辞。
//
// 安全性：纯只读查询（getAgentTaskStore().list），无副作用、无外部 IO。
import { resolveActorId } from "../agent/actor-id.js";
import { getAgentTaskStore } from "../services/agent-task-store.js";
import type { AgentTaskStatus } from "../services/agent-task-types.js";
import type { ToolRegistry } from "./tool-registry.js";
import type { ChatCompletionTool } from "openai/resources/chat/completions";

/** 状态中文标签（LLM 措辞可直接引用） */
const STATUS_LABEL: Record<AgentTaskStatus, string> = {
  pending: "排队中",
  planning: "拆解中",
  executing: "执行中",
  verifying: "校验中",
  awaiting_approval: "等你确认",
  done: "已完成",
  failed: "失败",
  paused: "已暂停",
};

/**
 * agent.tasks.list 的 LLM 工具声明（并入 getBuiltinAgentChatTools）。
 * 让模型在对话中看到完整描述与参数；执行体在 registerAgentTasksTools。
 */
export const AGENT_TASKS_CHAT_TOOLS: ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "agent.tasks.list",
      description: [
        "查询当前用户的 Agent 任务列表（自主任务状态机）。",
        "当用户问「我还有什么待办」「之前的任务跑完了吗」「帮我看看任务进度」时调用，",
        "返回任务的确定性状态（排队/执行中/等你确认/已完成/失败等）与进度，你只负责口语化转述。",
      ].join(" "),
      parameters: {
        type: "object",
        properties: {
          status: {
            type: "string",
            enum: ["active", "pending", "executing", "awaiting_approval", "done", "failed", "paused"],
            description:
              "过滤状态：active=未完成（排队/执行中/校验中/等确认，默认）；也可指定具体状态；不传默认 active",
          },
          limit: {
            type: "number",
            description: "最多返回条数（默认 10）",
          },
        },
        additionalProperties: false,
      },
    },
  },
];

/** 规范化 status 入参：active 是「未完成」组合视图，其余须为合法状态值 */
function parseStatusFilter(raw: unknown): { combo: "active" } | { status: AgentTaskStatus } | null {
  const v = String(raw ?? "active").trim();
  if (v === "active") return { combo: "active" };
  if (v in STATUS_LABEL) return { status: v as AgentTaskStatus };
  return null;
}

/**
 * 注册任务查询工具。
 * @param toolRegistry 统一工具注册中心
 */
export function registerAgentTasksTools(toolRegistry: ToolRegistry): void {
  toolRegistry.register(
    "agent.tasks.list",
    async (input, context) => {
      const actorId = resolveActorId(context);
      const filter = parseStatusFilter(input?.status);
      if (!filter) {
        return {
          ok: false,
          error:
            "status 可选：active（未完成，默认）/ pending / executing / awaiting_approval / done / failed / paused",
        };
      }
      const limit = Math.max(1, Math.min(50, Number(input?.limit ?? 10) || 10));

      const all = getAgentTaskStore().list({ actorId });
      const tasks = (
        "combo" in filter
          ? all.filter((t) =>
              ["pending", "planning", "executing", "verifying", "awaiting_approval", "paused"].includes(
                t.status,
              ),
            )
          : all.filter((t) => t.status === filter.status)
      )
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
        .slice(0, limit);

      return {
        ok: true,
        count: tasks.length,
        total: all.length,
        tasks: tasks.map((t) => ({
          id: t.id,
          goal: t.goal,
          status: t.status,
          statusLabel: STATUS_LABEL[t.status],
          progress: {
            currentRound: t.currentRound,
            maxRounds: t.maxRounds,
            subtaskDone: t.subtasks.filter((s) => s.status === "done").length,
            subtaskTotal: t.subtasks.length,
          },
          createdAt: t.createdAt,
          updatedAt: t.updatedAt,
          error: t.error,
        })),
      };
    },
    {
      category: "life",
      sideEffect: "none",
      riskLevel: "low",
    },
  );
}
