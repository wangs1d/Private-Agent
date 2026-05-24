import type { SkillManager } from "../skills/index.js";

export type ToolContext = {
  sessionId: string;
};

export type ToolHandler = (input: Record<string, unknown>, context: ToolContext) => Promise<Record<string, unknown>>;

/**
 * 🔴 状态连续性约束配置（见 .trae/rules/project_rules.md）
 *
 * 有状态的工具必须满足：
 * - 提供对应的 get_snapshot / get_status 方法
 * - 操作前验证当前状态
 * - 返回更新后的快照
 */
export interface StatefulToolConfig {
  /** 工具名称前缀，如 "world.gomoku" */
  modulePrefix: string;
  /** 状态检查工具名，如 "world.gomoku.get_snapshot" */
  snapshotToolName: string;
  /** 有效状态列表 */
  validStatuses: string[];
  /** 操作后是否必须返回快照 */
  mustReturnSnapshot: boolean;
}

export class ToolRegistry {
  private readonly tools = new Map<string, ToolHandler>();
  private skillManager?: SkillManager;
  private readonly statefulModules = new Map<string, StatefulToolConfig>();

  /**
   * 设置 Skill 管理器（可选）
   */
  setSkillManager(manager: SkillManager): void {
    this.skillManager = manager;
  }

  /**
   * 📝 注册有状态的模块（强制状态连续性）
   *
   * 使用示例：
   * ```typescript
   * registry.registerStatefulModule({
   *   modulePrefix: "world.new_feature",
   *   snapshotToolName: "world.new_feature.get_snapshot",
   *   validStatuses: ["waiting", "active", "completed"],
   *   mustReturnSnapshot: true,
   * });
   * ```
   *
   * 注册后，该模块的所有操作工具会自动被标记为"有状态"，
   * 便于后续审计和代码生成时强制包含状态检查逻辑。
   */
  registerStatefulModule(config: StatefulToolConfig): void {
    this.statefulModules.set(config.modulePrefix, config);
    console.log(
      `[ToolRegistry] ✅ 已注册有状态模块: ${config.modulePrefix} ` +
      `(snapshot: ${config.snapshotToolName}, statuses: ${config.validStatuses.join(", ")})`
    );
  }

  /**
   * 检查工具是否属于有状态模块
   */
  isStatefulTool(toolName: string): { isStateful: boolean; config?: StatefulToolConfig; snapshotTool?: string } {
    for (const [prefix, config] of this.statefulModules) {
      if (toolName.startsWith(prefix)) {
        const isSnapshotTool = toolName === config.snapshotToolName;
        return {
          isStateful: !isSnapshotTool,
          config,
          snapshotTool: config.snapshotToolName,
        };
      }
    }
    return { isStateful: false };
  }

  /**
   * 获取所有已注册的有状态模块（用于审计）
   */
  listStatefulModules(): StatefulToolConfig[] {
    return Array.from(this.statefulModules.values());
  }

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
    // 优先尝试通过 Skill 管理器执行
    if (this.skillManager) {
      const skillResult = await this.skillManager.execute(name, input, context);
      if (skillResult.ok) {
        return { ok: true, result: skillResult.result || {} };
      }
      // 如果 Skill 不存在，继续尝试传统工具
      if (skillResult.error?.code !== "SKILL_NOT_FOUND") {
        return { ok: false, result: { error: skillResult.error?.message || "Skill 执行失败" } };
      }
    }

    // 回退到传统工具执行
    const tool = this.tools.get(name);
    if (!tool) return { ok: false, result: { error: `未知工具: ${name}` } };
    try {
      const result = await tool(input, context);

      // 🔴 状态连续性审计：检查有状态工具是否返回了快照
      const stateInfo = this.isStatefulTool(name);
      if (stateInfo.isStateful && stateInfo.config?.mustReturnSnapshot) {
        if (!result || !('snapshot' in result) || !result.snapshot) {
          console.warn(
            `[ToolRegistry] ⚠️ 有状态工具 "${name}" 未返回 snapshot！` +
            `违反状态连续性原则（见 .trae/rules/project_rules.md）`
          );
        }
      }

      return { ok: true, result };
    } catch (error) {
      const message = error instanceof Error ? error.message : "工具执行失败";
      return { ok: false, result: { error: message } };
    }
  }
}
