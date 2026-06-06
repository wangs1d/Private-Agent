/**
 * MCP 客户端服务 —— 通过 mcporter CLI 与 MCP Server 交互
 *
 * 职责：
 * 1. 读取 MCP Server 配置（mcp-servers.json 或环境变量）
 * 2. 发现已配置 server 的可用工具列表
 * 3. 调用 MCP 工具并返回结果
 *
 * 调用方式与 UpstreamSearchService 一致：子进程调用 mcporter CLI
 */

import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// ---------- 类型 ----------

export type McpServerConfig = {
  /** server 别名（如 weibo、xiaohongshu），对应 mcporter 中的 alias */
  alias: string;
  /** 可选描述 */
  description?: string;
  /** 启用/禁用，默认 true */
  enabled?: boolean;
};

export type McpToolSchema = {
  /** 工具注册名，格式 mcp.<alias>.<tool_name> */
  name: string;
  /** 工具描述 */
  description: string;
  /** JSON Schema 格式的参数定义 */
  parameters: Record<string, unknown>;
  /** 所属 server alias */
  serverAlias: string;
  /** 原始工具名（不含 alias 前缀） */
  rawToolName: string;
};

type CommandResult = {
  ok: boolean;
  stdout: string;
  stderr: string;
  code: number;
};

// ---------- 配置加载 ----------

const DEFAULT_CONFIG_PATH = join(process.cwd(), "data", "mcp-servers.json");

function loadServerConfigs(): McpServerConfig[] {
  // 1. 优先从配置文件加载
  const configPath = process.env.MCP_SERVERS_CONFIG?.trim() || DEFAULT_CONFIG_PATH;
  if (existsSync(configPath)) {
    try {
      const raw = readFileSync(configPath, "utf-8");
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed.filter(isValidServerConfig);
      if (parsed.servers && Array.isArray(parsed.servers)) return parsed.servers.filter(isValidServerConfig);
    } catch {
      // 配置文件解析失败，继续尝试环境变量
    }
  }

  // 2. 从环境变量加载：MCP_SERVERS=weibo,xiaohongshu,wechat
  const envServers = process.env.MCP_SERVERS?.trim();
  if (envServers) {
    return envServers
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((alias) => ({ alias }));
  }

  return [];
}

function isValidServerConfig(obj: unknown): obj is McpServerConfig {
  return typeof obj === "object" && obj !== null && typeof (obj as McpServerConfig).alias === "string";
}

// ---------- mcporter 二进制路径 ----------

function resolveMcporterBin(): string {
  return process.env.MCPORTER_BIN?.trim() || "mcporter";
}

// ---------- 服务类 ----------

export class McpClientService {
  private readonly servers: McpServerConfig[];
  private readonly toolCache = new Map<string, McpToolSchema>();
  private cachePopulated = false;
  private cachePopulating: Promise<void> | null = null;

  constructor() {
    this.servers = loadServerConfigs().filter((s) => s.enabled !== false);
  }

  /** 获取已配置的 server 列表 */
  listServers(): McpServerConfig[] {
    return [...this.servers];
  }

  /** 获取已发现的工具列表（可能为空，需先调用 discoverTools） */
  listTools(): McpToolSchema[] {
    return Array.from(this.toolCache.values());
  }

  /** 获取单个工具 schema */
  getTool(name: string): McpToolSchema | undefined {
    return this.toolCache.get(name);
  }

  /**
   * 发现所有已配置 server 的可用工具
   * 调用 `mcporter list <alias>` 获取工具列表
   */
  async discoverTools(): Promise<void> {
    if (this.cachePopulating) return this.cachePopulating;

    this.cachePopulating = (async () => {
      const bin = resolveMcporterBin();
      for (const server of this.servers) {
        try {
          const result = await this.runCommand(bin, ["list", server.alias], 15_000);
          if (!result.ok) continue;

          const tools = this.parseToolList(result.stdout, server.alias);
          for (const tool of tools) {
            this.toolCache.set(tool.name, tool);
          }
        } catch {
          // 单个 server 发现失败不影响其他
        }
      }
      this.cachePopulated = true;
    })();

    return this.cachePopulating;
  }

  /**
   * 调用 MCP 工具
   * 调用 `mcporter call <alias>.<tool_name>(arg1: val1, arg2: val2)`
   */
  async callTool(
    serverAlias: string,
    toolName: string,
    args: Record<string, unknown>,
    timeoutMs = 30_000,
  ): Promise<{ ok: boolean; result: Record<string, unknown> }> {
    const bin = resolveMcporterBin();
    const callExpr = this.buildCallExpression(serverAlias, toolName, args);
    const result = await this.runCommand(bin, ["call", callExpr], timeoutMs);

    if (!result.ok) {
      return {
        ok: false,
        result: {
          error: `MCP 工具调用失败(${serverAlias}.${toolName}): ${result.stderr || result.stdout || "未知错误"}`,
        },
      };
    }

    // 尝试解析 JSON 输出
    try {
      const parsed = JSON.parse(result.stdout);
      return { ok: true, result: typeof parsed === "object" && parsed !== null ? parsed : { data: parsed } };
    } catch {
      // 非 JSON 输出，直接返回文本
      return { ok: true, result: { text: result.stdout } };
    }
  }

  /**
   * 通过注册名调用工具（格式 mcp.<alias>.<tool_name>）
   */
  async executeByRegistryName(
    registryName: string,
    args: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<{ ok: boolean; result: Record<string, unknown> }> {
    const parsed = this.parseRegistryName(registryName);
    if (!parsed) {
      return { ok: false, result: { error: `无效的 MCP 工具名: ${registryName}` } };
    }
    return this.callTool(parsed.serverAlias, parsed.toolName, args, timeoutMs);
  }

  /**
   * 健康检查：验证 mcporter 是否可用
   */
  async healthCheck(): Promise<{ ok: boolean; detail: string; servers: Record<string, { ok: boolean; toolCount: number }> }> {
    const bin = resolveMcporterBin();
    const versionResult = await this.runCommand(bin, ["--version"], 6_000);

    if (!versionResult.ok) {
      return {
        ok: false,
        detail: `mcporter 不可用: ${versionResult.stderr || "未安装或不在 PATH 中"}`,
        servers: {},
      };
    }

    const servers: Record<string, { ok: boolean; toolCount: number }> = {};
    for (const server of this.servers) {
      const tools = Array.from(this.toolCache.values()).filter((t) => t.serverAlias === server.alias);
      servers[server.alias] = {
        ok: tools.length > 0,
        toolCount: tools.length,
      };
    }

    return {
      ok: true,
      detail: (versionResult.stdout || versionResult.stderr || "ok").split(/\r?\n/)[0] ?? "ok",
      servers,
    };
  }

  // ---------- 内部方法 ----------

  private async runCommand(command: string, args: string[], timeoutMs: number): Promise<CommandResult> {
    try {
      const { stdout, stderr } = await execFileAsync(command, args, {
        timeout: timeoutMs,
        maxBuffer: 1024 * 1024 * 6,
        windowsHide: true,
      });
      return { ok: true, stdout: String(stdout ?? ""), stderr: String(stderr ?? ""), code: 0 };
    } catch (e) {
      const err = e as NodeJS.ErrnoException & { code?: string | number; stdout?: string; stderr?: string };
      const code = typeof err.code === "number" ? err.code : 1;
      if (err.code === "ENOENT") {
        return { ok: false, stdout: "", stderr: `${command} 未安装或不在 PATH 中`, code };
      }
      return {
        ok: false,
        stdout: String(err.stdout ?? ""),
        stderr: String(err.stderr ?? err.message ?? "命令执行失败"),
        code,
      };
    }
  }

  /**
   * 解析 mcporter list 输出，提取工具列表
   * 输出格式示例（每行一个工具）：
   *   search_weibo_content(keyword: string, limit: number) - 搜索微博内容
   *   或 JSON 格式
   */
  private parseToolList(stdout: string, serverAlias: string): McpToolSchema[] {
    const tools: McpToolSchema[] = [];

    // 尝试 JSON 解析
    try {
      const parsed = JSON.parse(stdout);
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          if (typeof item === "object" && item !== null) {
            const rawName = item.name || item.tool_name || "";
            if (!rawName) continue;
            tools.push({
              name: `mcp.${serverAlias}.${rawName}`,
              description: item.description || `${serverAlias} MCP 工具: ${rawName}`,
              parameters: item.parameters || item.inputSchema || { type: "object", properties: {} },
              serverAlias,
              rawToolName: rawName,
            });
          }
        }
        return tools;
      }
    } catch {
      // 非 JSON，尝试文本解析
    }

    // 文本格式解析：每行一个工具
    const lines = stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    for (const line of lines) {
      // 匹配格式：tool_name(param1: type1, ...) - description
      const match = line.match(/^(\w+)\s*\(([^)]*)\)\s*(?:-\s*)?(.*)$/);
      if (match) {
        const rawName = match[1];
        const paramsStr = match[2];
        const description = match[3] || `${serverAlias} MCP 工具: ${rawName}`;
        tools.push({
          name: `mcp.${serverAlias}.${rawName}`,
          description,
          parameters: this.parseParamsString(paramsStr),
          serverAlias,
          rawToolName: rawName,
        });
      } else if (/^\w+$/.test(line)) {
        // 纯工具名
        tools.push({
          name: `mcp.${serverAlias}.${line}`,
          description: `${serverAlias} MCP 工具: ${line}`,
          parameters: { type: "object", properties: {} },
          serverAlias,
          rawToolName: line,
        });
      }
    }

    return tools;
  }

  /** 解析参数字符串为 JSON Schema */
  private parseParamsString(paramsStr: string): Record<string, unknown> {
    if (!paramsStr.trim()) {
      return { type: "object", properties: {} };
    }

    const properties: Record<string, unknown> = {};
    const required: string[] = [];

    const params = paramsStr.split(",").map((p) => p.trim()).filter(Boolean);
    for (const param of params) {
      const parts = param.split(":").map((s) => s.trim());
      const name = parts[0];
      if (!name) continue;

      const typeStr = parts[1]?.toLowerCase() || "string";
      let type = "string";
      if (typeStr.includes("int") || typeStr.includes("num") || typeStr.includes("float") || typeStr === "number") {
        type = "number";
      } else if (typeStr.includes("bool")) {
        type = "boolean";
      } else if (typeStr.includes("arr") || typeStr.includes("list")) {
        type = "array";
      }

      properties[name] = { type, description: `${name} 参数` };
      required.push(name);
    }

    return {
      type: "object",
      properties,
      required,
      additionalProperties: false,
    };
  }

  /** 构建调用表达式：alias.tool_name(key1: val1, key2: val2) */
  private buildCallExpression(serverAlias: string, toolName: string, args: Record<string, unknown>): string {
    const argsStr = Object.entries(args)
      .map(([k, v]) => {
        if (typeof v === "string") return `${k}: ${JSON.stringify(v)}`;
        return `${k}: ${JSON.stringify(v)}`;
      })
      .join(", ");
    return `${serverAlias}.${toolName}(${argsStr})`;
  }

  /** 解析注册名 mcp.<alias>.<tool_name> */
  private parseRegistryName(registryName: string): { serverAlias: string; toolName: string } | null {
    if (!registryName.startsWith("mcp.")) return null;
    const rest = registryName.slice(4); // 去掉 "mcp."
    const dotIndex = rest.indexOf(".");
    if (dotIndex === -1) return null;
    return {
      serverAlias: rest.slice(0, dotIndex),
      toolName: rest.slice(dotIndex + 1),
    };
  }
}
