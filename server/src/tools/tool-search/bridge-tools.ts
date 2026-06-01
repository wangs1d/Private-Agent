import type { ChatCompletionTool } from "openai/resources/chat/completions";

import type { ToolSearchBridgeMode } from "./env.js";

function mergedBridgeTools(deferredCount: number): ChatCompletionTool[] {
  const countHint =
    deferredCount > 0
      ? `当前有 ${deferredCount} 个非核心工具在延迟目录中。`
      : "当前无延迟加载工具。";

  return [
    {
      type: "function",
      function: {
        name: "tool_discover",
        description:
          `发现并加载延迟工具（合并 search+describe）。${countHint} 用法：① 仅 query — 搜索，top-1 默认带完整 schema；② 仅 name — 直接拉取该工具 schema；③ query+name — 先搜索再校验 name。随后用 tool_call 执行。`,
        parameters: {
          type: "object",
          properties: {
            query: { type: "string", description: "自然语言或关键词" },
            name: { type: "string", description: "已知注册名时直接加载 schema，可省略 query" },
            limit: { type: "integer", description: "搜索条数上限，默认 5" },
            include_schema: {
              type: "boolean",
              description: "为 true 时为所有匹配附带完整 parameters（更占 token）",
            },
          },
          additionalProperties: false,
        },
      },
    },
    {
      type: "function",
      function: {
        name: "tool_call",
        description: "调用延迟目录中的工具。参数须符合 tool_discover 返回的 schema。",
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

function legacyBridgeTools(deferredCount: number): ChatCompletionTool[] {
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
          `在延迟加载工具目录中搜索匹配项。${countHint} 返回 name、description、score、parameterNames、requiredParameters。`,
        parameters: {
          type: "object",
          properties: {
            query: { type: "string", description: "自然语言或关键词" },
            limit: { type: "integer", description: "返回条数上限，默认 5" },
            include_schema: { type: "boolean", description: "为 true 时附带完整 parameters" },
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
        description: "加载单个延迟工具的完整 JSON Schema。",
        parameters: {
          type: "object",
          properties: {
            name: { type: "string", description: "工具注册名" },
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
        description: "调用一个延迟加载工具。",
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

/** 核心库之外的工具通过桥接按需披露（merged 默认 2 枚，legacy 为 Hermes 三件套）。 */
export function buildToolSearchBridgeTools(
  deferredCount: number,
  mode: ToolSearchBridgeMode = "merged",
): ChatCompletionTool[] {
  return mode === "legacy" ? legacyBridgeTools(deferredCount) : mergedBridgeTools(deferredCount);
}
