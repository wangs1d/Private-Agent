import type { ChatCompletionTool } from "openai/resources/chat/completions";

import { resolveActorId } from "../agent/actor-id.js";
import { getTaskHub } from "../task-plane/task-hub.js";
import type { ToolRegistry } from "./tool-registry.js";

/**
 * task.status / task.cancel —— 任务委派闭环的对话面查询与取消原语（2026-09-19 P0-2）。
 *
 * 背景：task.dispatch 把重活派到后台后，前台模型对任务进展是"盲"的——
 * 进度只有客户端回执可见，"怎么样了"依赖路由 prompt 注入 activeSummary 的
 * 被动挂接；模型自己想取消/核查任务时没有工具可调，只能口头应答。
 *
 * 本模块补齐委派闭环的最后两个动作：
 *   - task.status：零 LLM 直答的结构化查询（活跃优先 + 最近终态），taskId 缺省
 *     时列全会话，让"怎么样了/现在到哪步了"直接可答；
 *   - task.cancel：模型侧取消把手（客户端 chat.task_cancel 的同语义镜像），
 *     只做终态标记——dispatchBackgroundTask 的 isCancelled() 软取消检查消费
 *     该状态，停止一切增量/结果投递，与用户手动取消完全一致。
 *
 * 安全边界：两把工具都按 context 会话过滤，跨会话任务不可见、不可取消；
 * task.cancel 只作用于非终态记录，终态幂等返回 false。
 */

export const TASK_STATUS_TOOL_DEFINITION: ChatCompletionTool = {
  type: "function",
  function: {
    name: "task.status",
    description:
      "查询后台任务的当前状态与进度。用户问「怎么样了/办到哪了/还在弄吗」时调用，" +
      "不传 taskId 则列出本会话全部进行中与最近完成的任务。结果是结构化快照，" +
      "直接用一句话转述即可，不要编造进度之外的信息。",
    parameters: {
      type: "object",
      properties: {
        taskId: {
          type: "string",
          description: "要查询的任务 id（task.dispatch 返回的）；不传则查询全部任务",
        },
      },
    },
  },
};

export const TASK_CANCEL_TOOL_DEFINITION: ChatCompletionTool = {
  type: "function",
  function: {
    name: "task.cancel",
    description:
      "取消一个还在进行中的后台任务。用户说「不用订了/算了别查了」且对应对话里的" +
      "在办任务时调用。取消后后台会停止执行且不再回传结果，用一句话确认即可。",
    parameters: {
      type: "object",
      properties: {
        taskId: {
          type: "string",
          description: "要取消的任务 id（task.dispatch 返回的，或 task.status 查到的）",
        },
      },
      required: ["taskId"],
    },
  },
};

function elapsedMinutes(startedAt: number): number {
  return Math.max(0, Math.round((Date.now() - startedAt) / 60_000));
}

function describeRecord(record: {
  taskId: string;
  goal: string;
  state: string;
  progressLine?: string;
  startedAt: number;
}): Record<string, unknown> {
  return {
    taskId: record.taskId,
    state: record.state,
    goal: record.goal.slice(0, 120),
    ...(record.progressLine ? { progress: record.progressLine } : {}),
    elapsedMinutes: elapsedMinutes(record.startedAt),
  };
}

export function registerTaskPlaneTools(registry: ToolRegistry): void {
  registry.register("task.status", async (input, context) => {
    const actorId = resolveActorId(context);
    const sessionId = context.sessionId?.trim() || actorId;
    const hub = getTaskHub();
    const wanted = typeof input.taskId === "string" ? input.taskId.trim() : "";

    if (wanted) {
      const record = hub.get(wanted);
      if (!record || record.sessionId !== sessionId) {
        return { ok: false, error: `任务不存在或不属于当前会话：${wanted}` };
      }
      return { ok: true, task: describeRecord(record) };
    }

    const actives = hub.activeRecords(sessionId).map(describeRecord);
    const recentTerminal = [...hub.sessionRecords?.(sessionId) ?? []]
      .filter((r) => r.state === "done" || r.state === "failed" || r.state === "cancelled")
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, 3)
      .map(describeRecord);
    return {
      ok: true,
      activeCount: actives.length,
      tasks: [...actives, ...recentTerminal],
      summary:
        actives.length > 0
          ? actives
              .map((t) => `「${(t.goal as string).slice(0, 40)}」${t.state}${t.progress ? `（${t.progress}）` : ""}`)
              .join("；")
          : "当前没有进行中的后台任务",
    };
  });

  registry.register("task.cancel", async (input, context) => {
    const actorId = resolveActorId(context);
    const sessionId = context.sessionId?.trim() || actorId;
    const taskId = String(input.taskId ?? "").trim();
    if (!taskId) {
      return { ok: false, error: "缺少 taskId（task.status 可查到在办任务的 id）" };
    }
    const hub = getTaskHub();
    const record = hub.get(taskId);
    if (!record || record.sessionId !== sessionId) {
      return { ok: false, error: `任务不存在或不属于当前会话：${taskId}` };
    }
    if (record.state === "done" || record.state === "failed" || record.state === "cancelled") {
      return { ok: false, error: `任务已是终态（${record.state}），无需取消` };
    }
    hub.setState(taskId, "cancelled");
    console.info(
      `[task.cancel] 模型侧取消任务 ${taskId} (session=${sessionId}, goal=${record.goal.slice(0, 60)})`,
    );
    return {
      ok: true,
      taskId,
      state: "cancelled",
      summary: "已取消，后台停止执行且不再回传结果。请用一句话自然确认（如「好的，不弄了」）。",
    };
  });
}
