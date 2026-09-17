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
      "确认某技能与当前任务相关后再调用。" +
      "大文档建议两步读：先 mode=\"outline\" 看章节目录，再用 section=\"章节标题\" 只读所需章节，" +
      "避免整份文档挤占上下文（章节仅供导航，引用细节前须读对应章节原文）。",
    parameters: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "技能名（namespace.action 格式，如 'devops.deploy_k8s'）",
        },
        mode: {
          type: "string",
          enum: ["full", "outline"],
          description: "full=全文（默认）；outline=仅返回章节目录（标题+字数），不返回正文",
        },
        section: {
          type: "string",
          description: "章节标题（如 \"Pitfalls\" 或中文标题，支持部分匹配）。给出时只返回该章节内容",
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
        "procedural 技能需用 skill.view 读取后作为上下文使用（大文档可先 mode=\"outline\" 看章节目录再按 section 读，省上下文）；code 技能可直接调用执行。",
    };
  });

  // ========== skill.view：按需加载（渐进式召回 Level 1；WP4 支持分节读） ==========
  registry.register("skill.view", async (input) => {
    const name = String(input.name ?? "").trim();
    if (!name) {
      return { ok: false, error: "请提供技能名（name）" };
    }
    const mode = String(input.mode ?? "full");
    const section = String(input.section ?? "").trim();

    // procedural 技能：全文 / outline / section 三种读法
    if (skillManager.isProceduralSkill(name)) {
      const result = skillManager.getProceduralSkillDoc(name);
      if (!result.ok) {
        return { ok: false, error: result.error };
      }
      const doc = result.doc ?? "";
      const metadata = {
        name: result.metadata?.name,
        description: result.metadata?.description,
        tags: result.metadata?.tags,
        version: result.metadata?.version,
      };

      // WP4（借鉴 codebase-memory-mcp「结构索引+定向读取」）：确定性章节抽取
      // （复用 content-map 的 markdown 标题切节，无 LLM），大文档按节读省 token
      if (mode === "outline" || section) {
        const { buildContentMap, resolveQueryWindow } = await import(
          "../external-model/content-map.js"
        );
        const map = buildContentMap(doc);
        if (mode === "outline" && !section) {
          const { renderOutline } = await import("../external-model/content-map.js");
          return {
            ok: true,
            skillType: "procedural",
            name,
            mode: "outline",
            docChars: doc.length,
            outline: renderOutline(map),
            metadata,
            hint: "章节目录仅供导航。用 section=\"章节标题\" 读取所需章节；引用细节前必须读对应章节原文。",
          };
        }
        if (!map.sections.length) {
          return { ok: false, error: "该技能文档无章节结构（无 markdown 标题），请用 mode=\"full\" 读全文。" };
        }
        // 章节定位：先精确/前缀匹配标题，未命中再用 query 窗口定位（容错短语）
        const lower = section.toLowerCase();
        const hit =
          map.sections.find((s) => s.title.toLowerCase() === lower) ??
          map.sections.find((s) => s.title.toLowerCase().startsWith(lower) || s.title.toLowerCase().includes(lower));
        if (hit) {
          const body = doc.slice(hit.offset, hit.offset + hit.chars);
          return {
            ok: true,
            skillType: "procedural",
            name,
            mode: "section",
            section: hit.title,
            sectionChars: hit.chars,
            docChars: doc.length,
            content: body,
            metadata,
          };
        }
        const win = resolveQueryWindow(map, doc, section, 3000);
        if (win) {
          return {
            ok: true,
            skillType: "procedural",
            name,
            mode: "section",
            section: win.matchedTitles[0] ?? section,
            sectionChars: win.chars,
            docChars: doc.length,
            content: doc.slice(win.offset, win.offset + win.chars),
            metadata,
          };
        }
        return {
          ok: false,
          error: `未找到章节「${section}」。可先 mode="outline" 查看章节目录，或 mode="full" 读全文。`,
        };
      }

      return {
        ok: true,
        skillType: "procedural",
        name,
        doc,
        metadata,
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
