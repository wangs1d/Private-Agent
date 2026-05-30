import type { ChatCompletionTool } from "openai/resources/chat/completions";

/** Hermes 风格渐进式工具披露：三枚桥接工具替代延迟加载的工具 schema。 */
export function buildToolSearchBridgeTools(deferredCount: number): ChatCompletionTool[] {
  const countHint =
    deferredCount > 0
      ? `当前会话有 ${deferredCount} 个工具可通过本桥接按需加载。`
      : "当前无延迟加载工具。";

  return [
    {
      type: "function",
      function: {
        name: "tool_search",
        description:
          `在延迟加载工具目录中搜索匹配项。${countHint} 返回工具名与简短描述；选定后先用 tool_describe 查看完整参数，再用 tool_call 执行。`,
        parameters: {
          type: "object",
          properties: {
            query: { type: "string", description: "自然语言或关键词，描述需要的工具能力" },
            limit: { type: "integer", description: "返回条数上限，默认 5" },
          },
          required: ["query"],
          additionalProperties: false,
        },
      },
    },
    {
      type: "function",
      function: {
        name: "tool_describe",
        description: "加载单个延迟工具的完整 JSON Schema（name、description、parameters）。执行前必须先 describe。",
        parameters: {
          type: "object",
          properties: {
            name: { type: "string", description: "工具注册名，如 world.gomoku.create_table" },
          },
          required: ["name"],
          additionalProperties: false,
        },
      },
    },
    {
      type: "function",
      function: {
        name: "tool_call",
        description: "调用一个延迟加载工具。参数须符合 tool_describe 返回的 schema。",
        parameters: {
          type: "object",
          properties: {
            name: { type: "string", description: "工具注册名" },
            arguments: {
              type: "object",
              description: "工具参数字典",
              additionalProperties: true,
            },
          },
          required: ["name", "arguments"],
          additionalProperties: false,
        },
      },
    },
  ];
}
