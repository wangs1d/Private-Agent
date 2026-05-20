/**
 * Agent 自我学习与改进服务
 * 
 * 功能：
 * 1. 分析 Agent 的使用轨迹和失败案例
 * 2. 识别能力缺口和改进机会
 * 3. 主动生成改进建议和新技能提案
 * 4. 持续优化 Agent 的能力体系
 */

import { writeFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExternalChatProvider } from "../external-model/types.js";
import type { ToolRegistry } from "../tools/tool-registry.js";
import type { SkillManager } from "../skills/index.js";

export interface LearningRecord {
  timestamp: string;
  sessionId: string;
  userRequest: string;
  attemptedTools: string[];
  success: boolean;
  errorMessage?: string;
  responseTime?: number;
}

export interface ImprovementSuggestion {
  type: "new_skill" | "optimize_existing" | "add_tool" | "update_prompt";
  priority: "high" | "medium" | "low";
  title: string;
  description: string;
  rationale: string;
  estimatedImpact: string;
  implementationPlan?: string;
}

/**
 * Agent 自我学习服务
 */
export class AgentSelfLearningService {
  private readonly learningLogPath: string;
  private readonly suggestionsPath: string;
  private recentRecords: LearningRecord[] = [];
  
  constructor(
    private readonly chatProvider: ExternalChatProvider | null,
    private readonly toolRegistry: ToolRegistry,
    private readonly skillManager: SkillManager | null,
  ) {
    this.learningLogPath = join(process.cwd(), "data", "agent-learning-log.jsonl");
    this.suggestionsPath = join(process.cwd(), "data", "improvement-suggestions.json");
  }

  /**
   * 记录一次交互学习
   */
  async recordInteraction(record: Omit<LearningRecord, "timestamp">): Promise<void> {
    const fullRecord: LearningRecord = {
      ...record,
      timestamp: new Date().toISOString(),
    };
    
    // 添加到内存缓存
    this.recentRecords.push(fullRecord);
    if (this.recentRecords.length > 100) {
      this.recentRecords = this.recentRecords.slice(-100);
    }
    
    // 追加到日志文件
    try {
      await mkdir(join(process.cwd(), "data"), { recursive: true });
      const line = JSON.stringify(fullRecord) + "\n";
      await writeFile(this.learningLogPath, line, { flag: "a" });
    } catch (error) {
      console.error("[AgentSelfLearning] 记录学习数据失败:", error);
    }
  }

  /**
   * 分析最近的交互记录，生成改进建议
   */
  async analyzeAndGenerateSuggestions(): Promise<ImprovementSuggestion[]> {
    if (this.recentRecords.length < 5) {
      return [];
    }
    
    // 分析失败案例
    const failures = this.recentRecords.filter((r) => !r.success);
    const failureRate = failures.length / this.recentRecords.length;
    
    const suggestions: ImprovementSuggestion[] = [];
    
    // 如果失败率较高，生成通用改进建议
    if (failureRate > 0.3) {
      suggestions.push({
        type: "optimize_existing",
        priority: "high",
        title: "提高工具调用成功率",
        description: `最近 ${this.recentRecords.length} 次交互中，失败率达到 ${Math.round(failureRate * 100)}%`,
        rationale: "高失败率表明现有工具可能不够完善或参数设计不合理",
        estimatedImpact: "显著提升用户体验和任务完成率",
      });
    }
    
    // 分析常见的错误模式
    const errorPatterns = this.analyzeErrorPatterns(failures);
    for (const pattern of errorPatterns) {
      suggestions.push({
        type: "new_skill",
        priority: pattern.count > 3 ? "high" : "medium",
        title: `创建新技能处理：${pattern.errorType}`,
        description: `检测到 ${pattern.count} 次相关失败，可能需要专门的技能来处理`,
        rationale: pattern.example || "频繁出现的错误类型表明存在能力缺口",
        estimatedImpact: "减少同类错误，提高特定场景的处理能力",
      });
    }
    
    // 如果配置了 LLM，使用 AI 生成更智能的建议
    if (this.chatProvider && this.chatProvider.isEnabled()) {
      const aiSuggestions = await this.generateAISuggestions();
      suggestions.push(...aiSuggestions);
    }
    
    // 保存建议
    await this.saveSuggestions(suggestions);
    
    return suggestions;
  }

  /**
   * 分析错误模式
   */
  private analyzeErrorPatterns(failures: LearningRecord[]): Array<{
    errorType: string;
    count: number;
    example?: string;
  }> {
    const patterns = new Map<string, { count: number; example?: string }>();
    
    for (const failure of failures) {
      if (!failure.errorMessage) continue;
      
      // 简化的错误分类（实际应该更智能）
      let errorType = "unknown";
      const msg = failure.errorMessage.toLowerCase();
      
      if (msg.includes("参数") || msg.includes("param")) {
        errorType = "参数验证错误";
      } else if (msg.includes("权限") || msg.includes("permission")) {
        errorType = "权限不足";
      } else if (msg.includes("超时") || msg.includes("timeout")) {
        errorType = "执行超时";
      } else if (msg.includes("不存在") || msg.includes("not found")) {
        errorType = "资源不存在";
      } else if (msg.includes("格式") || msg.includes("format")) {
        errorType = "数据格式错误";
      }
      
      const existing = patterns.get(errorType);
      if (existing) {
        existing.count++;
      } else {
        patterns.set(errorType, {
          count: 1,
          example: failure.userRequest.substring(0, 100),
        });
      }
    }
    
    return Array.from(patterns.entries())
      .map(([type, data]) => ({
        errorType: type,
        count: data.count,
        example: data.example,
      }))
      .filter((p) => p.count >= 2) // 只返回出现至少 2 次的模式
      .sort((a, b) => b.count - a.count);
  }

  /**
   * 使用 AI 生成智能建议
   */
  private async generateAISuggestions(): Promise<ImprovementSuggestion[]> {
    try {
      // 构建分析提示词
      const recentFailures = this.recentRecords
        .filter((r) => !r.success)
        .slice(-10)
        .map((r) => ({
          request: r.userRequest,
          error: r.errorMessage,
          tools: r.attemptedTools,
        }));
      
      const prompt = `作为 AI Agent 架构师，请分析以下失败的交互记录，并提出改进建议。

**最近的失败案例：**
${JSON.stringify(recentFailures, null, 2)}

**当前可用的工具：**
${this.toolRegistry.list().join(", ")}

请分析：
1. 这些失败反映了什么能力缺口？
2. 应该创建什么新技能或工具来解决？
3. 如何优化现有工具的使用体验？

请以 JSON 数组格式返回建议，每个建议包含：
- type: "new_skill" | "optimize_existing" | "add_tool"
- priority: "high" | "medium" | "low"
- title: 简短标题
- description: 详细描述
- rationale: 为什么需要这个改进
- estimatedImpact: 预期影响`;

      let fullContent = "";
      if (this.chatProvider) {
        await this.chatProvider.streamCompletion(
          "self-improvement-analysis",
          { text: prompt },
          (delta) => {
            fullContent += delta;
          }
        );
      }
      
      // 解析 AI 生成的建议
      const jsonMatch = fullContent.match(/\[\s*\{[\s\S]*\}\s*\]/);
      if (jsonMatch) {
        const suggestions = JSON.parse(jsonMatch[0]);
        return suggestions.map((s: any) => ({
          ...s,
          type: s.type || "new_skill",
          priority: s.priority || "medium",
        }));
      }
      
      return [];
    } catch (error) {
      console.error("[AgentSelfLearning] AI 建议生成失败:", error);
      return [];
    }
  }

  /**
   * 保存建议到文件
   */
  private async saveSuggestions(suggestions: ImprovementSuggestion[]): Promise<void> {
    try {
      await mkdir(join(process.cwd(), "data"), { recursive: true });
      const data = {
        generatedAt: new Date().toISOString(),
        totalSuggestions: suggestions.length,
        suggestions,
      };
      await writeFile(this.suggestionsPath, JSON.stringify(data, null, 2), "utf8");
    } catch (error) {
      console.error("[AgentSelfLearning] 保存建议失败:", error);
    }
  }

  /**
   * 获取最近的改进建议
   */
  async getRecentSuggestions(): Promise<ImprovementSuggestion[]> {
    try {
      const content = await readFile(this.suggestionsPath, "utf8");
      const data = JSON.parse(content);
      return data.suggestions || [];
    } catch (error) {
      return [];
    }
  }

  /**
   * 检测是否需要新技能（基于用户需求）
   */
  async detectSkillNeed(userRequest: string, availableTools: string[]): Promise<{
    needNewSkill: boolean;
    reason: string;
    suggestedSkillName?: string;
  }> {
    // 简单的启发式检测
    const requestLower = userRequest.toLowerCase();
    
    // 检测常见的需求模式
    const patterns = [
      {
        keywords: ["图片", "图像", "photo", "image"],
        skillName: "image.processor",
        reason: "用户请求涉及图像处理",
      },
      {
        keywords: ["视频", "video", "剪辑"],
        skillName: "video.editor",
        reason: "用户请求涉及视频处理",
      },
      {
        keywords: ["翻译", "translate", "语言"],
        skillName: "language.translator",
        reason: "用户请求涉及语言翻译",
      },
      {
        keywords: ["计算", "calculate", "数学", "math"],
        skillName: "math.calculator",
        reason: "用户请求涉及复杂计算",
      },
    ];
    
    for (const pattern of patterns) {
      if (pattern.keywords.some((kw) => requestLower.includes(kw))) {
        // 检查是否已有相关工具
        const hasRelated = availableTools.some((tool) =>
          tool.toLowerCase().includes(pattern.skillName.split(".")[0]),
        );
        
        if (!hasRelated) {
          return {
            needNewSkill: true,
            reason: pattern.reason,
            suggestedSkillName: pattern.skillName,
          };
        }
      }
    }
    
    return {
      needNewSkill: false,
      reason: "当前工具集应该能够满足需求",
    };
  }
}
