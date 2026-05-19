import type { SkillManager } from "../skills/index.js";

export type ToolContext = {
  sessionId: string;
};

export type ToolHandler = (input: Record<string, unknown>, context: ToolContext) => Promise<Record<string, unknown>>;

export class ToolRegistry {
  private readonly tools = new Map<string, ToolHandler>();
  private skillManager?: SkillManager;

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
      return { ok: true, result };
    } catch (error) {
      const message = error instanceof Error ? error.message : "工具执行失败";
      return { ok: false, result: { error: message } };
    }
  }
}
