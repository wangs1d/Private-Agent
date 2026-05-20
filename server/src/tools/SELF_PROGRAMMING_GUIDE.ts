/**
 * Agent 自我编程能力 - 快速开始指南
 * 
 * 🎯 核心概念
 * ============
 * Agent 现在拥有自我进化的能力，可以：
 * 1. 自主创建新技能来扩展功能
 * 2. 智能生成代码（需要配置 LLM）
 * 3. 从交互中学习并改进
 * 4. 检测能力缺口并主动补全
 * 
 * 📚 可用工具
 * ===========
 * 
 * **基础工具**（无需外部依赖）：
 * - self.create_skill: 手动创建新技能
 * - self.update_skill: 更新现有技能
 * - self.delete_skill: 删除技能
 * - self.list_custom_skills: 列出所有自定义技能
 * - self.analyze_capabilities: 分析能力缺口
 * - self.generate_tool_template: 生成代码模板
 * 
 * **智能工具**（需要配置外部聊天提供商）：
 * - self.generate_skill: 根据描述智能生成技能代码
 * - self.generate_from_example: 基于示例生成新技能
 * - self.optimize_skill: 优化现有技能代码
 * 
 * **学习工具**（需要配置外部聊天提供商以获得最佳效果）：
 * - self.record_interaction: 记录交互用于学习
 * - self.analyze_improvements: 分析并生成改进建议
 * - self.get_suggestions: 获取改进建议详情
 * - self.detect_skill_need: 检测是否需要新技能
 * - self.get_learning_stats: 查看学习统计
 * 
 * 💡 使用场景示例
 * ================
 * 
 * **场景 1：用户需要一个不存在的功能**
 * ```
 * 用户：能帮我计算一下房贷月供吗？
 * 
 * Agent 的思考过程：
 * 1. 检查是否有房贷计算工具 → 没有
 * 2. 调用 self.detect_skill_need 确认需要新技能
 * 3. 调用 self.generate_skill 智能生成代码
 * 4. 调用 self.create_skill 创建技能
 * 5. 使用新创建的技能回答用户
 * ```
 * 
 * **场景 2：Agent 发现频繁失败**
 * ```
 * Agent 定期调用 self.analyze_improvements
 * → 发现"图片处理"相关请求失败率高
 * → 生成建议：创建 image.analyzer 技能
 * → Agent 主动创建该技能
 * ```
 * 
 * **场景 3：手动创建简单技能**
 * ```typescript
 * // Agent 调用 self.create_skill
 * {
 *   "skillName": "unit.converter",
 *   "displayName": "单位转换器",
 *   "description": "在不同单位之间转换（长度、重量等）",
 *   "handlerCode": `
 *     const value = Number(input.value);
 *     const from = input.from;
 *     const to = input.to;
 *     // 实现转换逻辑
 *     return { result: convertedValue };
 *   `,
 *   "parameters": [
 *     { "name": "value", "type": "number", "required": true },
 *     { "name": "from", "type": "string", "required": true },
 *     { "name": "to", "type": "string", "required": true }
 *   ]
 * }
 * ```
 * 
 * 🔧 配置要求
 * ===========
 * 
 * **基础功能**（无需额外配置）：
 * - 手动创建、更新、删除技能
 * - 能力分析和模板生成
 * 
 * **智能功能**（需要配置）：
 * 在 .env 文件中配置以下之一：
 * - OPENAI_API_KEY=your_key_here
 * - 或其他支持的聊天提供商
 * 
 * 📁 文件结构
 * ============
 * 
 * 创建的技能会保存在：
 * data/community-skills/{skillName}/
 *   ├── skill.json          # 技能元数据
 *   └── skill.handler.js    # 技能实现代码
 * 
 * 🚀 快速测试
 * ===========
 * 
 * 运行测试脚本验证功能：
 * ```bash
 * npx tsx test-self-programming.ts
 * ```
 * 
 * ⚠️ 安全注意事项
 * ================
 * 
 * 1. 创建的代码会在服务端执行，确保代码安全
 * 2. 建议在生产环境启用审核机制
 * 3. 限制 Skill 的权限范围
 * 4. 监控异常行为
 * 
 * 📖 更多信息
 * ===========
 * 
 * - 查看 self-programming-tools.ts 了解详细 API
 * - 查看 agent-capabilities.ts 了解 Agent 如何感知这些能力
 * - 查看 test-self-programming.ts 了解完整的使用示例
 */

// 这个文件只是文档，不需要导出任何内容
export {};
