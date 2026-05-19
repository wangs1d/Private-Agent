import type { WorldService } from "@private-ai-agent/agent-world";
import type { ChatCompletionTool } from "openai/resources/chat/completions";
import type { SkillManager } from "./skill-manager.js";
import type { SkillManifest, SkillParameter } from "./types.js";

function paramToJsonSchema(p: SkillParameter): Record<string, unknown> {
  const base: Record<string, unknown> = {};
  if (p.description) base.description = p.description;
  if (p.enum != null && Array.isArray(p.enum)) base.enum = p.enum;
  switch (p.type) {
    case "string":
      return { type: "string", ...base };
    case "number":
      return { type: "number", ...base };
    case "boolean":
      return { type: "boolean", ...base };
    case "array":
      return { type: "array", items: { type: "string" }, ...base };
    case "object":
    default:
      return { type: "object", ...base };
  }
}

/**
 * 将 Skill 元数据转为 OpenAI Chat Completions `tools` 条目（与 ToolRegistry 执行名一致）。
 */
export function skillManifestToChatTool(manifest: SkillManifest): ChatCompletionTool {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const p of manifest.parameters ?? []) {
    properties[p.name] = paramToJsonSchema(p);
    if (p.required) required.push(p.name);
  }
  return {
    type: "function",
    function: {
      name: manifest.name,
      description: manifest.description || manifest.displayName,
      parameters: {
        type: "object",
        properties,
        required: required.length ? required : undefined,
        additionalProperties: false,
      },
    },
  };
}

/**
 * 本会话可暴露给 LLM 的 Skill 工具：内置类全部 + 仅已购买的社区技能（与 ToolRegistry 所有权校验一致）。
 */
export function buildSessionSkillChatTools(
  actorId: string,
  world: WorldService,
  skillManager: SkillManager,
): ChatCompletionTool[] {
  const state = world.getOrCreateRoom(actorId, actorId);
  const owned = new Set(state.ownedSkillIds);
  const manifests = skillManager.list(true);
  const out: ChatCompletionTool[] = [];
  for (const m of manifests) {
    if (m.kind === "community" && !owned.has(m.name)) continue;
    out.push(skillManifestToChatTool(m));
  }
  return out;
}
