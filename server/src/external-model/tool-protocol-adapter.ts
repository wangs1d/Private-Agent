// 工具调用协议 Adapter SPI
//
// 职责：为不同 LLM 厂商的工具调用协议（OpenAI / Anthropic / Gemini / 自研）
// 提供统一适配层，让 openai-compatible-tool-loop 等调用方通过 adapter 抽象协议差异，
// 未来换非 OpenAI 协议的大脑只需新增 adapter case，无需改 loop 逻辑。
//
// 设计要点：
//   1. InternalToolCall 是协议无关的统一内部格式（与 OpenAI tool_calls 结构对齐，
//      因为当前内部全链路假设 OpenAI 格式，最小化迁移成本）
//   2. 每个 adapter 实现两个方向：
//      - normalizeInput：把厂商流式 delta 中的工具调用片段规整为 InternalToolCall
//      - denormalizeOutput：把 InternalToolCall 转回厂商协议格式（用于构造 tool result 消息）
//   3. OpenAI adapter 是 identity（内部格式即 OpenAI 格式），零开销
//   4. Anthropic/Gemini adapter 提供骨架，未来填充实际转换逻辑
//   5. stream-chat-helpers.ts 已有的多格式嗅探（tool_calls→tool_use→function_call）
//      可逐步迁移到 adapter.normalizeInput，但当前保持兼容不强制改造

import type { ToolCallingProtocol, ProviderCapabilities } from "./types.js";

// ============================================================
// 统一内部格式（协议无关）
// ============================================================

/**
 * 统一工具调用格式（内部表示）。
 *
 * 与 OpenAI ChatCompletionMessageToolCall 结构对齐，
 * 让现有 openai-compatible-tool-loop 零改动即可使用。
 */
export interface InternalToolCall {
  /** 工具调用 id（用于关联 tool result） */
  id: string;
  /** 工具名 */
  name: string;
  /** 工具参数（已解析的对象） */
  arguments: Record<string, unknown>;
}

/**
 * 统一工具结果格式（内部表示）。
 *
 * 对应 OpenAI 的 tool message（role: "tool", tool_call_id, content）。
 */
export interface InternalToolResult {
  /** 关联的 tool call id */
  toolCallId: string;
  /** 工具名（可选，便于日志） */
  toolName?: string;
  /** 结果内容（JSON 字符串或纯文本） */
  content: string;
  /** 是否成功 */
  ok: boolean;
}

// ============================================================
// Adapter SPI 接口
// ============================================================

/**
 * 工具调用协议适配器接口。
 *
 * 每种协议族实现此接口，提供双向转换：
 *   - normalizeInput：厂商流式/非流式响应 → InternalToolCall[]
 *   - denormalizeOutput：InternalToolResult → 厂商协议格式的 tool result 消息
 *
 * OpenAI adapter 是 identity（零转换），其他协议 adapter 做实际转换。
 */
export interface ToolProtocolAdapter {
  /** 协议族标识 */
  readonly protocol: ToolCallingProtocol;

  /**
   * 把厂商响应中的工具调用规整为内部格式。
   *
   * @param raw 厂商响应中的工具调用原始数据（类型宽松，各协议结构不同）
   * @returns 规整后的 InternalToolCall 数组（无工具调用时返回空数组）
   */
  normalizeInput(raw: unknown): InternalToolCall[];

  /**
   * 把内部工具结果转回厂商协议格式（用于构造下一轮请求消息）。
   *
   * @param result 内部工具结果
   * @returns 厂商协议格式的消息对象（可直接塞入 messages 数组）
   */
  denormalizeOutput(result: InternalToolResult): unknown;

  /**
   * 构造工具定义（把统一工具 schema 转为厂商协议格式）。
   *
   * @param tools 统一工具定义数组（JSON Schema 格式）
   * @returns 厂商协议格式的工具定义
   */
  normalizeToolDefinitions?(tools: unknown[]): unknown;
}

// ============================================================
// OpenAI Adapter（identity，零转换）
// ============================================================

/**
 * OpenAI 协议适配器。
 *
 * 内部格式与 OpenAI 格式对齐，故 normalizeInput/denormalizeOutput 为 identity。
 * 这是默认 adapter，确保现有代码零改动。
 */
export class OpenAiToolProtocolAdapter implements ToolProtocolAdapter {
  readonly protocol: ToolCallingProtocol = "openai";

  normalizeInput(raw: unknown): InternalToolCall[] {
    if (!raw || typeof raw !== "object") return [];
    const msg = raw as Record<string, unknown>;
    const toolCalls = msg.tool_calls as Array<Record<string, unknown>> | undefined;
    if (!Array.isArray(toolCalls)) return [];
    const result: InternalToolCall[] = [];
    for (const tc of toolCalls) {
      const id = typeof tc.id === "string" ? tc.id : "";
      const fn = tc.function as Record<string, unknown> | undefined;
      const name = typeof fn?.name === "string" ? fn.name : "";
      let args: Record<string, unknown> = {};
      if (typeof fn?.arguments === "string") {
        try { args = JSON.parse(fn.arguments); } catch { /* 保留空对象 */ }
      } else if (fn?.arguments && typeof fn.arguments === "object") {
        args = fn.arguments as Record<string, unknown>;
      }
      if (name) result.push({ id, name, arguments: args });
    }
    return result;
  }

  denormalizeOutput(result: InternalToolResult): unknown {
    return {
      role: "tool",
      tool_call_id: result.toolCallId,
      content: result.content,
    };
  }

  normalizeToolDefinitions(tools: unknown[]): unknown {
    return tools; // OpenAI 格式即内部格式
  }
}

// ============================================================
// Anthropic Adapter 骨架（预留，未来填充）
// ============================================================

/**
 * Anthropic Messages API 协议适配器骨架。
 *
 * Anthropic 工具调用格式：
 *   - 请求：tools: [{ name, description, input_schema }]
 *   - 响应：content blocks [{ type: "tool_use", id, name, input }]
 *   - 结果：content blocks [{ type: "tool_result", tool_use_id, content }]
 *
 * 当前为骨架，normalizeInput/denormalizeOutput 已实现基本转换，
 * 未来接入 Anthropic 原生 API 时可直接使用。
 */
export class AnthropicToolProtocolAdapter implements ToolProtocolAdapter {
  readonly protocol: ToolCallingProtocol = "anthropic";

  normalizeInput(raw: unknown): InternalToolCall[] {
    if (!raw || typeof raw !== "object") return [];
    const msg = raw as Record<string, unknown>;
    const contentBlocks = msg.content as Array<Record<string, unknown>> | undefined;
    if (!Array.isArray(contentBlocks)) return [];
    const result: InternalToolCall[] = [];
    for (const block of contentBlocks) {
      if (block.type !== "tool_use") continue;
      const id = typeof block.id === "string" ? block.id : "";
      const name = typeof block.name === "string" ? block.name : "";
      const input = (block.input && typeof block.input === "object")
        ? block.input as Record<string, unknown>
        : {};
      if (name) result.push({ id, name, arguments: input });
    }
    return result;
  }

  denormalizeOutput(result: InternalToolResult): unknown {
    return {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: result.toolCallId,
          content: result.content,
        },
      ],
    };
  }

  normalizeToolDefinitions(tools: unknown[]): unknown {
    // OpenAI tools: [{ type: "function", function: { name, description, parameters } }]
    // Anthropic tools: [{ name, description, input_schema }]
    return tools.map((t) => {
      const openaiTool = t as Record<string, unknown>;
      const fn = openaiTool.function as Record<string, unknown> | undefined;
      return {
        name: fn?.name ?? "",
        description: fn?.description ?? "",
        input_schema: fn?.parameters ?? { type: "object", properties: {} },
      };
    });
  }
}

// ============================================================
// Gemini Adapter 骨架（预留）
// ============================================================

/**
 * Gemini 协议适配器骨架。
 *
 * Gemini 工具调用格式：
 *   - 请求：tools: [{ functionDeclarations: [{ name, description, parameters }] }]
 *   - 响应：functionCall: { name, args }
 *   - 结果：functionResponse: { name, response }
 */
export class GeminiToolProtocolAdapter implements ToolProtocolAdapter {
  readonly protocol: ToolCallingProtocol = "gemini";

  normalizeInput(raw: unknown): InternalToolCall[] {
    if (!raw || typeof raw !== "object") return [];
    const msg = raw as Record<string, unknown>;
    const fc = msg.functionCall as Record<string, unknown> | undefined;
    if (!fc) return [];
    const name = typeof fc.name === "string" ? fc.name : "";
    const args = (fc.args && typeof fc.args === "object")
      ? fc.args as Record<string, unknown>
      : {};
    if (name) return [{ id: `gemini-${Date.now()}`, name, arguments: args }];
    return [];
  }

  denormalizeOutput(result: InternalToolResult): unknown {
    return {
      functionResponse: {
        name: result.toolName ?? "",
        response: { result: result.content },
      },
    };
  }
}

// ============================================================
// Custom Adapter（自研协议，identity fallback）
// ============================================================

/**
 * 自研协议适配器。
 *
 * 世界模型等自研 API 可继承此类或实现 ToolProtocolAdapter 接口，
 * 注册到 ADAPTER_REGISTRY 即可被 getToolProtocolAdapter 选中。
 * 默认行为与 OpenAI identity 一致（假设自研协议也用类似 tool_calls 结构）。
 */
export class CustomToolProtocolAdapter extends OpenAiToolProtocolAdapter {
  readonly protocol: ToolCallingProtocol = "custom";
}

// ============================================================
// Adapter 注册表与工厂
// ============================================================

const ADAPTER_REGISTRY: Record<ToolCallingProtocol, ToolProtocolAdapter> = {
  openai: new OpenAiToolProtocolAdapter(),
  anthropic: new AnthropicToolProtocolAdapter(),
  gemini: new GeminiToolProtocolAdapter(),
  custom: new CustomToolProtocolAdapter(),
};

/**
 * 注册自定义协议适配器（供外部项目扩展）。
 *
 * 示例：世界模型项目实现了 WorldModelToolProtocolAdapter 后注册：
 *   registerToolProtocolAdapter("custom", new WorldModelToolProtocolAdapter());
 */
export function registerToolProtocolAdapter(
  protocol: ToolCallingProtocol,
  adapter: ToolProtocolAdapter,
): void {
  ADAPTER_REGISTRY[protocol] = adapter;
}

/**
 * 从 provider 能力声明获取对应协议适配器。
 *
 * - 有 capabilities.toolCallingProtocol → 对应 adapter
 * - 无 capabilities → 默认 OpenAI adapter（向后兼容）
 */
export function getToolProtocolAdapter(
  capabilities?: ProviderCapabilities | null,
): ToolProtocolAdapter {
  const protocol = capabilities?.toolCallingProtocol ?? "openai";
  return ADAPTER_REGISTRY[protocol] ?? ADAPTER_REGISTRY.openai;
}

/**
 * 从 provider id 推断协议族（当 capabilities 缺失时的 fallback）。
 *
 * 已知映射：
 *   - moonshot-kimi / openai → openai
 *   - anthropic / claude → anthropic
 *   - gemini / google → gemini
 *   - 其他 → openai（默认兼容）
 */
export function inferProtocolFromProviderId(providerId: string): ToolCallingProtocol {
  const id = providerId.toLowerCase();
  if (id.includes("anthropic") || id.includes("claude")) return "anthropic";
  if (id.includes("gemini") || id.includes("google")) return "gemini";
  return "openai";
}
