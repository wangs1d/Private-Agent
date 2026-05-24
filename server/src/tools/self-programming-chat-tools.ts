import type { ChatCompletionTool } from "openai/resources/chat/completions";

/** tech 子 Agent 开发/RPA 相关自我编程工具（完全访问模式下可用）。 */
export const SELF_PROGRAMMING_CHAT_TOOLS: ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "self.list_custom_skills",
      description: "列出当前用户创建的自定义技能。",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "self.analyze_capabilities",
      description: "分析当前 Agent 能力缺口并给出扩展建议。",
      parameters: {
        type: "object",
        properties: {
          taskDescription: { type: "string", description: "待分析的任务描述" },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "self.generate_skill",
      description: "根据自然语言描述智能生成技能代码（生成后需审查并用 self.create_skill 提交）。",
      parameters: {
        type: "object",
        properties: {
          description: { type: "string", description: "技能功能描述" },
          useCase: { type: "string", description: "使用场景" },
          expectedInput: { type: "string", description: "期望输入" },
          expectedOutput: { type: "string", description: "期望输出" },
        },
        required: ["description"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "self.generate_from_example",
      description: "基于示例输入输出对生成新技能代码。",
      parameters: {
        type: "object",
        properties: {
          skillName: { type: "string", description: "技能名 namespace.action" },
          examples: {
            type: "array",
            items: {
              type: "object",
              properties: {
                input: { type: "object" },
                output: { type: "object" },
              },
            },
            description: "示例输入输出对",
          },
        },
        required: ["skillName", "examples"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "self.generate_tool_template",
      description: "生成技能 handler 代码模板。",
      parameters: {
        type: "object",
        properties: {
          skillName: { type: "string" },
          description: { type: "string" },
        },
        required: ["skillName", "description"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "self.create_skill",
      description: "创建并注册新的自定义技能。",
      parameters: {
        type: "object",
        properties: {
          skillName: { type: "string", description: "namespace.action 格式" },
          displayName: { type: "string" },
          description: { type: "string" },
          handlerCode: { type: "string", description: "JavaScript handler 代码" },
          parameters: { type: "array", items: { type: "object" } },
          permissions: { type: "array", items: { type: "string" } },
          tags: { type: "array", items: { type: "string" } },
        },
        required: ["skillName", "displayName", "description", "handlerCode"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "self.update_skill",
      description: "更新已有自定义技能的元数据或 handler 代码。",
      parameters: {
        type: "object",
        properties: {
          skillName: { type: "string" },
          displayName: { type: "string" },
          description: { type: "string" },
          handlerCode: { type: "string" },
          parameters: { type: "array", items: { type: "object" } },
        },
        required: ["skillName"],
        additionalProperties: false,
      },
    },
  },
];
