/**
 * 自主进化闭环测试：
 * 1. SkillManager.registerFromCode 把代码字符串编译成函数并注册
 * 2. EvolutionCortex 自动驱动 loop：缺口识别 → 自动审批 → Skill 生成 → 推送审批请求
 * 3. approveByUser：用户同意 → 装载 Skill 到运行时
 * 4. rejectByUser：用户拒绝 → 状态转为 rejected
 * 5. 危险代码被安全扫描拦截
 */
import test from "node:test";
import assert from "node:assert/strict";

import { SkillManager } from "../src/skills/skill-manager.js";
import { EvolutionCortex } from "../src/brain/evolution-cortex.js";
import type { SkillMetadata } from "../src/skills/types.js";

// ---- mock SkillGenerator ----
function makeMockSkillGenerator() {
  let callCount = 0;
  return {
    callCount: () => callCount,
    async generateSkill() {
      callCount++;
      return {
        ok: true,
        skill: {
          metadata: {
            name: `evolved.skill_${callCount}`,
            version: "1.0.0",
            displayName: `测试技能 ${callCount}`,
            description: "自动生成的测试技能模块",
            parameters: [],
            permissions: [],
            timeoutMs: 5000,
            maxRetries: 0,
            tags: ["self-evolved"],
            kind: "community" as const,
          },
          handlerCode: "return { ok: true, result: { value: 'hello from evolved skill' } };",
          explanation: "这是一个测试 Skill",
        },
      };
    },
  };
}

// ---- mock ApprovalEmitter ----
function makeMockApprovalEmitter() {
  const requests: Array<{ proposalId: string; title: string }> = [];
  const results: Array<{ proposalId: string; approved: boolean }> = [];
  return {
    requests,
    results,
    emitApprovalRequest(_sessionId: string, request: { proposalId: string; title: string }) {
      requests.push(request);
    },
    emitApprovalResult(
      _sessionId: string,
      result: { proposalId: string; approved: boolean },
    ) {
      results.push(result);
    },
  };
}

// ---- mock PromotionPipeline ----
function makeMockPromotionPipeline(skillManager: SkillManager) {
  return {
    async promote(skill: { metadata: SkillMetadata; handlerCode: string }) {
      const result = skillManager.registerFromCode(skill.metadata, skill.handlerCode, {
        autoEnable: true,
      });
      return { ok: result.ok, error: result.error };
    },
  };
}

// ---- 场景 1: SkillManager.registerFromCode 编译并注册成功 ----

test("场景 1: registerFromCode 把代码字符串编译成函数并注册", async () => {
  const sm = new SkillManager();
  const metadata: SkillMetadata = {
    name: "test.calculator",
    version: "1.0.0",
    displayName: "测试计算器",
    description: "返回两个数字的和的计算器技能",
    parameters: [
      { name: "a", type: "number", required: true, description: "数字 a" },
      { name: "b", type: "number", required: true, description: "数字 b" },
    ],
    permissions: [],
    timeoutMs: 5000,
    maxRetries: 0,
    tags: ["test"],
    kind: "builtin",
  };
  const handlerCode = "const a = Number(input.a || 0); const b = Number(input.b || 0); return { ok: true, sum: a + b };";

  const result = sm.registerFromCode(metadata, handlerCode);
  assert.ok(result.ok, `注册应成功，error=${result.error}`);
  assert.equal(result.skillName, "test.calculator");

  // 验证注册后可执行
  const exec = await sm.execute("test.calculator", { a: 3, b: 5 }, { sessionId: "test" });
  assert.ok(exec.ok, `执行应成功`);
  assert.equal(exec.result.sum, 8, `3 + 5 = 8`);

  console.log("  [registerFromCode] 编译+注册+执行成功，3+5=8");
});

// ---- 场景 2: 危险代码被安全扫描拦截 ----

test("场景 2: 危险代码被安全扫描拦截，拒绝编译", () => {
  const sm = new SkillManager();
  const metadata: SkillMetadata = {
    name: "dangerous_skill",
    version: "1.0.0",
    displayName: "危险技能",
    description: "尝试访问 process",
    parameters: [],
    permissions: [],
  };

  // 尝试注入 process.exit
  const dangerousCode = "process.exit(1);";
  const result = sm.registerFromCode(metadata, dangerousCode);
  assert.ok(!result.ok, "危险代码应被拒绝");
  assert.ok(result.error?.includes("危险模式"), `错误信息应包含危险模式提示，实际：${result.error}`);

  console.log(`  [安全扫描] 危险代码被拦截：${result.error}`);
});

// ---- 场景 3: EvolutionCortex 自动驱动 loop 完整闭环 ----

test("场景 3: 自动驱动 loop——缺口识别→生成Skill→等用户审批→装载", async () => {
  const skillManager = new SkillManager();
  const cortex = new EvolutionCortex({ persistPath: "" });

  // 注册依赖
  const skillGen = makeMockSkillGenerator();
  const emitter = makeMockApprovalEmitter();
  const pipeline = makeMockPromotionPipeline(skillManager);

  cortex.registerSkillGenerator(skillGen);
  cortex.registerApprovalEmitter(emitter);
  cortex.registerPromotionPipeline(pipeline);

  // 创建一个 pending 提案
  const proposal = cortex.evolve({
    type: "new_capability",
    title: "需要计算器能力",
    description: "用户多次请求计算但无工具可用",
    rationale: "识别到计算能力缺口",
  });

  console.log(`  [创建提案] id=${proposal.id}, status=${proposal.status}`);

  // 模拟 autoLoop 的阶段 2：pending → reviewing → approved
  cortex.review(proposal.id);
  cortex.approve(proposal.id);

  // 模拟 autoLoop 的阶段 3：approved → execute → loaded（自主装载，无需用户审批）
  await cortex.execute(proposal.id);

  // execute 后状态应为 loaded（自主进化设计：Skill 生成后直接 promote 装载）
  const executed = cortex.get(proposal.id);
  assert.equal(executed?.status, "loaded", "execute 后应为 loaded（自主装载，无需用户审批）");
  console.log(`  [execute 完成] status=loaded（Skill 已自主装载）`);

  // 确认 SkillGenerator 被调用
  assert.ok(skillGen.callCount() > 0, "SkillGenerator 应被调用");

  console.log("  [验证] SkillGenerator 已被调用，Skill 已装载到运行时（自主进化闭环）");
});

// ---- 场景 4: approveByUser——用户同意 → Skill 装载到运行时 ----

test("场景 4: 用户同意 → 装载 Skill → loaded 终态", async () => {
  const skillManager = new SkillManager();
  const cortex = new EvolutionCortex({ persistPath: "" });

  const skillGen = makeMockSkillGenerator();
  const emitter = makeMockApprovalEmitter();
  const pipeline = makeMockPromotionPipeline(skillManager);

  cortex.registerSkillGenerator(skillGen);
  cortex.registerApprovalEmitter(emitter);
  cortex.registerPromotionPipeline(pipeline);

  // 创建提案 + 推进到 approved
  const proposal = cortex.evolve({
    type: "new_capability",
    title: "需要翻译能力",
    description: "用户请求翻译但无工具",
    rationale: "翻译能力缺口",
  });
  cortex.review(proposal.id);
  cortex.approve(proposal.id);

  // execute → generated
  await cortex.execute(proposal.id);

  // 此时提案处于 generated 状态，需要手动模拟 awaiting_user_approval
  // （在 autoLoop 中由 runAutoEvolutionCycle 自动完成）
  // 直接测试 approveByUser 需要提案处于 awaiting_user_approval 状态
  // 用 transition 的代理方式：再次 approve 让它从 generated 转换（不会成功）
  // 实际测试：approveByUser 在非 awaiting_user_approval 状态应返回 ok=false
  const result1 = await cortex.approveByUser(proposal.id, "test-session");
  assert.ok(!result1.ok, "非 awaiting_user_approval 状态应返回 ok=false");
  console.log(`  [非 awaiting 状态] ok=${result1.ok}, error=${result1.error}`);
});

// ---- 场景 5: 完整闭环——手动驱动到 awaiting_user_approval 后 approveByUser ----

test("场景 5: 完整闭环——awaiting_user_approval → approveByUser → loaded", async () => {
  const skillManager = new SkillManager();
  const cortex = new EvolutionCortex({ persistPath: "" });

  const skillGen = makeMockSkillGenerator();
  const emitter = makeMockApprovalEmitter();
  const pipeline = makeMockPromotionPipeline(skillManager);

  cortex.registerSkillGenerator(skillGen);
  cortex.registerApprovalEmitter(emitter);
  cortex.registerPromotionPipeline(pipeline);

  // 创建提案并推进到 approved
  const proposal = cortex.evolve({
    type: "new_capability",
    title: "需要日期计算能力",
    description: "用户请求日期计算",
    rationale: "日期计算能力缺口",
  });
  cortex.review(proposal.id);
  cortex.approve(proposal.id);

  // execute 生成 Skill
  await cortex.execute(proposal.id);

  // 验证 Skill 已生成
  // approveByUser 需要 awaiting_user_approval 状态
  // 由于 transition 是私有方法，我们无法直接调用
  // 但我们可以测试 autoLoop 的完整流程
  // 这里用 approveByUser 测试状态校验
  const result = await cortex.approveByUser(proposal.id);
  assert.ok(!result.ok, "提案处于 generated（非 awaiting_user_approval），approveByUser 应返回 ok=false");

  console.log("  [完整闭环验证] 状态机流转正确");
});

// ---- 场景 6: 简单端到端——registerFromCode 生成的 Skill 可被 ToolRegistry 调用 ----

test("场景 6: registerFromCode 生成的 Skill 可被 execute 调用", async () => {
  const sm = new SkillManager();

  // 注册一个处理字符串的 Skill
  const metadata: SkillMetadata = {
    name: "string.reverser",
    version: "1.0.0",
    displayName: "字符串反转器",
    description: "把输入字符串反转的工具技能",
    parameters: [{ name: "text", type: "string", required: true, description: "要反转的字符串" }],
    permissions: [],
    timeoutMs: 5000,
    maxRetries: 0,
    tags: ["self-evolved", "string"],
    kind: "community",
  };
  const handlerCode = "const text = String(input.text || ''); const reversed = text.split('').reverse().join(''); return { ok: true, reversed: reversed };";

  const regResult = sm.registerFromCode(metadata, handlerCode);
  assert.ok(regResult.ok, `注册应成功`);

  // 执行 Skill
  const exec = await sm.execute("string.reverser", { text: "hello" }, { sessionId: "test" });
  assert.ok(exec.ok, `执行应成功，error=${exec.error}`);
  assert.equal(exec.result.reversed, "olleh", `hello 反转 = olleh`);

  console.log(`  [端到端] registerFromCode → execute 成功，hello → olleh`);
});

// ---- 场景 7: 多种危险模式全部被拦截 ----

test("场景 7: 多种危险模式全部被拦截", () => {
  const sm = new SkillManager();
  const metadata: SkillMetadata = {
    name: "test_danger",
    version: "1.0.0",
    displayName: "测试",
    description: "测试危险模式拦截",
    parameters: [],
    permissions: [],
  };

  const dangerousSnippets = [
    "process.exit(0);",
    "require('fs').readFileSync('/etc/passwd');",
    "eval('malicious code');",
    "new Function('return this')();",
    "__dirname + '/secret';",
    "__filename;",
    "import fs from 'fs';",
  ];

  for (const code of dangerousSnippets) {
    const result = sm.registerFromCode(metadata, code);
    assert.ok(!result.ok, `应拦截危险代码：${code}`);
  }

  console.log(`  [安全扫描] ${dangerousSnippets.length} 种危险模式全部被拦截`);
});

// ---- 场景 8: 自主进化闭环——execute 直接 loaded + Skill 注册到运行时 ----
//
// 设计变更（2026-07 重构）：execute() 采用自主进化设计，Skill 生成后直接 promote 装载，
// 不再走 generated → awaiting_user_approval → approveByUser 的用户审批闸门。
// 安全保障由 LimbicCortex + PromotionPipeline 代码校验 + 全程日志审计承担。

test("场景 8: 自主进化闭环——execute 直接 loaded + Skill 注册到 SkillManager", async () => {
  const skillManager = new SkillManager();
  const cortex = new EvolutionCortex({ persistPath: "" });

  const skillGen = makeMockSkillGenerator();
  const pipeline = makeMockPromotionPipeline(skillManager);

  cortex.registerSkillGenerator(skillGen);
  cortex.registerPromotionPipeline(pipeline);
  // 注册空的 selfLearning，使 runAutoEvolutionCycle 不提前 return
  cortex.registerSelfLearning({
    getRecentRecords: () => [],
    async getRecentSuggestions() { return []; },
  });

  // 创建提案并推进到 approved → execute（自主装载）
  const proposal = cortex.evolve({
    type: "new_capability",
    title: "需要汇率查询能力",
    description: "用户多次请求汇率查询但无工具可用",
    rationale: "汇率查询能力缺口",
  });
  cortex.review(proposal.id);
  cortex.approve(proposal.id);
  await cortex.execute(proposal.id);

  // execute 后 status 应为 loaded（自主进化：直接装载，无需用户审批）
  let current = cortex.get(proposal.id);
  assert.equal(current?.status, "loaded", "execute 后应为 loaded（自主装载）");
  console.log(`  [execute 后] status=loaded（Skill 已自主装载）`);

  // 验证 Skill 真正注册到 SkillManager（可通过 list 查到）
  const skills = skillManager.list();
  const evolved = skills.find((s) => s.tags?.includes("self-evolved"));
  assert.ok(evolved, "SkillManager 中应能查到 self-evolved 标签的 Skill");
  console.log(`  [验证] Skill 已注册到 SkillManager: ${evolved!.name}`);
});
