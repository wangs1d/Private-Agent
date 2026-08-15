/**
 * 技能管理工具 - 让 LLM 自主查询、沉淀、修补 procedural 技能。
 *
 * 技能管理三件套：
 *  - skill.list   ：列出轻量索引（Level 0 渐进式召回，常驻 prompt 之外的运行时补充）
 *  - skill.view   ：按需加载 procedural 技能全文（Level 1）
 *  - skill.manage ：create / patch / delete procedural 技能（沉淀经验 + 增量修补）
 *
 * 设计要点：
 *  - 复杂任务成功后（≥5 次工具调用）应主动 create 沉淀经验
 *  - 踩到新坑应立即 patch 补进 Pitfalls，不要等用户提醒
 *  - description ≤60 字符是召回质量的命门
 *  - 安全扫描在 SkillManager.patchProceduralSkill 内部完成（拦截注入/凭据/危险命令）
 */

import type { ChatCompletionTool } from "openai/resources/chat/completions";
import type { ToolRegistry } from "./tool-registry.js";
import type { SkillManager } from "../skills/index.js";

/** skill.list 工具定义（LLM 可见） */
export const SKILL_LIST_CHAT_TOOL: ChatCompletionTool = {
  type: "function",
  function: {
    name: "skill.list",
    description:
      "列出所有可用技能的轻量索引（name + description + 类型 + 标签）。" +
      "procedural 类型技能是过程式文档（操作流程/踩坑经验），需配合 skill.view 读取全文后作为上下文使用；" +
      "code 类型技能可直接调用执行。先调用本工具了解有哪些可复用技能，再决定是否 skill.view 加载详情。",
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
};

/** skill.view 工具定义（LLM 可见） */
export const SKILL_VIEW_CHAT_TOOL: ChatCompletionTool = {
  type: "function",
  function: {
    name: "skill.view",
    description:
      "读取指定技能的详情。procedural 技能返回 SKILL.md 全文" +
      "（含 ## When to Use / ## Procedure / ## Pitfalls / ## Verification 四个章节）；" +
      "code 技能返回元数据。用于按需加载技能全文（渐进式召回 Level 1），" +
      "确认某技能与当前任务相关后再调用。",
    parameters: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "技能名（namespace.action 格式，如 'devops.deploy_k8s'）",
        },
      },
      required: ["name"],
      additionalProperties: false,
    },
  },
};

/** skill.manage 工具定义（LLM 可见） */
export const SKILL_MANAGE_CHAT_TOOL: ChatCompletionTool = {
  type: "function",
  function: {
    name: "skill.manage",
    description:
      "管理 procedural 技能（过程式文档）。" +
      "action=create 创建新技能：复杂任务成功后（≥5 次工具调用、踩过坑、用户纠正过、发现非平凡流程）应主动沉淀；" +
      "action=patch 局部修补：使用中踩到 Skill 未覆盖的新坑应立即补进 Pitfalls，不要等用户提醒；" +
      "action=delete 删除技能。" +
      "简单一次性任务不要创建技能。description 必须 ≤60 字符（召回命门）。",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["create", "patch", "delete"],
          description: "操作类型",
        },
        name: {
          type: "string",
          description: "技能名（namespace.action 格式，如 'devops.deploy_k8s'）",
        },
        description: {
          type: "string",
          description: "create 时必填：一句话功能描述（≤60 字符，决定召回质量）",
        },
        doc: {
          type: "string",
          description:
            "create 时必填：SKILL.md 全文，包含四个章节：## When to Use / ## Procedure / ## Pitfalls / ## Verification",
        },
        oldString: {
          type: "string",
          description: "patch 时必填：要替换的原文片段（模糊匹配，容忍格式差异）",
        },
        newString: {
          type: "string",
          description: "patch 时必填：替换为的内容",
        },
        replaceAll: {
          type: "boolean",
          description: "patch 时是否替换所有匹配（默认 false，只替换第一处）",
        },
        tags: {
          type: "array",
          items: { type: "string" },
          description: "create 时的分类标签（第一个 tag 作为存储 category 目录）",
        },
      },
      required: ["action", "name"],
      additionalProperties: false,
    },
  },
};

/** 三个技能管理工具的集合（供 chatToolsExtra 注入） */
export const SKILL_MANAGE_CHAT_TOOLS: ChatCompletionTool[] = [
  SKILL_LIST_CHAT_TOOL,
  SKILL_VIEW_CHAT_TOOL,
  SKILL_MANAGE_CHAT_TOOL,
];

/**
 * 注册技能管理工具到 ToolRegistry。
 *
 * 在 bootstrap 完成所有技能注册后调用一次。
 */
export function registerSkillManageTools(
  registry: ToolRegistry,
  skillManager: SkillManager,
): void {
  // ========== skill.list：列出轻量索引 ==========
  registry.register("skill.list", async () => {
    const manifests = skillManager.list(true);
    return {
      ok: true,
      total: manifests.length,
      skills: manifests.map((m) => ({
        name: m.name,
        displayName: m.displayName,
        description: m.description,
        skillType: m.skillType ?? "code",
        tags: m.tags ?? [],
        version: m.version,
      })),
      hint:
        "procedural 技能需用 skill.view 读取全文后作为上下文使用；code 技能可直接调用执行。",
    };
  });

  // ========== skill.view：按需加载全文（渐进式召回 Level 1） ==========
  registry.register("skill.view", async (input) => {
    const name = String(input.name ?? "").trim();
    if (!name) {
      return { ok: false, error: "请提供技能名（name）" };
    }

    // procedural 技能：返回全文
    if (skillManager.isProceduralSkill(name)) {
      const result = skillManager.getProceduralSkillDoc(name);
      if (!result.ok) {
        return { ok: false, error: result.error };
      }
      return {
        ok: true,
        skillType: "procedural",
        name,
        doc: result.doc,
        metadata: {
          name: result.metadata?.name,
          description: result.metadata?.description,
          tags: result.metadata?.tags,
          version: result.metadata?.version,
        },
      };
    }

    // code 技能：返回 manifest（无 handler 代码）
    const manifest = skillManager.get(name);
    if (!manifest) {
      return { ok: false, error: `技能不存在: ${name}` };
    }
    return {
      ok: true,
      skillType: "code",
      name,
      metadata: manifest,
    };
  });

  // ========== skill.manage：create / patch / delete procedural 技能 ==========
  registry.register("skill.manage", async (input) => {
    const action = String(input.action ?? "").trim();
    const name = String(input.name ?? "").trim();

    if (!action || !name) {
      return { ok: false, error: "请提供 action 和 name" };
    }

    if (action === "create") {
      const description = String(input.description ?? "").trim();
      const doc = String(input.doc ?? "").trim();
      const tags = Array.isArray(input.tags) ? input.tags.map(String) : [];

      if (!description) {
        return { ok: false, error: "create 需要 description（≤60 字符，召回命门）" };
      }
      if (description.length > 60) {
        return { ok: false, error: `description 过长（${description.length} 字符），请控制在 60 字符内` };
      }
      if (!doc) {
        return { ok: false, error: "create 需要 doc（SKILL.md 全文）" };
      }

      const result = skillManager.registerProceduralSkill(
        {
          name,
          version: "1.0.0",
          displayName: name,
          description,
          parameters: [],
          permissions: [],
          tags,
          skillType: "procedural",
          kind: "community",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
        doc,
      );
      return result;
    }

    if (action === "patch") {
      const oldString = String(input.oldString ?? "");
      const newString = String(input.newString ?? "");
      const replaceAll = input.replaceAll === true;

      if (!oldString || !newString) {
        return { ok: false, error: "patch 需要 oldString 和 newString" };
      }
      return skillManager.patchProceduralSkill(name, oldString, newString, replaceAll);
    }

    if (action === "delete") {
      return skillManager.deleteProceduralSkill(name);
    }

    return { ok: false, error: `未知 action: ${action}（支持 create/patch/delete）` };
  });
}
