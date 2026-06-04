import type { WorldService } from "@private-ai-agent/agent-world";
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
};

export type ToolHandler = (input: Record<string, unknown>, context: ToolContext) => Promise<Record<string, unknown>>;

/** LLM/API 工具名（下划线）→ 注册名（点号），兼容历史会话与未走 prepareToolsForChatApi 的路径。 */
const REGISTRY_TOOL_NAME_ALIASES: Record<string, string> = {
  master_invoke_sub_agent: "master.invoke_sub_agent",
  master_list_sub_agents: "master.list_sub_agents",
  master_poll_sub_agent_tasks: "master.poll_sub_agent_tasks",
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

export class ToolRegistry {
  private readonly tools = new Map<string, ToolHandler>();
  private skillManager?: SkillManager;
  private worldService?: WorldService | null;

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
   * 注册传统工具（代码方式）
   */
  register(name: string, handler: ToolHandler): void {
    this.tools.set(name, handler);
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

  async execute(
    name: string,
    input: Record<string, unknown>,
    context: ToolContext,
  ): Promise<{ ok: boolean; result: Record<string, unknown> }> {
    const registryName = resolveRegistryToolName(name);
    const accessMode = parseAgentAccessMode(context.agentAccessMode);
    if (!isToolAllowedInAccessMode(registryName, accessMode, {
      desktopBridgeOnline: context.desktopBridgeOnline,
    })) {
      return { ok: false, result: { error: sandboxDeniedToolMessage(registryName) } };
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
    try {
      const result = await tool(input, context);
      return { ok: true, result };
    } catch (error) {
      const message = error instanceof Error ? error.message : "工具执行失败";
      return { ok: false, result: { error: message } };
    }
  }
}
