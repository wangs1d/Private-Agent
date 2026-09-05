import type { ChatCompletionTool } from "openai/resources/chat/completions";

import { resolveActorId } from "../agent/actor-id.js";
import type { ToolRegistry } from "./tool-registry.js";

/**
 * task.dispatch —— 前后台架构的前台派任务原语（2026-09-05）。
 *
 * 设计契约：
 *   - 前台（对话面）只保留两个动作：search_web（必须立刻知道答案的快查）和
 *     本工具（把要真正「办」的事派到后台）。dispatch 立即返回 taskId，前台继续
 *     与用户对话；后台完成后结果以独立消息回灌对话流（agent-core 投递）。
 *   - 这是「前台永不阻塞、后台真办事」的结构保证：写动作不再依赖路由判对，
 *     前台模型自己决定派发；出口诚实闸（commitment-gate）兜底漏派。
 *   - 工具本体零副作用：只调 launch 回调登记任务并立即返回，不等待执行。
 *
 * launch 由 bootstrap 在 AgentCore 创建后晚绑定注入（agentCore.dispatchBackgroundTask）。
 */

export type TaskDispatchInput = {
  actorId: string;
  sessionId?: string;
  chatUserMessageId?: string;
  goal: string;
  note?: string;
};

export type TaskDispatchLauncher = (input: TaskDispatchInput) => string | null;

/** 注入给前台对话的工具 schema（与工具实现同文件，防漂移）。 */
export const TASK_DISPATCH_TOOL_DEFINITION: ChatCompletionTool = {
  type: "function",
  function: {
    name: "task.dispatch",
    description:
      "把需要真正「办」的事派发到后台执行：查实时信息（新闻/价格/天气/比分）、" +
      "找照片/视频、看位置/周边、创建/修改日程提醒、发消息、下单支付、操作软件/设备、" +
      "多步任务等。本工具立即返回，不会阻塞对话；任务完成后结果会自动出现在对话里。" +
      "调用后用一句话自然告知对方已经在办了（如「在办了」「这就去看看」），" +
      "不要报任务编号、不要复述执行步骤、不要承诺具体完成时间。",
    parameters: {
      type: "object",
      properties: {
        goal: {
          type: "string",
          description:
            "用一句完整、自包含的话描述要达成的结果（后台执行者看不到当前聊天上下文之外的补充说明时，靠这句话理解任务）",
        },
        note: {
          type: "string",
          description: "可选补充信息：时间、对象、偏好等执行时需要的细节",
        },
      },
      required: ["goal"],
    },
  },
};

export function registerTaskDispatchTool(
  registry: ToolRegistry,
  deps: {
    /** 晚绑定：bootstrap 在 AgentCore 就绪后注入；未注入时返回拒绝结果 */
    launch: TaskDispatchLauncher;
  },
): void {
  registry.register("task.dispatch", async (input, context) => {
    const actorId = resolveActorId(context);
    const goal = String(input.goal ?? input.task ?? "").trim();
    if (!goal) {
      return { ok: false, error: "缺少 goal（用一句话描述要办成的事）" };
    }
    if (goal.length > 4000) {
      return { ok: false, error: "goal 过长（上限 4000 字符），请提炼成一句话任务" };
    }
    const note = typeof input.note === "string" ? input.note.trim() : undefined;

    const taskId = deps.launch({
      actorId,
      ...(context.sessionId ? { sessionId: context.sessionId } : {}),
      ...(context.chatUserMessageId ? { chatUserMessageId: context.chatUserMessageId } : {}),
      goal,
      ...(note ? { note } : {}),
    });
    if (!taskId) {
      return {
        ok: false,
        error: "后台任务通道未就绪（launch 未注入），请直接告知用户暂时无法代办",
      };
    }

    return {
      ok: true,
      taskId,
      summary:
        "后台任务已提交，正在执行，完成后结果会自动回到对话中。" +
        "现在请继续自然地回应用户（一句话告知在办了即可），不要等待本任务的结果。",
    };
  });
}
