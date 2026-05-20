/**
 * 智能技能生成器 - 基于 LLM 自动生成 Skill 代码
 * 
 * 功能：
 * 1. 根据自然语言描述生成完整的 Skill 定义和实现代码
 * 2. 自动推断参数、权限、标签等元数据
 * 3. 生成符合规范的 handler 代码
 */

import type { ExternalChatProvider } from "../external-model/types.js";
import type { SkillDefinition, SkillMetadata, SkillParameter } from "../skills/types.js";

export interface SkillGenerationRequest {
  description: string;        // 技能功能描述（自然语言）
  useCase?: string;          // 使用场景示例
  expectedInput?: string;    // 期望的输入格式
  expectedOutput?: string;   // 期望的输出格式
}

export interface SkillGenerationResult {
  ok: boolean;
  skill?: {
    metadata: SkillMetadata;
    handlerCode: string;
    explanation: string;
  };
  error?: string;
  suggestions?: string[];
}

/**
 * 智能技能生成服务
 */
export class SkillGenerator {
  constructor(private readonly chatProvider: ExternalChatProvider | null) {}

  /**
   * 根据描述生成技能
   */
  async generateSkill(request: SkillGenerationRequest): Promise<SkillGenerationResult> {
    if (!this.chatProvider || !this.chatProvider.isEnabled()) {
      return {
        ok: false,
        error: "需要配置外部聊天提供商才能使用智能生成功能",
        suggestions: [
          "请配置 OPENAI_API_KEY 或其他聊天提供商",
          "或者手动编写技能代码并使用 self.create_skill 工具",
        ],
      };
    }

    try {
      // 构建提示词
      const prompt = this.buildGenerationPrompt(request);
      
      // 调用 LLM 生成代码（使用 streamCompletion，但收集完整响应）
      let fullContent = "";
      await this.chatProvider.streamCompletion(
        "skill-generator-session",
        { text: prompt },
        (delta) => {
          fullContent += delta;
        }
      );

      // 解析生成的代码
      const parsed = this.parseGeneratedCode(fullContent);
      
      if (!parsed) {
        return {
          ok: false,
          error: "无法解析生成的代码，请重试或手动编写",
          suggestions: [
            "尝试更详细地描述技能功能",
            "提供具体的输入输出示例",
          ],
        };
      }

      return {
        ok: true,
        skill: parsed,
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return {
        ok: false,
        error: `生成失败：${msg}`,
        suggestions: ["检查网络连接和 API 配置", "简化需求描述后重试"],
      };
    }
  }

  /**
   * 获取系统提示词
   */
  private getSystemPrompt(): string {
    return `你是一个专业的 TypeScript 开发者，专门为用户创建 AI Agent 的技能（Skill）。

你的任务是：
1. 根据用户的需求描述，设计合理的技能接口
2. 生成符合规范的 Skill 元数据（metadata）
3. 编写安全、高效的 handler 代码

**重要规范：**
- 技能名称必须是 \`namespace.action\` 格式，如 \`image.resize\`、\`data.analyze\`
- 必须包含完整的参数验证和错误处理
- 代码必须使用 ES Module 格式（export default）
- 不要访问文件系统或执行危险操作
- 优先使用 input 参数和 context 中的信息

**输出格式：**
你必须严格按照以下 JSON 格式输出：

\`\`\`json
{
  "metadata": {
    "name": "namespace.action",
    "version": "1.0.0",
    "displayName": "显示名称",
    "description": "详细描述",
    "parameters": [
      {
        "name": "paramName",
        "type": "string|number|boolean|object|array",
        "required": true,
        "description": "参数说明"
      }
    ],
    "permissions": [],
    "tags": ["tag1", "tag2"]
  },
  "handlerCode": "async function (input, context) { ... }",
  "explanation": "对生成代码的简要说明"
}
\`\`\`

确保输出的 JSON 是完整且有效的。`;
  }

  /**
   * 构建生成提示词
   */
  private buildGenerationPrompt(request: SkillGenerationRequest): string {
    let prompt = `请为我创建一个 AI Agent 技能。\n\n`;
    
    prompt += `**功能描述：**\n${request.description}\n\n`;
    
    if (request.useCase) {
      prompt += `**使用场景：**\n${request.useCase}\n\n`;
    }
    
    if (request.expectedInput) {
      prompt += `**期望输入：**\n${request.expectedInput}\n\n`;
    }
    
    if (request.expectedOutput) {
      prompt += `**期望输出：**\n${request.expectedOutput}\n\n`;
    }
    
    prompt += `请生成完整的技能定义和实现代码。确保代码安全、健壮且易于理解。`;
    
    return prompt;
  }

  /**
   * 解析生成的代码
   */
  private parseGeneratedCode(content: string): SkillGenerationResult["skill"] | null {
    try {
      // 尝试提取 JSON 代码块
      const jsonMatch = content.match(/```json\s*([\s\S]*?)\s*```/);
      if (jsonMatch) {
        const jsonStr = jsonMatch[1];
        const parsed = JSON.parse(jsonStr);
        
        // 验证基本结构
        if (!parsed.metadata || !parsed.handlerCode) {
          return null;
        }
        
        // 补充默认值
        const metadata: SkillMetadata = {
          name: parsed.metadata.name,
          version: parsed.metadata.version || "1.0.0",
          displayName: parsed.metadata.displayName,
          description: parsed.metadata.description,
          kind: "community",
          parameters: parsed.metadata.parameters || [],
          permissions: parsed.metadata.permissions || [],
          tags: parsed.metadata.tags || ["auto-generated"],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
        
        return {
          metadata,
          handlerCode: parsed.handlerCode,
          explanation: parsed.explanation || "自动生成的技能代码",
        };
      }
      
      return null;
    } catch (error) {
      console.error("[SkillGenerator] 解析失败:", error);
      return null;
    }
  }
}
