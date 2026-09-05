/**
 * 统一的工具调用协议、注册中心与路由分发。
 * 移植自 photography_agent.agent(protocol/registry/router),
 * invoke 改为 async 以兼容 sharp 等异步图像操作。
 */

export interface ToolCallRequest {
  toolName: string;
  arguments: Record<string, unknown>;
  callId?: string | null;
}

export interface ToolCallResponse {
  callId?: string | null;
  success: boolean;
  result?: Record<string, unknown> | null;
  error?: string | null;
}

export type ToolResult = Record<string, unknown>;

export type ToolHandler = (args: Record<string, unknown>) => object | Promise<object>;

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
}

/** 快速生成简单的 JSON Schema 片段 */
export function makeSchema(
  properties: Record<string, unknown>,
  required?: string[],
): Record<string, unknown> {
  const schema: Record<string, unknown> = { type: 'object', properties };
  if (required) {
    schema.required = required;
  }
  return schema;
}

interface ToolEntry {
  definition: ToolDefinition;
  handler: ToolHandler;
}

/** 工具注册中心,管理工具定义与对应处理函数的映射 */
export class ToolRegistry {
  private readonly tools = new Map<string, ToolEntry>();

  register(definition: ToolDefinition, handler: ToolHandler): void {
    if (this.tools.has(definition.name)) {
      throw new Error(`Tool already registered: ${definition.name}`);
    }
    this.tools.set(definition.name, { definition, handler });
  }

  unregister(name: string): void {
    this.tools.delete(name);
  }

  get(name: string): { definition: ToolDefinition; handler: ToolHandler } | null {
    return this.tools.get(name) ?? null;
  }

  listTools(): ToolDefinition[] {
    return [...this.tools.values()].map((entry) => entry.definition);
  }
}

/** 接口层入口,组合 ToolRegistry,负责注册与按名称路由分发 */
export class AgentInterface {
  private readonly registry = new ToolRegistry();

  registerTool(definition: ToolDefinition, handler: ToolHandler): void {
    this.registry.register(definition, handler);
  }

  unregisterTool(name: string): void {
    this.registry.unregister(name);
  }

  listTools(): ToolDefinition[] {
    return this.registry.listTools();
  }

  /** 按 toolName 查找工具并调用;未命中或 handler 抛错均以 error 形式返回 */
  async invoke(call: ToolCallRequest): Promise<ToolCallResponse> {
    const entry = this.registry.get(call.toolName);
    if (!entry) {
      return { callId: call.callId ?? null, success: false, error: `Tool not found: ${call.toolName}` };
    }
    try {
      const result = (await entry.handler(call.arguments ?? {})) as ToolResult;
      return { callId: call.callId ?? null, success: true, result };
    } catch (err) {
      return {
        callId: call.callId ?? null,
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /** 便捷方法:直接以关键字参数构造请求并调用 */
  async invokeRaw(
    toolName: string,
    arguments_: Record<string, unknown>,
  ): Promise<ToolCallResponse> {
    return this.invoke({ toolName, arguments: arguments_ });
  }
}

/** 从 arguments 中取必填参数,缺失时抛出与 Python 版一致的错误信息 */
export function requireArg<T>(args: Record<string, unknown>, key: string): T {
  const value = args[key];
  if (value === undefined || value === null) {
    throw new Error(`缺少必填参数: ${key}`);
  }
  return value as T;
}

export function optionalArg<T>(args: Record<string, unknown>, key: string, fallback: T): T {
  const value = args[key];
  return value === undefined || value === null ? fallback : (value as T);
}
