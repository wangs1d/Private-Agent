/**
 * MCP 工具注册 —— 将 MCP 工具注册到 ToolRegistry
 *
 * 遵循项目 registerXxxTools 模式：
 *   export function registerMcpTools(toolRegistry, mcpClientService)
 */

import type { McpClientService, McpToolSchema } from "../services/mcp-client-service.js";
import type { ToolRegistry } from "./tool-registry.js";

/**
 * 将 MCP 工具注册到 ToolRegistry
 * 每个已发现的 MCP 工具注册为 mcp.<alias>.<tool_name>
 */
export function registerMcpTools(
  toolRegistry: ToolRegistry,
  mcpClientService: McpClientService,
): void {
  const tools = mcpClientService.listTools();

  for (const tool of tools) {
    toolRegistry.register(tool.name, async (input) => {
      const result = await mcpClientService.executeByRegistryName(tool.name, input);
      if (!result.ok) {
        return { error: result.result.error };
      }
      return result.result;
    });
  }
}

/**
 * 从已发现的 MCP 工具动态生成 ChatCompletionTool 定义
 * 遵循项目 ChatCompletionTool[] 模式
 */
export function buildMcpChatTools(mcpClientService: McpClientService): import("openai/resources/chat/completions").ChatCompletionTool[] {
  const tools = mcpClientService.listTools();
  return tools.map(mcpToolToChatTool);
}

/** 将单个 McpToolSchema 转换为 OpenAI ChatCompletionTool */
export function mcpToolToChatTool(schema: McpToolSchema): import("openai/resources/chat/completions").ChatCompletionTool {
  return {
    type: "function",
    function: {
      name: schema.name,
      description: schema.description,
      parameters: schema.parameters as {
        type: "object";
        properties?: Record<string, unknown>;
        required?: string[];
        additionalProperties?: boolean;
      },
    },
  };
}
