/**
 * skill.view 分节读测试（WP4，2026-09-17）。
 *
 * 借鉴 codebase-memory-mcp「outline 先于原文」：procedural 技能文档（SKILL.md）
 * 支持三档读取——mode="outline" 章节目录 / section="标题" 单节 / 默认全文（旧行为）。
 * 章节抽取复用 content-map 的确定性 markdown 切节（无 LLM，防幻觉）。
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { ToolRegistry } from "../src/tools/tool-registry.js";
import { SkillManager } from "../src/skills/skill-manager.js";
import { registerSkillManageTools, SKILL_VIEW_CHAT_TOOL } from "../src/tools/skill-manage-tools.js";

function makeFixture(): { registry: ToolRegistry; manager: SkillManager } {
  const registry = new ToolRegistry();
  const manager = new SkillManager();
  registerSkillManageTools(registry, manager);
  const doc = [
    "# 数据备份技能",
    "",
    "## When to Use",
    "当用户要求备份数据库或工作区文件时使用本技能。" + "引".repeat(600),
    "",
    "## Procedure",
    "1. 停止写入；2. 全量快照；3. 校验哈希。" + "步".repeat(600),
    "",
    "## Pitfalls",
    "备份窗口避开业务高峰，否则拖慢线上查询。" + "坑".repeat(600),
    "",
    "## Verification",
    "用 restore 演练验证备份可用。" + "验".repeat(300),
  ].join("\n");
  const reg = manager.registerProceduralSkill(
    {
      name: "ops.backup_data",
      version: "1.0.0",
      displayName: "数据备份",
      description: "备份数据库与工作区的标准流程",
      tags: ["ops"],
      parameters: [],
      permissions: ["filesystem:read"],
      skillType: "procedural",
    },
    doc,
  );
  assert.ok(reg.ok, `procedural 技能注册应成功: ${reg.error}`);
  return { registry, manager };
}

const VIEW_CTX = { userId: "tester", sessionId: "test-session" } as never;

async function viewSkill(registry: ToolRegistry, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const out = await registry.execute("skill.view", args, VIEW_CTX);
  return out.result as Record<string, unknown>;
}

describe("skill.view 分节读（WP4）", () => {
  test("默认（无 mode/section）返回全文，行为不变", async () => {
    const { registry } = makeFixture();
    const result = await viewSkill(registry, { name: "ops.backup_data" });
    assert.equal(result.ok, true);
    assert.match(String(result.doc), /## Pitfalls/);
    assert.equal(result.mode, undefined, "旧行为不应带 mode 字段");
  });

  test("mode=outline 返回章节目录（无正文），含导航提示", async () => {
    const { registry } = makeFixture();
    const result = await viewSkill(registry, { name: "ops.backup_data", mode: "outline" });
    assert.equal(result.ok, true);
    assert.equal(result.mode, "outline");
    assert.equal(result.doc, undefined, "outline 不应返回正文 doc");
    const outline = String(result.outline);
    assert.match(outline, /When to Use/);
    assert.match(outline, /Pitfalls/);
    assert.match(outline, /仅供导航/);
  });

  test("section=标题 只返回该节内容（默认读全文的 1/4 量级）", async () => {
    const { registry } = makeFixture();
    const result = await viewSkill(registry, { name: "ops.backup_data", section: "Pitfalls" });
    assert.equal(result.ok, true);
    assert.equal(result.mode, "section");
    const content = String(result.content);
    assert.match(content, /备份窗口避开业务高峰/);
    assert.ok(!content.includes("When to Use"), "应只包含目标节");
    const docChars = Number(result.docChars);
    assert.ok(
      Number(result.sectionChars) < docChars / 2,
      `单节（${result.sectionChars}）应显著小于全文（${docChars}）`,
    );
  });

  test("section 中文标题与部分匹配均可命中；未命中给可恢复错误", async () => {
    const { registry } = makeFixture();
    const cn = await viewSkill(registry, { name: "ops.backup_data", section: "Verification" });
    assert.equal(cn.ok, true);
    assert.match(String(cn.content), /restore 演练/);
    const miss = await viewSkill(registry, { name: "ops.backup_data", section: "完全不存在的章节" });
    assert.equal(miss.ok, false);
    assert.match(String(miss.error), /outline/);
  });

  test("schema 含 mode/section 参数", () => {
    const props = (SKILL_VIEW_CHAT_TOOL.function.parameters as { properties: Record<string, unknown> }).properties;
    assert.ok("mode" in props);
    assert.ok("section" in props);
  });
});
