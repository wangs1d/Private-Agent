import type { ChatCompletionTool } from "openai/resources/chat/completions";

const toolDefinitions: { name: string; description: string; parameters: Record<string, unknown> }[] = [
  {
    name: "messages.list_conversations",
    description: "列出聚合消息中心中的会话，支持微信、QQ、飞书等平台。",
    parameters: {
      type: "object",
      properties: {
        platform: { type: "string", description: "可选平台过滤，如 wechat / qq / feishu" },
        limit: { type: "integer", description: "最多返回多少个会话，默认 50" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "messages.read_conversation",
    description: "读取某个聚合会话的详情和最近消息。",
    parameters: {
      type: "object",
      properties: {
        conversationId: { type: "string", description: "会话 ID" },
        limit: { type: "integer", description: "最多返回多少条消息，默认 50" },
      },
      required: ["conversationId"],
      additionalProperties: false,
    },
  },
  {
    name: "messages.reply",
    description: "向某个聚合会话发送回复。",
    parameters: {
      type: "object",
      properties: {
        conversationId: { type: "string", description: "会话 ID" },
        text: { type: "string", description: "回复内容" },
        replyToMessageId: { type: "string", description: "可选，回复到某条消息" },
      },
      required: ["conversationId", "text"],
      additionalProperties: false,
    },
  },
  {
    name: "messages.mark_read",
    description: "将某个聚合会话标记为已读。",
    parameters: {
      type: "object",
      properties: {
        conversationId: { type: "string", description: "会话 ID" },
      },
      required: ["conversationId"],
      additionalProperties: false,
    },
  },
];

export const MESSAGE_HUB_CHAT_TOOL_DEFINITIONS: ChatCompletionTool[] = toolDefinitions.map((def) => ({
  type: "function" as const,
  function: {
    name: def.name,
    description: def.description,
    parameters: def.parameters as any,
  },
}));
