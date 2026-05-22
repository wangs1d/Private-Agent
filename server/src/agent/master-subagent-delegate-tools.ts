/**
 * Chat tools used by the master Agent to delegate work to sub-agents.
 */

import type { ChatCompletionTool } from "openai/resources/chat/completions";

import type { SubAgentCapability, SubAgentType } from "../services/master-agent-types.js";

export const MASTER_INVOKE_SUB_AGENT_REGISTRY = "master.invoke_sub_agent";
export const MASTER_LIST_SUB_AGENTS_REGISTRY = "master.list_sub_agents";

const SUB_AGENT_TYPES: SubAgentType[] = [
  "life",
  "work",
  "social",
  "entertainment",
  "finance",
  "tech",
  "info",
  "general",
];

export function parseSubAgentType(raw: unknown): SubAgentType | null {
  const t = String(raw ?? "")
    .trim()
    .toLowerCase();
  return (SUB_AGENT_TYPES as string[]).includes(t) ? (t as SubAgentType) : null;
}

export function buildMasterSubAgentDelegateChatTools(
  capabilities: Iterable<SubAgentCapability>,
): ChatCompletionTool[] {
  const lines: string[] = [];
  for (const cap of capabilities) {
    lines.push(`- ${cap.type} (${cap.name}): ${cap.description}`);
  }
  const catalog = lines.length ? lines.join("\n") : SUB_AGENT_TYPES.map((t) => `- ${t}`).join("\n");

  return [
    {
      type: "function",
      function: {
        name: MASTER_INVOKE_SUB_AGENT_REGISTRY,
        description:
          [
            "Master Agent delegates one professional sub-task to one sub-agent.",
            "Call this only when delegation is useful; simple tasks should use normal tools directly.",
            "After receiving a report, synthesize for the user or delegate another distinct sub-task.",
            `Available sub-agents:\n${catalog}`,
          ].join("\n"),
        parameters: {
          type: "object",
          properties: {
            agentType: {
              type: "string",
              enum: [...SUB_AGENT_TYPES],
              description: "Sub-agent type to invoke.",
            },
            taskDescription: {
              type: "string",
              description: "Concrete task for the sub-agent, including required context.",
            },
            userStatusLine: {
              type: "string",
              description:
                "Required. A short user-visible progress line written naturally by the master Agent.",
            },
            priorContext: {
              type: "string",
              description: "Optional extra background for the sub-agent, such as prior conclusions.",
            },
          },
          required: ["agentType", "taskDescription", "userStatusLine"],
          additionalProperties: false,
        },
      },
    },
    {
      type: "function",
      function: {
        name: MASTER_LIST_SUB_AGENTS_REGISTRY,
        description: "List available sub-agent types and responsibilities.",
        parameters: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
      },
    },
  ];
}
