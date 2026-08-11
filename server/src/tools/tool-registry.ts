import type { WorldService } from "@private-ai-agent/agent-world";
import {
  getToolMetadata as inferToolMetadata,
  type ToolMetadata,
} from "../agent/loop/tool-metadata.js";
import { resolveActorId } from "../agent/actor-id.js";
import {
  isToolAllowedInAccessMode,
  parseAgentAccessMode,
  sandboxDeniedToolMessage,
  type AgentAccessMode,
} from "../agent/agent-access-mode.js";
import type { SkillManager } from "../skills/index.js";

import type { ClientLocationWire } from "../types/client-location.js";

export type ToolContext = {
  sessionId: string;
  /** 稳定用户标识（优先）；与 `sessionId` 二选一由 {@link resolveActorId} 合并 */
  userId?: string;
  /** 触发本轮工具执行的 `chat.user_message.messageId`（发送方主会话），用于审计与中继关联 */
  chatUserMessageId?: string;
  /** 客户端 IP（仅在前端未上报定位时作兜底） */
  clientIp?: string;
  /** 前端 GPS / 浏览器定位（优先于 IP 地理库） */
  clientLocation?: ClientLocationWire;
  /** 默认沙箱；`full` 时开放高权限工具 */
  agentAccessMode?: AgentAccessMode;
  /** 电脑桥接在线时允许 desktop.visual.* */
  desktopBridgeOnline?: boolean;
  /** 手机桥接在线时允许 phone.* */
  phoneBridgeOnline?: boolean;
};

export type ToolHandler = (input: Record<string, unknown>, context: ToolContext) => Promise<Record<string, unknown>>;

export type ToolAvailabilityResult =
  | boolean
  | {
      ok: boolean;
      reason?: string;
    };

export type ToolAvailabilityCheck = (
  context: ToolContext,
) => ToolAvailabilityResult | Promise<ToolAvailabilityResult>;

export type ToolRegistrationMetadata = Partial<Omit<ToolMetadata, "name">> & {
  /** Runtime availability gate, similar to external agent check_fn design. */
  checkFn?: ToolAvailabilityCheck;
};

/** LLM/API 工具名（下划线）→ 注册名（点号），兼容历史会话与未走 prepareToolsForChatApi 的路径。 */
const REGISTRY_TOOL_NAME_ALIASES: Record<string, string> = {
  master_invoke_sub_agent: "master.invoke_sub_agent",
  master_list_sub_agents: "master.list_sub_agents",
  master_poll_sub_agent_tasks: "master.poll_sub_agent_tasks",
  subagent_ask_peer: "subagent.ask_peer",
  embodiment_roam: "embodiment.roam",
  embodiment_move: "embodiment.move",
  embodiment_stop: "embodiment.stop",
  embodiment_set_state: "embodiment.set_state",
  embodiment_excite: "embodiment.excite",
  embodiment_window_roam: "embodiment.window_roam",
  embodiment_window_place: "embodiment.window_place",
  embodiment_observe: "embodiment.observe",
  desktop_visual_screenshot: "desktop.visual.screenshot",
  desktop_visual_run_task: "desktop.visual.run_task",
};

export function resolveRegistryToolName(name: string): string {
  return REGISTRY_TOOL_NAME_ALIASES[name] ?? name;
}

/**
 * 工具结果缓存：相同工具名+参数在 TTL 内复用结果。
 * 适用场景：天气/时间/搜索等查询类工具，短时间内重复调用概率高。
 * 不适用：写操作、桌面操作、购物下单等副作用工具。
 */
interface ToolCacheEntry {
  result: { ok: boolean; result: Record<string, unknown> };
  timestamp: number;
}

const TOOL_CACHE_TTL_MS = 60_000; // 60 秒缓存
const TOOL_CACHE_MAX_SIZE = 100;

/** 需要缓存的工具名（查询类、无副作用） */
const CACHEABLE_TOOLS = new Set([
  "weather.get_local",
  "internet.research",
  "internet.live_check",
  "internet.verify",
  "search_web",
  "fetch_web",
  "info.inspect_webpage",
  "info.navigate_site",
  "info.search",
]);

/** 生成工具缓存键 */
function buildToolCacheKey(name: string, input: Record<string, unknown>): string {
  const sortedInput = Object.keys(input).sort().reduce((acc, key) => {
    acc[key] = input[key];
    return acc;
  }, {} as Record<string, unknown>);
  return `${name}:${JSON.stringify(sortedInput)}`;
}

export class ToolRegistry {
  private readonly tools = new Map<string, ToolHandler>();
  private readonly metadata = new Map<string, ToolMetadata & { checkFn?: ToolAvailabilityCheck }>();
  private skillManager?: SkillManager;
  private worldService?: WorldService | null;
  private readonly toolCache = new Map<string, ToolCacheEntry>();

  /**
   * 用于校验社区 Skill 是否已被当前会话购买（个人房 `roomId === sessionId`）。
   */
  setWorldService(service: WorldService | null): void {
    this.worldService = service;
  }

  /**
   * 设置 Skill 管理器（可选）
   */
  setSkillManager(manager: SkillManager): void {
    this.skillManager = manager;
  }

  /**
   * 获取已注入的 SkillManager（可能未注入，返回 undefined）。
   * 用于需要查询 skill schema 的场景（如 brain.list_capabilities include_schema）。
   */
  getSkillManager(): SkillManager | undefined {
    return this.skillManager;
  }

  /**
   * 注册传统工具（代码方式）
   */
  register(name: string, handler: ToolHandler, metadata?: ToolRegistrationMetadata): void {
    this.tools.set(name, handler);
    this.metadata.set(name, this.mergeMetadata(name, metadata));
  }

  list(): string[] {
    const traditionalTools = Array.from(this.tools.keys());
    
    // 如果有 Skill 管理器，合并 Skill 列表
    if (this.skillManager) {
      const skills = this.skillManager.list(true); // 只列出启用的
      const skillNames = skills.map(s => s.name);
      return [...traditionalTools, ...skillNames];
    }
    
    return traditionalTools;
  }

  getMetadata(name: string): ToolMetadata & { checkFn?: ToolAvailabilityCheck } {
    const registryName = resolveRegistryToolName(name);
    return this.metadata.get(registryName) ?? this.mergeMetadata(registryName);
  }

  listMetadata(): Array<ToolMetadata & { checkFn?: ToolAvailabilityCheck }> {
    return this.list().map((name) => this.getMetadata(name));
  }

  async execute(
    name: string,
    input: Record<string, unknown>,
    context: ToolContext,
  ): Promise<{ ok: boolean; result: Record<string, unknown> }> {
    const registryName = resolveRegistryToolName(name);
    const accessMode = parseAgentAccessMode(context.agentAccessMode);
    if (!isToolAllowedInAccessMode(registryName, accessMode, {
      desktopBridgeOnline: context.desktopBridgeOnline,
      phoneBridgeOnline: context.phoneBridgeOnline,
    })) {
      return { ok: false, result: { error: sandboxDeniedToolMessage(registryName) } };
    }

    const availability = await this.checkAvailability(registryName, context);
    if (!availability.ok) {
      return {
        ok: false,
        result: { error: availability.reason ?? `宸ュ叿褰撳墠涓嶅彲鐢? ${registryName}` },
      };
    }

    // 优先尝试通过 Skill 管理器执行
    if (this.skillManager) {
      const manifest = this.skillManager.get(registryName);
      const actorId = resolveActorId(context);
      if (
        manifest?.kind === "community" &&
        this.worldService &&
        !this.worldService.getOrCreateRoom(actorId, actorId).ownedSkillIds.includes(registryName)
      ) {
        return {
          ok: false,
          result: { error: `未拥有该社区技能，无法调用：${registryName}（请在世界商店购买后再试）` },
        };
      }
      const skillResult = await this.skillManager.execute(registryName, input, context);
      if (skillResult.ok) {
        return { ok: true, result: skillResult.result || {} };
      }
      // 如果 Skill 不存在，继续尝试传统工具
      if (skillResult.error?.code !== "SKILL_NOT_FOUND") {
        return { ok: false, result: { error: skillResult.error?.message || "Skill 执行失败" } };
      }
    }

    // 回退到传统工具执行
    const tool = this.tools.get(registryName);
    if (!tool) return { ok: false, result: { error: `未知工具: ${registryName}` } };

    // 工具结果缓存：查询类工具在 TTL 内复用结果
    if (this.isCacheableTool(registryName)) {
      const ttlMs = this.resolveToolCacheTtlMs(registryName);
      const cacheKey = buildToolCacheKey(registryName, input);
      const cached = this.toolCache.get(cacheKey);
      if (cached && Date.now() - cached.timestamp < ttlMs) {
        return cached.result;
      }
      // 缓存未命中或过期，执行并缓存
      try {
        const result = await tool(input, context);
        const ok = true;
        const entry = { result: { ok, result }, timestamp: Date.now() };
        // LRU 淘汰：超过最大容量时删除最旧的
        if (this.toolCache.size >= TOOL_CACHE_MAX_SIZE) {
          const oldestKey = this.toolCache.keys().next().value;
          if (oldestKey !== undefined) {
            this.toolCache.delete(oldestKey);
          }
        }
        this.toolCache.set(cacheKey, entry);
        return { ok, result };
      } catch (error) {
        const message = error instanceof Error ? error.message : "工具执行失败";
        return { ok: false, result: { error: message } };
      }
    }

    try {
      const result = await tool(input, context);
      return { ok: true, result };
    } catch (error) {
      const message = error instanceof Error ? error.message : "工具执行失败";
      return { ok: false, result: { error: message } };
    }
  }

  /**
   * 查询工具缓存（供 tool search 桥接层调用）。
   * 命中时直接返回缓存结果，跳过 executeTool 调用。
   * @returns 缓存结果，未命中返回 null
   */
  getCachedResult(
    name: string,
    input: Record<string, unknown>,
  ): { ok: boolean; result: Record<string, unknown> } | null {
    const registryName = resolveRegistryToolName(name);
    if (!this.isCacheableTool(registryName)) return null;
    const ttlMs = this.resolveToolCacheTtlMs(registryName);
    const cacheKey = buildToolCacheKey(registryName, input);
    const cached = this.toolCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < ttlMs) {
      return cached.result;
    }
    return null;
  }

  /** 清理过期缓存（定期调用） */
  cleanupCache(): void {
    const now = Date.now();
    for (const [key, entry] of this.toolCache.entries()) {
      const toolName = key.slice(0, key.indexOf(":"));
      if (now - entry.timestamp >= this.resolveToolCacheTtlMs(toolName)) {
        this.toolCache.delete(key);
      }
    }
  }

  private mergeMetadata(
    name: string,
    metadata?: ToolRegistrationMetadata,
  ): ToolMetadata & { checkFn?: ToolAvailabilityCheck } {
    const inferred = inferToolMetadata(name);
    return {
      ...inferred,
      ...metadata,
      name,
      category: metadata?.category ?? inferred.category,
      alternatives: metadata?.alternatives ?? inferred.alternatives,
      requireHonestFailure: metadata?.requireHonestFailure ?? inferred.requireHonestFailure,
    };
  }

  private async checkAvailability(
    name: string,
    context: ToolContext,
  ): Promise<{ ok: boolean; reason?: string }> {
    const checkFn = this.metadata.get(name)?.checkFn;
    if (!checkFn) return { ok: true };
    const result = await checkFn(context);
    if (typeof result === "boolean") return { ok: result };
    return { ok: result.ok, reason: result.reason };
  }

  private isCacheableTool(name: string): boolean {
    const policy = this.getMetadata(name).cachePolicy;
    return policy?.enabled === true || CACHEABLE_TOOLS.has(name);
  }

  private resolveToolCacheTtlMs(name: string): number {
    return this.getMetadata(name).cachePolicy?.ttlMs ?? TOOL_CACHE_TTL_MS;
  }
}
