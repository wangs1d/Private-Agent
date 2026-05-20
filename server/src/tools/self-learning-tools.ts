/**
 * Agent 自我学习工具 - 让 Agent 能够从交互中学习和改进
 */

import { resolveActorId } from "../agent/actor-id.js";
import type { ToolRegistry } from "./tool-registry.js";
import type { SkillManager } from "../skills/index.js";
import type { ExternalChatProvider } from "../external-model/types.js";
import { AgentSelfLearningService } from "../services/agent-self-learning-service.js";

/**
 * 注册 Agent 自我学习工具
 */
export function registerSelfLearningTools(
  registry: ToolRegistry,
  chatProvider: ExternalChatProvider | null,
  skillManager?: SkillManager | null,
): void {
  const learningService = new AgentSelfLearningService(chatProvider, registry, skillManager || null);

  // ========== 记录交互用于学习 ==========
  registry.register("self.record_interaction", async (input, context) => {
    const actorId = resolveActorId(context);
    
    try {
      const userRequest = String(input.userRequest ?? "").trim();
      const attemptedTools = (input.attemptedTools as string[]) || [];
      const success = Boolean(input.success);
      const errorMessage = input.errorMessage ? String(input.errorMessage) : undefined;
      const responseTime = input.responseTime ? Number(input.responseTime) : undefined;
      
      if (!userRequest) {
        return { ok: false, error: "需要提供用户请求（userRequest）" };
      }
      
      await learningService.recordInteraction({
        sessionId: actorId,
        userRequest,
        attemptedTools,
        success,
        errorMessage,
        responseTime,
      });
      
      return {
        ok: true,
        message: "交互记录已保存，将用于后续分析和改进",
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return { ok: false, error: `记录失败：${msg}` };
    }
  });
  
  // ========== 分析并生成改进建议 ==========
  registry.register("self.analyze_improvements", async (_input, context) => {
    const actorId = resolveActorId(context);
    
    try {
      const suggestions = await learningService.analyzeAndGenerateSuggestions();
      
      if (suggestions.length === 0) {
        return {
          ok: true,
          message: "暂无改进建议，继续收集更多交互数据",
          suggestions: [],
        };
      }
      
      return {
        ok: true,
        totalSuggestions: suggestions.length,
        highPriorityCount: suggestions.filter((s) => s.priority === "high").length,
        suggestions: suggestions.map((s) => ({
          type: s.type,
          priority: s.priority,
          title: s.title,
          description: s.description,
          rationale: s.rationale,
          estimatedImpact: s.estimatedImpact,
        })),
        note: "使用 self.get_suggestions 查看详细实施计划",
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return { ok: false, error: `分析失败：${msg}` };
    }
  });
  
  // ========== 获取改进建议详情 ==========
  registry.register("self.get_suggestions", async (_input, context) => {
    const actorId = resolveActorId(context);
    
    try {
      const suggestions = await learningService.getRecentSuggestions();
      
      return {
        ok: true,
        suggestions,
        totalCount: suggestions.length,
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return { ok: false, error: `获取建议失败：${msg}` };
    }
  });
  
  // ========== 检测是否需要新技能 ==========
  registry.register("self.detect_skill_need", async (input, context) => {
    const actorId = resolveActorId(context);
    
    try {
      const userRequest = String(input.userRequest ?? "").trim();
      
      if (!userRequest) {
        return { ok: false, error: "需要提供用户需求（userRequest）" };
      }
      
      const availableTools = registry.list();
      const detection = await learningService.detectSkillNeed(userRequest, availableTools);
      
      return {
        ok: true,
        ...detection,
        nextSteps: detection.needNewSkill
          ? [
              "使用 self.generate_skill 智能生成技能代码",
              "或使用 self.create_skill 手动创建技能",
            ]
          : ["当前工具集应该能够满足需求"],
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return { ok: false, error: `检测失败：${msg}` };
    }
  });
  
  // ========== 查看学习统计 ==========
  registry.register("self.get_learning_stats", async (_input, context) => {
    const actorId = resolveActorId(context);
    
    try {
      // 这里可以返回更详细的统计数据
      const recentSuggestions = await learningService.getRecentSuggestions();
      
      return {
        ok: true,
        stats: {
          totalSuggestions: recentSuggestions.length,
          byType: {
            newSkill: recentSuggestions.filter((s) => s.type === "new_skill").length,
            optimizeExisting: recentSuggestions.filter((s) => s.type === "optimize_existing").length,
            addTool: recentSuggestions.filter((s) => s.type === "add_tool").length,
          },
          byPriority: {
            high: recentSuggestions.filter((s) => s.priority === "high").length,
            medium: recentSuggestions.filter((s) => s.priority === "medium").length,
            low: recentSuggestions.filter((s) => s.priority === "low").length,
          },
        },
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return { ok: false, error: `获取统计失败：${msg}` };
    }
  });
}
