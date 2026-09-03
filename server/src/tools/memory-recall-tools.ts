// 记忆回查工具：把短期记忆网关的会话情景台账（EpisodicTurn + BM25）
// 暴露为模型可调用的检索入口。
//
// 设计动机（压缩 + 按需展开，对齐 OpenClaw 2.0 Lossless Claw 思路）：
// 会话历史经滚动摘要/修剪后细节会"被压缩掉"，此前模型没有任何工具能把
// 原始轮次捞回来（数据都在 short-term-task-stack.json，缺的只是工具暴露层）。
// 有了本工具，"有损摘要"升级为"压缩 + 按需展开"。

import type { ChatCompletionTool } from "openai/resources/chat/completions";

import type { ToolRegistry } from "./tool-registry.js";
import type { ShortTermMemoryGatewayService } from "../services/short-term-memory-gateway.js";

/** memory.recall_episodic —— 回查当前会话的原始对话轮次 */
export const MEMORY_RECALL_EPISODIC_TOOL: ChatCompletionTool = {
  type: "function",
  function: {
    name: "memory.recall_episodic",
    description:
      "回查当前会话的原始对话记录（逐轮原文检索）。当用户追问刚才/之前说过的具体细节、或你需要核对本会话内出现过的原话而最近对话窗口已看不到时调用。返回与 query 最相关的若干轮对话原文（用户问句 + 你的回复 + 时间）。",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "要回查的内容关键词或问题，越具体命中越准",
        },
        k: {
          type: "integer",
          description: "返回轮数，默认 6，最大 20",
          default: 6,
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
};

export const MEMORY_RECALL_CHAT_TOOLS: ChatCompletionTool[] = [MEMORY_RECALL_EPISODIC_TOOL];

export function registerMemoryRecallTools(
  toolRegistry: ToolRegistry,
  deps: {
    shortTermMemoryGateway: ShortTermMemoryGatewayService | null;
  },
): void {
  if (!deps.shortTermMemoryGateway) return;

  toolRegistry.register("memory.recall_episodic", async (input, context) => {
    const gateway = deps.shortTermMemoryGateway!;
    const query = typeof input.query === "string" ? input.query.trim() : "";
    if (!query) {
      return { ok: false, error: "缺少 query 参数：请给出要回查的内容关键词或问题。" };
    }
    const kRaw = Number(input.k);
    const k = Number.isFinite(kRaw) && kRaw > 0 ? Math.min(20, Math.floor(kRaw)) : 6;

    const turns = gateway.searchEpisodic(context.sessionId, query, k);
    if (turns.length === 0) {
      return {
        ok: true,
        turns: [],
        message: "当前会话没有检索到相关对话轮次。若内容可能在更早的会话，请直接告知用户无法回查到。",
      };
    }

    return {
      ok: true,
      turns: turns.map((t) => ({
        idx: t.idx,
        time: new Date(t.ts).toISOString().slice(0, 16).replace("T", " "),
        user: t.user,
        assistant: t.assistant,
      })),
      message: `已按相关度返回 ${turns.length} 轮会话原文（idx 为会话内轮次序号，越大越新）。引用时忠实于原文，不要凭印象补细节。`,
    };
  });
}
